// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console2.sol";

import {ToshFactory} from "../src/ToshFactory.sol";

/*//////////////////////////////////////////////////////////////////////////
//  RecomputeInitcodeHash.s.sol
//
//  Pre-mainnet item #23 (PM-C6 in docs/PRE_MAINNET_CHECKLIST.md, where the
//  numbering is defined) — Live-reads the freshly-deployed factory's
//  `getLiveHookInitcodeHash()` and `HOOK_CREATION_CODEHASH` so the
//  frontend salt miner can be reseeded against the production build.
//
//  Why this script exists
//  ──────────────────────
//  The frontend's `hookMiner.ts` precomputes the (factory, salt, initcode)
//  CREATE2 address.  When `ToshLaunchpadHook.sol` changes — even by a
//  single bytecode-level peephole — the runtime `initcodeHash` shifts.
//  Mining against a stale hash produces wrong predicted addresses, and
//  every `createLaunch()` reverts on the on-chain `InvalidHookSalt` check.
//
//  Usage (against an ALREADY-deployed factory address — env or arg):
//
//      forge script script/RecomputeInitcodeHash.s.sol:RecomputeInitcodeHashScript \
//        --rpc-url $TARGET_RPC \
//        --sig 'run(address)' $FACTORY_ADDRESS \
//        -vvv
//
//  The script does NOT broadcast — it only reads.  Pipe the JSON tail into
//  `soat-frontend/src/app/lib/factoryDeployments.ts` (or whatever your
//  frontend uses as the per-chain config).
//////////////////////////////////////////////////////////////////////////*/

contract RecomputeInitcodeHashScript is Script {
    function run() external view {
        // Default to env-driven `FACTORY_ADDRESS` if no arg is supplied.
        address factory = vm.envAddress("FACTORY_ADDRESS");
        _dump(factory);
    }

    function run(address factory) external view {
        require(factory != address(0), "factory address required");
        _dump(factory);
    }

    function _dump(address factoryAddr) internal view {
        ToshFactory factory = ToshFactory(factoryAddr);

        // ── Read every value the frontend needs to derive predictedHook ────
        bytes32 creationHash = factory.HOOK_CREATION_CODEHASH();
        bytes32 liveHash = factory.getLiveHookInitcodeHash();
        address poolManager = factory.poolManager();
        address pogSigner = factory.pogSigner();
        address platformTreasury = factory.platformTreasury();
        address ladderTreasury = factory.ladderTreasury();
        uint256 launchFee = factory.launchFee();
        uint256 defaultSoftCap = factory.defaultSoftCap();
        uint256 maxPogAlloc = factory.maxPogAllocationLimit();

        console2.log("============================================================");
        console2.log("Tosh Factory  ::  Live State Snapshot");
        console2.log("============================================================");
        console2.log("Factory                 :", factoryAddr);
        console2.log("Chain ID                :", block.chainid);
        console2.log("Block                   :", block.number);
        console2.log("------------------------------------------------------------");
        console2.log("HOOK_CREATION_CODEHASH  :", vm.toString(creationHash));
        console2.log("getLiveHookInitcodeHash :", vm.toString(liveHash));
        console2.log("------------------------------------------------------------");
        console2.log("Wired V4 PoolManager    :", poolManager);
        console2.log("Wired PoG signer        :", pogSigner);
        console2.log("Wired Platform Treasury :", platformTreasury);
        console2.log("  (immutable; takes 0.30% of every buy's ETH input)");
        console2.log("Wired Ladder Treasury   :", ladderTreasury);
        console2.log("Launch Fee (wei)        :", launchFee);
        console2.log("Default Soft Cap (wei)  :", defaultSoftCap);
        console2.log("Per-wallet cap (wei)    :", maxPogAlloc);
        console2.log("============================================================");
        console2.log("");
        console2.log("JSON drop-in (paste into soat-frontend/src/app/lib/factoryDeployments.ts):");
        console2.log("{");
        console2.log('  "chainId":', block.chainid);
        console2.log(',  "factory": "%s",', vm.toString(factoryAddr));
        console2.log('  "poolManager": "%s",', vm.toString(poolManager));
        console2.log('  "pogSigner": "%s",', vm.toString(pogSigner));
        console2.log('  "platformTreasury": "%s",', vm.toString(platformTreasury));
        console2.log('  "ladderTreasury": "%s",', vm.toString(ladderTreasury));
        console2.log('  "hookCreationCodehash": "%s",', vm.toString(creationHash));
        console2.log('  "hookInitcodeHash": "%s",', vm.toString(liveHash));
        console2.log('  "launchFeeWei": "%s",', vm.toString(launchFee));
        console2.log('  "defaultSoftCapWei": "%s",', vm.toString(defaultSoftCap));
        console2.log('  "perWalletCapWei": "%s"', vm.toString(maxPogAlloc));
        console2.log("}");
        console2.log("");
        console2.log("NOTE: `hookInitcodeHash` above is the 24h STANDARD window.");
        console2.log("The genesis duration is part of the constructor tuple, so a");
        console2.log("3h or 72h launch hashes differently and the miner must");
        console2.log("rebuild the hash for whichever window the creator picked.");
        console2.log("");
        console2.log("The frontend needs no copy of this: the launch page reads");
        console2.log("factory.hookInitcodeHash(...) from chain and mines against");
        console2.log("that. This value is for publication and for checking a");
        console2.log("deployment against its source -- so commit it, but never");
        console2.log("hardcode it in tooling that could instead ask the factory.");
    }
}
