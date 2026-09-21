// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console2.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";
import {HookDeployLib} from "../src/libraries/HookDeployLib.sol";

/// @notice Just enough of `CLPoolManager` to ask which Vault it belongs to.
/// @dev    Declared locally, returning `address` rather than `IVault`, so this
///         script does not drag an Infinity interface tree in for one eth_call —
///         and so the call cannot start type-checking against a periphery
///         version that has nothing to do with the chain being deployed to.
interface IInfinityVaultGetter {
    function vault() external view returns (address);
}

/*//////////////////////////////////////////////////////////////////////////
//  DeployMainnet.s.sol  —  Production-grade deployer
//
//  Differences from script/Deploy.s.sol (Base Sepolia helper):
//    • No MockSATO and no faucet — v5.0 is BNB-native end to end and the
//      factory has no SATO wiring at all.
//    • Logs the live `hookInitcodeHash` so the frontend can confirm the clone
//      initcode against the mainnet build. There is no salt miner: Infinity
//      registers permissions via `getHooksRegistrationBitmap()`.
//    • Two-step transferOwnership reminder — production MUST hand off to a
//      Gnosis Safe multisig before any users transact.
//
//  TARGET CHAIN: BNB Smart Chain, chain id 56.  This header has now been
//  wrong three times —
//  it read "8453 = Base" then "1 = Ethereum" then "4663 = Robinhood" — and the
//  reason it never mattered is worth keeping: the script refuses to run unless
//  `block.chainid` equals whatever `TARGET_CHAIN_ID` says, so a stale comment
//  can only send an operator to authorise the wrong chain and waste a broadcast
//  finding out.  It cannot misdeploy anything.
//
//  Verification is Etherscan v2 (BscScan).  It needs an API key; without one
//  the broadcast still succeeds and verification is a follow-up.
//
//  Required env vars (extend `.env.production` from `.env.example`):
//    PRIVATE_KEY           — deployer EOA (low-privilege; rotates to Safe)
//    TARGET_CHAIN_ID       — chain this run is authorised for (56 = BSC)
//    INFINITY_CL_POOL_MANAGER — PancakeSwap Infinity CLPoolManager on the target
//    INFINITY_VAULT        — PancakeSwap Infinity Vault (the CL manager's vault())
//    QUOTE_ASSET           — BEM, 0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a on 56.
//                            Must have 8 decimals; the hook's constructor asserts
//                            it. Immutable on all three contracts, so a wrong
//                            value is a full redeploy, not a config fix.
//    POG_SIGNER_ADDRESS    — backend signer; a NEW EOA, not the deployer
//                            — a NEW EOA, not reused from testnet. The private
//                            key lives in Vercel Production, not in this file.
//    PLATFORM_TREASURY     — Gnosis Safe multisig (NOT an EOA)
//    PROD_OWNER_SAFE       — Gnosis Safe multisig that will own the factory
//
//  Deploy command. Note `set -a` — it is not decoration.
//
//  `source .env.production` alone sets SHELL variables, and this script reads
//  the ENVIRONMENT via vm.envUint/vm.envAddress, so the values would not reach
//  it. What would reach it is `.env`, which forge auto-loads and which holds
//  testnet roles: TARGET_CHAIN_ID=97, PLATFORM_TREASURY and
//  POG_SIGNER_ADDRESS both the deployer, and no PROD_OWNER_SAFE at all. That
//  last one makes it fail loudly rather than deploy wrongly — vm.envAddress
//  reverts on a missing var — but it fails on deploy day, at the broadcast.
//
//  Run scripts/preflightMainnet.mjs first. It is the only check that reaches the
//  chain before the broadcast does, and it asks the CLPoolManager for its own
//  vault() rather than trusting the two addresses the environment names.
//
//    set -a && source .env.production && set +a
//    node scripts/preflightMainnet.mjs
//    forge script script/DeployMainnet.s.sol:DeployMainnetScript \
//      --rpc-url $TARGET_RPC \
//      --broadcast \
//      --verify \
//      -vvvv
//
//  Plain `--verify`. The `--verifier blockscout --verifier-url …robinhoodchain…`
//  pair that stood here belongs to the retired chain; Blockscout does not serve
//  chain 56 at any tier, so passing it now verifies nothing and reports success
//  for having done so. Verification goes through Etherscan v2, which covers 56
//  and 97 from one host under one ETHERSCAN_API_KEY — see [etherscan] in
//  foundry.toml, where `bsc` and `bsc_testnet` are both already wired.
//
//  After broadcast, the Safe signers MUST call `acceptOwnership()` on BOTH the
//  factory and the treasury.  The script itself initiates both transfers, so no
//  manual `transferOwnership` is needed; until the Safe accepts, the deployer
//  EOA retains ownership — that is the intended two-step safety mechanism.
//////////////////////////////////////////////////////////////////////////*/

contract DeployMainnetScript is Script {
    /// @notice The only chain this script will broadcast to.
    /// @dev    Kept beside the code that enforces it rather than read from the
    ///         environment, because it is the one value the environment must not
    ///         be able to choose. See the require in `run()` for why the
    ///         RPC-versus-env check was not enough on its own. Must be changed
    ///         together with `TARGET_CHAIN` in `test/DeployMainnet.t.sol`.
    uint256 internal constant MAINNET_CHAIN_ID = 56;

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
    /// @notice Refuse a target that is not mainnet, however the environment got that way.
    /// @dev    The `block.chainid == targetChainId` check in `run()` only proves the RPC
    ///         agrees with the environment — not that either names the chain this script
    ///         is for. `TARGET_CHAIN_ID=97` against a 97 RPC satisfied it completely, and
    ///         the filename is not an assertion: a parked `.env` restored by habit, or a
    ///         shell still carrying the testnet export, broadcast the MAINNET script to
    ///         testnet with every check green. `Deploy.s.sol` has pinned 97 since it was
    ///         written; this side had nothing.
    ///
    ///         `DeployMainnet.t.sol` argues the chain guard should be env-driven rather
    ///         than hard-coded, because the target has changed four times. That holds for
    ///         which chain is *configured*; it does not extend to a script whose name
    ///         promises one.
    ///
    ///         `public pure`, taking the id as an argument, for the same reason
    ///         `requireDistinctRoles` is: it lets the test reach this branch without
    ///         `vm.setEnv`. That matters more than it looks. `setEnv` writes the process
    ///         environment, which is outside the state Forge snapshots, and `setUp` runs
    ///         once — so a test that varied `TARGET_CHAIN_ID` to get here leaked 97 into
    ///         every later test in the file. Measured: four failures from one new test,
    ///         and restoring the value on the next line only brought it down to two.
    function requireMainnetTarget(uint256 targetChainId) public pure {
        require(targetChainId == MAINNET_CHAIN_ID, "TARGET_CHAIN_ID is not mainnet: use Deploy.s.sol for testnet");
    }

    function requireDistinctRoles(address deployer, address pogSigner, address prodOwnerSafe, address platformTreasury)
        public
        pure
    {
        require(pogSigner != deployer, "POG_SIGNER_ADDRESS must not equal deployer");
        require(prodOwnerSafe != deployer, "PROD_OWNER_SAFE must NOT equal deployer EOA");
        require(platformTreasury != deployer, "PLATFORM_TREASURY must NOT equal deployer EOA");
        require(platformTreasury != pogSigner, "PLATFORM_TREASURY must NOT equal the PoG signer");

        // The checks above all compare roles against EACH OTHER, which cannot
        // see the failure that actually happened on 97: every role distinct,
        // every address well-formed, and `platformTreasury` set to Anvil's
        // account #1 by a stale shell variable shadowing `.env`. Distinctness is
        // orthogonal to controllability. See `_refuseWellKnownKey` for the
        // full account of it.
        _refuseWellKnownKey(platformTreasury);
        _refuseWellKnownKey(prodOwnerSafe);
        _refuseWellKnownKey(pogSigner);
        _refuseWellKnownKey(deployer);
    }

    /// @dev Refuse an address whose private key is public knowledge — the first
    ///      ten accounts of Foundry's default test mnemonic.
    ///
    ///      ⚠ THIS CAUGHT A REAL DEPLOY on 97. `.env` named the intended
    ///        treasury; a PowerShell session left over from local Anvil work
    ///        still exported `PLATFORM_TREASURY=0x7099…dc79C8`, and Foundry lets
    ///        the process environment shadow `.env`. The file was right, the
    ///        deploy was wrong, and the deploy log agreed with the deploy, so
    ///        nothing reconciled the two.
    ///
    ///        On 97 that cost nothing. Here it would be permanent and drainable:
    ///        `platformTreasury` takes 0.30 % of the native input of every buy on
    ///        every pool and is immutable on both the factory and the hook
    ///        implementation, and `prodOwnerSafe` owns the factory. Anyone who has
    ///        run `anvil` holds those keys.
    ///
    ///      Applied to all four roles rather than just the treasury, because the
    ///      mechanism is the environment and not the variable — any of them can
    ///      be shadowed the same way. Note what this does NOT do: a passing
    ///      address is not thereby one you control.
    function _refuseWellKnownKey(address who) internal pure {
        address[10] memory anvil = [
            0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266,
            0x70997970C51812dc3A010C7d01b50e0d17dc79C8,
            0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC,
            0x90F79bf6EB2c4f870365E785982E1f101E93b906,
            0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65,
            0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc,
            0x976EA74026E726554dB657fA54763abd0C3a0aa9,
            0x14dC79964da2C08b23698B3D3cc7Ca32193d9955,
            0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f,
            0xa0Ee7A142d267C1f36714E4a8F75612F20a79720
        ];
        for (uint256 i = 0; i < anvil.length; i++) {
            require(who != anvil[i], "role is an Anvil test account -- its key is public");
        }
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

        requireMainnetTarget(targetChainId);

        require(block.chainid == targetChainId, "chain id mismatch: wrong --rpc-url for this deploy");

        address poolManager = vm.envAddress("INFINITY_CL_POOL_MANAGER");
        require(poolManager != address(0), "INFINITY_CL_POOL_MANAGER unset");
        // ⚠ CODE CHECK, for the same reason `QUOTE_ASSET` has one thirty lines
        //   below, and this is the address where its absence costs most. Both
        //   Infinity addresses are chain-specific and both are IMMUTABLE on the
        //   factory and on every hook it clones, so a value carried over from
        //   another chain deploys a perfectly healthy-looking factory whose
        //   every `createLaunch` reverts — discovered by the first creator, not
        //   by the deploy. `QUOTE_ASSET` was guarded and these two were not,
        //   which was an inconsistency rather than a decision.
        require(poolManager.code.length > 0, "INFINITY_CL_POOL_MANAGER holds no code on this chain");

        // Infinity's Vault. Immutable on the factory and on every hook it
        // deploys, exactly like the manager, and it must be the Vault that
        // OWNS this manager — `CLPoolManager` and `Vault` each reject the
        // other's counterparty, so a mismatched pair does not misbehave
        // quietly, it bricks every launch.
        address vault = vm.envAddress("INFINITY_VAULT");
        require(vault != address(0), "INFINITY_VAULT unset");
        require(vault.code.length > 0, "INFINITY_VAULT holds no code on this chain");

        // ⚠ AND THE PAIRING IS CHECKED HERE RATHER THAN BY A HUMAN. This block
        //   used to end "verify the pairing on the target chain before
        //   broadcasting; the fork suite asserts it for the live pair, but this
        //   script cannot" — and the last clause was simply untrue. The script
        //   runs against `--rpc-url`, so `manager.vault()` is one eth_call, and
        //   the manager publishes exactly the value being verified. What the
        //   comment did was convert a mechanical check into a manual step in a
        //   procedure with twenty other manual steps, on the one pair of
        //   addresses that cannot be corrected afterwards.
        //
        //   Wrapped in a try/catch so the failure names the real problem: an
        //   address with code that is NOT a CLPoolManager has no `vault()` to
        //   call, and a bare revert here would read as an RPC fault.
        try IInfinityVaultGetter(poolManager).vault() returns (address declared) {
            require(declared == vault, "INFINITY_VAULT is not the vault this INFINITY_CL_POOL_MANAGER reports");
        } catch {
            revert("INFINITY_CL_POOL_MANAGER does not answer vault(): not a CLPoolManager on this chain");
        }

        // The quote asset: what every raise is denominated in, and `currency0` of
        // every pool this factory will ever create. BEM,
        // `0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a` on 56.
        //
        // Immutable on all three contracts with no setter anywhere, so a wrong
        // value is a redeploy of the whole set — not a config fix. Two properties
        // the checks below cannot establish and a human must:
        //
        //   1. IT MUST HAVE 8 DECIMALS. The hook's constructor asserts this, so a
        //      wrong token fails the broadcast rather than shipping. It is
        //      asserted rather than assumed because `MIN_SOFT_CAP_PROD` and the
        //      shelf ladder's usable range were computed against 8, and at 18 the
        //      ladder's flattening cliff moves somewhere nobody has checked.
        //
        //   2. ITS SUPPLY POLICY IS A TRUST ASSUMPTION. BEM's minter is an
        //      upgradeable ERC-1967 proxy, so whoever controls it can inflate the
        //      asset every raise is denominated in. That is acceptable only
        //      because it is OURS; if this address ever names a token controlled
        //      by someone else, re-read docs/BEM_QUOTE_ASSET.md §1.1 first.
        //
        // No rehearsal exists for this configuration. BEM has no deployment on
        // testnet 97, so the deposit, refund and settlement paths reach mainnet
        // having been exercised only in tests and against a fork. That was a
        // decision, not an oversight — docs/BEM_QUOTE_ASSET.md §3 — and the fork
        // suite against real BEM bytecode is the compensation.
        address quoteAsset = vm.envAddress("QUOTE_ASSET");
        require(quoteAsset != address(0), "QUOTE_ASSET unset");
        require(quoteAsset.code.length > 0, "QUOTE_ASSET holds no code on this chain");

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
        console2.log("Infinity CLPoolManager    :", poolManager);
        console2.log("PoG Signer (not deployer) :", pogSigner);
        console2.log("Platform fee recipient    :", platformTreasury);
        console2.log("  ^ takes 0.30% of every buy's BNB input. IMMUTABLE: no setter,");
        console2.log("    baked into the hook implementation too. Must accept BNB always.");
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
        ToshLadderTreasury treasury = new ToshLadderTreasury(poolManager, vault, deployer, quoteAsset);
        console2.log("ToshLadderTreasury deployed:", address(treasury));

        ToshFactory factory =
            new ToshFactory(poolManager, vault, pogSigner, platformTreasury, address(treasury), quoteAsset);
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
        console2.log("   counts as done: SECURITY.md and docs/DEVELOPMENT.md.)");
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
        console2.log("     if --verify above didn't catch it. Etherscan v2 covers 56");
        console2.log("     and 97 from one host under one key:");
        console2.log("       --etherscan-api-key $ETHERSCAN_API_KEY --chain 56");
        console2.log("     Do NOT pass --verifier blockscout, which this line used to");
        console2.log("     say: it does not serve chain 56 and verifies nothing.");
        console2.log("  5. Pre-fund the PoG signer (a new EOA, not this deployer)");
        console2.log("     with ~0.05 BNB. Its key is in Vercel Production only.");
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
