// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolIdLibrary, PoolId} from "infinity-core/src/types/PoolId.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshToken} from "../src/ToshToken.sol";
import {HookMiner} from "../src/libraries/HookMiner.sol";

/// @notice Rehearsal for the mainnet FIRST launch, against the **deployed**
///         factory, at the **0.035 BNB soft-cap floor**.
///
/// @dev    ── Why this file exists, when `ToshV5Fork.t.sol` already forks 4663 ──
///
///         Two gaps, and this closes both.
///
///         **1. The lowest soft cap ever launched at, anywhere, is 1 ETH.**
///         `ToshV5Attack`, `ToshV5ArbSys`, `ToshV5Fuzz` and `ToshV5Fork` all use
///         `SOFT_CAP = 1 ether`; `ToshV5Invariants` uses 2 and `ToshHookClone`
///         uses 5. At the `MIN_SOFT_CAP_PROD` floor only the *arithmetic* is
///         covered — `ToshV5Fuzz.test_smallestReachableShelfP0_stillStepsTheLadder`
///         derives `shelfP0 = 8_749_999_999` and a 16,646,947-wei step, but it
///         does so on a hook it `new`s directly, never through a real genesis.
///         The planned mainnet run puts the protocol's permanent launchId 0
///         through that path for the first time, with real money. This runs it
///         first, for free.
///
///         **2. Every other suite deploys its own factory.** `ToshV5Fork` forks
///         the chain for the Uniswap singleton and then `new`s a `ToshFactory`.
///         That is the same source, not the same bytecode, and never the same
///         storage. This one binds to the 10,789-byte factory that is really at
///         `FACTORY`, with its real owner, its real `pogSigner` and its real
///         frozen dials — so what it proves is a claim about the deployment the
///         launch will actually touch.
///
///         ── The one deviation, and why it is not load-bearing ──
///
///         `setPogSigner` is repointed at a key this test holds, because the
///         real signer's key is not in this repository (and must not be). The
///         digest, the recovery path and every guard around them are untouched;
///         only the keypair differs, and `registerPoG` cannot tell one secp256k1
///         key from another. `scripts/signPoG.mjs` is what exercises the real
///         key, off-chain, and `scripts/checkPogDigestTuple.mjs` pins the digest
///         the two agree on.
///
///         ── What the BNB cutover did to this file ──
///
///         It used to bind to the factory deployed on Robinhood Chain 4663,
///         with that deployment's Safe and signer written in as literals. That
///         deployment is being left behind, and the rename to neutral coin
///         naming was what surfaced it: this suite went red on
///         `totalNativeDeposited()` reverting, because the bytecode at 4663
///         answers `totalEthDeposited()` and always will. The suite was
///         correct and the premise had expired.
///
///         So it now targets BSC, and the deployed factory it binds to does
///         not exist yet. `FACTORY` moved from a literal to
///         `BSC_FACTORY_ADDRESS`, which costs the property the literal was
///         there for — a mangled env pointing this suite at nothing while it
///         still passes. That property is bought back a different way:
///         **unset** skips, but **set and wrong** fails, and
///         `test_rehearsal_liveFactoryIsWhatWeThinkItIs` checks for code at
///         the address before anything else depends on it.
///
///         `ArbSys` is gone rather than mocked. On 4663 the hook read
///         `arbBlockNumber()` and Foundry has no such precompile, so this file
///         etched one. BSC has no `ArbSys` either, and `_hasArbSys` is set from
///         `ARB_SYS.code.length` at construction — so the fallback to
///         `block.number` is the real production path here, and etching a mock
///         would have hidden the one thing worth exercising.
///         `ToshV5ForkBsc.test_forkBsc_arbSysIsAbsentSoTheFallbackIsWhatRuns`
///         asserts the absence directly.
///
///         Skips rather than fails when `BSC_RPC` or `BSC_FACTORY_ADDRESS` is
///         unset, matching `ToshV5Fork.t.sol` — a fork suite that goes red on a
///         missing credential teaches everyone to ignore red.
contract ToshV5FirstLaunchRehearsalTest is Test {
    using MessageHashUtils for bytes32;
    using PoolIdLibrary for PoolKey;

    // ─── The live deployment ──────────────────────────────────────────────────

    /// @dev Uniswap V4 `PoolManager` on BSC. Still a literal, because unlike the
    ///      factory this one already exists and is pinned by
    ///      `ToshV5ForkBsc.t.sol` to the same address.
    address internal constant POOL_MANAGER = 0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF;

    /// @dev Read from `BSC_FACTORY_ADDRESS`; see the contract docstring for what
    ///      that costs and how it is paid for.
    address internal factoryAddr;

    /// @dev `factory.owner()` — the Safe. Read off the chain rather than pinned,
    ///      because the deployment this binds to has not happened yet, so there
    ///      is no address to pin. Impersonated directly rather than driven
    ///      through Safe execution: what is being rehearsed is the factory's
    ///      response to the call, not the Safe's ability to make it.
    address internal ownerSafe;

    // ─── The rehearsal's own parameters ───────────────────────────────────────

    /// @dev The whole point: `MIN_SOFT_CAP_PROD`, the floor nothing has launched
    ///      at. Asserted against the deployed constant rather than trusted, so a
    ///      factory built from different source than this checkout says so.
    uint256 internal constant REHEARSAL_SOFT_CAP = 0.035 ether;

    /// @dev Enforced on chain by `ToshLaunchpadHook.initializeToken`, which
    ///      rejects anything but the three rungs with `InvalidDuration`. 3 h is
    ///      the shortest genesis that exists; there is no faster option to buy.
    uint256 internal constant GENESIS = 3 hours;

    int24 internal constant TICK_LOWER = -887200;
    int24 internal constant TICK_UPPER = 887200;

    ToshFactory internal factory;

    uint256 internal rehearsalSignerPk = 0xA11CE_5EED;
    address internal rehearsalSigner;

    address internal creator = makeAddr("rehearsalCreator");
    address internal projTreasury = makeAddr("rehearsalProjTreasury");

    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("BSC_RPC", string(""));
        factoryAddr = vm.envOr("BSC_FACTORY_ADDRESS", address(0));
        if (bytes(rpc).length == 0 || factoryAddr == address(0)) return;

        vm.createSelectFork(rpc);
        forked = true;

        // No `ArbSys` etch: BSC does not have the precompile, so the hook's
        // fallback to `block.number` is what production runs. See the docstring.
        factory = ToshFactory(payable(factoryAddr));
        rehearsalSigner = vm.addr(rehearsalSignerPk);

        // Read rather than pinned — the Safe for this deployment is whatever
        // `DeployMainnet` handed ownership to, and this file predates it.
        ownerSafe = factory.owner();

        vm.deal(creator, 1 ether);
    }

    function _requireFork() internal {
        vm.skip(!forked, "BSC_RPC or BSC_FACTORY_ADDRESS unset, see .env.example");
    }

    /// @dev Step 1 of the plan: the Safe transaction that lowers the dial.
    ///      Repoints the signer in the same breath — see the contract docstring.
    function _applySafeStep() internal {
        vm.startPrank(ownerSafe);
        factory.setDefaultSoftCap(REHEARSAL_SOFT_CAP);
        factory.setPogSigner(rehearsalSigner);
        vm.stopPrank();
    }

    /// @dev Mines against the factory's OWN `hookInitcodeHash`, reading the
    ///      dials live, which is what makes this sensitive to the ordering the
    ///      plan has to respect: mine after the dial lands, never before.
    function _pickSalt() internal view returns (bytes32 rawSalt) {
        bytes32 initcodeHash = factory.hookInitcodeHash(
            projTreasury, creator, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), GENESIS
        );
        for (uint256 i; i < 1000; ++i) {
            rawSalt = bytes32(i);
            address predicted =
                HookMiner.computeAddress(factoryAddr, keccak256(abi.encode(creator, rawSalt)), initcodeHash);
            if (predicted.code.length == 0) return rawSalt;
        }
        revert("_pickSalt: first 1000 salts are all occupied");
    }

    function _registerPoG(address user, uint256 maxAlloc) internal {
        uint256 nonce = factory.pogNonces(user);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest =
            keccak256(abi.encode(user, maxAlloc, nonce, deadline, factoryAddr, block.chainid)).toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(rehearsalSignerPk, digest);
        vm.prank(user);
        factory.registerPoG(maxAlloc, deadline, nonce, abi.encodePacked(r, s, v));
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  The premise: the chain is what .env.production says, and .env is not
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice The deployment this suite binds to is the one that is really
    ///         there, and the live dials are the ones the plan was written
    ///         against.
    ///
    /// @dev    Every later test is conditional on this, so it is asserted rather
    ///         than assumed.
    ///
    ///         The code-length check is what replaces the pinned literal this
    ///         file used to carry: `BSC_FACTORY_ADDRESS` set to a typo skips
    ///         nothing and fails here, by name, instead of surfacing four tests
    ///         later as an unexplained revert.
    ///
    ///         `pogSigner` is no longer compared to a pinned address — there is
    ///         no deployment yet to pin — but it is still asserted non-zero,
    ///         because a factory whose signer was never set cannot attest and
    ///         the rehearsal would otherwise repoint it and never notice.
    function test_rehearsal_liveFactoryIsWhatWeThinkItIs() public {
        _requireFork();

        assertEq(block.chainid, 56, "fork is not BNB Smart Chain mainnet");
        assertGt(factoryAddr.code.length, 0, "no factory at BSC_FACTORY_ADDRESS");
        assertGt(POOL_MANAGER.code.length, 0, "no Uniswap V4 PoolManager at the pinned BSC address");
        assertTrue(ownerSafe != address(0), "factory owner is unset");
        assertTrue(factory.pogSigner() != address(0), "pogSigner was never set; no attestation can verify");
        assertFalse(factory.paused(), "factory is paused; no launch can be created");

        assertEq(factory.MIN_SOFT_CAP_PROD(), REHEARSAL_SOFT_CAP, "the floor moved");
        assertEq(factory.maxPogAllocationLimit(), 1.75 ether, "PoG limit moved");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  The plan, steps 1 and 3-6, end to end at the floor
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Lower the dial, mine, create, attest, fund to exactly the floor,
    ///         `launch()` — and the live Uniswap singleton ends up holding an
    ///         initialised pool with the genesis liquidity locked in it.
    ///
    /// @dev    This is the path the mainnet run takes, and the first time it has
    ///         been executed at a 0.035 BNB raise. The assertions worth reading
    ///         are the two exact ones:
    ///
    ///           - `totalNativeDeposited == softCap()` exactly, which is what makes
    ///             `launch()`'s `>=` a boundary rather than a margin. A single
    ///             wei of rounding anywhere in `deposit` would strand the raise
    ///             one wei short of a cap it was supposed to have met, and the
    ///             failure would look like nothing at all until the 7-day
    ///             `LAUNCH_WINDOW` closed.
    ///
    ///           - `shelfP0 == 8_749_999_999`, the figure
    ///             `ToshV5Fuzz.test_smallestReachableShelfP0_stillStepsTheLadder`
    ///             derives arithmetically from `MIN_SOFT_CAP_PROD`. Asserting it
    ///             here joins that derivation to the deployed bytecode: the unit
    ///             test says what the number should be, this says the real
    ///             factory, real clone and real singleton produce it.
    function test_rehearsal_fullLifecycleAtTheSoftCapFloor() public {
        _requireFork();

        // ── Step 1: the Safe lowers the dial ─────────────────────────────────
        _applySafeStep();
        assertEq(factory.defaultSoftCap(), REHEARSAL_SOFT_CAP, "the dial did not take");

        // ── Step 3: the test wallet creates the launch ───────────────────────
        bytes32 salt = _pickSalt();
        uint256 fee = factory.launchFee();

        vm.prank(creator);
        (address tokenAddr, address hookAddr) =
            factory.createLaunch{value: fee}("Rehearsal", "RHS", projTreasury, projTreasury, salt, fee, GENESIS);
        ToshToken token = ToshToken(tokenAddr);
        ToshLaunchpadHook hook = ToshLaunchpadHook(payable(hookAddr));

        // ── Step 4: read the frozen dials back, first thing ──────────────────
        // The plan's abort condition. If `createLaunch` raced a dial change it
        // would have frozen the OLD 10 ETH cap into this clone permanently, and
        // this is where that is caught.
        assertEq(hook.softCap(), REHEARSAL_SOFT_CAP, "clone froze the wrong soft cap: ABORT");
        assertEq(hook.perWalletCap(), factory.maxPogAllocationLimit(), "clone froze the wrong per-wallet cap");
        assertEq(hook.genesisDuration(), GENESIS, "clone froze the wrong genesis duration");
        assertEq(hook.creator(), creator, "creator is not the test wallet: launch() would be unreachable");

        // ── Step 5: attest, then fund to exactly the cap ─────────────────────
        _registerPoG(creator, REHEARSAL_SOFT_CAP);

        vm.prank(creator);
        factory.deposit{value: REHEARSAL_SOFT_CAP}(hookAddr, address(0));

        assertEq(
            hook.totalNativeDeposited(), hook.softCap(), "a deposit of exactly the cap must register as exactly the cap"
        );

        // ── Step 6: the creator, and only the creator, launches ──────────────
        vm.warp(hook.genesisDeadline() + 1);

        // The `OnlyCreator` constraint, exercised rather than read. `creator` is
        // an immutable clone arg, so this is permanent for the life of the hook.
        vm.prank(makeAddr("notTheCreator"));
        vm.expectRevert(ToshLaunchpadHook.OnlyCreator.selector);
        hook.launch();

        vm.prank(creator);
        hook.launch();
        assertTrue(hook.launched(), "hook does not consider itself launched");

        // ── The pool is real, in the singleton that is really there ──────────
        PoolKey memory key = hook.getPoolKey();
        PoolId id = key.toId();

        (uint160 sqrtPriceX96,,,) = ICLPoolManager(POOL_MANAGER).getSlot0(id);
        assertGt(sqrtPriceX96, 0, "live singleton has no price for our pool");

        // `getLiquidity`, not V4's `getPositionInfo` behind `StateLibrary`:
        // Infinity's CLPoolManager exposes position state as a plain view
        // function, so there is no `extsload` reader to go through.
        uint128 liquidity = ICLPoolManager(POOL_MANAGER).getLiquidity(id, hookAddr, TICK_LOWER, TICK_UPPER, bytes32(0));
        assertGt(liquidity, 0, "genesis LP is not in the live singleton");

        assertEq(Currency.unwrap(key.currency0), address(0), "currency0 is not native ETH");
        assertEq(Currency.unwrap(key.currency1), address(token), "currency1 is not the project token");

        // The ladder base the fuzz suite predicted for this exact raise.
        assertEq(hook.shelfP0(), 8_749_999_999, "shelfP0 at the floor is not the derived figure");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  The two facts the plan has to be built around
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice ⚠ A DIAL CHANGE IN FLIGHT IS NOW HONOURED SILENTLY. It used to be
    ///         rejected, and the mitigation plan was written around that.
    ///
    /// @dev    This test asserted the opposite until the PancakeSwap Infinity
    ///         port. Inverting it is the honest change rather than deleting it,
    ///         because the risk it documents did not go away — only the backstop
    ///         did.
    ///
    ///         What the plan assumed: a salt ground against stale dials produces
    ///         an address that fails V4's flag check with probability 503/512, so
    ///         98.2% of in-flight dial changes reverted loudly. The residual
    ///         ~1.8% — address still valid, clone freezing dials the creator never
    ///         agreed to — was called the case that CANNOT be caught in code, and
    ///         the mitigation was made operational: never let a dial change be in
    ///         flight during `createLaunch`.
    ///
    ///         What is true now: that 1.8% is 100%. Infinity reads permissions
    ///         from the hook's registration bitmap, `ToshFactory` checks no
    ///         address bits, and `InvalidHookSalt` no longer exists — so the
    ///         launch always succeeds, at an address the creator did not predict,
    ///         freezing whatever the dials read at execution time.
    ///
    ///         The operational mitigation is no longer belt-and-braces; it is the
    ///         only control. `expectedFee` shows the shape a real fix would take:
    ///         the caps need the same treatment. Recorded in
    ///         docs/PANCAKESWAP_INFINITY.md §11.
    function test_rehearsal_aDialChangeInFlightIsSilentlyHonoured() public {
        _requireFork();

        _applySafeStep();
        bytes32 salt = _pickSalt();

        // The Safe moves the dial again, after the salt is ground. Twice the
        // floor, as before — it has to clear `MIN_SOFT_CAP_PROD` or the setter
        // reverts and the test would pass for the wrong reason.
        vm.prank(ownerSafe);
        factory.setDefaultSoftCap(REHEARSAL_SOFT_CAP * 2);

        uint256 fee = factory.launchFee();
        vm.prank(creator);
        (, address hook) =
            factory.createLaunch{value: fee}("Stale", "STL", projTreasury, projTreasury, salt, fee, GENESIS);

        assertEq(
            ToshLaunchpadHook(payable(hook)).softCap(),
            REHEARSAL_SOFT_CAP * 2,
            "the launch froze the dial as of execution, not as of agreement"
        );
    }

    /// @notice A lone depositor meeting the whole floor takes the entire genesis
    ///         tranche: 4,620,000 tokens, 22% of `MAX_SUPPLY`, for 0.035 BNB.
    ///
    /// @dev    Not a defect — the tranche is always pro-rata, so this is what
    ///         "one wallet, one raise" necessarily means. It is asserted because
    ///         it is the permanent consequence that decides whether the first
    ///         launch may carry a real project's name: the pool can be deepened
    ///         later by anyone via the position manager, but a cap table showing
    ///         22% of supply to one address for ~$30 cannot be undone.
    function test_rehearsal_loneDepositorTakesTheWholeGenesisTranche() public {
        _requireFork();

        _applySafeStep();

        bytes32 salt = _pickSalt();
        uint256 fee = factory.launchFee();
        vm.prank(creator);
        (address tokenAddr, address hookAddr) =
            factory.createLaunch{value: fee}("Concentration", "CNC", projTreasury, projTreasury, salt, fee, GENESIS);
        ToshToken token = ToshToken(tokenAddr);
        ToshLaunchpadHook hook = ToshLaunchpadHook(payable(hookAddr));

        _registerPoG(creator, REHEARSAL_SOFT_CAP);
        vm.prank(creator);
        factory.deposit{value: REHEARSAL_SOFT_CAP}(hookAddr, address(0));

        vm.warp(hook.genesisDeadline() + 1);
        vm.prank(creator);
        hook.launch();

        vm.prank(creator);
        hook.claimGenesis();

        assertEq(
            token.balanceOf(creator),
            hook.GENESIS_CLAIM_SUPPLY(),
            "a lone depositor must receive the entire genesis claim supply"
        );
        assertEq(hook.GENESIS_CLAIM_SUPPLY(), 4_620_000e18, "genesis tranche moved");
        assertEq(token.balanceOf(creator) * 100 / token.MAX_SUPPLY(), 22, "the tranche is 22% of max supply");
    }
}
