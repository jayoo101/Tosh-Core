// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console2.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";
import {HookDeployLib} from "../src/libraries/HookDeployLib.sol";

/*//////////////////////////////////////////////////////////////////////////
//  DeployMainnet.s.sol  —  Production-grade deployer
//
//  Differences from script/Deploy.s.sol (Base Sepolia helper):
//    • No MockSATO and no faucet — v5.0 is ETH-native end to end and the
//      factory has no SATO wiring at all.
//    • Logs the live `hookInitcodeHash` so the frontend salt miner can be
//      regenerated against the mainnet build (item #23 on the pre-mainnet
//      checklist = PM-C6 in docs/PRE_MAINNET_CHECKLIST.md).
//    • Two-step transferOwnership reminder — production MUST hand off to a
//      Gnosis Safe multisig before any users transact.
//
//  TARGET CHAIN: Robinhood Chain, chain id 4663 (docs/ROBINHOOD_MIGRATION.md,
//  which supersedes the PM-B1 "Ethereum L1" decision in
//  docs/PRE_MAINNET_CHECKLIST.md §2).  This header has now been wrong twice —
//  it read "8453 = Base" before it read "1 = Ethereum" — and the reason it
//  never mattered is worth keeping: the script refuses to run unless
//  `block.chainid` equals whatever `TARGET_CHAIN_ID` says, so a stale comment
//  can only send an operator to authorise the wrong chain and waste a broadcast
//  finding out.  It cannot misdeploy anything.
//
//  Verification is Blockscout, not Etherscan.  Chain 4663 is served by neither
//  Etherscan v2's multichain host nor Basescan, and Blockscout needs no API key,
//  so ETHERSCAN_API_KEY has dropped out of this path entirely.
//
//  Required env vars (extend `.env.production` from `.env.example`):
//    PRIVATE_KEY           — deployer EOA (low-privilege; rotates to Safe)
//    TARGET_CHAIN_ID       — chain this run is authorised for (4663 = Robinhood)
//    V4_POOL_MANAGER       — Uniswap V4 PoolManager on the target chain
//    POG_SIGNER_ADDRESS    — backend signer; a NEW EOA, not the deployer
//                            (docs/PRE_MAINNET_CHECKLIST.md §4.1). The private
//                            key lives in Vercel Production, not in this file.
//    PLATFORM_TREASURY     — Gnosis Safe multisig (NOT an EOA)
//    PROD_OWNER_SAFE       — Gnosis Safe multisig that will own the factory
//
//  Deploy command (after `source .env.production`):
//    forge script script/DeployMainnet.s.sol:DeployMainnetScript \
//      --rpc-url $TARGET_RPC \
//      --broadcast \
//      --verify \
//      --verifier blockscout \
//      --verifier-url https://robinhoodchain.blockscout.com/api \
//      -vvvv
//
//  After broadcast, the Safe signers MUST call `acceptOwnership()` on BOTH the
//  factory and the treasury.  The script itself initiates both transfers, so no
//  manual `transferOwnership` is needed; until the Safe accepts, the deployer
//  EOA retains ownership — that is the intended two-step safety mechanism.
//////////////////////////////////////////////////////////////////////////*/

contract DeployMainnetScript is Script {
    /// @dev Public so the test can exercise the 46630 collapse without
    ///      mutating process env — `vm.setEnv` is not snapshotted, and this
    ///      tree's `.env` already has deployer and signer as the same address.
    ///
    ///      `platformTreasury` joined this guard when it went back onto a money
    ///      path.  It receives 0.30 % of the ETH input of every buy, forever
    ///      and immutably, so a deploy that leaves it pointing at the hot
    ///      deployer key sends the platform's entire swap revenue to a
    ///      single-signature EOA that lives on a CI runner — and there is no
    ///      setter to correct it with.  The `pogSigner` collision is worth
    ///      refusing for the same reason it always was, plus one more: the PoG
    ///      signer's key is online by design, so pointing revenue at it is
    ///      strictly worse than pointing revenue at the deployer.
    function requireDistinctRoles(address deployer, address pogSigner, address prodOwnerSafe, address platformTreasury)
        public
        pure
    {
        require(pogSigner != deployer, "POG_SIGNER_ADDRESS must not equal deployer");
        require(prodOwnerSafe != deployer, "PROD_OWNER_SAFE must NOT equal deployer EOA");
        require(platformTreasury != deployer, "PLATFORM_TREASURY must NOT equal deployer EOA");
        require(platformTreasury != pogSigner, "PLATFORM_TREASURY must NOT equal the PoG signer");
    }

    function run() external {
        // ── 1. Load required env vars (no defaults — mainnet must be explicit). ─
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);

        // Refuse to broadcast anywhere the operator did not explicitly name.
        // Every other address here comes from the environment, so a stale or
        // mistyped RPC would otherwise deploy a real, ownable, fee-taking
        // factory onto the wrong chain wired to that chain's non-existent V4.
        uint256 targetChainId = vm.envUint("TARGET_CHAIN_ID");
        require(targetChainId != 0, "TARGET_CHAIN_ID unset");
        require(block.chainid == targetChainId, "chain id mismatch: wrong --rpc-url for this deploy");

        address poolManager = vm.envAddress("V4_POOL_MANAGER");
        require(poolManager != address(0), "V4_POOL_MANAGER unset");

        address pogSigner = vm.envAddress("POG_SIGNER_ADDRESS");
        require(pogSigner != address(0), "POG_SIGNER_ADDRESS unset");

        // Takes 0.30 % of the ETH input of every buy, on every pool, forever.
        // Immutable on the factory AND baked into the hook implementation as
        // `platformFeeRecipient`, so this value cannot be rotated — a mistake
        // here is a factory redeploy, not a config change.
        //
        // It must accept ETH unconditionally: `poolManager.take` performs a raw
        // value transfer and the buy path is NOT fault-isolated, so a recipient
        // whose `receive()` can revert bricks every buy on every pool. A Safe
        // is fine; a contract with conditional logic in `receive()` is not.
        address platformTreasury = vm.envAddress("PLATFORM_TREASURY");
        require(platformTreasury != address(0), "PLATFORM_TREASURY unset");

        address prodOwnerSafe = vm.envAddress("PROD_OWNER_SAFE");
        require(prodOwnerSafe != address(0), "PROD_OWNER_SAFE unset");

        requireDistinctRoles(deployer, pogSigner, prodOwnerSafe, platformTreasury);

        console2.log("============================================================");
        console2.log("Tosh Fair Launchpad -- MAINNET Deployment");
        console2.log("============================================================");
        console2.log("Chain ID (verified)       :", block.chainid);
        console2.log("Deployer (will hand off)  :", deployer);
        console2.log("PROD owner (Gnosis Safe)  :", prodOwnerSafe);
        console2.log("V4 PoolManager            :", poolManager);
        console2.log("PoG Signer (not deployer) :", pogSigner);
        console2.log("Platform fee recipient    :", platformTreasury);
        console2.log("  ^ takes 0.30% of every buy's ETH input. IMMUTABLE: no setter,");
        console2.log("    baked into the hook implementation too. Must accept ETH always.");
        console2.log("------------------------------------------------------------");

        vm.startBroadcast(deployerPk);

        // ── 2. ToshLadderTreasury ───────────────────────────────────────────
        // Deployed first: the factory holds its address as an immutable, and
        // every hook inherits it from the factory.
        //
        // Owned by the deployer just long enough to run `setFactory` (a
        // one-shot the factory's own address is required for), then handed to
        // the Safe via the same two-step dance as the factory.  The window is
        // harmless: the treasury has no withdraw path at all, so even a fully
        // compromised deployer key could only mis-curate the buyback ladder.
        ToshLadderTreasury treasury = new ToshLadderTreasury(poolManager, deployer);
        console2.log("ToshLadderTreasury deployed:", address(treasury));

        ToshFactory factory = new ToshFactory(poolManager, pogSigner, platformTreasury, address(treasury));
        console2.log("ToshFactory deployed      :", address(factory));

        // ── 3. Close the treasury <-> factory loop ──────────────────────────
        treasury.setFactory(address(factory));
        console2.log("Treasury bound to factory.");

        // ── 4. Two-step ownership transfers  (Ownable2Step) ─────────────────
        // The deployer initiates; the Safe completes by calling acceptOwnership()
        // on BOTH contracts.
        factory.transferOwnership(prodOwnerSafe);
        treasury.transferOwnership(prodOwnerSafe);
        console2.log("Ownership of factory + treasury transferred (pending acceptance).");

        vm.stopBroadcast();

        // ── 3. Print mainnet-specific deployment manifest ───────────────────
        console2.log("============================================================");
        console2.log("MAINNET DEPLOY COMPLETE");
        console2.log("============================================================");
        console2.log("FACTORY_ADDRESS          =", address(factory));
        console2.log("TREASURY_ADDRESS         =", address(treasury));
        console2.log("HOOK_CREATION_CODEHASH   =", vm.toString(factory.HOOK_CREATION_CODEHASH()));
        // Reference only.  This hash is built from SENTINEL addresses and the
        // 24h window, so a salt mined against it reverts with InvalidHookSalt
        // for every real launch.  Mine against factory.hookInitcodeHash(...)
        // with the creator's actual addresses and their chosen duration.
        console2.log("SENTINEL_24H_HASH (ref)  =", vm.toString(factory.getLiveHookInitcodeHash()));
        console2.log("DEFAULT_SOFT_CAP_WEI     =", factory.defaultSoftCap());
        console2.log("MAX_POG_ALLOC_WEI        =", factory.maxPogAllocationLimit());
        console2.log("LAUNCH_FEE_WEI           =", factory.launchFee());
        console2.log("============================================================");
        console2.log("");
        console2.log("CRITICAL NEXT STEPS:");
        console2.log("  (Full checklist, with the evidence each step needs before it");
        console2.log("   counts as done: docs/PRE_MAINNET_CHECKLIST.md gate C.)");
        console2.log("  1. Have the Gnosis Safe call acceptOwnership() on BOTH the");
        console2.log("     factory and the ladder treasury -- until that happens the");
        console2.log("     deployer EOA still owns them.");
        console2.log("     Until the Safe accepts, do NOT announce the factory to users.");
        console2.log("  2. Regenerate `soat-frontend/src/app/lib/abis.ts`:");
        console2.log("       forge build");
        console2.log("       node scripts/extractAbis.js");
        console2.log("     The launch page reads factory.hookInitcodeHash(...) from chain,");
        console2.log("     so mining follows a redeploy on its own. The ABI does not:");
        console2.log("     hookInitcodeHash lost its projectAdmin argument in the clone");
        console2.log("     refactor, and a stale abis.ts calls the old selector and reverts.");
        console2.log("  3. Update `soat-frontend/.env.production`:");
        console2.log("       NEXT_PUBLIC_FACTORY_ADDRESS=", address(factory));
        console2.log("       NEXT_PUBLIC_CHAIN_ID=", block.chainid);
        console2.log("  4. Run `forge verify-contract` on the deployed Factory address");
        console2.log("     against Blockscout if --verify above didn't catch it:");
        console2.log("       --verifier blockscout --verifier-url \\");
        console2.log("         https://robinhoodchain.blockscout.com/api");
        console2.log("  5. Pre-fund the PoG signer (a new EOA, not this deployer)");
        console2.log("     with ~0.05 ETH. Its key is in Vercel Production only.");
        console2.log("  6. Wire monitoring:  Defender / Tenderly alerts on FACTORY_ADDRESS");
        console2.log("     for events Paused / Unpaused / OwnershipTransferred /");
        console2.log("     PogSignerUpdated / LaunchCreated.");
        console2.log("     (TreasuryUpdated is gone -- platformTreasury is immutable.)");
        console2.log("  7. Confirm the platform fee recipient is wired identically in");
        console2.log("     both places, since divergence there is a money bug:");
        console2.log("       factory.platformTreasury() ==");
        console2.log("         ToshLaunchpadHook(factory.hookImplementation()).platformFeeRecipient()");
        console2.log("     script/VerifyDeployment.s.sol asserts this.");
        console2.log("============================================================");
    }
}
