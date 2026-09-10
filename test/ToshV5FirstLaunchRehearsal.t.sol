// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary, PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshToken} from "../src/ToshToken.sol";
import {HookMiner} from "../src/libraries/HookMiner.sol";

/// @dev See `_installArbSys`. Duplicated from `ToshV5Fork.t.sol` on purpose;
///      that file explains at length why these helpers are not shared.
contract RehearsalArbSys {
    uint256 private _height;

    function arbBlockNumber() external view returns (uint256) {
        return _height;
    }

    function setHeight(uint256 h) external {
        _height = h;
    }
}

/// @notice Rehearsal for the mainnet FIRST launch, against the **deployed**
///         factory, at the **0.01 ETH soft-cap floor**.
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
///         derives `shelfP0 = 2_499_999_999` and a 4,756,270-wei step, but it
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
///         Skips rather than fails when `ROBINHOOD_RPC` is unset, matching
///         `ToshV5Fork.t.sol` — a fork suite that goes red on a missing
///         credential teaches everyone to ignore red.
contract ToshV5FirstLaunchRehearsalTest is Test {
    using MessageHashUtils for bytes32;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // ─── The live deployment, from .env.production ────────────────────────────
    //
    // Written as literals, not read from env, so that a mangled `.env` cannot
    // silently point this suite at nothing and still pass. `.env` currently
    // carries a stale `FACTORY_ADDRESS` with zero code at it, which is exactly
    // the accident this guards against.

    address internal constant FACTORY = 0xBa9d2E86281b988225Eca383C375215912fb20B9;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant ARB_SYS = 0x0000000000000000000000000000000000000064;

    /// @dev `factory.owner()` — the 2-of-3 Safe. Impersonated directly rather
    ///      than driven through Safe execution: what is being rehearsed is the
    ///      factory's response to the call, not the Safe's ability to make it.
    address internal constant OWNER_SAFE = 0x2953957774482efA660921df85A1E7634ccfe27A;

    /// @dev `factory.pogSigner()` as the chain reports it. Asserted on before
    ///      being repointed, so that a rotation nobody told this file about
    ///      shows up here instead of as a mystery `InvalidSignature` on the day.
    address internal constant LIVE_POG_SIGNER = 0x9A1a8C7b7D68d391909F02e8bD5B148b4B95b736;

    // ─── The rehearsal's own parameters ───────────────────────────────────────

    /// @dev The whole point: `MIN_SOFT_CAP_PROD`, the floor nothing has launched at.
    uint256 internal constant REHEARSAL_SOFT_CAP = 0.01 ether;

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
        string memory rpc = vm.envOr("ROBINHOOD_RPC", string(""));
        if (bytes(rpc).length == 0) return;

        vm.createSelectFork(rpc);
        forked = true;

        _installArbSys();

        factory = ToshFactory(payable(FACTORY));
        rehearsalSigner = vm.addr(rehearsalSignerPk);

        vm.deal(creator, 1 ether);
    }

    function _requireFork() internal {
        vm.skip(!forked, "ROBINHOOD_RPC unset, see .env.example");
    }

    /// @dev Foundry has no `ArbSys`, and the chain keeps only a stub at `0x64`
    ///      whose `arbBlockNumber()` is served below the EVM. A fork copies the
    ///      stub and not the node, so `_hasArbSys` reads true and then every
    ///      call through it reverts. See `ToshV5Fork.t.sol::_installArbSys` for
    ///      the full argument, including what this mock cannot tell us.
    function _installArbSys() internal {
        RehearsalArbSys impl = new RehearsalArbSys();
        vm.etch(ARB_SYS, address(impl).code);
        RehearsalArbSys(ARB_SYS).setHeight(block.number);
    }

    /// @dev Step 1 of the plan: the Safe transaction that lowers the dial.
    ///      Repoints the signer in the same breath — see the contract docstring.
    function _applySafeStep() internal {
        vm.startPrank(OWNER_SAFE);
        factory.setDefaultSoftCap(REHEARSAL_SOFT_CAP);
        factory.setPogSigner(rehearsalSigner);
        vm.stopPrank();
    }

    /// @dev Mines against the factory's OWN `hookInitcodeHash`, reading the
    ///      dials live, which is what makes this sensitive to the ordering the
    ///      plan has to respect: mine after the dial lands, never before.
    function _mineSalt() internal view returns (bytes32 rawSalt) {
        bytes32 initcodeHash = factory.hookInitcodeHash(
            projTreasury, creator, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), GENESIS
        );
        for (uint256 i; i < 500_000; ++i) {
            rawSalt = bytes32(i);
            address predicted = HookMiner.computeAddress(FACTORY, keccak256(abi.encode(creator, rawSalt)), initcodeHash);
            if (HookMiner.isValidHookAddress(predicted) && predicted.code.length == 0) return rawSalt;
        }
        revert("no valid salt found");
    }

    function _registerPoG(address user, uint256 maxAlloc) internal {
        uint256 nonce = factory.pogNonces(user);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest =
            keccak256(abi.encode(user, maxAlloc, nonce, deadline, FACTORY, block.chainid)).toEthSignedMessageHash();
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
    ///         than assumed. `pogSigner` is included because both `.env` and
    ///         `.env.production` disagree with the chain about it — the rotation
    ///         after the previous key leaked was applied on chain and never
    ///         written back. If it rotates again, this is the line that says so.
    function test_rehearsal_liveFactoryIsWhatWeThinkItIs() public {
        _requireFork();

        assertEq(block.chainid, 4663, "fork is not Robinhood Chain mainnet");
        assertGt(FACTORY.code.length, 0, "no factory at the .env.production address");
        assertEq(factory.owner(), OWNER_SAFE, "factory owner is not the production Safe");
        assertEq(factory.pogSigner(), LIVE_POG_SIGNER, "pogSigner rotated: signPoG.mjs needs the new key");
        assertFalse(factory.paused(), "factory is paused; no launch can be created");

        assertEq(factory.MIN_SOFT_CAP_PROD(), REHEARSAL_SOFT_CAP, "the floor moved");
        assertEq(factory.launchFee(), 0.01 ether, "launch fee moved; re-budget the run");
        assertEq(factory.maxPogAllocationLimit(), 0.1 ether, "PoG limit moved");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  The plan, steps 1 and 3-6, end to end at the floor
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Lower the dial, mine, create, attest, fund to exactly the floor,
    ///         `launch()` — and the live Uniswap singleton ends up holding an
    ///         initialised pool with the genesis liquidity locked in it.
    ///
    /// @dev    This is the path the mainnet run takes, and the first time it has
    ///         been executed at a 0.01 ETH raise. The assertions worth reading
    ///         are the two exact ones:
    ///
    ///           - `totalEthDeposited == softCap()` exactly, which is what makes
    ///             `launch()`'s `>=` a boundary rather than a margin. A single
    ///             wei of rounding anywhere in `deposit` would strand the raise
    ///             one wei short of a cap it was supposed to have met, and the
    ///             failure would look like nothing at all until the 7-day
    ///             `LAUNCH_WINDOW` closed.
    ///
    ///           - `shelfP0 == 2_499_999_999`, the figure
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
        bytes32 salt = _mineSalt();
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
            hook.totalEthDeposited(), hook.softCap(), "a deposit of exactly the cap must register as exactly the cap"
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

        (uint160 sqrtPriceX96,,,) = IPoolManager(POOL_MANAGER).getSlot0(id);
        assertGt(sqrtPriceX96, 0, "live singleton has no price for our pool");

        (uint128 liquidity,,) =
            IPoolManager(POOL_MANAGER).getPositionInfo(id, hookAddr, TICK_LOWER, TICK_UPPER, bytes32(0));
        assertGt(liquidity, 0, "genesis LP is not in the live singleton");

        assertEq(Currency.unwrap(key.currency0), address(0), "currency0 is not native ETH");
        assertEq(Currency.unwrap(key.currency1), address(token), "currency1 is not the project token");

        // The ladder base the fuzz suite predicted for this exact raise.
        assertEq(hook.shelfP0(), 2_499_999_999, "shelfP0 at the floor is not the derived figure");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  The two facts the plan has to be built around
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice A dial change that lands between mining and `createLaunch` is
    ///         rejected, not silently honoured with the old dials.
    ///
    /// @dev    This is the 98.2% branch of the race quantified for the plan:
    ///         `isValidHookAddress` accepts a random address with probability
    ///         9/512, so a salt mined against stale dials almost always fails
    ///         the flag check and reverts here. The residual ~1.8% is the case
    ///         that CANNOT be caught in code — the address happens to remain
    ///         valid and the clone freezes dials the creator never agreed to —
    ///         which is why the mitigation is operational: never have a dial
    ///         change in flight during `createLaunch`. `test_..._fullLifecycle`
    ///         asserts the `softCap()` read-back that catches it after the fact.
    function test_rehearsal_saltMinedAgainstStaleDialsIsRejected() public {
        _requireFork();

        _applySafeStep();
        bytes32 salt = _mineSalt();

        // The Safe moves the dial again, after the salt is ground.
        vm.prank(OWNER_SAFE);
        factory.setDefaultSoftCap(0.02 ether);

        uint256 fee = factory.launchFee();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.InvalidHookSalt.selector);
        factory.createLaunch{value: fee}("Stale", "STL", projTreasury, projTreasury, salt, fee, GENESIS);
    }

    /// @notice A lone depositor meeting the whole floor takes the entire genesis
    ///         tranche: 4,620,000 tokens, 22% of `MAX_SUPPLY`, for 0.01 ETH.
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

        bytes32 salt = _mineSalt();
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
