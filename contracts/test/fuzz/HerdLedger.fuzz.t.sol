// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

import {IHerdLedger} from "../../src/IHerdLedger.sol";
import {LedgerFixture} from "../utils/LedgerFixture.sol";

/// @notice Property-based tests: each rule is checked against an independent model over random inputs.
contract HerdLedgerFuzzTest is LedgerFixture {
    uint256 internal constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint32 internal constant MAX_HERD = 10_000_000;

    // ------------------------------------------------------------------ registry & biology

    function testFuzz_RegisterRanch_OpeningBalanceAndTotals(uint32 cap, uint32 init, uint32 cows, bytes32 id)
        public
    {
        vm.assume(id != bytes32(0));
        _registerRanch(id, cap, init, cows);
        assertEq(ledger.balanceOf(id), init);
        assertEq(ledger.totals().ranchHead, init);
        assertTrue(ledger.isConserved());
    }

    function testFuzz_RegisterSink_OnlyKnownKinds(uint8 kind) public {
        if (kind == 1 || kind == 2) {
            _registerSink(PORT, kind);
            assertEq(ledger.sink(PORT).kind, kind);
        } else {
            vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidSinkKind.selector, kind));
            _registerSink(PORT, kind);
        }
    }

    function testFuzz_RecordBirths_MatchesBiologyModel(uint32 cows, uint32 first, uint32 second, uint16 year)
        public
    {
        cows = uint32(bound(cows, 0, MAX_HERD));
        uint256 max = (uint256(cows) * 8500) / 10_000;
        _registerRanch(BREEDER, MAX_HERD, cows, cows);

        first = uint32(bound(first, 1, max + 10));
        if (first > max) {
            vm.expectRevert(
                abi.encodeWithSelector(IHerdLedger.BirthsExceedBiology.selector, BREEDER, year, first, max)
            );
            _births(BREEDER, first, year);
            return;
        }
        _births(BREEDER, first, year);

        second = uint32(bound(second, 1, max + 10));
        uint256 total = uint256(first) + second;
        if (total > max) {
            vm.expectRevert(
                abi.encodeWithSelector(IHerdLedger.BirthsExceedBiology.selector, BREEDER, year, total, max)
            );
            _births(BREEDER, second, year);
            assertEq(ledger.birthsInYear(BREEDER, year), first);
        } else {
            _births(BREEDER, second, year);
            assertEq(ledger.birthsInYear(BREEDER, year), total);
            assertEq(ledger.balanceOf(BREEDER), uint256(cows) + total);
        }
        assertTrue(ledger.isConserved());
    }

    function testFuzz_RecordDeaths_NeverBelowZero(uint32 init, uint32 deaths) public {
        init = uint32(bound(init, 0, MAX_HERD));
        deaths = uint32(bound(deaths, 1, MAX_HERD));
        _registerRanch(BREEDER, MAX_HERD, init, 0);
        if (deaths > init) {
            vm.expectRevert(
                abi.encodeWithSelector(IHerdLedger.InsufficientHerd.selector, BREEDER, init, deaths)
            );
            _deaths(BREEDER, deaths);
            assertEq(ledger.balanceOf(BREEDER), init);
        } else {
            _deaths(BREEDER, deaths);
            assertEq(ledger.balanceOf(BREEDER), init - deaths);
        }
        assertTrue(ledger.isConserved());
    }

    // ------------------------------------------------------------------ movements

    function testFuzz_RecordMovement_ConservationModel(uint32 init, uint32 head, bool toSink) public {
        init = uint32(bound(init, 0, MAX_HERD));
        head = uint32(bound(head, 1, MAX_HERD));
        _registerRanch(BREEDER, MAX_HERD, init, 0);
        _registerRanch(FATTENER, MAX_HERD, 0, 0);
        _registerSink(PORT, 2);
        bytes32 to = toSink ? PORT : FATTENER;

        if (head > init) {
            vm.expectRevert(
                abi.encodeWithSelector(IHerdLedger.InsufficientHerd.selector, BREEDER, init, head)
            );
            _move(keccak256("g"), BREEDER, to, head);
            assertEq(ledger.balanceOf(BREEDER), init);
            assertEq(ledger.balanceOf(to), 0);
        } else {
            _move(keccak256("g"), BREEDER, to, head);
            assertEq(ledger.balanceOf(BREEDER), init - head);
            assertEq(ledger.balanceOf(to), head);
            assertEq(ledger.totals().ranchHead, toSink ? init - head : init);
        }
        assertTrue(ledger.isConserved());
    }

    /// @notice Random walk of the same animals through a chain of ranches: head is never created.
    function testFuzz_RecordMovement_ChainCannotCreateCattle(uint32 init, uint32[6] memory hops) public {
        init = uint32(bound(init, 1, MAX_HERD));
        bytes32[4] memory chain = [BREEDER, MIDDLEMAN, FATTENER, keccak256("ranch:R0004")];
        _registerRanch(chain[0], MAX_HERD, init, 0);
        for (uint256 i = 1; i < chain.length; ++i) {
            _registerRanch(chain[i], MAX_HERD, 0, 0);
        }
        _registerSink(PORT, 2);

        uint256[4] memory model;
        model[0] = init;
        uint256 shipped;
        for (uint256 i = 0; i < hops.length; ++i) {
            uint256 fromIdx = i % chain.length;
            bool last = i == hops.length - 1;
            bytes32 to = last ? PORT : chain[(i + 1) % chain.length];
            uint32 head = uint32(bound(hops[i], 1, MAX_HERD));
            bytes32 g = keccak256(abi.encode("hop", i));
            if (head > model[fromIdx]) {
                vm.expectRevert(
                    abi.encodeWithSelector(
                        IHerdLedger.InsufficientHerd.selector, chain[fromIdx], model[fromIdx], head
                    )
                );
                _move(g, chain[fromIdx], to, head);
                continue;
            }
            _move(g, chain[fromIdx], to, head);
            model[fromIdx] -= head;
            if (last) shipped += head;
            else model[(i + 1) % chain.length] += head;
        }

        uint256 live;
        for (uint256 i = 0; i < chain.length; ++i) {
            assertEq(ledger.balanceOf(chain[i]), model[i]);
            live += model[i];
        }
        assertEq(live + shipped, init, "head conserved");
        assertEq(ledger.balanceOf(PORT), shipped);
        assertTrue(ledger.isConserved());
    }

    function testFuzz_RecordMovement_PurposeValidation(uint8 purpose) public {
        _registerWorld();
        if (purpose > 4) {
            vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidPurpose.selector, purpose));
        }
        vm.prank(issuer);
        ledger.recordMovement(keccak256("g"), BREEDER, FATTENER, 1, purpose, DATE);
    }

    function testFuzz_RecordMovement_GtaHashSingleUse(bytes32 h, uint32 a, uint32 b) public {
        vm.assume(h != bytes32(0));
        _registerWorld();
        a = uint32(bound(a, 1, BREEDER_INIT));
        b = uint32(bound(b, 1, FATTENER_INIT));
        _move(h, BREEDER, MIDDLEMAN, a);
        vm.expectRevert(_err(IHerdLedger.DuplicateGta.selector, h));
        _move(h, FATTENER, PORT, b);
    }

    function testFuzz_CapacitySignal_ExactThreshold(uint32 cap, uint32 head) public {
        cap = uint32(bound(cap, 0, MAX_HERD));
        head = uint32(bound(head, 1, MAX_HERD));
        _registerRanch(BREEDER, MAX_HERD, MAX_HERD, 0);
        _registerRanch(FATTENER, cap, 0, 0);

        vm.recordLogs();
        _move(keccak256("g"), BREEDER, FATTENER, head);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool emitted;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == IHerdLedger.CapacityExceeded.selector) emitted = true;
        }
        assertEq(emitted, uint256(head) * 100 > uint256(cap) * 110);
    }

    function testFuzz_Embargo_BlocksEveryOutgoingMovement(uint32 head, bool toSink, uint8 purpose) public {
        _registerWorld();
        head = uint32(bound(head, 1, BREEDER_INIT));
        purpose = uint8(bound(purpose, 0, 4));
        _embargo(BREEDER, true);
        vm.expectRevert(_err(IHerdLedger.OriginEmbargoed.selector, BREEDER));
        vm.prank(issuer);
        ledger.recordMovement(keccak256("g"), BREEDER, toSink ? PORT : FATTENER, head, purpose, DATE);
        assertEq(ledger.ranch(BREEDER).totalOut, 0);
    }

    // ------------------------------------------------------------------ oracle signatures

    function testFuzz_AttestRisk_RoundTripThenReplayRejected(
        uint8 riskClass,
        uint16 scoreBps,
        bytes32 evidence,
        uint64 asOf,
        uint256 nonce
    ) public {
        _registerWorld();
        riskClass = uint8(bound(riskClass, 0, 2));
        scoreBps = uint16(bound(scoreBps, 0, 10_000));
        IHerdLedger.RiskAttestation memory a =
            IHerdLedger.RiskAttestation(MIDDLEMAN, riskClass, scoreBps, evidence, asOf, nonce);
        bytes memory sig = _signRisk(oraclePk, a);
        ledger.attestRisk(a, sig);
        IHerdLedger.RiskRecord memory r = ledger.riskOf(MIDDLEMAN);
        assertEq(r.riskClass, riskClass);
        assertEq(r.scoreBps, scoreBps);
        assertEq(r.evidenceHash, evidence);
        assertEq(r.asOf, asOf);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.NonceAlreadyUsed.selector, oracle, nonce));
        ledger.attestRisk(a, sig);
    }

    function testFuzz_AttestRisk_FieldValidation(uint8 riskClass, uint16 scoreBps) public {
        _registerWorld();
        IHerdLedger.RiskAttestation memory a = _risk(BREEDER, riskClass, scoreBps, 1);
        bytes memory sig = _signRisk(oraclePk, a);
        if (riskClass > 2) {
            vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidRiskClass.selector, riskClass));
        } else if (scoreBps > 10_000) {
            vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidScore.selector, scoreBps));
        }
        ledger.attestRisk(a, sig);
    }

    function testFuzz_AttestRisk_RejectsAnyNonOracleKey(uint256 pk) public {
        pk = bound(pk, 1, SECP256K1_N - 1);
        vm.assume(pk != oraclePk);
        _registerWorld();
        IHerdLedger.RiskAttestation memory a = _risk(MIDDLEMAN, 0, 0, 1);
        bytes memory sig = _signRisk(pk, a);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidSigner.selector, vm.addr(pk)));
        ledger.attestRisk(a, sig);
    }

    function testFuzz_AttestRisk_RejectsRandomSignatureBytes(bytes memory sig) public {
        _registerWorld();
        IHerdLedger.RiskAttestation memory a = _risk(MIDDLEMAN, 0, 0, 1);
        vm.expectRevert(); // InvalidSigner(<whatever recovers, or 0>)
        ledger.attestRisk(a, sig);
        assertEq(ledger.riskOf(MIDDLEMAN).oracle, address(0));
    }

    function testFuzz_AttestRisk_StaleNeverOverwrites(uint64 first, uint64 second) public {
        _registerWorld();
        _attest(_risk(MIDDLEMAN, 2, 9000, first));
        IHerdLedger.RiskAttestation memory b = _risk(MIDDLEMAN, 0, 0, second);
        bytes memory sig = _signRisk(oraclePk, b);
        if (second < first) {
            vm.expectRevert(
                abi.encodeWithSelector(IHerdLedger.StaleAttestation.selector, MIDDLEMAN, second, first)
            );
            ledger.attestRisk(b, sig);
            assertEq(ledger.riskOf(MIDDLEMAN).riskClass, 2);
        } else {
            ledger.attestRisk(b, sig);
            assertEq(ledger.riskOf(MIDDLEMAN).riskClass, 0);
        }
    }

    function testFuzz_Signature_BoundToChainId(uint64 otherChain) public {
        vm.assume(otherChain != block.chainid && otherChain != 0);
        _registerWorld();
        IHerdLedger.RiskAttestation memory a = _risk(MIDDLEMAN, 0, 0, 1);
        bytes memory sig = _signRisk(oraclePk, a);
        vm.chainId(otherChain);
        vm.expectRevert(); // InvalidSigner(<unrelated address>)
        ledger.attestRisk(a, sig);
    }

    // ------------------------------------------------------------------ certificates

    function testFuzz_IssueCertificate_HeadBoundedByGtas(uint32[4] memory heads, uint32 lotHead) public {
        _registerRanch(FATTENER, MAX_HERD, MAX_HERD, 0);
        _registerSink(PORT, 2);
        bytes32[] memory gtas = new bytes32[](4);
        uint256 sum;
        for (uint256 i = 0; i < 4; ++i) {
            heads[i] = uint32(bound(heads[i], 1, 100_000));
            gtas[i] = keccak256(abi.encode("g", i));
            _move(gtas[i], FATTENER, PORT, heads[i]);
            sum += heads[i];
        }
        lotHead = uint32(bound(lotHead, 1, sum * 2));
        IHerdLedger.Certificate memory c = _cert(_lot("SHP"), PORT, gtas, lotHead, 0);
        bytes memory sig = _signCert(oraclePk, c);
        if (lotHead > sum) {
            vm.expectRevert(
                abi.encodeWithSelector(IHerdLedger.CertificateHeadExceedsGtas.selector, c.lotId, lotHead, sum)
            );
            ledger.issueCertificate(c, sig);
            assertEq(ledger.gta(gtas[0]).lotId, bytes32(0), "no GTA left bound after a revert");
        } else {
            ledger.issueCertificate(c, sig);
            assertEq(ledger.certificate(c.lotId).head, lotHead);
        }
    }

    function testFuzz_IssueCertificate_OverlapAlwaysRejected(uint8 n, uint8 split, uint8 overlapAt) public {
        n = uint8(bound(n, 2, 20));
        split = uint8(bound(split, 1, n - 1));
        _registerRanch(FATTENER, MAX_HERD, MAX_HERD, 0);
        _registerSink(PORT, 2);
        bytes32[] memory all = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) {
            all[i] = keccak256(abi.encode("g", i));
            _move(all[i], FATTENER, PORT, 10);
        }
        bytes32[] memory first = new bytes32[](split);
        for (uint256 i = 0; i < split; ++i) {
            first[i] = all[i];
        }
        _issue(_cert(_lot("A"), PORT, first, uint32(split) * 10, 0));

        // Second lot: the remaining GTAs plus one that already backs lot A.
        bytes32[] memory second = new bytes32[](n - split + 1);
        for (uint256 i = split; i < n; ++i) {
            second[i - split] = all[i];
        }
        bytes32 reused = all[bound(overlapAt, 0, split - 1)];
        second[n - split] = reused;
        IHerdLedger.Certificate memory c = _cert(_lot("B"), PORT, second, 10, 0);
        bytes memory sig = _signCert(oraclePk, c);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.GtaAlreadyCertified.selector, reused, _lot("A")));
        ledger.issueCertificate(c, sig);
    }

    function testFuzz_IssueCertificate_TamperedLotRejected(bytes32 otherLot) public {
        bytes32 lot = _lot("SHP-0007");
        vm.assume(otherLot != lot && otherLot != bytes32(0));
        (bytes32 g1,) = _worldWithDeliveries();
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0);
        bytes memory sig = _signCert(oraclePk, c);
        c.lotId = otherLot;
        vm.expectRevert();
        ledger.issueCertificate(c, sig);
        assertFalse(ledger.certificate(otherLot).issued);
    }

    function testFuzz_ConsumeCertificate_OnlyCleanAndOnlyOnce(uint8 verdict, uint8 use, uint8 attempts)
        public
    {
        verdict = uint8(bound(verdict, 0, 3)); // clean, flagged, unknown, review
        use = uint8(bound(use, 0, 2));
        attempts = uint8(bound(attempts, 1, 5));
        (bytes32 g1,) = _worldWithDeliveries();
        bytes32 lot = _lot("SHP");
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, verdict));

        uint256 successes;
        for (uint256 i = 0; i < attempts; ++i) {
            vm.prank(i % 2 == 0 ? buyer : buyer2);
            try ledger.consumeCertificate(lot, use, bytes32(i + 1)) {
                successes++;
            } catch (bytes memory reason) {
                bytes4 sel = bytes4(reason);
                assertTrue(
                    sel == IHerdLedger.CertificateAlreadyUsed.selector
                        || sel == IHerdLedger.CertificateNotClean.selector
                );
            }
        }
        assertEq(successes, verdict == 0 ? 1 : 0);
        assertEq(ledger.totals().consumed, successes);
    }
}
