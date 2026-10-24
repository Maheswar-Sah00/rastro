// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {HerdLedger} from "../../src/HerdLedger.sol";
import {IHerdLedger} from "../../src/IHerdLedger.sol";
import {LedgerFixture} from "../utils/LedgerFixture.sol";

/// @notice Constructor, roles, views, multicall batching and an end-to-end laundering scenario.
contract LedgerViewsTest is LedgerFixture {
    // ------------------------------------------------------------------ constructor & roles

    function test_Constructor_GrantsOnlyAdmin() public {
        HerdLedger fresh = new HerdLedger(admin);
        assertTrue(fresh.hasRole(fresh.DEFAULT_ADMIN_ROLE(), admin));
        assertFalse(fresh.hasRole(fresh.DEFAULT_ADMIN_ROLE(), address(this)));
        assertFalse(fresh.hasRole(fresh.REGISTRAR_ROLE(), admin));
        assertFalse(fresh.hasRole(fresh.ORACLE_ROLE(), admin));
    }

    function test_Roles_AreDistinct() public view {
        bytes32[6] memory roles = [
            ledger.DEFAULT_ADMIN_ROLE(),
            ledger.REGISTRAR_ROLE(),
            ledger.ISSUER_ROLE(),
            ledger.REGULATOR_ROLE(),
            ledger.ORACLE_ROLE(),
            ledger.BUYER_ROLE()
        ];
        for (uint256 i = 0; i < roles.length; ++i) {
            for (uint256 j = i + 1; j < roles.length; ++j) {
                assertTrue(roles[i] != roles[j]);
            }
        }
    }

    function test_AdminGrantsAndRevokesRoles() public {
        bytes32 role = ledger.BUYER_ROLE();
        vm.prank(admin);
        ledger.grantRole(role, stranger);
        assertTrue(ledger.hasRole(role, stranger));
        vm.prank(admin);
        ledger.revokeRole(role, stranger);
        assertFalse(ledger.hasRole(role, stranger));
    }

    function test_RevertWhen_NonAdminGrantsRole() public {
        bytes32 role = ledger.ORACLE_ROLE();
        bytes32 adminRole = ledger.DEFAULT_ADMIN_ROLE();
        vm.expectRevert(_unauthorized(registrar, adminRole));
        vm.prank(registrar);
        ledger.grantRole(role, registrar);
    }

    function test_RenounceRole() public {
        bytes32 role = ledger.BUYER_ROLE();
        vm.prank(buyer);
        ledger.renounceRole(role, buyer);
        assertFalse(ledger.hasRole(role, buyer));
    }

    function test_SupportsInterface() public view {
        assertTrue(ledger.supportsInterface(type(IAccessControl).interfaceId));
        assertTrue(ledger.supportsInterface(type(IERC165).interfaceId));
        assertFalse(ledger.supportsInterface(0xffffffff));
    }

    // ------------------------------------------------------------------ views

    function test_BalanceOf_RanchSinkAndUnknown() public {
        _registerWorld();
        _move(_gtaHash("G"), FATTENER, PORT, 40);
        assertEq(ledger.balanceOf(FATTENER), FATTENER_INIT - 40);
        assertEq(ledger.balanceOf(PORT), 40);
        assertEq(ledger.balanceOf(UNKNOWN), 0);
    }

    function test_EntityType_AllKinds() public {
        _registerWorld();
        assertEq(uint8(ledger.entityType(BREEDER)), uint8(IHerdLedger.EntityType.Ranch));
        assertEq(uint8(ledger.entityType(PORT)), uint8(IHerdLedger.EntityType.Sink));
        assertEq(uint8(ledger.entityType(UNKNOWN)), uint8(IHerdLedger.EntityType.None));
    }

    function test_Views_DefaultsForUnknownIds() public view {
        assertEq(ledger.ranch(UNKNOWN).head, 0);
        assertEq(ledger.sink(UNKNOWN).kind, 0);
        assertEq(ledger.gta(UNKNOWN).from, bytes32(0));
        assertFalse(ledger.certificate(UNKNOWN).issued);
        assertEq(ledger.certificateGtas(UNKNOWN).length, 0);
        assertEq(ledger.riskOf(UNKNOWN).oracle, address(0));
        assertEq(ledger.birthsInYear(UNKNOWN, 2024), 0);
        assertFalse(ledger.isNonceUsed(oracle, 1));
    }

    function test_Totals_TrackEveryFlow() public {
        _registerWorld();
        _births(BREEDER, 100, 2024);
        _deaths(FATTENER, 5);
        _move(_gtaHash("A"), BREEDER, MIDDLEMAN, 150);
        _move(_gtaHash("B"), MIDDLEMAN, PORT, 150);
        IHerdLedger.Totals memory t = ledger.totals();
        assertEq(t.ranches, 3);
        assertEq(t.sinks, 2);
        assertEq(t.movements, 2);
        assertEq(t.initialHead, BREEDER_INIT + FATTENER_INIT);
        assertEq(t.births, 100);
        assertEq(t.deaths, 5);
        assertEq(t.headToSinks, 150);
        assertEq(t.ranchHead, BREEDER_INIT + FATTENER_INIT + 100 - 5 - 150);
        assertEq(
            t.ranchHead, ledger.balanceOf(BREEDER) + ledger.balanceOf(MIDDLEMAN) + ledger.balanceOf(FATTENER)
        );
        assertTrue(ledger.isConserved());
    }

    function test_DomainSeparator_MatchesEip712AndEip5267() public view {
        assertEq(ledger.DOMAIN_SEPARATOR(), _domainSeparator(address(ledger)));
        (bytes1 fields, string memory name, string memory version, uint256 chainId, address verifying,,) =
            ledger.eip712Domain();
        assertEq(fields, hex"0f");
        assertEq(name, "Rastro HerdLedger");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifying, address(ledger));
    }

    function test_DomainSeparator_FollowsChainId() public {
        bytes32 before = ledger.DOMAIN_SEPARATOR();
        vm.chainId(84_532);
        assertTrue(ledger.DOMAIN_SEPARATOR() != before);
        assertEq(ledger.DOMAIN_SEPARATOR(), _domainSeparator(address(ledger)));
    }

    function test_Typehashes_MatchSpec() public view {
        assertEq(ledger.RISK_ATTESTATION_TYPEHASH(), RISK_TYPEHASH);
        assertEq(ledger.CERTIFICATE_TYPEHASH(), CERT_TYPEHASH);
    }

    // ------------------------------------------------------------------ multicall

    function test_Multicall_BatchesRegistrations() public {
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(HerdLedger.registerRanch, (BREEDER, 1000, 800, 300, GEOM));
        calls[1] = abi.encodeCall(HerdLedger.registerRanch, (MIDDLEMAN, 200, 0, 0, GEOM));
        calls[2] = abi.encodeCall(HerdLedger.registerSink, (PORT, 2));
        vm.prank(registrar);
        ledger.multicall(calls);
        assertEq(ledger.totals().ranches, 2);
        assertEq(ledger.totals().sinks, 1);
    }

    function test_Multicall_InnerCallsKeepTheirRoleChecks() public {
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(HerdLedger.registerSink, (PORT, 2));
        vm.expectRevert(_unauthorized(stranger, ledger.REGISTRAR_ROLE()));
        vm.prank(stranger);
        ledger.multicall(calls);
    }

    function test_Multicall_CannotMixRolesTheSenderLacks() public {
        _registerWorld();
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(HerdLedger.recordBirths, (BREEDER, 10, 2024));
        calls[1] = abi.encodeCall(HerdLedger.recordMovement, (_gtaHash("X"), BREEDER, PORT, 10, 3, DATE));
        vm.expectRevert(_unauthorized(registrar, ledger.ISSUER_ROLE()));
        vm.prank(registrar);
        ledger.multicall(calls);
        assertEq(ledger.birthsInYear(BREEDER, 2024), 0, "batch is atomic");
    }

    function test_Multicall_IsAtomicAndBubblesTheInnerError() public {
        _registerWorld();
        bytes[] memory calls = new bytes[](2);
        calls[0] =
            abi.encodeCall(HerdLedger.recordMovement, (_gtaHash("A"), BREEDER, MIDDLEMAN, 100, 1, DATE));
        calls[1] = abi.encodeCall(HerdLedger.recordMovement, (_gtaHash("B"), MIDDLEMAN, PORT, 101, 4, DATE));
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InsufficientHerd.selector, MIDDLEMAN, 100, 101));
        vm.prank(issuer);
        ledger.multicall(calls);
        assertEq(ledger.totals().movements, 0);
        assertEq(ledger.balanceOf(BREEDER), BREEDER_INIT);
    }

    function test_Multicall_RelaysSignedOracleMessages() public {
        _registerWorld();
        IHerdLedger.RiskAttestation memory a = _risk(BREEDER, 2, 9000, 1);
        IHerdLedger.RiskAttestation memory b = _risk(MIDDLEMAN, 1, 6000, 1);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(HerdLedger.attestRisk, (a, _signRisk(oraclePk, a)));
        calls[1] = abi.encodeCall(HerdLedger.attestRisk, (b, _signRisk(oraclePk, b)));
        vm.prank(relayer);
        ledger.multicall(calls);
        assertEq(ledger.riskOf(BREEDER).riskClass, 2);
        assertEq(ledger.riskOf(MIDDLEMAN).riskClass, 1);
    }

    // ------------------------------------------------------------------ end-to-end scenario

    /// @notice Breeder inside a protected area sells calves to a pass-through intermediary, which
    ///         resells to a fattener supplying an export lot. The oracle flags the lot; a buyer
    ///         cannot consume it, cannot re-certify the same GTAs as clean, and once Ibama embargoes
    ///         the breeder no further animals leave it.
    function test_Scenario_LaunderingChainIsContained() public {
        _registerWorld();
        _births(BREEDER, 255, 2023);
        bytes32 a = _gtaHash("GTA-PA-2023-000101");
        bytes32 b = _gtaHash("GTA-PA-2023-000102");
        bytes32 c = _gtaHash("GTA-PA-2023-000103");
        _move(a, BREEDER, MIDDLEMAN, 200); // calves to the intermediary
        _move(b, MIDDLEMAN, FATTENER, 200); // resold within days
        _move(c, FATTENER, PORT, 600); // export lot (200 laundered + 400 own)

        _attest(_risk(BREEDER, 2, 9400, 1_735_689_600));
        _attest(_risk(MIDDLEMAN, 2, 8800, 1_735_689_600));

        bytes32 lot = _lot("SHP-0012");
        _issue(_cert(lot, PORT, _list(c), 600, 1));

        vm.expectRevert(_err(IHerdLedger.CertificateNotClean.selector, lot));
        _consume(lot);

        IHerdLedger.Certificate memory cleanRetry = _cert(_lot("SHP-0012b"), PORT, _list(c), 600, 0);
        bytes memory sig = _signCert(oraclePk, cleanRetry);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.GtaAlreadyCertified.selector, c, lot));
        ledger.issueCertificate(cleanRetry, sig);

        _embargo(BREEDER, true);
        vm.expectRevert(_err(IHerdLedger.OriginEmbargoed.selector, BREEDER));
        _move(_gtaHash("GTA-DEMO-EMBARGO"), BREEDER, PORT, 50);

        assertTrue(ledger.isConserved());
        assertEq(ledger.totals().headToSinks, 600);
    }

    function test_Scenario_CleanLotConsumedExactlyOnce() public {
        _registerWorld();
        bytes32 g = _gtaHash("GTA-PA-2025-000777");
        _move(g, FATTENER, SLAUGHTERHOUSE, 480);
        bytes32 lot = _lot("SHP-0007");
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g), 480, 0));
        _consume(lot);
        vm.expectRevert(_err(IHerdLedger.CertificateAlreadyUsed.selector, lot));
        _consume(lot);
        assertEq(ledger.totals().consumed, 1);
    }
}
