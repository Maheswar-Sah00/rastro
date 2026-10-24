// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IHerdLedger
/// @notice Types, errors, events and external surface of the Rastro herd ledger.
/// @dev Entity ids are opaque salted commitments, `bytes32 = SHA-256(salt ‖ official code)` in the Rastro
///      pipeline. Salts stay with the registrar, so no personal data (CPF/CNPJ/CAR codes) ever reaches the
///      chain and a guessable code cannot be confirmed by hashing candidates.
///
///      The ledger enforces the validity of submitted state transitions under its rules. It cannot
///      establish physical facts nobody verified: the true number of breeding cows, whether a declared
///      birth happened, or whether animals on a valid GTA really moved.
interface IHerdLedger {
    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    /// @notice What a registered id refers to.
    enum EntityType {
        None,
        Ranch,
        Sink
    }

    /// @notice Lifecycle of a lot certificate as seen by a buyer.
    enum CertificateStatus {
        None, // never issued
        Valid, // issued, clean, not consumed, not revoked: a buyer may consume it
        Consumed, // already used once (export shipment / EUDR DDS / retail claim)
        Revoked, // withdrawn by a regulator
        NotClean, // verdict is flagged, unknown or review: can never be consumed
        Expired // past its signed expiry: can no longer be consumed
    }

    /// @notice A ranch (property holding live animals). Balances are conserved.
    struct Ranch {
        uint32 capacityHead; // pasture carrying capacity in head (~1.5 head/ha of cleared pasture)
        uint32 breedingCows; // declared breeding females; bounds yearly births
        uint32 initialHead; // head declared at registration (opening balance)
        uint32 head; // current balance
        uint64 embargoedSince; // block timestamp the active embargo started (0 when not embargoed)
        bool embargoed; // Ibama / court embargo: no animal may leave while set
        uint64 totalIn; // cumulative head received from other ranches
        uint64 totalOut; // cumulative head sent (to ranches or sinks)
        uint64 totalBirths; // cumulative recorded births
        uint64 totalDeaths; // cumulative recorded deaths
        bytes32 geomHash; // hash of the property polygon (CAR geometry) kept off-chain
        bytes32 embargoReason; // hash of the latest embargo / lift decision document
        uint64 embargoExpiresAt; // 0 = until lifted; otherwise the embargo stops blocking at this time
    }

    /// @notice A slaughterhouse or live-export port. Animals that enter a sink leave the system.
    struct Sink {
        uint8 kind; // 1 = slaughterhouse, 2 = export port
        uint64 receivedHead; // cumulative head received
        uint64 movementsIn; // number of GTAs received
    }

    /// @notice On-chain commitment to one GTA (Guia de Trânsito Animal, animal transit permit).
    struct Gta {
        bytes32 from; // origin ranch id (never zero for a recorded GTA)
        bytes32 to; // destination ranch or sink id
        uint32 head;
        uint8 purpose; // 0 breeding, 1 rearing, 2 fattening, 3 slaughter, 4 export
        uint64 date; // GTA issue date (unix seconds, as written on the permit)
        uint64 recordedAt; // block timestamp of the on-chain commitment
        bytes32 lotId; // certificate this GTA backs (0 while uncertified)
    }

    /// @notice Oracle (Rastro AI) risk assessment of a ranch. EIP-712 signed, relayable by anyone.
    struct RiskAttestation {
        bytes32 ranch;
        uint8 riskClass; // 0 clean, 1 watch, 2 high
        uint16 scoreBps; // model score in basis points (0..10000)
        bytes32 evidenceHash; // hash of the off-chain evidence bundle (features, flags, model version)
        uint64 asOf; // assessment date (unix seconds)
        uint256 nonce; // unordered, single-use per oracle signer
    }

    /// @notice Oracle-signed lot certificate binding a shipment to the exact GTAs that fed it.
    /// @dev Chain id and verifying contract are bound by the EIP-712 domain. Certification is whole-GTA
    ///      and single-use: a GTA backs at most one certificate, whatever its verdict.
    struct Certificate {
        bytes32 lotId; // certificate id
        bytes32 sink; // slaughterhouse / port that received the GTAs
        bytes32[] gtaHashes; // GTAs into `sink` that make up the lot (the lot commitment)
        bytes32 shipment; // salted commitment to the shipment / delivery the lot belongs to
        uint32 head; // head in the lot (<= sum of the GTAs' head)
        uint8 verdict; // 0 clean (PASS), 1 flagged (FLAGGED), 2 unknown, 3 review (REVIEW)
        bytes32 evidenceHash; // SHA-256 of the canonical evidence bundle (decision, findings, lineage)
        uint64 issuedAt; // oracle issuance time (unix seconds)
        uint64 expiresAt; // after this the certificate cannot be consumed
        uint16 policyVersion; // risk-policy / schema version the decision was made under
        uint256 nonce; // unordered, single-use per oracle signer
    }

    /// @notice Stored state of an issued certificate (GTA list available via `certificateGtas`).
    struct CertificateRecord {
        bytes32 sink;
        bytes32 evidenceHash;
        address oracle; // signer that issued it
        uint32 head;
        uint8 verdict;
        bool issued;
        bool consumed;
        bool revoked;
        uint8 use; // 0 export shipment, 1 EUDR due-diligence statement, 2 retail claim (valid once consumed)
        address consumedBy;
        uint64 issuedAt;
        uint64 consumedAt;
        bytes32 consumeRef; // commitment to the consuming shipment / DDS reference
        bytes32 revokeReason;
        bytes32 shipment; // shipment commitment signed into the certificate
        uint64 expiresAt; // signed expiry
        uint64 recordedAt; // block timestamp of issuance on-chain (`issuedAt` is the signed time)
        uint16 policyVersion;
    }

    /// @notice An anchored evidence commitment (SHA-256 of a canonical off-chain bundle).
    struct EvidenceRecord {
        bytes32 subject; // what it is about: ranch id, lot id or shipment commitment
        bytes32 uriHash; // hash of where the bundle is published (URL / content id); 0 if not public
        uint16 schemaVersion; // evidence schema version
        address anchoredBy;
        uint64 anchoredAt;
    }

    /// @notice Latest risk attestation stored per ranch.
    struct RiskRecord {
        uint8 riskClass;
        uint16 scoreBps;
        uint64 asOf;
        address oracle; // zero when the ranch was never attested
        bytes32 evidenceHash;
    }

    /// @notice Ledger-wide counters. `isConserved()` checks the conservation identity on these.
    struct Totals {
        uint64 ranches;
        uint64 sinks;
        uint64 movements;
        uint64 certificates;
        uint64 consumed;
        uint64 revoked;
        uint64 initialHead;
        uint64 births;
        uint64 deaths;
        uint64 headToSinks;
        uint64 ranchHead; // sum of all ranch balances
    }

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    error ZeroId();
    error ZeroHead();
    error EntityAlreadyRegistered(bytes32 id);
    error UnknownEntity(bytes32 id);
    error NotARanch(bytes32 id);
    error NotASink(bytes32 id);
    error InvalidSinkKind(uint8 kind);
    error BirthsExceedBiology(bytes32 ranch, uint16 year, uint256 total, uint256 max);
    error InsufficientHerd(bytes32 ranch, uint256 have, uint256 need);
    error DuplicateGta(bytes32 gtaHash);
    error SameOriginAndDestination(bytes32 id);
    error InvalidPurpose(uint8 purpose);
    error OriginEmbargoed(bytes32 ranch);
    error InvalidRiskClass(uint8 riskClass);
    error InvalidScore(uint16 scoreBps);
    error StaleAttestation(bytes32 ranch, uint64 asOf, uint64 latestAsOf);
    error InvalidSigner(address signer);
    error NonceAlreadyUsed(address signer, uint256 nonce);
    error CertificateAlreadyIssued(bytes32 lotId);
    error EmptyCertificate(bytes32 lotId);
    error TooManyGtas(uint256 count, uint256 max);
    error InvalidVerdict(uint8 verdict);
    error UnknownGta(bytes32 gtaHash);
    error GtaDestinationMismatch(bytes32 gtaHash, bytes32 to, bytes32 sink);
    error GtaAlreadyCertified(bytes32 gtaHash, bytes32 lotId);
    error CertificateHeadExceedsGtas(bytes32 lotId, uint256 head, uint256 gtaHead);
    error UnknownCertificate(bytes32 lotId);
    error InvalidUse(uint8 use);
    error CertificateAlreadyUsed(bytes32 lotId);
    error CertificateNotClean(bytes32 lotId);
    error CertificateRevoked(bytes32 lotId);
    error CertificateExpired(bytes32 lotId, uint64 expiresAt);
    error InvalidValidity(uint64 issuedAt, uint64 expiresAt);
    error PolicyVersionRetired(uint16 policyVersion, uint16 minPolicyVersion);
    error EvidenceAlreadyAnchored(bytes32 evidenceHash);

    // ---------------------------------------------------------------------------------------------
    // Events (one per state change; the web app reads these)
    // ---------------------------------------------------------------------------------------------

    event RanchRegistered(
        bytes32 indexed ranch, uint32 capacityHead, uint32 initialHead, uint32 breedingCows, bytes32 geomHash
    );
    event SinkRegistered(bytes32 indexed sink, uint8 kind);
    event BirthsRecorded(
        bytes32 indexed ranch, uint16 indexed year, uint32 head, uint32 yearTotal, uint32 balance
    );
    event DeathsRecorded(bytes32 indexed ranch, uint32 head, uint32 balance);
    event MovementRecorded(
        bytes32 indexed gtaHash,
        bytes32 indexed from,
        bytes32 indexed to,
        uint32 head,
        uint8 purpose,
        uint64 date
    );
    /// @notice Soft signal (not a revert): a ranch now holds more than capacity × 110 %.
    event CapacityExceeded(bytes32 indexed ranch, uint32 head, uint32 capacity);
    event EmbargoSet(bytes32 indexed ranch, bool on, bytes32 reasonHash, address indexed regulator);
    /// @notice A time-limited embargo: it stops blocking at `expiresAt` without a further transaction.
    event EmbargoExpirySet(bytes32 indexed ranch, uint64 expiresAt, address indexed regulator);
    event EvidenceAnchored(
        bytes32 indexed evidenceHash, bytes32 indexed subject, bytes32 uriHash, uint16 schemaVersion, address indexed by
    );
    event MinPolicyVersionSet(uint16 minPolicyVersion, address indexed admin);
    event RiskAttested(
        bytes32 indexed ranch,
        uint8 riskClass,
        uint16 scoreBps,
        bytes32 evidenceHash,
        uint64 asOf,
        address indexed oracle,
        uint256 nonce
    );
    event CertificateIssued(
        bytes32 indexed lotId,
        bytes32 indexed sink,
        uint32 head,
        uint8 verdict,
        bytes32 evidenceHash,
        bytes32[] gtaHashes,
        address indexed oracle,
        uint256 nonce
    );
    /// @notice Signed terms of a certificate, emitted next to `CertificateIssued`.
    event CertificateTerms(
        bytes32 indexed lotId, bytes32 indexed shipment, uint64 issuedAt, uint64 expiresAt, uint16 policyVersion
    );
    /// @notice `refHash` is the commitment of the consuming shipment / DDS.
    event CertificateConsumed(bytes32 indexed lotId, uint8 use, bytes32 refHash, address indexed buyer);
    /// @dev Named `CertificateRevocation` because `CertificateRevoked` is the (binding) revert name.
    event CertificateRevocation(bytes32 indexed lotId, bytes32 reasonHash, address indexed regulator);

    // ---------------------------------------------------------------------------------------------
    // Mutating functions
    // ---------------------------------------------------------------------------------------------

    function registerRanch(
        bytes32 id,
        uint32 capacityHead,
        uint32 initialHead,
        uint32 breedingCows,
        bytes32 geomHash
    ) external;

    function registerSink(bytes32 id, uint8 kind) external;

    function recordBirths(bytes32 ranchId, uint32 head, uint16 year) external;

    function recordDeaths(bytes32 ranchId, uint32 head) external;

    function recordMovement(
        bytes32 gtaHash,
        bytes32 from,
        bytes32 to,
        uint32 head,
        uint8 purpose,
        uint64 date
    ) external;

    function setEmbargo(bytes32 ranchId, bool on, bytes32 reasonHash) external;

    function setEmbargoUntil(bytes32 ranchId, uint64 expiresAt, bytes32 reasonHash) external;

    function anchorEvidence(bytes32 evidenceHash, bytes32 subject, bytes32 uriHash, uint16 schemaVersion) external;

    function setMinPolicyVersion(uint16 minPolicyVersion) external;

    function pause() external;

    function unpause() external;

    function attestRisk(RiskAttestation calldata a, bytes calldata sig) external;

    function issueCertificate(Certificate calldata c, bytes calldata sig) external;

    function consumeCertificate(bytes32 lotId, uint8 use, bytes32 refHash) external;

    function revokeCertificate(bytes32 lotId, bytes32 reasonHash) external;

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function balanceOf(bytes32 id) external view returns (uint256);
    function entityType(bytes32 id) external view returns (EntityType);
    function ranch(bytes32 id) external view returns (Ranch memory);
    function sink(bytes32 id) external view returns (Sink memory);
    function gta(bytes32 gtaHash) external view returns (Gta memory);
    function certificate(bytes32 lotId) external view returns (CertificateRecord memory);
    function certificateGtas(bytes32 lotId) external view returns (bytes32[] memory);
    function certificateStatus(bytes32 lotId) external view returns (CertificateStatus);
    function riskOf(bytes32 ranchId) external view returns (RiskRecord memory);
    function birthsInYear(bytes32 ranchId, uint16 year) external view returns (uint32);
    function isEmbargoed(bytes32 ranchId) external view returns (bool);
    function evidence(bytes32 evidenceHash) external view returns (EvidenceRecord memory);
    function isOracle(address signer) external view returns (bool);
    function oracles() external view returns (address[] memory);
    function minPolicyVersion() external view returns (uint16);
    function isNonceUsed(address signer, uint256 nonce) external view returns (bool);
    function totals() external view returns (Totals memory);
    function isConserved() external view returns (bool);
    function hashRiskAttestation(RiskAttestation calldata a) external view returns (bytes32);
    function hashCertificate(Certificate calldata c) external view returns (bytes32);
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
