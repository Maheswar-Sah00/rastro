// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHerdLedger} from "../../src/IHerdLedger.sol";
import {LedgerFixture} from "../utils/LedgerFixture.sol";

/// @notice registerRanch, registerSink, recordBirths, recordDeaths.
contract RegistryTest is LedgerFixture {
    // ------------------------------------------------------------------ registerRanch

    function test_RegisterRanch_StoresFieldsAndTotals() public {
        vm.prank(registrar);
        ledger.registerRanch(BREEDER, BREEDER_CAP, BREEDER_INIT, BREEDER_COWS, GEOM);

        IHerdLedger.Ranch memory r = ledger.ranch(BREEDER);
        assertEq(r.capacityHead, BREEDER_CAP);
        assertEq(r.initialHead, BREEDER_INIT);
        assertEq(r.breedingCows, BREEDER_COWS);
        assertEq(r.head, BREEDER_INIT);
        assertEq(r.geomHash, GEOM);
        assertFalse(r.embargoed);
        assertEq(uint8(ledger.entityType(BREEDER)), uint8(IHerdLedger.EntityType.Ranch));
        assertEq(ledger.balanceOf(BREEDER), BREEDER_INIT);

        IHerdLedger.Totals memory t = ledger.totals();
        assertEq(t.ranches, 1);
        assertEq(t.initialHead, BREEDER_INIT);
        assertEq(t.ranchHead, BREEDER_INIT);
        assertTrue(ledger.isConserved());
    }

    function test_RegisterRanch_EmitsEvent() public {
        vm.expectEmit(address(ledger));
        emit IHerdLedger.RanchRegistered(BREEDER, BREEDER_CAP, BREEDER_INIT, BREEDER_COWS, GEOM);
        vm.prank(registrar);
        ledger.registerRanch(BREEDER, BREEDER_CAP, BREEDER_INIT, BREEDER_COWS, GEOM);
    }

    function test_RegisterRanch_EmitsCapacityExceededWhenOpeningAboveTolerance() public {
        // 111 head on a 100-head pasture is above the 110 % tolerance.
        vm.expectEmit(address(ledger));
        emit IHerdLedger.CapacityExceeded(BREEDER, 111, 100);
        _registerRanch(BREEDER, 100, 111, 0);
    }

    function test_RegisterRanch_NoCapacitySignalAtExactTolerance() public {
        vm.recordLogs();
        _registerRanch(BREEDER, 100, 110, 0);
        assertEq(vm.getRecordedLogs().length, 1, "only RanchRegistered");
    }

    function test_RegisterRanch_ZeroCapacityHoldingCattleIsSignalled() public {
        // A "ranch" with no cleared pasture that declares animals is itself a red flag.
        vm.expectEmit(address(ledger));
        emit IHerdLedger.CapacityExceeded(BREEDER, 1, 0);
        _registerRanch(BREEDER, 0, 1, 0);
    }

    function test_RevertWhen_RegisterRanch_ZeroId() public {
        vm.expectRevert(IHerdLedger.ZeroId.selector);
        _registerRanch(bytes32(0), 1, 1, 0);
    }

    function test_RevertWhen_RegisterRanch_Duplicate() public {
        _registerRanch(BREEDER, 1, 1, 0);
        vm.expectRevert(_err(IHerdLedger.EntityAlreadyRegistered.selector, BREEDER));
        _registerRanch(BREEDER, 5, 5, 0);
    }

    function test_RevertWhen_RegisterRanch_IdAlreadyUsedBySink() public {
        _registerSink(SLAUGHTERHOUSE, 1);
        vm.expectRevert(_err(IHerdLedger.EntityAlreadyRegistered.selector, SLAUGHTERHOUSE));
        _registerRanch(SLAUGHTERHOUSE, 1, 1, 0);
    }

    function test_RevertWhen_RegisterRanch_CallerNotRegistrar() public {
        vm.expectRevert(_unauthorized(issuer, ledger.REGISTRAR_ROLE()));
        vm.prank(issuer);
        ledger.registerRanch(BREEDER, 1, 1, 0, GEOM);
    }

    // ------------------------------------------------------------------ registerSink

    function test_RegisterSink_Slaughterhouse() public {
        vm.expectEmit(address(ledger));
        emit IHerdLedger.SinkRegistered(SLAUGHTERHOUSE, 1);
        _registerSink(SLAUGHTERHOUSE, 1);
        assertEq(ledger.sink(SLAUGHTERHOUSE).kind, 1);
        assertEq(uint8(ledger.entityType(SLAUGHTERHOUSE)), uint8(IHerdLedger.EntityType.Sink));
        assertEq(ledger.totals().sinks, 1);
    }

    function test_RegisterSink_ExportPort() public {
        _registerSink(PORT, 2);
        assertEq(ledger.sink(PORT).kind, 2);
        assertEq(ledger.balanceOf(PORT), 0);
    }

    function test_RevertWhen_RegisterSink_KindZero() public {
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidSinkKind.selector, uint8(0)));
        _registerSink(PORT, 0);
    }

    function test_RevertWhen_RegisterSink_KindThree() public {
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidSinkKind.selector, uint8(3)));
        _registerSink(PORT, 3);
    }

    function test_RevertWhen_RegisterSink_ZeroId() public {
        vm.expectRevert(IHerdLedger.ZeroId.selector);
        _registerSink(bytes32(0), 1);
    }

    function test_RevertWhen_RegisterSink_Duplicate() public {
        _registerSink(PORT, 2);
        vm.expectRevert(_err(IHerdLedger.EntityAlreadyRegistered.selector, PORT));
        _registerSink(PORT, 1);
    }

    function test_RevertWhen_RegisterSink_IdAlreadyUsedByRanch() public {
        _registerRanch(BREEDER, 1, 1, 0);
        vm.expectRevert(_err(IHerdLedger.EntityAlreadyRegistered.selector, BREEDER));
        _registerSink(BREEDER, 1);
    }

    function test_RevertWhen_RegisterSink_CallerNotRegistrar() public {
        vm.expectRevert(_unauthorized(stranger, ledger.REGISTRAR_ROLE()));
        vm.prank(stranger);
        ledger.registerSink(PORT, 2);
    }

    // ------------------------------------------------------------------ recordBirths

    function test_RecordBirths_UpdatesBalanceYearTotalAndTotals() public {
        _registerWorld();
        _births(BREEDER, 120, 2023);
        assertEq(ledger.balanceOf(BREEDER), BREEDER_INIT + 120);
        assertEq(ledger.birthsInYear(BREEDER, 2023), 120);
        assertEq(ledger.ranch(BREEDER).totalBirths, 120);
        assertEq(ledger.totals().births, 120);
        assertTrue(ledger.isConserved());
    }

    function test_RecordBirths_AllowsExactlyTheBiologicalMax() public {
        _registerWorld();
        _births(BREEDER, 255, 2023); // 300 cows × 85 % = 255
        assertEq(ledger.birthsInYear(BREEDER, 2023), 255);
    }

    function test_RecordBirths_CumulativeUpToMax() public {
        _registerWorld();
        _births(BREEDER, 200, 2023);
        _births(BREEDER, 55, 2023);
        assertEq(ledger.birthsInYear(BREEDER, 2023), 255);
    }

    function test_RecordBirths_YearsAreIndependent() public {
        _registerWorld();
        _births(BREEDER, 255, 2023);
        _births(BREEDER, 255, 2024);
        assertEq(ledger.birthsInYear(BREEDER, 2024), 255);
        assertEq(ledger.balanceOf(BREEDER), BREEDER_INIT + 510);
    }

    function test_RecordBirths_EmitsEvent() public {
        _registerWorld();
        _births(BREEDER, 100, 2023);
        vm.expectEmit(address(ledger));
        emit IHerdLedger.BirthsRecorded(BREEDER, 2023, 50, 150, BREEDER_INIT + 150);
        _births(BREEDER, 50, 2023);
    }

    function test_RecordBirths_EmitsCapacityExceeded() public {
        _registerRanch(BREEDER, 100, 100, 100); // max 85 births
        vm.expectEmit(address(ledger));
        emit IHerdLedger.CapacityExceeded(BREEDER, 185, 100);
        _births(BREEDER, 85, 2023);
    }

    function test_RecordBirths_AllowedWhileEmbargoed() public {
        _registerWorld();
        _embargo(BREEDER, true);
        _births(BREEDER, 10, 2023);
        assertEq(ledger.balanceOf(BREEDER), BREEDER_INIT + 10);
    }

    function test_RevertWhen_RecordBirths_SingleEntryExceedsBiology() public {
        _registerWorld();
        vm.expectRevert(
            abi.encodeWithSelector(IHerdLedger.BirthsExceedBiology.selector, BREEDER, uint16(2023), 256, 255)
        );
        _births(BREEDER, 256, 2023);
    }

    function test_RevertWhen_RecordBirths_CumulativeExceedsBiology() public {
        _registerWorld();
        _births(BREEDER, 250, 2023);
        vm.expectRevert(
            abi.encodeWithSelector(IHerdLedger.BirthsExceedBiology.selector, BREEDER, uint16(2023), 256, 255)
        );
        _births(BREEDER, 6, 2023);
    }

    function test_RevertWhen_RecordBirths_IntermediaryWithoutCows() public {
        // The "phantom births" pattern: an intermediary with no cows declaring calves.
        _registerWorld();
        vm.expectRevert(
            abi.encodeWithSelector(IHerdLedger.BirthsExceedBiology.selector, MIDDLEMAN, uint16(2025), 500, 0)
        );
        _births(MIDDLEMAN, 500, 2025);
    }

    function test_RevertWhen_RecordBirths_ZeroHead() public {
        _registerWorld();
        vm.expectRevert(IHerdLedger.ZeroHead.selector);
        _births(BREEDER, 0, 2023);
    }

    function test_RevertWhen_RecordBirths_UnknownRanch() public {
        vm.expectRevert(_err(IHerdLedger.UnknownEntity.selector, UNKNOWN));
        _births(UNKNOWN, 1, 2023);
    }

    function test_RevertWhen_RecordBirths_OnSink() public {
        _registerWorld();
        vm.expectRevert(_err(IHerdLedger.NotARanch.selector, PORT));
        _births(PORT, 1, 2023);
    }

    function test_RevertWhen_RecordBirths_CallerNotRegistrar() public {
        _registerWorld();
        vm.expectRevert(_unauthorized(issuer, ledger.REGISTRAR_ROLE()));
        vm.prank(issuer);
        ledger.recordBirths(BREEDER, 1, 2023);
    }

    // ------------------------------------------------------------------ recordDeaths

    function test_RecordDeaths_UpdatesBalanceAndTotals() public {
        _registerWorld();
        _deaths(BREEDER, 4);
        assertEq(ledger.balanceOf(BREEDER), BREEDER_INIT - 4);
        assertEq(ledger.ranch(BREEDER).totalDeaths, 4);
        assertEq(ledger.totals().deaths, 4);
        assertEq(ledger.totals().ranchHead, BREEDER_INIT + FATTENER_INIT - 4);
        assertTrue(ledger.isConserved());
    }

    function test_RecordDeaths_EntireHerd() public {
        _registerWorld();
        _deaths(BREEDER, BREEDER_INIT);
        assertEq(ledger.balanceOf(BREEDER), 0);
    }

    function test_RecordDeaths_EmitsEvent() public {
        _registerWorld();
        vm.expectEmit(address(ledger));
        emit IHerdLedger.DeathsRecorded(BREEDER, 4, BREEDER_INIT - 4);
        _deaths(BREEDER, 4);
    }

    function test_RecordDeaths_AllowedWhileEmbargoed() public {
        _registerWorld();
        _embargo(BREEDER, true);
        _deaths(BREEDER, 1);
        assertEq(ledger.balanceOf(BREEDER), BREEDER_INIT - 1);
    }

    function test_RevertWhen_RecordDeaths_MoreThanHerd() public {
        _registerWorld();
        vm.expectRevert(
            abi.encodeWithSelector(
                IHerdLedger.InsufficientHerd.selector, BREEDER, BREEDER_INIT, BREEDER_INIT + 1
            )
        );
        _deaths(BREEDER, BREEDER_INIT + 1);
    }

    function test_RevertWhen_RecordDeaths_EmptyRanch() public {
        _registerWorld();
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InsufficientHerd.selector, MIDDLEMAN, 0, 1));
        _deaths(MIDDLEMAN, 1);
    }

    function test_RevertWhen_RecordDeaths_ZeroHead() public {
        _registerWorld();
        vm.expectRevert(IHerdLedger.ZeroHead.selector);
        _deaths(BREEDER, 0);
    }

    function test_RevertWhen_RecordDeaths_UnknownRanch() public {
        vm.expectRevert(_err(IHerdLedger.UnknownEntity.selector, UNKNOWN));
        _deaths(UNKNOWN, 1);
    }

    function test_RevertWhen_RecordDeaths_OnSink() public {
        _registerWorld();
        vm.expectRevert(_err(IHerdLedger.NotARanch.selector, SLAUGHTERHOUSE));
        _deaths(SLAUGHTERHOUSE, 1);
    }

    function test_RevertWhen_RecordDeaths_CallerNotRegistrar() public {
        _registerWorld();
        vm.expectRevert(_unauthorized(regulator, ledger.REGISTRAR_ROLE()));
        vm.prank(regulator);
        ledger.recordDeaths(BREEDER, 1);
    }
}
