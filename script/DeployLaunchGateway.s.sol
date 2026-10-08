// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ToshLaunchGateway} from "../src/ToshLaunchGateway.sol";

interface IOwned {
    function owner() external view returns (address);
}

interface ISafeOwners {
    function getOwners() external view returns (address[] memory);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Deploy ToshLaunchGateway for the live factory.
//
//    FACTORY_ADDRESS   the factory the gateway will own
//    PROD_OWNER_SAFE   the Safe that owns it now and will own the gateway
//    PRIVATE_KEY       any funded key; the deployer gets no role
//
//  This only deploys. Ownership moves when the Safe executes the batch from
//  `node scripts/safeLaunchTx.mjs gateway-handoff --gateway <address>`:
//  `factory.transferOwnership(gateway)` then `gateway.execute(acceptOwnership())`.
//
//    forge script script/DeployLaunchGateway.s.sol --rpc-url $TARGET_RPC --broadcast --verify
// ─────────────────────────────────────────────────────────────────────────────
contract DeployLaunchGateway is Script {
    function run() external returns (ToshLaunchGateway gateway) {
        address factory = vm.envAddress("FACTORY_ADDRESS");
        address safe = vm.envAddress("PROD_OWNER_SAFE");

        require(factory.code.length > 0, "FACTORY_ADDRESS holds no code on this chain");
        require(safe.code.length > 0, "PROD_OWNER_SAFE holds no code on this chain");
        require(IOwned(factory).owner() == safe, "the factory is not owned by PROD_OWNER_SAFE");
        require(ISafeOwners(safe).getOwners().length > 0, "PROD_OWNER_SAFE reports no owners");

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        gateway = new ToshLaunchGateway(factory, safe);
        vm.stopBroadcast();

        require(address(gateway.factory()) == factory && address(gateway.safe()) == safe, "gateway wiring");
        console2.log("ToshLaunchGateway:", address(gateway));
        console2.log("  factory:", factory);
        console2.log("  safe:   ", safe);
    }
}
