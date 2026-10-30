// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ToshLaunchGatewayV3} from "../src/v3/ToshLaunchGatewayV3.sol";

interface IOwned {
    function owner() external view returns (address);
}

interface IGateway {
    function safe() external view returns (address);
}

interface ISafeOwners {
    function getOwners() external view returns (address[] memory);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Deploy ToshLaunchGatewayV3 for a live v3 factory that a ToshLaunchGateway owns.
//
//    FACTORY_ADDRESS   the factory the new gateway will own
//    PROD_OWNER_SAFE   the Safe behind the current gateway, and the new one
//    PRIVATE_KEY       any funded key; the deployer gets no role
//
//  This only deploys. The Safe then runs, as one batch:
//    1. oldGateway.execute(factory.transferOwnership(newGateway))
//    2. newGateway.execute(acceptOwnership())
//    3. newGateway.haltForever(hook)          — once per project to stop for good
//
//    forge script script/DeployLaunchGatewayV3.s.sol --rpc-url $TARGET_RPC --broadcast --verify
// ─────────────────────────────────────────────────────────────────────────────
contract DeployLaunchGatewayV3 is Script {
    function run() external returns (ToshLaunchGatewayV3 gateway) {
        address factory = vm.envAddress("FACTORY_ADDRESS");
        address safe = vm.envAddress("PROD_OWNER_SAFE");

        require(factory.code.length > 0, "FACTORY_ADDRESS holds no code on this chain");
        require(safe.code.length > 0, "PROD_OWNER_SAFE holds no code on this chain");
        address current = IOwned(factory).owner();
        require(IGateway(current).safe() == safe, "the factory's owner is not a gateway for PROD_OWNER_SAFE");
        require(ISafeOwners(safe).getOwners().length > 0, "PROD_OWNER_SAFE reports no owners");

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        gateway = new ToshLaunchGatewayV3(factory, safe);
        vm.stopBroadcast();

        require(address(gateway.factory()) == factory && address(gateway.safe()) == safe, "gateway wiring");
        console2.log("ToshLaunchGatewayV3:", address(gateway));
        console2.log("  factory:    ", factory);
        console2.log("  safe:       ", safe);
        console2.log("  old gateway:", current);
    }
}
