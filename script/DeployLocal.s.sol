// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";

contract DeployLocal is Script {
    function run() external {
        // Anvil default account #0 private key
        uint256 deployerPk = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
        address deployer = vm.addr(deployerPk);

        // That key is published in Anvil's banner, so anything it deploys is
        // owned by everyone.  Refuse to broadcast outside a local devnet.
        require(block.chainid == 31337 || block.chainid == 1337, "DeployLocal is for anvil (31337/1337) only");

        // Uniswap V4 PoolManager. Override with a real fork address when you
        // want launches to actually initialise a pool; the stub is fine for
        // exercising factory-level flows (PoG, referral binding, eligibility).
        address poolManager = vm.envOr("V4_POOL_MANAGER", address(1));

        vm.startBroadcast(deployerPk);

        // Treasury first — the factory needs its address at construction time.
        ToshLadderTreasury treasury = new ToshLadderTreasury(poolManager, deployer);
        console.log("ToshLadderTreasury deployed at:", address(treasury));

        ToshFactory factory = new ToshFactory(
            poolManager, // _poolManager
            deployer, // _pogSigner        (deployer signs PoG attestations)
            deployer, // _platformTreasury
            address(treasury) // _ladderTreasury
        );

        treasury.setFactory(address(factory));

        console.log("====================================");
        console.log("COMMANDER, FACTORY DEPLOYED AT:");
        console.log(address(factory));
        console.log("Ladder Treasury :", address(treasury));
        console.log("PoG Signer      :", deployer);
        console.log("====================================");
        console.log("v5.0: launch fee and deposits are NATIVE ETH (no approve).");
        console.log("      Hook salt mask is 0x20CC.");
        console.log("====================================");

        vm.stopBroadcast();
    }
}
