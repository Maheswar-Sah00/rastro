// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {HerdLedger} from "../../src/HerdLedger.sol";
import {Deploy} from "../../script/Deploy.s.sol";

/// @notice The deployment script grants every role to the configured holders.
/// @dev Environment variables are process-wide, so everything that sets them lives in one test.
contract DeployScriptTest is Test {
    address internal constant ANVIL_0 = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address internal constant ANVIL_1 = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address internal constant ANVIL_2 = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    address internal constant ANVIL_3 = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;
    address internal constant ANVIL_5 = 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc;

    function test_Deploy_LocalDefaultsThenPublicChainWithEnvOverrides() public {
        // 1. Anvil: dev accounts, no configuration (unless a developer .env overrides them).
        vm.chainId(31_337);
        (HerdLedger local,) = new Deploy().run();
        assertTrue(local.hasRole(local.DEFAULT_ADMIN_ROLE(), vm.envOr("ADMIN_ADDRESS", ANVIL_0)));
        address registrar = vm.envOr("REGISTRAR_ADDRESS", ANVIL_1);
        assertTrue(local.hasRole(local.REGISTRAR_ROLE(), registrar));
        assertTrue(local.hasRole(local.ISSUER_ROLE(), vm.envOr("ISSUER_ADDRESS", registrar)));
        assertTrue(local.hasRole(local.REGULATOR_ROLE(), vm.envOr("REGULATOR_ADDRESS", ANVIL_2)));
        assertTrue(local.hasRole(local.BUYER_ROLE(), vm.envOr("BUYER_ADDRESS", ANVIL_3)));
        assertTrue(local.hasRole(local.ORACLE_ROLE(), vm.envOr("ORACLE_ADDRESS", ANVIL_5)));

        // 2. Public chain: deployer key from PRIVATE_KEY, explicit role holders, admin handed over.
        vm.chainId(84_532);
        (address deployer, uint256 pk) = makeAddrAndKey("testnet-deployer");
        address admin = makeAddr("multisig");
        address oracle = makeAddr("oracle-signer");
        address buyer = makeAddr("exporter");
        vm.deal(deployer, 1 ether);
        vm.setEnv("PRIVATE_KEY", vm.toString(bytes32(pk)));
        vm.setEnv("ADMIN_ADDRESS", vm.toString(admin));
        vm.setEnv("REGISTRAR_ADDRESS", vm.toString(deployer));
        vm.setEnv("ISSUER_ADDRESS", vm.toString(deployer));
        vm.setEnv("REGULATOR_ADDRESS", vm.toString(deployer));
        vm.setEnv("ORACLE_ADDRESS", vm.toString(oracle));
        vm.setEnv("BUYER_ADDRESS", vm.toString(buyer));

        (HerdLedger pub, Deploy.Roles memory roles) = new Deploy().run();
        assertEq(roles.admin, admin);
        assertTrue(pub.hasRole(pub.DEFAULT_ADMIN_ROLE(), admin));
        assertFalse(pub.hasRole(pub.DEFAULT_ADMIN_ROLE(), deployer), "deployer renounced admin");
        assertTrue(pub.hasRole(pub.PAUSER_ROLE(), admin));
        assertFalse(pub.hasRole(pub.PAUSER_ROLE(), deployer), "deployer renounced pauser");
        assertTrue(pub.hasRole(pub.REGISTRAR_ROLE(), deployer));
        assertTrue(pub.hasRole(pub.ISSUER_ROLE(), deployer));
        assertTrue(pub.hasRole(pub.REGULATOR_ROLE(), deployer));
        assertTrue(pub.hasRole(pub.ORACLE_ROLE(), oracle));
        assertTrue(pub.hasRole(pub.BUYER_ROLE(), buyer));
        assertFalse(pub.hasRole(pub.ORACLE_ROLE(), deployer));
    }
}
