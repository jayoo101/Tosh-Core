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

        // PancakeSwap Infinity's CLPoolManager and Vault. Override both with
        // real fork addresses when you want launches to actually initialise a
        // pool; the stubs are fine for exercising factory-level flows (PoG,
        // referral binding, eligibility), which never reach the AMM.
        //
        // Distinct stub values on purpose. They are separate contracts under
        // Infinity, and a single stub used for both would let a wiring mistake
        // that conflates them pass here and fail only on a real chain.
        address poolManager = vm.envOr("INFINITY_CL_POOL_MANAGER", address(1));
        address vault = vm.envOr("INFINITY_VAULT", address(2));

        // REQUIRED even on anvil, and deliberately not defaulted to `deployer`.
        //
        // `platformTreasury` now receives 0.30 % of the ETH input of every buy
        // (`ToshLaunchpadHook.PLATFORM_SWAP_FEE_BPS`) and is immutable on both
        // the factory and the hook implementation. A default here would train
        // the muscle memory that this address does not need thinking about,
        // which on a real chain is an unrecoverable mistake — there is no
        // setter, so a wrong value means redeploying the factory.
        //
        // Set it to anvil account #1 for local work:
        //   PLATFORM_TREASURY=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
        address platformTreasury = vm.envAddress("PLATFORM_TREASURY");
        require(platformTreasury != address(0), "PLATFORM_TREASURY unset");

        // REQUIRED, and it cannot be stubbed the way the manager and Vault are.
        //
        // `address(1)` works for those because nothing in the constructors calls
        // them. The quote asset is different: the hook's constructor calls
        // `decimals()` on it and requires 8, so a stub address reverts the deploy.
        // That is deliberate — the alternative is a local factory whose pools
        // would sort the wrong way and whose ladder geometry would be computed
        // against the wrong precision.
        //
        // For local work, deploy an 8-decimal mock first and pass it here. Do not
        // reach for an 18-decimal one: it will be rejected, and if the assertion
        // were ever relaxed the shelf ladder would silently change shape.
        address quoteAsset = vm.envAddress("QUOTE_ASSET");
        require(quoteAsset != address(0), "QUOTE_ASSET unset");

        vm.startBroadcast(deployerPk);

        // Treasury first — the factory needs its address at construction time.
        ToshLadderTreasury treasury = new ToshLadderTreasury(poolManager, vault, deployer, quoteAsset);
        console.log("ToshLadderTreasury deployed at:", address(treasury));

        ToshFactory factory = new ToshFactory(
            poolManager, // _poolManager      (Infinity CLPoolManager)
            vault, // _vault            (Infinity Vault)
            deployer, // _pogSigner        (deployer signs PoG attestations)
            platformTreasury, // _platformTreasury (0.30 % of every buy, immutable)
            address(treasury), // _ladderTreasury
            quoteAsset // _quoteAsset       (also currency0 of every pool)
        );

        treasury.setFactory(address(factory));

        console.log("====================================");
        console.log("COMMANDER, FACTORY DEPLOYED AT:");
        console.log(address(factory));
        console.log("Ladder Treasury :", address(treasury));
        console.log("PoG Signer      :", deployer);
        console.log("Platform Treasury (0.30% of buys, IMMUTABLE):", platformTreasury);
        console.log("====================================");
        console.log("v5.0: launch fee and deposits are the QUOTE ASSET -- approve first.");
        console.log("      quote asset:", quoteAsset);
        // The 0x20CC line that used to sit here was Uniswap V4's hook-permission
        // mask, and it was the last place in the deploy scripts still telling an
        // operator to mine an address. Infinity reads permissions from the hook's
        // own bitmap, so any salt lands.
        console.log("      Any hook salt is admissible; no address mining.");
        console.log("====================================");

        vm.stopBroadcast();
    }
}
