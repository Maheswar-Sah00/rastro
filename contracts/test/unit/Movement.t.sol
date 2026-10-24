// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHerdLedger} from "../../src/IHerdLedger.sol";
import {LedgerFixture} from "../utils/LedgerFixture.sol";

/// @notice recordMovement and setEmbargo.
contract MovementTest is LedgerFixture {
    bytes32 internal g1 = keccak256("salt:GTA-PA-2023-000001");
    bytes32 internal g2 = keccak256("salt:GTA-PA-2023-000002");
    bytes32 internal g3 = keccak256("salt:GTA-PA-2023-000003");

    function setUp() public override {
        super.setUp();
        _registerWorld();
    }

    // ------------------------------------------------------------------ happy paths

    function test_RecordMovement_RanchToRanch_ConservesHead() public {
        _move(g1, BREEDER, MIDDLEMAN, 120);
        assertEq(ledger.balanceOf(BREEDER), BREEDER_INIT - 120);
        assertEq(ledger.balanceOf(MIDDLEMAN), 120);
        assertEq(ledger.ranch(BREEDER).totalOut, 120);
        assertEq(ledger.ranch(MIDDLEMAN).totalIn, 120);
        IHerdLedger.Totals memory t = ledger.totals();
        assertEq(t.ranchHead, BREEDER_INIT + FATTENER_INIT, "live herd unchanged");
        assertEq(t.movements, 1);
        assertTrue(ledger.isConserved());
    }

    function test_RecordMovement_RanchToSink_LeavesLiveHerd() public {
        _move(g1, FATTENER, SLAUGHTERHOUSE, 450);
        assertEq(ledger.balanceOf(FATTENER), FATTENER_INIT - 450);
        assertEq(ledger.balanceOf(SLAUGHTERHOUSE), 450);
        IHerdLedger.Sink memory s = ledger.sink(SLAUGHTERHOUSE);
        assertEq(s.receivedHead, 450);
        assertEq(s.movementsIn, 1);
        IHerdLedger.Totals memory t = ledger.totals();
        assertEq(t.headToSinks, 450);
        assertEq(t.ranchHead, BREEDER_INIT + FATTENER_INIT - 450);
        assertTrue(ledger.isConserved());
    }

    function test_RecordMovement_StoresGta() public {
        vm.warp(1_700_000_000);
        vm.prank(issuer);
        ledger.recordMovement(g1, BREEDER, MIDDLEMAN, 120, 1, DATE);
        IHerdLedger.Gta memory g = ledger.gta(g1);
        assertEq(g.from, BREEDER);
        assertEq(g.to, MIDDLEMAN);
        assertEq(g.head, 120);
        assertEq(g.purpose, 1);
        assertEq(g.date, DATE);
        assertEq(g.recordedAt, 1_700_000_000);
        assertEq(g.lotId, bytes32(0));
    }

    function test_RecordMovement_EmitsEvent() public {
        vm.expectEmit(address(ledger));
        emit IHerdLedger.MovementRecorded(g1, BREEDER, PORT, 50, 4, DATE);
        vm.prank(issuer);
        ledger.recordMovement(g1, BREEDER, PORT, 50, 4, DATE);
    }

    function test_RecordMovement_EntireHerd() public {
        _move(g1, BREEDER, FATTENER, BREEDER_INIT);
        assertEq(ledger.balanceOf(BREEDER), 0);
        assertEq(ledger.balanceOf(FATTENER), FATTENER_INIT + BREEDER_INIT);
    }

    function test_RecordMovement_AllPurposesAccepted() public {
        for (uint8 p = 0; p <= 4; ++p) {
            bytes32 h = keccak256(abi.encode("gta", p));
            vm.prank(issuer);
            ledger.recordMovement(h, BREEDER, FATTENER, 1, p, DATE);
            assertEq(ledger.gta(h).purpose, p);
        }
    }

    function test_RecordMovement_EmitsCapacityExceededAboveTolerance() public {
        // MIDDLEMAN capacity 200: tolerance 220 head.
        vm.expectEmit(address(ledger));
        emit IHerdLedger.CapacityExceeded(MIDDLEMAN, 221, MIDDLEMAN_CAP);
        _move(g1, BREEDER, MIDDLEMAN, 221);
    }

    function test_RecordMovement_NoCapacitySignalAtTolerance() public {
        vm.recordLogs();
        _move(g1, BREEDER, MIDDLEMAN, 220);
        assertEq(vm.getRecordedLogs().length, 1, "only MovementRecorded");
    }

    function test_RecordMovement_CapacityNotCheckedForSinks() public {
        vm.recordLogs();
        _move(g1, BREEDER, SLAUGHTERHOUSE, BREEDER_INIT);
        assertEq(vm.getRecordedLogs().length, 1);
    }

    function test_RecordMovement_IntoEmbargoedRanchAllowed() public {
        // Only the origin is blocked; an embargoed ranch can still receive (and then hold) animals.
        _embargo(MIDDLEMAN, true);
        _move(g1, BREEDER, MIDDLEMAN, 10);
        assertEq(ledger.balanceOf(MIDDLEMAN), 10);
    }

    function test_RecordMovement_PassThroughIsBoundedByInflow() public {
        // Intermediary buys 120 and resells 120; the 121st animal does not exist.
        _move(g1, BREEDER, MIDDLEMAN, 120);
        _move(g2, MIDDLEMAN, FATTENER, 100);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InsufficientHerd.selector, MIDDLEMAN, 20, 21));
        _move(g3, MIDDLEMAN, PORT, 21);
        _move(g3, MIDDLEMAN, PORT, 20);
        assertEq(ledger.balanceOf(MIDDLEMAN), 0);
    }

    // ------------------------------------------------------------------ reverts

    function test_RevertWhen_RecordMovement_ZeroGtaHash() public {
        vm.expectRevert(IHerdLedger.ZeroId.selector);
        _move(bytes32(0), BREEDER, MIDDLEMAN, 1);
    }

    function test_RevertWhen_RecordMovement_UnknownOrigin() public {
        vm.expectRevert(_err(IHerdLedger.UnknownEntity.selector, UNKNOWN));
        _move(g1, UNKNOWN, MIDDLEMAN, 1);
    }

    function test_RevertWhen_RecordMovement_UnknownDestination() public {
        vm.expectRevert(_err(IHerdLedger.UnknownEntity.selector, UNKNOWN));
        _move(g1, BREEDER, UNKNOWN, 1);
    }

    function test_RevertWhen_RecordMovement_OriginIsSink() public {
        // Slaughtered or exported animals cannot come back as "clean" stock.
        vm.expectRevert(_err(IHerdLedger.NotARanch.selector, SLAUGHTERHOUSE));
        _move(g1, SLAUGHTERHOUSE, FATTENER, 1);
    }

    function test_RevertWhen_RecordMovement_SameOriginAndDestination() public {
        vm.expectRevert(_err(IHerdLedger.SameOriginAndDestination.selector, BREEDER));
        _move(g1, BREEDER, BREEDER, 1);
    }

    function test_RevertWhen_RecordMovement_DuplicateGta() public {
        _move(g1, BREEDER, MIDDLEMAN, 1);
        vm.expectRevert(_err(IHerdLedger.DuplicateGta.selector, g1));
        _move(g1, FATTENER, PORT, 1);
    }

    function test_RevertWhen_RecordMovement_ZeroHead() public {
        vm.expectRevert(IHerdLedger.ZeroHead.selector);
        _move(g1, BREEDER, MIDDLEMAN, 0);
    }

    function test_RevertWhen_RecordMovement_InvalidPurpose() public {
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidPurpose.selector, uint8(5)));
        vm.prank(issuer);
        ledger.recordMovement(g1, BREEDER, MIDDLEMAN, 1, 5, DATE);
    }

    function test_RevertWhen_RecordMovement_OriginEmbargoed() public {
        _embargo(BREEDER, true);
        vm.expectRevert(_err(IHerdLedger.OriginEmbargoed.selector, BREEDER));
        _move(g1, BREEDER, MIDDLEMAN, 1);
    }

    function test_RevertWhen_RecordMovement_EmbargoedOriginToSink() public {
        _embargo(FATTENER, true);
        vm.expectRevert(_err(IHerdLedger.OriginEmbargoed.selector, FATTENER));
        _move(g1, FATTENER, SLAUGHTERHOUSE, 50);
    }

    function test_RevertWhen_RecordMovement_EmbargoCheckedBeforeBalance() public {
        _embargo(MIDDLEMAN, true);
        vm.expectRevert(_err(IHerdLedger.OriginEmbargoed.selector, MIDDLEMAN));
        _move(g1, MIDDLEMAN, FATTENER, 1000);
    }

    function test_RevertWhen_RecordMovement_InsufficientHerd() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IHerdLedger.InsufficientHerd.selector, BREEDER, BREEDER_INIT, BREEDER_INIT + 1
            )
        );
        _move(g1, BREEDER, MIDDLEMAN, BREEDER_INIT + 1);
    }

    function test_RevertWhen_RecordMovement_FailedMovementLeavesNoTrace() public {
        vm.expectRevert();
        _move(g1, MIDDLEMAN, PORT, 1);
        assertEq(ledger.gta(g1).from, bytes32(0));
        assertEq(ledger.totals().movements, 0);
        _move(g1, BREEDER, MIDDLEMAN, 1); // the GTA hash is still free
    }

    function test_RevertWhen_RecordMovement_CallerNotIssuer() public {
        vm.expectRevert(_unauthorized(registrar, ledger.ISSUER_ROLE()));
        vm.prank(registrar);
        ledger.recordMovement(g1, BREEDER, MIDDLEMAN, 1, 0, DATE);
    }

    // ------------------------------------------------------------------ setEmbargo

    function test_SetEmbargo_On() public {
        vm.warp(1_750_000_000);
        _embargo(BREEDER, true);
        IHerdLedger.Ranch memory r = ledger.ranch(BREEDER);
        assertTrue(r.embargoed);
        assertEq(r.embargoedSince, 1_750_000_000);
        assertEq(r.embargoReason, REASON);
    }

    function test_SetEmbargo_EmitsEvent() public {
        vm.expectEmit(address(ledger));
        emit IHerdLedger.EmbargoSet(BREEDER, true, REASON, regulator);
        _embargo(BREEDER, true);
    }

    function test_SetEmbargo_LiftResumesMovements() public {
        _embargo(BREEDER, true);
        bytes32 courtOrder = keccak256("court-order:lift");
        vm.prank(regulator);
        ledger.setEmbargo(BREEDER, false, courtOrder);
        IHerdLedger.Ranch memory r = ledger.ranch(BREEDER);
        assertFalse(r.embargoed);
        assertEq(r.embargoedSince, 0);
        assertEq(r.embargoReason, courtOrder);
        _move(g1, BREEDER, MIDDLEMAN, 10);
        assertEq(ledger.balanceOf(MIDDLEMAN), 10);
    }

    function test_SetEmbargo_ReassertKeepsStartTimeAndUpdatesReason() public {
        vm.warp(1000);
        _embargo(BREEDER, true);
        vm.warp(2000);
        bytes32 second = keccak256("second-notice");
        vm.prank(regulator);
        ledger.setEmbargo(BREEDER, true, second);
        IHerdLedger.Ranch memory r = ledger.ranch(BREEDER);
        assertEq(r.embargoedSince, 1000);
        assertEq(r.embargoReason, second);
    }

    function test_SetEmbargo_DoesNotFreezeBalance() public {
        _embargo(BREEDER, true);
        assertEq(ledger.balanceOf(BREEDER), BREEDER_INIT);
    }

    function test_RevertWhen_SetEmbargo_UnknownRanch() public {
        vm.expectRevert(_err(IHerdLedger.UnknownEntity.selector, UNKNOWN));
        _embargo(UNKNOWN, true);
    }

    function test_RevertWhen_SetEmbargo_OnSink() public {
        vm.expectRevert(_err(IHerdLedger.NotARanch.selector, PORT));
        _embargo(PORT, true);
    }

    function test_RevertWhen_SetEmbargo_CallerNotRegulator() public {
        vm.expectRevert(_unauthorized(registrar, ledger.REGULATOR_ROLE()));
        vm.prank(registrar);
        ledger.setEmbargo(BREEDER, true, REASON);
    }
}
