// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {HerdLedger} from "../../src/HerdLedger.sol";
import {IHerdLedger} from "../../src/IHerdLedger.sol";
import {LedgerHandler} from "./LedgerHandler.sol";

/// @notice Stateful invariant suite: after every random sequence of honest and malicious calls, the
///         ledger must still obey conservation of cattle and the one-time-claim rules.
contract HerdLedgerInvariantTest is StdInvariant, Test {
    HerdLedger internal ledger;
    LedgerHandler internal handler;

    function setUp() public {
        address admin = makeAddr("admin");
        address registrar = makeAddr("registrar");
        address issuer = makeAddr("issuer");
        address regulator = makeAddr("regulator");
        address buyer = makeAddr("buyer");
        (address oracle, uint256 oraclePk) = makeAddrAndKey("oracle");
        (, uint256 roguePk) = makeAddrAndKey("rogue");

        ledger = new HerdLedger(admin);
        vm.startPrank(admin);
        ledger.grantRole(ledger.REGISTRAR_ROLE(), registrar);
        ledger.grantRole(ledger.ISSUER_ROLE(), issuer);
        ledger.grantRole(ledger.REGULATOR_ROLE(), regulator);
        ledger.grantRole(ledger.ORACLE_ROLE(), oracle);
        ledger.grantRole(ledger.BUYER_ROLE(), buyer);
        vm.stopPrank();

        handler = new LedgerHandler(ledger, registrar, issuer, regulator, buyer, oraclePk, roguePk);

        bytes4[] memory selectors = new bytes4[](18);
        selectors[0] = LedgerHandler.registerRanch.selector;
        selectors[1] = LedgerHandler.registerSink.selector;
        selectors[2] = LedgerHandler.recordBirths.selector;
        selectors[3] = LedgerHandler.recordDeaths.selector;
        selectors[4] = LedgerHandler.recordMovement.selector;
        selectors[5] = LedgerHandler.recordMovement.selector; // weighted: movements dominate real data
        selectors[6] = LedgerHandler.setEmbargo.selector;
        selectors[7] = LedgerHandler.attestRisk.selector;
        selectors[8] = LedgerHandler.issueCertificate.selector;
        selectors[9] = LedgerHandler.consumeCertificate.selector;
        selectors[10] = LedgerHandler.revokeCertificate.selector;
        selectors[11] = LedgerHandler.warp.selector;
        selectors[12] = LedgerHandler.attackOverdraft.selector;
        selectors[13] = LedgerHandler.attackEmbargoedOrigin.selector;
        selectors[14] = LedgerHandler.attackRecertify.selector;
        selectors[15] = LedgerHandler.attackPhantomBirths.selector;
        selectors[16] = LedgerHandler.attackSignature.selector;
        selectors[17] = LedgerHandler.issueCertificate.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    // ---------------------------------------------------------------------------------------------
    // The five required invariants (SPEC §4)
    // ---------------------------------------------------------------------------------------------

    /// @notice Σ ranch balances == Σ initial + Σ births − Σ deaths − Σ head moved into sinks.
    /// @dev The left side is summed from each ranch's own balance, not from the contract's totals.
    function invariant_ConservationOfTotalHead() public view {
        uint256 sum;
        for (uint256 i = 0; i < handler.ranchCount(); ++i) {
            sum += ledger.balanceOf(handler.ranches(i));
        }
        uint256 expected =
            handler.ghostInitial() + handler.ghostBirths() - handler.ghostDeaths() - handler.ghostToSinks();
        assertEq(sum, expected, "sum of balances != initial + births - deaths - to sinks");
        assertEq(ledger.totals().ranchHead, sum, "on-chain total drifted from balances");
        assertTrue(ledger.isConserved(), "isConserved() false");
    }

    /// @notice No ranch balance ever goes negative, and every overdraft attempt is rejected.
    /// @dev Balances are uint32 on-chain; the ghost model tracks them as signed integers so a missed
    ///      underflow would show up as a negative ghost balance or a mismatch.
    function invariant_NoNegativeBalances() public view {
        for (uint256 i = 0; i < handler.ranchCount(); ++i) {
            bytes32 r = handler.ranches(i);
            int256 ghost = handler.ghostBalance(r);
            assertGe(ghost, 0, "negative balance in model");
            assertEq(uint256(ghost), ledger.balanceOf(r), "balance != independent model");
        }
        assertEq(handler.overdraftBreaches(), 0, "overdraft accepted");
    }

    /// @notice A certificate is consumed at most once (and only when clean and unrevoked).
    function invariant_CertificateConsumedAtMostOnce() public view {
        uint256 consumed;
        for (uint256 i = 0; i < handler.lotCount(); ++i) {
            bytes32 lotId = handler.lots(i);
            uint256 n = handler.consumeSuccesses(lotId);
            assertLe(n, 1, "certificate consumed twice");
            IHerdLedger.CertificateRecord memory c = ledger.certificate(lotId);
            assertEq(c.consumed, n == 1, "consumed flag mismatch");
            if (c.consumed) {
                assertEq(c.verdict, 0, "non-clean certificate consumed");
                consumed++;
            }
        }
        assertEq(ledger.totals().consumed, consumed, "consumed counter mismatch");
        assertEq(handler.badConsumeBreaches(), 0, "flagged / revoked / used certificate consumed");
    }

    /// @notice A GTA is in at most one certificate, and the GTA→lot binding agrees both ways.
    function invariant_GtaInAtMostOneCertificate() public view {
        uint256 bound_;
        for (uint256 i = 0; i < handler.gtaCount(); ++i) {
            bytes32 g = handler.gtas(i);
            uint256 n = handler.gtaCertifications(g);
            assertLe(n, 1, "GTA certified twice");
            bytes32 lotId = ledger.gta(g).lotId;
            assertEq(lotId != bytes32(0), n == 1, "GTA binding mismatch");
            if (lotId != bytes32(0)) bound_++;
        }
        uint256 listed;
        for (uint256 i = 0; i < handler.lotCount(); ++i) {
            bytes32 lotId = handler.lots(i);
            bytes32[] memory list = ledger.certificateGtas(lotId);
            for (uint256 j = 0; j < list.length; ++j) {
                assertEq(ledger.gta(list[j]).lotId, lotId, "certificate lists a GTA bound elsewhere");
            }
            listed += list.length;
        }
        assertEq(listed, bound_, "GTA counted in more than one certificate");
        assertEq(handler.doubleCertificationBreaches(), 0, "re-certification accepted");
    }

    /// @notice An embargoed ranch has no outgoing movement after the embargo.
    function invariant_EmbargoedRanchHasNoOutflowAfterEmbargo() public view {
        for (uint256 i = 0; i < handler.ranchCount(); ++i) {
            bytes32 r = handler.ranches(i);
            IHerdLedger.Ranch memory rec = ledger.ranch(r);
            assertEq(rec.embargoed, handler.ghostEmbargoed(r), "embargo flag mismatch");
            if (rec.embargoed) {
                assertEq(rec.totalOut, handler.outAtEmbargo(r), "animals left an embargoed ranch");
            }
        }
        assertEq(handler.embargoBreaches(), 0, "movement from embargoed origin accepted");
    }

    // ---------------------------------------------------------------------------------------------
    // Additional safety invariants
    // ---------------------------------------------------------------------------------------------

    /// @notice Head that left ranches for sinks equals what the sinks report receiving.
    function invariant_SinkReceiptsMatchHeadLeavingTheHerd() public view {
        uint256 received;
        for (uint256 i = 0; i < handler.sinkCount(); ++i) {
            received += ledger.sink(handler.sinks(i)).receivedHead;
        }
        assertEq(received, handler.ghostToSinks());
        assertEq(ledger.totals().headToSinks, received);
    }

    /// @notice Every animal that left a ranch arrived at a ranch or a sink (no animals lost in transit).
    function invariant_FlowBetweenEntitiesBalances() public view {
        uint256 totalOut;
        uint256 totalIn;
        for (uint256 i = 0; i < handler.ranchCount(); ++i) {
            IHerdLedger.Ranch memory rec = ledger.ranch(handler.ranches(i));
            totalOut += rec.totalOut;
            totalIn += rec.totalIn;
            // Per-ranch identity: head = initial + births + in − deaths − out.
            assertEq(
                uint256(rec.head) + rec.totalDeaths + rec.totalOut,
                uint256(rec.initialHead) + rec.totalBirths + rec.totalIn,
                "per-ranch flow identity broken"
            );
        }
        assertEq(totalOut, totalIn + handler.ghostToSinks(), "out != in + to sinks");
    }

    /// @notice Recorded births never exceed breeding cows × 85 % for any ranch and year.
    function invariant_BirthsWithinBiology() public view {
        for (uint256 i = 0; i < handler.birthKeyCount(); ++i) {
            (bytes32 r, uint16 year) = handler.birthKeyAt(i);
            uint256 max = (uint256(ledger.ranch(r).breedingCows) * 8500) / 10_000;
            assertLe(ledger.birthsInYear(r, year), max, "births above biology");
        }
        assertEq(handler.biologyBreaches(), 0, "phantom births accepted");
    }

    /// @notice Every certificate is backed: its GTAs went to its sink and cover its head count.
    function invariant_CertificatesBackedByTheirGtas() public view {
        for (uint256 i = 0; i < handler.lotCount(); ++i) {
            bytes32 lotId = handler.lots(i);
            IHerdLedger.CertificateRecord memory c = ledger.certificate(lotId);
            bytes32[] memory list = ledger.certificateGtas(lotId);
            assertGt(list.length, 0);
            uint256 sum;
            for (uint256 j = 0; j < list.length; ++j) {
                IHerdLedger.Gta memory g = ledger.gta(list[j]);
                assertEq(g.to, c.sink, "GTA not delivered to the certificate sink");
                sum += g.head;
            }
            assertLe(c.head, sum, "certificate claims more head than its GTAs");
        }
        assertEq(ledger.totals().certificates, handler.lotCount());
    }

    /// @notice Oracle messages cannot be replayed or forged.
    function invariant_SignaturesNeverReplayedOrForged() public view {
        assertEq(handler.signatureBreaches(), 0);
    }

    /// @notice Every attack was rejected with the specific error the rule defines.
    function invariant_AttacksFailForTheRightReason() public view {
        assertEq(handler.unexpectedReverts(), 0);
    }

    /// @notice Registry and movement counters agree with what was actually recorded.
    function invariant_CountersMatchRegistry() public view {
        IHerdLedger.Totals memory t = ledger.totals();
        assertEq(t.ranches, handler.ranchCount());
        assertEq(t.sinks, handler.sinkCount());
        assertEq(t.movements, handler.gtaCount());
        assertEq(t.initialHead, handler.ghostInitial());
        assertEq(t.births, handler.ghostBirths());
        assertEq(t.deaths, handler.ghostDeaths());
    }

    function afterInvariant() external view {
        console2.log("ranches", handler.ranchCount(), "sinks", handler.sinkCount());
        console2.log("movements", handler.gtaCount(), "certificates", handler.lotCount());
        console2.log("consumed", ledger.totals().consumed, "revoked", ledger.totals().revoked);
        console2.log("head to sinks", handler.ghostToSinks(), "live head", ledger.totals().ranchHead);
    }
}
