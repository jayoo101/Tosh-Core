// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console2.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";

/*//////////////////////////////////////////////////////////////////////////
//  RecomputeInitcodeHash.s.sol
//
//  Live-reads the freshly-deployed factory's
//  `getLiveHookInitcodeHash()` and `HOOK_CREATION_CODEHASH` so the
//  published record can be reseated against the production build, and
//  asserts the latter against this tree's creation bytecode.
//
//  Why this script exists
//  ──────────────────────
//  The frontend's `hookAddress.ts` precomputes the (factory, salt, initcode)
//  CREATE2 address.  When `ToshLaunchpadHook.sol` changes — even by a
//  single bytecode-level peephole — the runtime `initcodeHash` shifts.
//  Mining against a stale hash produces wrong predicted addresses.
//
//  ⚠ AND NOTHING ON CHAIN REFUSES THEM ANY MORE. This paragraph used to end
//    "every `createLaunch()` reverts on the on-chain `InvalidHookSalt` check",
//    which was true under Uniswap V4 and is not true now: the PancakeSwap
//    Infinity port deleted the address-bit gate, because Infinity reads hook
//    permissions from `getHooksRegistrationBitmap()` rather than from the low
//    bits of the address. `hookSalt` may be any value, `InvalidHookSalt` no
//    longer exists, and a stale prediction DEPLOYS SUCCESSFULLY — at an address
//    the UI then cannot name.
//
//    So the failure changed shape from a revert every caller sees to a silent
//    mismatch, and the things that still catch it are off-chain and must stay in
//    the pipeline: `scripts/checkCloneInitcodeTuple.mjs` (in `test.yml` and
//    `precheck.ps1`), `test_hookInitcodeHash_matchesHandBuiltCloneInitcode`, and
//    reading `factory.hookInitcodeHash(...)` live rather than pasting a constant.
//    Do not carry a hash from one chain to another: the factory is CREATE'd, so
//    the deployer differs, and the hook implementation address inside the clone
//    initcode differs with it.
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
//  exist, which is the same defect a dead path in an old playbook already
//  had to correct once. The launch page reads `factory.hookInitcodeHash(...)`
//  from chain and mines against that. The JSON is the published record —
//  commit it (the sibling VerifyDeployment snapshot lives next to this
//  script) and never hardcode it in tooling that could instead
//  ask the factory.
//
//  On-demand, not CI. This script talks to a live RPC. The 4663 public
//  endpoint rate-limits a tight request loop,
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
        address poolManager = factory.poolManager();
        address pogSigner = factory.pogSigner();
        address platformTreasury = factory.platformTreasury();
        address ladderTreasury = factory.ladderTreasury();
        address circuitNFT = factory.circuitNFT();
        uint256 maxPogAlloc = factory.maxPogAllocationLimit();

        // Like-with-like only. `HOOK_CREATION_CODEHASH` is keccak256 of the
        // hook implementation's creation code (`HookDeployLib.creationCodeHash`,
        // which is `keccak256(type(ToshLaunchpadHook).creationCode)`). That is
        // the comparison §5.26 performed by hand against the artifact's
        // `bytecode.object`.
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

        console2.log("Wired V4 PoolManager    :", poolManager);
        console2.log("Wired PoG signer        :", pogSigner);
        console2.log("Wired Platform Treasury :", platformTreasury);
        console2.log("  (immutable; takes 0.30% of every buy's ETH input)");
        console2.log("Wired Ladder Treasury   :", ladderTreasury);
        console2.log("Circuit NFT             :", circuitNFT);
        console2.log("Max PoG alloc (wei)     :", maxPogAlloc);
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
        console2.log('  "circuitNFT": "%s",', vm.toString(circuitNFT));
        console2.log('  "maxPogAllocWei": "%s"', vm.toString(maxPogAlloc));
        console2.log("}");
        console2.log("");
        console2.log("A launch's hook address is predicted from");
        console2.log("factory.hookInitcodeHash(developer, owner, hardCap, walletCap, duration),");
        console2.log("read from chain. The creation-code hash above is for publication");
        console2.log("and for checking a deployment against its source.");

        if (!fingerprintMatches) {
            revert HookCreationCodehashMismatch(localCreationHash, creationHash);
        }
    }
}
