// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console2.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";

/*//////////////////////////////////////////////////////////////////////////
//  RecomputeInitcodeHash.s.sol
//
//  Pre-mainnet item #23 (PM-C6 in docs/PRE_MAINNET_CHECKLIST.md, where the
//  numbering is defined) — Live-reads the freshly-deployed factory's
//  `getLiveHookInitcodeHash()` and `HOOK_CREATION_CODEHASH` so the
//  published record can be reseated against the production build, and
//  asserts the latter against this tree's creation bytecode.
//
//  Why this script exists
//  ──────────────────────
//  The frontend's `hookMiner.ts` precomputes the (factory, salt, initcode)
//  CREATE2 address.  When `ToshLaunchpadHook.sol` changes — even by a
//  single bytecode-level peephole — the runtime `initcodeHash` shifts.
//  Mining against a stale hash produces wrong predicted addresses, and
//  every `createLaunch()` reverts on the on-chain `InvalidHookSalt` check.
//
//  Usage (against an ALREADY-deployed factory address — env or arg).
//  The contract declares both `run()` and `run(address)`, so forge cannot
//  pick an entry point from the ABI alone and needs `--sig`. Without it
//  the command fails with "Multiple functions with the same name 'run'
//  found in the ABI":
//
//      forge script script/RecomputeInitcodeHash.s.sol:RecomputeInitcodeHashScript \
//        --rpc-url $TARGET_RPC \
//        --sig 'run(address)' $FACTORY_ADDRESS \
//        -vvv
//
//      forge script script/RecomputeInitcodeHash.s.sol:RecomputeInitcodeHashScript \
//        --rpc-url $TARGET_RPC \
//        --sig 'run()' \
//        -vvv
//
//  The script does NOT broadcast — it only reads.  There is no frontend
//  file to paste the JSON into. A previous version of this header named
//  `soat-frontend/src/app/lib/factoryDeployments.ts`; that file does not
//  exist, which is the same defect INCIDENT_RESPONSE.md §2 Step 1 already
//  had to correct once. The launch page reads `factory.hookInitcodeHash(...)`
//  from chain and mines against that. The JSON is the published record —
//  commit it (docs/SECURITY_AUDIT.md is where the sibling VerifyDeployment
//  snapshot lives) and never hardcode it in tooling that could instead
//  ask the factory.
//
//  On-demand, not CI. This script talks to a live RPC. The 4663 public
//  endpoint rate-limits a tight request loop (SECURITY_AUDIT.md §5.28),
//  and putting that on every push is how the mainnet watcher reported
//  success while blind. Run it when a deployment needs a fingerprint,
//  not on every commit.
//////////////////////////////////////////////////////////////////////////*/

contract RecomputeInitcodeHashScript is Script {
    error HookCreationCodehashMismatch(bytes32 local, bytes32 onChain);

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

        // ── Read every value the published record needs ────────────────────
        bytes32 creationHash = factory.HOOK_CREATION_CODEHASH();
        bytes32 liveHash = factory.getLiveHookInitcodeHash();
        address poolManager = factory.poolManager();
        address pogSigner = factory.pogSigner();
        address platformTreasury = factory.platformTreasury();
        address ladderTreasury = factory.ladderTreasury();
        uint256 launchFee = factory.launchFee();
        uint256 defaultSoftCap = factory.defaultSoftCap();
        uint256 maxPogAlloc = factory.maxPogAllocationLimit();

        // Like-with-like only. `HOOK_CREATION_CODEHASH` is keccak256 of the
        // hook implementation's creation code (`HookDeployLib.creationCodeHash`,
        // which is `keccak256(type(ToshLaunchpadHook).creationCode)`). That is
        // the comparison §5.26 performed by hand against the artifact's
        // `bytecode.object`. `getLiveHookInitcodeHash()` is a different
        // measurement — the clone initcode hash built from sentinel constructor
        // values — and is supposed to differ. Do not compare the two hashes
        // to each other; an operator who treats them as a pair will conclude
        // the deployment is broken. See VerifyDeployment.s.sol.
        bytes32 localCreationHash = keccak256(type(ToshLaunchpadHook).creationCode);
        bool fingerprintMatches = localCreationHash == creationHash;

        console2.log("============================================================");
        console2.log("Tosh Factory  ::  Live State Snapshot");
        console2.log("============================================================");
        console2.log("Factory                 :", factoryAddr);
        console2.log("Chain ID                :", block.chainid);
        console2.log("Block                   :", block.number);
        console2.log("------------------------------------------------------------");
        console2.log("HOOK_CREATION_CODEHASH  :", vm.toString(creationHash));
        console2.log("local creationCode hash :", vm.toString(localCreationHash));
        if (fingerprintMatches) {
            console2.log("  MATCH -- keccak256(type(ToshLaunchpadHook).creationCode)");
            console2.log("  equals on-chain HOOK_CREATION_CODEHASH.");
            console2.log("  This is the implementation creation-code fingerprint.");
        } else {
            console2.log("  MISMATCH -- local creation bytecode does not match");
            console2.log("  on-chain HOOK_CREATION_CODEHASH. This tree did not");
            console2.log("  produce the deployed implementation.");
        }
        console2.log("------------------------------------------------------------");
        console2.log("getLiveHookInitcodeHash :", vm.toString(liveHash));
        console2.log("  clone initcode hash with sentinel constructor values.");
        console2.log("  Different measurement from HOOK_CREATION_CODEHASH;");
        console2.log("  they MUST differ. Not compared, not a mismatch.");
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
        console2.log("JSON drop-in (published record; there is no file to paste this into):");
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

        if (!fingerprintMatches) {
            revert HookCreationCodehashMismatch(localCreationHash, creationHash);
        }
    }
}
