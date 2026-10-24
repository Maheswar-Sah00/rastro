// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {HerdLedger} from "../../src/HerdLedger.sol";
import {IHerdLedger} from "../../src/IHerdLedger.sol";

/// @notice Stateful fuzzing handler. Each action plays one actor in the cattle supply chain:
///         honest actions are bounded so they must succeed (the suite runs with
///         `fail_on_revert = true`, so a rejected honest action fails the run), while "attack"
///         actions try to break a rule and record a breach if the ledger ever lets them through.
///         Ghost variables keep an independent model of the herd that the invariants compare
///         against the contract's own state.
contract LedgerHandler is CommonBase, StdCheats, StdUtils {
    HerdLedger public immutable ledger;
    address internal immutable registrar;
    address internal immutable issuer;
    address internal immutable regulator;
    address internal immutable buyer;
    uint256 internal immutable oraclePk;
    uint256 internal immutable roguePk;

    uint256 internal constant MAX_RANCHES = 16;
    uint256 internal constant MAX_SINKS = 4;
    uint16[3] internal YEARS = [uint16(2023), 2024, 2025];

    // ---- registry known to the handler
    bytes32[] public ranches;
    bytes32[] public sinks;
    bytes32[] public gtas;
    bytes32[] public lots;
    mapping(bytes32 sinkId => bytes32[]) internal openGtas; // delivered to the sink, not yet certified
    bytes32[] internal birthKeys; // keccak(ranch, year) touched by births
    mapping(bytes32 key => bytes32) public birthKeyRanch;
    mapping(bytes32 key => uint16) public birthKeyYear;

    // ---- ghost model
    uint256 public ghostInitial;
    uint256 public ghostBirths;
    uint256 public ghostDeaths;
    uint256 public ghostToSinks;
    mapping(bytes32 ranchId => int256) public ghostBalance;
    mapping(bytes32 lotId => uint256) public consumeSuccesses;
    mapping(bytes32 gtaHash => uint256) public gtaCertifications;
    mapping(bytes32 ranchId => uint64) public outAtEmbargo;
    mapping(bytes32 ranchId => bool) public ghostEmbargoed;

    // ---- breaches (must stay zero)
    uint256 public overdraftBreaches; // movement / death above balance accepted
    uint256 public embargoBreaches; // movement out of an embargoed ranch accepted
    uint256 public doubleCertificationBreaches; // GTA accepted into a second certificate
    uint256 public badConsumeBreaches; // flagged / unknown / revoked / used certificate consumed
    uint256 public signatureBreaches; // replayed or forged oracle message accepted
    uint256 public biologyBreaches; // births above breeding cows × 85 % accepted
    uint256 public unexpectedReverts; // an attack reverted with the wrong error

    // ---- call counters (printed after each run)
    mapping(bytes32 action => uint256) public calls;

    uint256 internal nonce = 1;
    bytes internal lastRiskSig;
    IHerdLedger.RiskAttestation internal lastRisk;
    bool internal haveLastRisk;

    constructor(
        HerdLedger ledger_,
        address registrar_,
        address issuer_,
        address regulator_,
        address buyer_,
        uint256 oraclePk_,
        uint256 roguePk_
    ) {
        ledger = ledger_;
        registrar = registrar_;
        issuer = issuer_;
        regulator = regulator_;
        buyer = buyer_;
        oraclePk = oraclePk_;
        roguePk = roguePk_;

        // Seed world so that early calls already interact.
        registerRanch(1, 1000, 800, 300);
        registerRanch(2, 200, 0, 0);
        registerRanch(3, 3000, 1500, 40);
        registerSink(1, false);
        registerSink(2, true);
    }

    // =============================================================================================
    // Honest actions (must succeed)
    // =============================================================================================

    function registerRanch(uint256 seed, uint32 cap, uint32 init, uint32 cows) public {
        if (ranches.length >= MAX_RANCHES) return;
        bytes32 id = keccak256(abi.encode("ranch", seed, ranches.length));
        if (ledger.entityType(id) != IHerdLedger.EntityType.None) return;
        cap = uint32(bound(cap, 0, 100_000));
        init = uint32(bound(init, 0, 100_000));
        cows = uint32(bound(cows, 0, 50_000));

        vm.prank(registrar);
        ledger.registerRanch(id, cap, init, cows, keccak256(abi.encode("geom", id)));

        ranches.push(id);
        ghostInitial += init;
        ghostBalance[id] = int256(uint256(init));
        calls["registerRanch"]++;
    }

    function registerSink(uint256 seed, bool port) public {
        if (sinks.length >= MAX_SINKS) return;
        bytes32 id = keccak256(abi.encode("sink", seed, sinks.length));
        if (ledger.entityType(id) != IHerdLedger.EntityType.None) return;
        vm.prank(registrar);
        ledger.registerSink(id, port ? 2 : 1);
        sinks.push(id);
        calls["registerSink"]++;
    }

    function recordBirths(uint256 ranchSeed, uint32 head, uint256 yearSeed) public {
        bytes32 r = _ranch(ranchSeed);
        uint16 year = YEARS[yearSeed % YEARS.length];
        uint256 max = (uint256(ledger.ranch(r).breedingCows) * 8500) / 10_000;
        uint256 used = ledger.birthsInYear(r, year);
        if (used >= max) return;
        head = uint32(bound(head, 1, max - used));

        vm.prank(registrar);
        ledger.recordBirths(r, head, year);

        ghostBirths += head;
        ghostBalance[r] += int256(uint256(head));
        bytes32 key = keccak256(abi.encode(r, year));
        if (birthKeyRanch[key] == bytes32(0)) {
            birthKeyRanch[key] = r;
            birthKeyYear[key] = year;
            birthKeys.push(key);
        }
        calls["recordBirths"]++;
    }

    function recordDeaths(uint256 ranchSeed, uint32 head) public {
        bytes32 r = _ranch(ranchSeed);
        uint256 bal = ledger.balanceOf(r);
        if (bal == 0) return;
        head = uint32(bound(head, 1, bal));

        vm.prank(registrar);
        ledger.recordDeaths(r, head);

        ghostDeaths += head;
        ghostBalance[r] -= int256(uint256(head));
        calls["recordDeaths"]++;
    }

    function recordMovement(uint256 fromSeed, uint256 toSeed, bool toSink, uint32 head, uint8 purpose)
        public
    {
        bytes32 from = _ranch(fromSeed);
        if (ghostEmbargoed[from]) return; // covered by attackEmbargoedOrigin
        uint256 bal = ledger.balanceOf(from);
        if (bal == 0) return;
        head = uint32(bound(head, 1, bal));
        purpose = uint8(bound(purpose, 0, 4));

        bytes32 to;
        if (toSink || ranches.length < 2) {
            to = sinks[toSeed % sinks.length];
        } else {
            to = ranches[toSeed % ranches.length];
            if (to == from) to = ranches[(toSeed % ranches.length + 1) % ranches.length];
        }

        bytes32 g = keccak256(abi.encode("gta", gtas.length, fromSeed));
        vm.prank(issuer);
        ledger.recordMovement(g, from, to, head, purpose, uint64(block.timestamp));

        gtas.push(g);
        ghostBalance[from] -= int256(uint256(head));
        if (ledger.entityType(to) == IHerdLedger.EntityType.Sink) {
            ghostToSinks += head;
            openGtas[to].push(g);
        } else {
            ghostBalance[to] += int256(uint256(head));
        }
        calls["recordMovement"]++;
    }

    function setEmbargo(uint256 ranchSeed, bool on) public {
        bytes32 r = _ranch(ranchSeed);
        vm.prank(regulator);
        ledger.setEmbargo(r, on, keccak256(abi.encode("reason", block.timestamp)));
        if (on && !ghostEmbargoed[r]) outAtEmbargo[r] = ledger.ranch(r).totalOut;
        ghostEmbargoed[r] = on;
        calls[on ? bytes32("embargoOn") : bytes32("embargoOff")]++;
    }

    function attestRisk(uint256 ranchSeed, uint8 riskClass, uint16 scoreBps, uint32 asOfStep) public {
        bytes32 r = _ranch(ranchSeed);
        uint64 asOf = ledger.riskOf(r).asOf + uint64(bound(asOfStep, 0, 400 days));
        IHerdLedger.RiskAttestation memory a = IHerdLedger.RiskAttestation({
            ranch: r,
            riskClass: uint8(bound(riskClass, 0, 2)),
            scoreBps: uint16(bound(scoreBps, 0, 10_000)),
            evidenceHash: keccak256(abi.encode("evidence", nonce)),
            asOf: asOf,
            nonce: nonce++
        });
        bytes memory sig = _sign(oraclePk, ledger.hashRiskAttestation(a));

        ledger.attestRisk(a, sig); // relayed by the handler: anyone may relay

        lastRisk = a;
        lastRiskSig = sig;
        haveLastRisk = true;
        calls["attestRisk"]++;
    }

    function issueCertificate(uint256 sinkSeed, uint8 count, uint8 verdict, uint32 headSeed) public {
        bytes32 s = sinks[sinkSeed % sinks.length];
        bytes32[] storage open = openGtas[s];
        if (open.length == 0) return;
        count = uint8(bound(count, 1, open.length < 8 ? open.length : 8));

        bytes32[] memory picked = new bytes32[](count);
        uint256 sum;
        for (uint256 i = 0; i < count; ++i) {
            picked[i] = open[open.length - 1];
            open.pop();
            sum += ledger.gta(picked[i]).head;
        }
        bytes32 lotId = keccak256(abi.encode("lot", lots.length, sinkSeed));
        IHerdLedger.Certificate memory c = IHerdLedger.Certificate({
            lotId: lotId,
            sink: s,
            gtaHashes: picked,
            shipment: keccak256(abi.encode("shipment", lotId)),
            head: uint32(bound(headSeed, 1, sum)),
            verdict: uint8(bound(verdict, 0, 3)),
            evidenceHash: keccak256(abi.encode("trace", lotId)),
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp) + 365 days,
            policyVersion: 1,
            nonce: nonce++
        });
        ledger.issueCertificate(c, _sign(oraclePk, ledger.hashCertificate(c)));

        lots.push(lotId);
        for (uint256 i = 0; i < count; ++i) {
            gtaCertifications[picked[i]]++;
        }
        calls["issueCertificate"]++;
    }

    /// @dev Buyers try to consume any lot; only a clean, unrevoked, unused lot may succeed.
    function consumeCertificate(uint256 lotSeed, uint8 use) public {
        if (lots.length == 0) return;
        bytes32 lotId = lots[lotSeed % lots.length];
        IHerdLedger.CertificateRecord memory before = ledger.certificate(lotId);
        bool allowed =
            before.verdict == 0 && !before.revoked && !before.consumed && block.timestamp <= before.expiresAt;

        vm.prank(buyer);
        try ledger.consumeCertificate(lotId, uint8(bound(use, 0, 2)), keccak256(abi.encode("ref", lotSeed))) {
            consumeSuccesses[lotId]++;
            if (!allowed) badConsumeBreaches++;
            calls["consumeOk"]++;
        } catch (bytes memory reason) {
            bytes4 sel = bytes4(reason);
            if (allowed) unexpectedReverts++;
            if (
                sel != IHerdLedger.CertificateAlreadyUsed.selector
                    && sel != IHerdLedger.CertificateNotClean.selector
                    && sel != IHerdLedger.CertificateRevoked.selector
                    && sel != IHerdLedger.CertificateExpired.selector
            ) unexpectedReverts++;
            calls["consumeRejected"]++;
        }
    }

    function revokeCertificate(uint256 lotSeed) public {
        if (lots.length == 0) return;
        bytes32 lotId = lots[lotSeed % lots.length];
        if (ledger.certificate(lotId).revoked) return;
        vm.prank(regulator);
        ledger.revokeCertificate(lotId, keccak256(abi.encode("revoke", lotSeed)));
        calls["revokeCertificate"]++;
    }

    function warp(uint32 secondsForward) public {
        vm.warp(block.timestamp + bound(secondsForward, 1, 30 days));
        calls["warp"]++;
    }

    // =============================================================================================
    // Attacks (must be rejected with the right error)
    // =============================================================================================

    /// @dev Ship more animals than the ranch holds (the core laundering move).
    function attackOverdraft(uint256 fromSeed, uint256 toSeed, uint32 extra) public {
        bytes32 from = _ranch(fromSeed);
        if (ghostEmbargoed[from]) return;
        uint256 bal = ledger.balanceOf(from);
        uint32 head = uint32(bal + bound(extra, 1, 10_000));
        bytes32 to = sinks[toSeed % sinks.length];
        vm.prank(issuer);
        try ledger.recordMovement(
            keccak256(abi.encode("overdraft", gtas.length, extra)), from, to, head, 3, 0
        ) {
            overdraftBreaches++;
        } catch (bytes memory reason) {
            if (bytes4(reason) != IHerdLedger.InsufficientHerd.selector) unexpectedReverts++;
        }
        vm.prank(registrar);
        try ledger.recordDeaths(from, head) {
            overdraftBreaches++;
        } catch (bytes memory reason) {
            if (bytes4(reason) != IHerdLedger.InsufficientHerd.selector) unexpectedReverts++;
        }
        calls["attackOverdraft"]++;
    }

    /// @dev Move animals out of an embargoed ranch (straight to a sink or via an intermediary).
    function attackEmbargoedOrigin(uint256 fromSeed, uint256 toSeed, uint32 head) public {
        bytes32 from = _ranch(fromSeed);
        if (!ghostEmbargoed[from]) return;
        bytes32 to = toSeed % 2 == 0 || ranches.length < 2
            ? sinks[toSeed % sinks.length]
            : ranches[toSeed % ranches.length];
        if (to == from) to = sinks[0];
        head = uint32(bound(head, 1, 10_000));
        vm.prank(issuer);
        try ledger.recordMovement(
            keccak256(abi.encode("embargoed", gtas.length, head)), from, to, head, 3, 0
        ) {
            embargoBreaches++;
        } catch (bytes memory reason) {
            if (bytes4(reason) != IHerdLedger.OriginEmbargoed.selector) unexpectedReverts++;
        }
        calls["attackEmbargo"]++;
    }

    /// @dev Re-package already-certified GTAs into a new lot (shopping for a clean verdict).
    function attackRecertify(uint256 lotSeed) public {
        if (lots.length == 0) return;
        bytes32 oldLot = lots[lotSeed % lots.length];
        bytes32[] memory used = ledger.certificateGtas(oldLot);
        IHerdLedger.Certificate memory c = IHerdLedger.Certificate({
            lotId: keccak256(abi.encode("recertify", lotSeed, nonce)),
            sink: ledger.certificate(oldLot).sink,
            gtaHashes: used,
            shipment: keccak256(abi.encode("recertify-shipment", lotSeed)),
            head: 1,
            verdict: 0,
            evidenceHash: bytes32(0),
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp) + 365 days,
            policyVersion: 1,
            nonce: nonce++
        });
        try ledger.issueCertificate(c, _sign(oraclePk, ledger.hashCertificate(c))) {
            doubleCertificationBreaches++;
        } catch (bytes memory reason) {
            if (bytes4(reason) != IHerdLedger.GtaAlreadyCertified.selector) unexpectedReverts++;
        }
        calls["attackRecertify"]++;
    }

    /// @dev Phantom births: declare more calves than the breeding herd can produce.
    function attackPhantomBirths(uint256 ranchSeed, uint256 yearSeed, uint32 extra) public {
        bytes32 r = _ranch(ranchSeed);
        uint16 year = YEARS[yearSeed % YEARS.length];
        uint256 max = (uint256(ledger.ranch(r).breedingCows) * 8500) / 10_000;
        uint256 used = ledger.birthsInYear(r, year);
        uint32 head = uint32(max - used + bound(extra, 1, 10_000));
        vm.prank(registrar);
        try ledger.recordBirths(r, head, year) {
            biologyBreaches++;
        } catch (bytes memory reason) {
            if (bytes4(reason) != IHerdLedger.BirthsExceedBiology.selector) unexpectedReverts++;
        }
        calls["attackPhantomBirths"]++;
    }

    /// @dev Replay the last relayed risk attestation, or forge one with a non-oracle key.
    function attackSignature(bool replay, uint8 riskClass) public {
        if (replay) {
            if (!haveLastRisk) return;
            try ledger.attestRisk(lastRisk, lastRiskSig) {
                signatureBreaches++;
            } catch (bytes memory reason) {
                bytes4 sel = bytes4(reason);
                // A newer attestation for the same ranch makes the replay stale before the nonce check.
                if (
                    sel != IHerdLedger.NonceAlreadyUsed.selector
                        && sel != IHerdLedger.StaleAttestation.selector
                ) {
                    unexpectedReverts++;
                }
            }
        } else {
            bytes32 r = ranches[0];
            IHerdLedger.RiskAttestation memory a = IHerdLedger.RiskAttestation({
                ranch: r,
                riskClass: uint8(bound(riskClass, 0, 2)),
                scoreBps: 0,
                evidenceHash: bytes32(0),
                asOf: ledger.riskOf(r).asOf,
                nonce: nonce++
            });
            try ledger.attestRisk(a, _sign(roguePk, ledger.hashRiskAttestation(a))) {
                signatureBreaches++;
            } catch (bytes memory reason) {
                if (bytes4(reason) != IHerdLedger.InvalidSigner.selector) unexpectedReverts++;
            }
        }
        calls["attackSignature"]++;
    }

    // =============================================================================================
    // Views for the invariant suite
    // =============================================================================================

    function ranchCount() external view returns (uint256) {
        return ranches.length;
    }

    function sinkCount() external view returns (uint256) {
        return sinks.length;
    }

    function gtaCount() external view returns (uint256) {
        return gtas.length;
    }

    function lotCount() external view returns (uint256) {
        return lots.length;
    }

    function birthKeyCount() external view returns (uint256) {
        return birthKeys.length;
    }

    function birthKeyAt(uint256 i) external view returns (bytes32 r, uint16 year) {
        bytes32 key = birthKeys[i];
        return (birthKeyRanch[key], birthKeyYear[key]);
    }

    // =============================================================================================
    // Internals
    // =============================================================================================

    function _ranch(uint256 seed) internal view returns (bytes32) {
        return ranches[seed % ranches.length];
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
