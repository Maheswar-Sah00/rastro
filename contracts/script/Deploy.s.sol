// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {HerdLedger} from "../src/HerdLedger.sol";

/// @title Deploy
/// @notice Deploys HerdLedger and grants every role to the configured addresses.
///
///         Local anvil (chain id 31337), no configuration needed:
///           forge script script/Deploy.s.sol --rpc-url anvil --broadcast
///         Public testnet (keys and addresses from .env):
///           forge script script/Deploy.s.sol --rpc-url amoy --broadcast --verify --verifier sourcify
///
/// @dev Environment (all optional on anvil):
///        PRIVATE_KEY         deployer key on public chains. If unset, the CLI signer is used
///                            (--account / --ledger / --private-key). Ignored on anvil, which uses
///                            account #0 (override with ANVIL_PRIVATE_KEY).
///        ADMIN_ADDRESS       final DEFAULT_ADMIN_ROLE and PAUSER_ROLE holder (default: deployer). If it
///                            differs from the deployer, both are handed over and the deployer renounces
///                            them. Use a multisig on public networks.
///        REGISTRAR_ADDRESS   state agency registry desk   (anvil default: account #1)
///        ISSUER_ADDRESS      state agency GTA desk        (default: REGISTRAR_ADDRESS)
///        REGULATOR_ADDRESS   Ibama / prosecutors          (anvil default: account #2)
///        BUYER_ADDRESS       meatpacker / exporter        (anvil default: account #3)
///        ORACLE_ADDRESS      off-chain signer (EIP-712)   (anvil default: account #5)
///      On public chains every role defaults to the deployer, so a single funded key is enough
///      for a demo. Never reuse the anvil keys on a public network: they are well known.
contract Deploy is Script {
    uint256 internal constant ANVIL_CHAIN_ID = 31_337;
    // Default anvil / hardhat mnemonic ("test test ... junk"), accounts #0..#5.
    uint256 internal constant ANVIL_KEY_0 =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address internal constant ANVIL_1 = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address internal constant ANVIL_2 = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    address internal constant ANVIL_3 = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;
    address internal constant ANVIL_5 = 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc;

    struct Roles {
        address admin;
        address registrar;
        address issuer;
        address regulator;
        address buyer;
        address oracle;
    }

    function run() external returns (HerdLedger ledger, Roles memory roles) {
        bool local = block.chainid == ANVIL_CHAIN_ID;
        // On anvil the well-known dev key is used even if a testnet PRIVATE_KEY is in the environment.
        uint256 pk = local ? vm.envOr("ANVIL_PRIVATE_KEY", ANVIL_KEY_0) : vm.envOr("PRIVATE_KEY", uint256(0));

        address deployer;
        if (pk != 0) {
            deployer = vm.addr(pk);
            vm.startBroadcast(pk);
        } else {
            vm.startBroadcast();
            (, deployer,) = vm.readCallers();
        }

        roles = resolveRoles(deployer, local);
        ledger = deployAndConfigure(deployer, roles);
        vm.stopBroadcast();

        console2.log("HerdLedger deployed at", address(ledger));
        console2.log("  chain id ", block.chainid);
        console2.log("  admin    ", roles.admin);
        console2.log("  registrar", roles.registrar);
        console2.log("  issuer   ", roles.issuer);
        console2.log("  regulator", roles.regulator);
        console2.log("  buyer    ", roles.buyer);
        console2.log("  oracle   ", roles.oracle);
    }

    /// @notice Role holders from the environment, with anvil or deployer defaults.
    function resolveRoles(address deployer, bool local) public view returns (Roles memory r) {
        r.admin = vm.envOr("ADMIN_ADDRESS", deployer);
        r.registrar = vm.envOr("REGISTRAR_ADDRESS", local ? ANVIL_1 : deployer);
        r.issuer = vm.envOr("ISSUER_ADDRESS", r.registrar);
        r.regulator = vm.envOr("REGULATOR_ADDRESS", local ? ANVIL_2 : deployer);
        r.buyer = vm.envOr("BUYER_ADDRESS", local ? ANVIL_3 : deployer);
        r.oracle = vm.envOr("ORACLE_ADDRESS", local ? ANVIL_5 : deployer);
    }

    /// @dev Must run inside a broadcast (or prank) as `deployer`.
    function deployAndConfigure(address deployer, Roles memory r) public returns (HerdLedger ledger) {
        ledger = new HerdLedger(deployer);
        ledger.grantRole(ledger.REGISTRAR_ROLE(), r.registrar);
        ledger.grantRole(ledger.ISSUER_ROLE(), r.issuer);
        ledger.grantRole(ledger.REGULATOR_ROLE(), r.regulator);
        ledger.grantRole(ledger.BUYER_ROLE(), r.buyer);
        ledger.grantRole(ledger.ORACLE_ROLE(), r.oracle);
        if (r.admin != deployer) {
            // The final admin also becomes the pauser; the deployer keeps neither role.
            ledger.grantRole(ledger.PAUSER_ROLE(), r.admin);
            ledger.grantRole(ledger.DEFAULT_ADMIN_ROLE(), r.admin);
            ledger.renounceRole(ledger.PAUSER_ROLE(), deployer);
            ledger.renounceRole(ledger.DEFAULT_ADMIN_ROLE(), deployer);
        }
    }
}
