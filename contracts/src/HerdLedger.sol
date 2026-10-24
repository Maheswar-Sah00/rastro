// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControlEnumerable} from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IHerdLedger} from "./IHerdLedger.sol";

/// @title HerdLedger
/// @author Rastro
/// @notice Shared ledger that enforces "conservation of cattle" across mutually distrusting parties.
///
///         A cow is born once, dies once, and can't be in two places. Neither can its paperwork.
///
///         Laundering moves animals from a ranch with illegal deforestation (or inside a protected area,
///         or under embargo) through a "clean" intermediary to a slaughterhouse or export ship. Each step
///         is backed by a GTA (animal transit permit). This contract makes the paperwork obey physics:
///
///         1. Conservation: a ranch cannot ship more head than it holds
///            (initial + births + purchases − deaths − sales).
///         2. Biology: births per ranch per year <= breeding cows × 85 %.
///         3. Carrying capacity: a ranch above capacity × 110 % is publicly signalled.
///         4. Embargo: an embargoed ranch cannot send animals anywhere.
///         5. One-time claims: each GTA backs at most one lot certificate, and each certificate
///            can be consumed exactly once (one export shipment or one EUDR due-diligence statement).
///
///         The off-chain detection model (the "oracle") signs risk attestations and lot certificates with
///         EIP-712; anyone can relay them, and the contract checks the signer holds `ORACLE_ROLE`.
///
///         Modules (one contract, separated below): ranch registry, herd ledger (births, deaths, GTAs),
///         regulator (embargoes, revocation), oracle registry (`ORACLE_ROLE`, enumerable), certificate
///         registry (EIP-712, single-use GTAs, one-time consumption, expiry, policy version), evidence
///         registry (anchored SHA-256 commitments) and emergency pause.
///
///         The ledger checks that submitted transitions are valid under these rules. It cannot verify
///         physical facts: breeding-cow counts and births are declarations by the registrar, and a valid
///         GTA does not prove the animals moved.
///
/// @dev Roles: `REGISTRAR_ROLE` and `ISSUER_ROLE` model the state animal-health agency (e.g. Adepará),
///      `REGULATOR_ROLE` models Ibama / prosecutors, `BUYER_ROLE` models meatpackers, exporters and
///      importers, `ORACLE_ROLE` is the off-chain signer. `multicall` batches calls; every inner call
///      still runs its own role check against the original sender (self-delegatecall), and no function
///      is payable, so batching cannot bypass any rule.
///
///      Emergency pause (`PAUSER_ROLE`) stops every registry, ledger, oracle and buyer transition.
///      Protective regulator actions (embargoes, revocations) and role administration keep working while
///      paused. Only `DEFAULT_ADMIN_ROLE` can unpause, so a compromised pauser can stop the ledger but not
///      resume it; the admin rotates compromised keys with `revokeRole` / `grantRole` (revoking an oracle
///      invalidates all of its unrelayed messages).
contract HerdLedger is IHerdLedger, AccessControlEnumerable, EIP712, Multicall, Pausable {
    // ---------------------------------------------------------------------------------------------
    // Roles and constants
    // ---------------------------------------------------------------------------------------------

    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant REGULATOR_ROLE = keccak256("REGULATOR_ROLE");
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant BUYER_ROLE = keccak256("BUYER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    bytes32 public constant RISK_ATTESTATION_TYPEHASH = keccak256(
        "RiskAttestation(bytes32 ranch,uint8 riskClass,uint16 scoreBps,bytes32 evidenceHash,uint64 asOf,uint256 nonce)"
    );
    bytes32 public constant CERTIFICATE_TYPEHASH = keccak256(
        "Certificate(bytes32 lotId,bytes32 sink,bytes32[] gtaHashes,bytes32 shipment,uint32 head,uint8 verdict,bytes32 evidenceHash,uint64 issuedAt,uint64 expiresAt,uint16 policyVersion,uint256 nonce)"
    );

    uint256 public constant BPS = 10_000;
    /// @notice Maximum yearly calving rate: births <= breeding cows × 85 %.
    uint256 public constant MAX_CALVING_RATE_BPS = 8500;
    /// @notice Carrying-capacity tolerance before `CapacityExceeded` is emitted (110 %).
    uint256 public constant CAPACITY_TOLERANCE_BPS = 11_000;
    /// @notice Upper bound on GTAs per certificate, keeping `issueCertificate` well inside a block.
    uint256 public constant MAX_GTAS_PER_CERTIFICATE = 256;
    /// @notice Tolerated clock difference between the oracle and the chain for a certificate's `issuedAt`.
    uint64 public constant MAX_CLOCK_SKEW = 15 minutes;
    /// @notice Longest validity a certificate may be signed for.
    uint64 public constant MAX_CERTIFICATE_VALIDITY = 5 * 365 days;

    uint8 public constant SINK_SLAUGHTERHOUSE = 1;
    uint8 public constant SINK_EXPORT_PORT = 2;

    uint8 public constant PURPOSE_BREEDING = 0;
    uint8 public constant PURPOSE_REARING = 1;
    uint8 public constant PURPOSE_FATTENING = 2;
    uint8 public constant PURPOSE_SLAUGHTER = 3;
    uint8 public constant PURPOSE_EXPORT = 4;

    uint8 public constant RISK_CLEAN = 0;
    uint8 public constant RISK_WATCH = 1;
    uint8 public constant RISK_HIGH = 2;

    uint8 public constant VERDICT_CLEAN = 0;
    uint8 public constant VERDICT_FLAGGED = 1;
    uint8 public constant VERDICT_UNKNOWN = 2;
    /// @notice Decision-layer REVIEW: recorded (its GTAs bound) but never consumable as clean.
    uint8 public constant VERDICT_REVIEW = 3;

    uint8 public constant USE_EXPORT_SHIPMENT = 0;
    uint8 public constant USE_EUDR_DDS = 1;
    uint8 public constant USE_RETAIL_CLAIM = 2;

    // ---------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------

    mapping(bytes32 id => EntityType) private _entityType;
    mapping(bytes32 id => Ranch) private _ranches;
    mapping(bytes32 id => Sink) private _sinks;
    mapping(bytes32 ranchId => mapping(uint16 year => uint32 births)) private _birthsInYear;
    mapping(bytes32 gtaHash => Gta) private _gtas;
    mapping(bytes32 lotId => CertificateRecord) private _certificates;
    mapping(bytes32 lotId => bytes32[] gtaHashes) private _certificateGtas;
    mapping(bytes32 ranchId => RiskRecord) private _risk;
    mapping(address signer => mapping(uint256 nonce => bool used)) private _nonceUsed;
    mapping(bytes32 evidenceHash => EvidenceRecord) private _evidence;
    Totals private _totals;
    uint16 private _minPolicyVersion = 1;

    /// @param admin Receives `DEFAULT_ADMIN_ROLE` (grants and revokes every other role) and `PAUSER_ROLE`.
    constructor(address admin) EIP712("Rastro HerdLedger", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ---------------------------------------------------------------------------------------------
    // Registry (state agency)
    // ---------------------------------------------------------------------------------------------

    /// @notice Register a ranch with its opening balance and biological / pasture limits.
    /// @dev Emits `CapacityExceeded` if the opening balance is already above capacity × 110 %.
    /// @param id Salted hash of the property code (no personal data on-chain).
    /// @param capacityHead Pasture carrying capacity in head.
    /// @param initialHead Opening herd balance.
    /// @param breedingCows Declared breeding females, which bound yearly births. The ledger cannot verify
    ///        this count; it only bounds births by what was declared.
    /// @param geomHash Hash of the property polygon kept off-chain.
    function registerRanch(
        bytes32 id,
        uint32 capacityHead,
        uint32 initialHead,
        uint32 breedingCows,
        bytes32 geomHash
    ) external onlyRole(REGISTRAR_ROLE) whenNotPaused {
        _register(id, EntityType.Ranch);

        Ranch storage r = _ranches[id];
        r.capacityHead = capacityHead;
        r.breedingCows = breedingCows;
        r.initialHead = initialHead;
        r.head = initialHead;
        r.geomHash = geomHash;

        _totals.ranches += 1;
        _totals.initialHead += initialHead;
        _totals.ranchHead += initialHead;

        emit RanchRegistered(id, capacityHead, initialHead, breedingCows, geomHash);
        _signalCapacity(id, r);
    }

    /// @notice Register a sink (slaughterhouse or live-export port). Sinks only receive animals: head that
    ///         enters a sink leaves the live herd for good and can never be sent on.
    /// @param id Salted hash of the establishment code (e.g. SIF number).
    /// @param kind 1 = slaughterhouse, 2 = export port.
    function registerSink(bytes32 id, uint8 kind) external onlyRole(REGISTRAR_ROLE) whenNotPaused {
        if (kind != SINK_SLAUGHTERHOUSE && kind != SINK_EXPORT_PORT) revert InvalidSinkKind(kind);
        _register(id, EntityType.Sink);
        _sinks[id].kind = kind;
        _totals.sinks += 1;
        emit SinkRegistered(id, kind);
    }

    /// @notice Record calves born on a ranch. Blocks "phantom births" used to legitimise laundered animals.
    /// @dev Reverts `BirthsExceedBiology` if cumulative births in `year` exceed breeding cows × 85 %. Whether a
    ///      birth physically happened is outside what the ledger can establish.
    function recordBirths(bytes32 ranchId, uint32 head, uint16 year)
        external
        onlyRole(REGISTRAR_ROLE)
        whenNotPaused
    {
        Ranch storage r = _requireRanch(ranchId);
        if (head == 0) revert ZeroHead();

        uint256 total = uint256(_birthsInYear[ranchId][year]) + head;
        uint256 max = (uint256(r.breedingCows) * MAX_CALVING_RATE_BPS) / BPS;
        if (total > max) revert BirthsExceedBiology(ranchId, year, total, max);

        // `total <= max <= type(uint32).max * 0.85`, so the narrowing cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 yearTotal = uint32(total);
        _birthsInYear[ranchId][year] = yearTotal;
        r.head += head;
        r.totalBirths += head;
        _totals.births += head;
        _totals.ranchHead += head;

        emit BirthsRecorded(ranchId, year, head, yearTotal, r.head);
        _signalCapacity(ranchId, r);
    }

    /// @notice Record deaths on a ranch. A ranch cannot report more deaths than animals it holds.
    function recordDeaths(bytes32 ranchId, uint32 head) external onlyRole(REGISTRAR_ROLE) whenNotPaused {
        Ranch storage r = _requireRanch(ranchId);
        if (head == 0) revert ZeroHead();
        if (r.head < head) revert InsufficientHerd(ranchId, r.head, head);

        unchecked {
            r.head -= head; // checked above
        }
        r.totalDeaths += head;
        _totals.deaths += head;
        _totals.ranchHead -= head;

        emit DeathsRecorded(ranchId, head, r.head);
    }

    // ---------------------------------------------------------------------------------------------
    // Movements (GTA commitments)
    // ---------------------------------------------------------------------------------------------

    /// @notice Commit a GTA and move `head` animals from a ranch to a ranch or sink.
    /// @dev Conservation is enforced here: the origin must hold `head` animals, must not be under an active
    ///      embargo, and each GTA hash can be committed once. Emits `CapacityExceeded` (no revert) when the
    ///      receiving ranch ends above capacity × 110 %.
    /// @param gtaHash Salted hash of the GTA number.
    /// @param from Origin ranch.
    /// @param to Destination ranch or sink.
    /// @param head Animals moved.
    /// @param purpose 0 breeding, 1 rearing, 2 fattening, 3 slaughter, 4 export.
    /// @param date GTA issue date (unix seconds, as written on the permit).
    function recordMovement(
        bytes32 gtaHash,
        bytes32 from,
        bytes32 to,
        uint32 head,
        uint8 purpose,
        uint64 date
    ) external onlyRole(ISSUER_ROLE) whenNotPaused {
        if (gtaHash == bytes32(0)) revert ZeroId();
        EntityType fromType = _entityType[from];
        EntityType toType = _entityType[to];
        if (fromType == EntityType.None) revert UnknownEntity(from);
        if (toType == EntityType.None) revert UnknownEntity(to);
        if (fromType != EntityType.Ranch) revert NotARanch(from);
        if (from == to) revert SameOriginAndDestination(from);
        if (_gtas[gtaHash].from != bytes32(0)) revert DuplicateGta(gtaHash);
        if (head == 0) revert ZeroHead();
        if (purpose > PURPOSE_EXPORT) revert InvalidPurpose(purpose);

        Ranch storage origin = _ranches[from];
        if (_embargoActive(origin)) revert OriginEmbargoed(from);
        if (origin.head < head) revert InsufficientHerd(from, origin.head, head);

        unchecked {
            origin.head -= head; // checked above
        }
        origin.totalOut += head;

        _gtas[gtaHash] = Gta({
            from: from,
            to: to,
            head: head,
            purpose: purpose,
            date: date,
            recordedAt: _now(),
            lotId: bytes32(0)
        });
        _totals.movements += 1;

        emit MovementRecorded(gtaHash, from, to, head, purpose, date);

        if (toType == EntityType.Ranch) {
            Ranch storage dest = _ranches[to];
            dest.head += head;
            dest.totalIn += head;
            _signalCapacity(to, dest);
        } else {
            // Animals entering a slaughterhouse or export port leave the live herd for good.
            Sink storage s = _sinks[to];
            s.receivedHead += head;
            s.movementsIn += 1;
            _totals.headToSinks += head;
            _totals.ranchHead -= head;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Regulator (stays available while paused: protective actions)
    // ---------------------------------------------------------------------------------------------

    /// @notice Place or lift an embargo. While active, no GTA may leave the ranch, so animals from an
    ///         embargoed area cannot be "washed" through an intermediary.
    /// @dev Re-asserting an active embargo updates the reason, keeps the original start time and makes it
    ///      open-ended. Lifting is also how an embargo entered in error is corrected: the reason hash points
    ///      to the correcting decision, and the full `EmbargoSet` history stays on-chain.
    function setEmbargo(bytes32 ranchId, bool on, bytes32 reasonHash) external onlyRole(REGULATOR_ROLE) {
        Ranch storage r = _requireRanch(ranchId);
        if (on) {
            if (!_embargoActive(r)) r.embargoedSince = _now();
        } else {
            r.embargoedSince = 0;
        }
        r.embargoed = on;
        r.embargoExpiresAt = 0;
        r.embargoReason = reasonHash;
        emit EmbargoSet(ranchId, on, reasonHash, msg.sender);
    }

    /// @notice Place (or re-time) an embargo that stops blocking at `expiresAt` without a further transaction.
    /// @dev An expired embargo is inactive: `isEmbargoed` returns false and movements pass again.
    function setEmbargoUntil(bytes32 ranchId, uint64 expiresAt, bytes32 reasonHash)
        external
        onlyRole(REGULATOR_ROLE)
    {
        Ranch storage r = _requireRanch(ranchId);
        if (expiresAt <= _now()) revert InvalidValidity(_now(), expiresAt);
        if (!_embargoActive(r)) r.embargoedSince = _now();
        r.embargoed = true;
        r.embargoExpiresAt = expiresAt;
        r.embargoReason = reasonHash;
        emit EmbargoSet(ranchId, true, reasonHash, msg.sender);
        emit EmbargoExpirySet(ranchId, expiresAt, msg.sender);
    }

    /// @notice Withdraw a certificate (e.g. new evidence of deforestation upstream). A revoked
    ///         certificate can no longer be consumed; its GTAs stay bound to it so they cannot be
    ///         re-packaged into a fresh "clean" lot.
    function revokeCertificate(bytes32 lotId, bytes32 reasonHash) external onlyRole(REGULATOR_ROLE) {
        CertificateRecord storage cert = _certificates[lotId];
        if (!cert.issued) revert UnknownCertificate(lotId);
        if (cert.revoked) revert CertificateRevoked(lotId);
        cert.revoked = true;
        cert.revokeReason = reasonHash;
        _totals.revoked += 1;
        emit CertificateRevocation(lotId, reasonHash, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Oracle (EIP-712, relayable by anyone)
    // ---------------------------------------------------------------------------------------------

    /// @notice Anchor a signed risk assessment of a ranch. Anyone may relay it.
    /// @dev The signer must hold `ORACLE_ROLE` at relay time; each (signer, nonce) is single-use; an
    ///      attestation older than the stored one is rejected so a stale "clean" cannot overwrite a newer
    ///      "high".
    function attestRisk(RiskAttestation calldata a, bytes calldata sig) external whenNotPaused {
        _requireRanch(a.ranch);
        if (a.riskClass > RISK_HIGH) revert InvalidRiskClass(a.riskClass);
        if (a.scoreBps > BPS) revert InvalidScore(a.scoreBps);
        RiskRecord storage cur = _risk[a.ranch];
        if (cur.oracle != address(0) && a.asOf < cur.asOf) {
            revert StaleAttestation(a.ranch, a.asOf, cur.asOf);
        }

        address oracle = _useSignature(_hashRiskAttestation(a), sig, a.nonce);

        cur.riskClass = a.riskClass;
        cur.scoreBps = a.scoreBps;
        cur.asOf = a.asOf;
        cur.oracle = oracle;
        cur.evidenceHash = a.evidenceHash;

        // The only external call above is the ecrecover precompile (a staticcall): no reentrancy.
        // forge-lint: disable-next-line(reentrancy-events)
        emit RiskAttested(a.ranch, a.riskClass, a.scoreBps, a.evidenceHash, a.asOf, oracle, a.nonce);
    }

    /// @notice Issue a signed lot certificate binding a shipment to the GTAs that fed it.
    /// @dev Every GTA must exist, must have been delivered to `c.sink`, and must not already back another
    ///      certificate (whole-GTA, single-use certification). The lot cannot claim more head than its GTAs
    ///      delivered. Flagged, unknown and review verdicts are recorded too: their GTAs are then burned for
    ///      any later "clean" certificate, so nobody can shop for a better verdict. The signed validity
    ///      window and policy version are checked.
    function issueCertificate(Certificate calldata c, bytes calldata sig) external whenNotPaused {
        if (c.lotId == bytes32(0) || c.shipment == bytes32(0)) revert ZeroId();
        if (_certificates[c.lotId].issued) revert CertificateAlreadyIssued(c.lotId);
        EntityType sinkType = _entityType[c.sink];
        if (sinkType == EntityType.None) revert UnknownEntity(c.sink);
        if (sinkType != EntityType.Sink) revert NotASink(c.sink);
        if (c.verdict > VERDICT_REVIEW) revert InvalidVerdict(c.verdict);
        uint256 n = c.gtaHashes.length;
        if (n == 0) revert EmptyCertificate(c.lotId);
        if (n > MAX_GTAS_PER_CERTIFICATE) revert TooManyGtas(n, MAX_GTAS_PER_CERTIFICATE);
        if (c.head == 0) revert ZeroHead();
        _checkTerms(c);

        address oracle = _useSignature(_hashCertificate(c), sig, c.nonce);

        uint256 gtaHead = _bindGtas(c.lotId, c.sink, c.gtaHashes);
        if (c.head > gtaHead) revert CertificateHeadExceedsGtas(c.lotId, c.head, gtaHead);

        _storeCertificate(c, oracle);
        _certificateGtas[c.lotId] = c.gtaHashes;
        _totals.certificates += 1;

        _emitIssued(c, oracle);
    }

    // ---------------------------------------------------------------------------------------------
    // Evidence registry
    // ---------------------------------------------------------------------------------------------

    /// @notice Anchor an evidence commitment (SHA-256 of a canonical off-chain bundle) once.
    /// @dev Called directly by an oracle key held in a trusted backend. Risk attestations and certificates
    ///      already carry their evidence hash; this registry is for bundles that are not attestations
    ///      (a decision report, a corrected trace).
    function anchorEvidence(bytes32 evidenceHash, bytes32 subject, bytes32 uriHash, uint16 schemaVersion)
        external
        onlyRole(ORACLE_ROLE)
        whenNotPaused
    {
        if (evidenceHash == bytes32(0) || subject == bytes32(0)) revert ZeroId();
        EvidenceRecord storage e = _evidence[evidenceHash];
        if (e.anchoredAt != 0) revert EvidenceAlreadyAnchored(evidenceHash);
        e.subject = subject;
        e.uriHash = uriHash;
        e.schemaVersion = schemaVersion;
        e.anchoredBy = msg.sender;
        e.anchoredAt = _now();
        emit EvidenceAnchored(evidenceHash, subject, uriHash, schemaVersion, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------------------------------

    /// @notice Retire certificates signed under older risk policies: they can no longer be issued.
    function setMinPolicyVersion(uint16 minPolicyVersion_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (minPolicyVersion_ == 0) revert PolicyVersionRetired(0, 1);
        _minPolicyVersion = minPolicyVersion_;
        emit MinPolicyVersionSet(minPolicyVersion_, msg.sender);
    }

    /// @notice Emergency stop of registry, ledger, oracle and buyer transitions.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resume after an emergency. Admin only, so a compromised pauser cannot resume.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------------------------------
    // Buyer
    // ---------------------------------------------------------------------------------------------

    /// @notice Use a clean certificate once: for one export shipment, one EUDR due-diligence statement or
    ///         one retail claim. A second buyer (or the same one) cannot reuse the same animals' paperwork.
    /// @param lotId Certificate to consume.
    /// @param use 0 export shipment, 1 EUDR DDS, 2 retail claim.
    /// @param refHash Commitment to the consuming shipment / DDS reference (non-zero); emitted in
    ///        `CertificateConsumed`.
    function consumeCertificate(bytes32 lotId, uint8 use, bytes32 refHash)
        external
        onlyRole(BUYER_ROLE)
        whenNotPaused
    {
        CertificateRecord storage cert = _certificates[lotId];
        if (!cert.issued) revert UnknownCertificate(lotId);
        if (use > USE_RETAIL_CLAIM) revert InvalidUse(use);
        if (refHash == bytes32(0)) revert ZeroId();
        if (cert.revoked) revert CertificateRevoked(lotId);
        if (cert.consumed) revert CertificateAlreadyUsed(lotId);
        if (cert.verdict != VERDICT_CLEAN) revert CertificateNotClean(lotId);
        if (_now() > cert.expiresAt) revert CertificateExpired(lotId, cert.expiresAt);

        cert.consumed = true;
        cert.use = use;
        cert.consumedBy = msg.sender;
        cert.consumedAt = _now();
        cert.consumeRef = refHash;
        _totals.consumed += 1;

        emit CertificateConsumed(lotId, use, refHash, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Live head on a ranch, or cumulative head received by a sink (0 for unknown ids).
    function balanceOf(bytes32 id) external view returns (uint256) {
        EntityType t = _entityType[id];
        if (t == EntityType.Ranch) return _ranches[id].head;
        if (t == EntityType.Sink) return _sinks[id].receivedHead;
        return 0;
    }

    function entityType(bytes32 id) external view returns (EntityType) {
        return _entityType[id];
    }

    function ranch(bytes32 id) external view returns (Ranch memory) {
        return _ranches[id];
    }

    function sink(bytes32 id) external view returns (Sink memory) {
        return _sinks[id];
    }

    function gta(bytes32 gtaHash) external view returns (Gta memory) {
        return _gtas[gtaHash];
    }

    function certificate(bytes32 lotId) external view returns (CertificateRecord memory) {
        return _certificates[lotId];
    }

    function certificateGtas(bytes32 lotId) external view returns (bytes32[] memory) {
        return _certificateGtas[lotId];
    }

    /// @notice One-call answer to "can this lot still be claimed?" for buyers and auditors.
    function certificateStatus(bytes32 lotId) external view returns (CertificateStatus) {
        CertificateRecord storage cert = _certificates[lotId];
        if (!cert.issued) return CertificateStatus.None;
        if (cert.revoked) return CertificateStatus.Revoked;
        if (cert.consumed) return CertificateStatus.Consumed;
        if (cert.verdict != VERDICT_CLEAN) return CertificateStatus.NotClean;
        if (_now() > cert.expiresAt) return CertificateStatus.Expired;
        return CertificateStatus.Valid;
    }

    function riskOf(bytes32 ranchId) external view returns (RiskRecord memory) {
        return _risk[ranchId];
    }

    function birthsInYear(bytes32 ranchId, uint16 year) external view returns (uint32) {
        return _birthsInYear[ranchId][year];
    }

    /// @notice Whether the ranch's embargo blocks movements right now (time-limited embargoes expire).
    function isEmbargoed(bytes32 ranchId) external view returns (bool) {
        return _embargoActive(_ranches[ranchId]);
    }

    function evidence(bytes32 evidenceHash) external view returns (EvidenceRecord memory) {
        return _evidence[evidenceHash];
    }

    /// @notice Oracle registry: whether `signer` may sign attestations and certificates now.
    function isOracle(address signer) external view returns (bool) {
        return hasRole(ORACLE_ROLE, signer);
    }

    /// @notice Every currently authorised oracle signer.
    function oracles() external view returns (address[] memory) {
        return getRoleMembers(ORACLE_ROLE);
    }

    function minPolicyVersion() external view returns (uint16) {
        return _minPolicyVersion;
    }

    function isNonceUsed(address signer, uint256 nonce) external view returns (bool) {
        return _nonceUsed[signer][nonce];
    }

    function totals() external view returns (Totals memory) {
        return _totals;
    }

    /// @notice Σ ranch balances == Σ initial + Σ births − Σ deaths − Σ head delivered to sinks.
    /// @dev Written without subtraction so a broken ledger returns false instead of reverting.
    function isConserved() external view returns (bool) {
        Totals storage t = _totals;
        return uint256(t.initialHead) + t.births == uint256(t.ranchHead) + t.deaths + t.headToSinks;
    }

    /// @notice EIP-712 digest the oracle signs for a risk attestation.
    function hashRiskAttestation(RiskAttestation calldata a) external view returns (bytes32) {
        return _hashRiskAttestation(a);
    }

    /// @notice EIP-712 digest the oracle signs for a certificate.
    function hashCertificate(Certificate calldata c) external view returns (bytes32) {
        return _hashCertificate(c);
    }

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _register(bytes32 id, EntityType t) private {
        if (id == bytes32(0)) revert ZeroId();
        if (_entityType[id] != EntityType.None) revert EntityAlreadyRegistered(id);
        _entityType[id] = t;
    }

    function _requireRanch(bytes32 id) private view returns (Ranch storage) {
        EntityType t = _entityType[id];
        if (t == EntityType.None) revert UnknownEntity(id);
        if (t != EntityType.Ranch) revert NotARanch(id);
        return _ranches[id];
    }

    function _now() private view returns (uint64) {
        // Unix seconds fit in uint64 for the next ~5.8e11 years.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(block.timestamp);
    }

    function _embargoActive(Ranch storage r) private view returns (bool) {
        return r.embargoed && (r.embargoExpiresAt == 0 || _now() < r.embargoExpiresAt);
    }

    /// @dev Validity window and policy version of a certificate's signed terms.
    function _checkTerms(Certificate calldata c) private view {
        uint64 nowTs = _now();
        if (
            c.issuedAt > nowTs + MAX_CLOCK_SKEW || c.expiresAt <= c.issuedAt || c.expiresAt <= nowTs
                || c.expiresAt - c.issuedAt > MAX_CERTIFICATE_VALIDITY
        ) revert InvalidValidity(c.issuedAt, c.expiresAt);
        if (c.policyVersion < _minPolicyVersion) revert PolicyVersionRetired(c.policyVersion, _minPolicyVersion);
    }

    function _storeCertificate(Certificate calldata c, address oracle) private {
        CertificateRecord storage cert = _certificates[c.lotId];
        cert.sink = c.sink;
        cert.evidenceHash = c.evidenceHash;
        cert.oracle = oracle;
        cert.head = c.head;
        cert.verdict = c.verdict;
        cert.issued = true;
        cert.issuedAt = c.issuedAt;
        cert.shipment = c.shipment;
        cert.expiresAt = c.expiresAt;
        cert.recordedAt = _now();
        cert.policyVersion = c.policyVersion;
    }

    /// @dev Emits the soft over-capacity signal when head > capacity × 110 %.
    function _signalCapacity(bytes32 id, Ranch storage r) private {
        if (uint256(r.head) * BPS > uint256(r.capacityHead) * CAPACITY_TOLERANCE_BPS) {
            emit CapacityExceeded(id, r.head, r.capacityHead);
        }
    }

    /// @dev Recovers the EIP-712 signer, requires `ORACLE_ROLE`, and burns the (signer, nonce) pair.
    function _useSignature(bytes32 digest, bytes calldata sig, uint256 nonce)
        private
        returns (address signer)
    {
        ECDSA.RecoverError err;
        (signer, err,) = ECDSA.tryRecoverCalldata(digest, sig);
        if (err != ECDSA.RecoverError.NoError || !hasRole(ORACLE_ROLE, signer)) revert InvalidSigner(signer);
        if (_nonceUsed[signer][nonce]) revert NonceAlreadyUsed(signer, nonce);
        _nonceUsed[signer][nonce] = true;
    }

    /// @dev Binds each GTA to `lotId` after checking it exists, was delivered to `sinkId` and is not
    ///      already certified (which also rejects a GTA listed twice). Returns the GTAs' total head.
    function _bindGtas(bytes32 lotId, bytes32 sinkId, bytes32[] calldata gtaHashes)
        private
        returns (uint256 gtaHead)
    {
        for (uint256 i = 0; i < gtaHashes.length; ++i) {
            bytes32 h = gtaHashes[i];
            Gta storage g = _gtas[h];
            // Reverting inside the loop is intended: one bad GTA invalidates the whole certificate.
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (g.from == bytes32(0)) revert UnknownGta(h);
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (g.to != sinkId) revert GtaDestinationMismatch(h, g.to, sinkId);
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (g.lotId != bytes32(0)) revert GtaAlreadyCertified(h, g.lotId);
            g.lotId = lotId;
            gtaHead += g.head;
        }
    }

    function _emitIssued(Certificate calldata c, address oracle) private {
        // Only external call before this is the ecrecover precompile (a staticcall): no reentrancy.
        // forge-lint: disable-start(reentrancy-events)
        emit CertificateIssued(
            c.lotId, c.sink, c.head, c.verdict, c.evidenceHash, c.gtaHashes, oracle, c.nonce
        );
        emit CertificateTerms(c.lotId, c.shipment, c.issuedAt, c.expiresAt, c.policyVersion);
        // forge-lint: disable-end(reentrancy-events)
    }

    function _hashRiskAttestation(RiskAttestation calldata a) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RISK_ATTESTATION_TYPEHASH,
                    a.ranch,
                    a.riskClass,
                    a.scoreBps,
                    a.evidenceHash,
                    a.asOf,
                    a.nonce
                )
            )
        );
    }

    function _hashCertificate(Certificate calldata c) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CERTIFICATE_TYPEHASH,
                    c.lotId,
                    c.sink,
                    keccak256(abi.encodePacked(c.gtaHashes)),
                    c.shipment,
                    c.head,
                    c.verdict,
                    c.evidenceHash,
                    c.issuedAt,
                    c.expiresAt,
                    c.policyVersion,
                    c.nonce
                )
            )
        );
    }
}
