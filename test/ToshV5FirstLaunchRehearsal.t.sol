// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolIdLibrary, PoolId} from "infinity-core/src/types/PoolId.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshToken} from "../src/ToshToken.sol";
import {HookAddress} from "../src/libraries/HookAddress.sol";

/// @notice Rehearsal for the mainnet FIRST launch, against the **deployed**
///         factory, at the **100 BEM soft-cap floor**.
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
///
///         **Set and wrong is the other case, and it fails.** A value that is
///         absent is a credential nobody has; a value that names another chain is
///         a claim that is false, and `setUp` rejects both an RPC that is not 56
///         and a factory address with no code there, each with a message naming
///         the cause. The distinction matters because the two arrive looking
///         identical from the outside: one red suite either way.
contract ToshV5FirstLaunchRehearsalTest is Test {
    using MessageHashUtils for bytes32;
    using PoolIdLibrary for PoolKey;

    // ─── The live deployment ──────────────────────────────────────────────────

    /// @dev PancakeSwap Infinity `CLPoolManager` on BSC mainnet. Still a literal,
    ///      because unlike the factory this one already exists.
    ///
    ///      ⚠ THIS WAS UNISWAP V4's `PoolManager` UNTIL THE PORT, and the wrong
    ///        value survived every guard this file has. It was
    ///        `0x28e2Ea09…`, which does hold code — 24,009 bytes of it — so the
    ///        `code.length > 0` check below passed while naming Infinity in its
    ///        failure message. Nothing else caught it either: this suite skips
    ///        unless `BSC_FACTORY_ADDRESS` is set, and 56 is not deployed, so all
    ///        four tests have been silently skipping since the retarget.
    ///
    ///        It would have surfaced at the mainnet cutover, as an unexplained
    ///        revert inside `getSlot0` on the first run anyone set that env var
    ///        for. The stale docstring pointed at `ToshV5ForkBsc.t.sol` as the
    ///        file pinning "the same address", and that file was deleted in the
    ///        port — so the cross-check it claimed did not exist either.
    ///
    ///        The two are told apart by asking, not by length: only Infinity's
    ///        manager answers `vault()`, and it must name the Vault this
    ///        protocol settles through. That is asserted in
    ///        `test_rehearsal_liveFactoryIsWhatWeThinkItIs` rather than left to
    ///        a comment.
    address internal constant POOL_MANAGER = 0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b;

    /// @dev The Vault the manager above must name. Infinity splits the AMM: the
    ///      manager runs the pool, the Vault holds every balance.
    address internal constant VAULT = 0x238a358808379702088667322f80aC48bAd5e6c4;

    /// @dev BEM on BSC mainnet — the asset the whole rehearsal is denominated in.
    ///      Pinned to the same literal `ToshV5Fork.t.sol` uses, and asserted
    ///      against the live factory's own `quoteAsset()` in
    ///      `test_rehearsal_liveFactoryIsWhatWeThinkItIs` rather than trusted:
    ///      this file's job is to disagree out loud with a deployment that was
    ///      built against something else.
    address internal constant BEM = 0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a;

    IERC20 internal quote = IERC20(BEM);

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
    ///
    ///      ⚠ THIS WAS `0.035 ether` UNTIL AFTER THE BEM MOVE — wrong currency
    ///        and wrong scale, 3.5e16 against a floor of 1e10 — and it is the
    ///        second value in this file to survive a migration for the same
    ///        reason the PoolManager address did: all four tests behind
    ///        `_requireFork()` skip until `BSC_FACTORY_ADDRESS` is set, so a
    ///        green suite is not evidence that anything here compiles against
    ///        reality. The `maxPogAllocationLimit` assertion below was caught by
    ///        hand in the same sweep; this one was not, and the pair is the
    ///        argument for reading this file whenever a dial is re-denominated.
    ///
    ///        100 BEM, in base units. `MIN_SOFT_CAP_PROD` did not track the
    ///        26.51 BEM/BNB rate the other dials were converted at — it was
    ///        raised deliberately, because 8 decimals collapse the shelf-ladder
    ///        granularity margin from ~16,000,000x to ~4.75x. See
    ///        docs/BEM_QUOTE_ASSET.md §2.1.
    uint256 internal constant REHEARSAL_SOFT_CAP = 100e8;

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

    /// @dev The fork exists whenever `BSC_RPC` does.
    bool internal forked;

    /// @dev The factory is bound on top of the fork, and only if
    ///      `BSC_FACTORY_ADDRESS` names one.
    ///
    ///      The two are separated because they expire at different times. The
    ///      addresses this file pins are checkable TODAY; the factory does not
    ///      exist on 56 yet. Gating both behind one flag meant the pinned-address
    ///      test could not run either, which is how this file came to be pinning
    ///      Uniswap V4's PoolManager — see the note on `POOL_MANAGER`. Skipping
    ///      is right for a credential nobody has, and wrong for a fact anyone can
    ///      check.
    bool internal factoryBound;

    function setUp() public {
        string memory rpc = vm.envOr("BSC_RPC", string(""));
        if (bytes(rpc).length == 0) return;

        vm.createSelectFork(rpc);
        forked = true;

        // Every address this file pins — `POOL_MANAGER`, `VAULT`, `BEM` — is a
        // chain-56 literal, and `BSC_TESTNET_RPC` exists as a separate variable,
        // so a fork that is not 56 is a mangled env rather than a choice. CI says
        // the same thing in prose: test.yml tells the operator to "check that the
        // value names chain 56 and not 97".
        //
        // Asserted HERE as well as in the two tests that already check it, because
        // `setUp` dereferences the factory a few lines down — so on the wrong chain
        // those assertions are never reached to report anything.
        require(
            block.chainid == 56,
            "BSC_RPC does not name BNB Smart Chain mainnet (56); every address pinned in this file is a 56 literal"
        );

        factoryAddr = vm.envOr("BSC_FACTORY_ADDRESS", address(0));
        if (factoryAddr == address(0)) return;
        factoryBound = true;

        // ⚠ THIS CHECK USED TO EXIST ONLY IN `test_rehearsal_liveFactoryIsWhatWeThinkItIs`,
        //   whose docstring claimed it ran "before anything else depends on it".
        //   It did not. `factory.owner()` below is the first dereference, so a
        //   wrong address failed THERE instead — as `[FAIL: call to non-contract
        //   address 0x9CC550…] setUp()`, which takes out all four tests at once
        //   and names neither the factory, nor the chain, nor the env var that
        //   pointed at it. The file's own diagnostic was unreachable by
        //   construction, and the failure it was written to explain is the exact
        //   one that reached it.
        //
        //   Which is how it read when a `BSC_FACTORY_ADDRESS` left exported in a
        //   shell during the chain-97 rebuild met a mainnet `BSC_RPC`: a suite
        //   that looks broken, rather than an env that is. Both halves were
        //   individually valid — a real factory, a real endpoint, different
        //   chains — and that pairing is the likely shape of the mistake at the
        //   56 cutover too, so it is worth naming in the message.
        require(
            factoryAddr.code.length > 0,
            "no code at BSC_FACTORY_ADDRESS on chain 56: a testnet factory address exported into this shell lands here"
        );

        // No `ArbSys` etch: BSC does not have the precompile, so the hook's
        // fallback to `block.number` is what production runs. See the docstring.
        factory = ToshFactory(payable(factoryAddr));
        rehearsalSigner = vm.addr(rehearsalSignerPk);

        // Read rather than pinned — the Safe for this deployment is whatever
        // `DeployMainnet` handed ownership to, and this file predates it.
        ownerSafe = factory.owner();

        // Native coin for gas, and that is now ALL it is for. Before the BEM
        // move this line funded the launch fee and the raise as well, which is
        // why nothing here acquired a token balance.
        vm.deal(creator, 1 ether);

        // The fee and the raise are both pulled with `transferFrom` now, so the
        // creator needs a balance and an allowance or `createLaunch` reverts
        // before any of this file's assertions are reached.
        //
        // `deal(token, ...)` pokes BEM's balance slot rather than buying any:
        // BEM's only real pool holds about 1,959 tokens, so the raise rehearsed
        // here is not an amount the open market could supply, and nothing in this
        // file is evidence that it could. See docs/BEM_QUOTE_ASSET.md §1.2.
        //
        // The spender is the FACTORY for both the fee and the deposit. The hook
        // is the spender only for `mintBondingCurve`, which this rehearsal does
        // not reach.
        deal(BEM, creator, 10_000e8);
        vm.prank(creator);
        quote.approve(factoryAddr, type(uint256).max);
    }

    function _requireFork() internal {
        vm.skip(!factoryBound, "BSC_FACTORY_ADDRESS unset (56 is not deployed), see .env.example");
    }

    /// @dev For assertions about the chain itself, which need no deployment of
    ///      ours to be checkable.
    function _requireRpc() internal {
        vm.skip(!forked, "BSC_RPC unset, see .env.example");
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
                HookAddress.computeAddress(factoryAddr, keccak256(abi.encode(creator, rawSalt)), initcodeHash);
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
    ///         nothing and fails by name, instead of surfacing four tests later
    ///         as an unexplained revert.
    ///
    ///         That check now runs in `setUp` and is repeated here. It was only
    ///         ever here, and this docstring used to say it ran "before anything
    ///         else depends on it" — which was false, because `setUp` reads
    ///         `owner()` first and therefore reached the bad address before this
    ///         test could describe it. Keeping the duplicate is deliberate: it
    ///         costs one `extcodesize` and it is what states the requirement
    ///         where a reader looks for it.
    ///
    ///         `pogSigner` is no longer compared to a pinned address — there is
    ///         no deployment yet to pin — but it is still asserted non-zero,
    ///         because a factory whose signer was never set cannot attest and
    ///         the rehearsal would otherwise repoint it and never notice.
    /// @notice The AMM addresses this file pins are PancakeSwap Infinity's, not
    ///         Uniswap V4's.
    ///
    /// @dev    Runs on `BSC_RPC` alone, which is the whole point of it existing
    ///         separately: every other test here waits on a mainnet factory, and
    ///         while they waited this file spent the entire port pinning
    ///         `0x28e2Ea09…` — Uniswap V4's PoolManager on BSC — under a constant
    ///         named for Infinity's.
    ///
    ///         A code-length check cannot tell the two apart; both hold code, and
    ///         pinning a length proves nothing anyway. `vault()` can tell them
    ///         apart, because it exists only on Infinity's manager and because
    ///         the address it returns is where this protocol's balances actually
    ///         live. A manager that names a different Vault is as wrong here as
    ///         no manager at all.
    function test_rehearsal_pinnedAmmIsInfinityNotUniswap() public {
        _requireRpc();

        assertEq(block.chainid, 56, "fork is not BNB Smart Chain mainnet");
        assertGt(POOL_MANAGER.code.length, 0, "no contract at the pinned CLPoolManager address");
        assertGt(VAULT.code.length, 0, "no contract at the pinned Vault address");
        assertEq(address(ICLPoolManager(POOL_MANAGER).vault()), VAULT, "the pinned manager does not name our Vault");
    }

    function test_rehearsal_liveFactoryIsWhatWeThinkItIs() public {
        _requireFork();

        assertEq(block.chainid, 56, "fork is not BNB Smart Chain mainnet");
        assertGt(factoryAddr.code.length, 0, "no factory at BSC_FACTORY_ADDRESS");
        assertGt(POOL_MANAGER.code.length, 0, "no contract at the pinned BSC CLPoolManager address");
        assertTrue(ownerSafe != address(0), "factory owner is unset");
        assertTrue(factory.pogSigner() != address(0), "pogSigner was never set; no attestation can verify");
        assertFalse(factory.paused(), "factory is paused; no launch can be created");

        // The asset before the amounts, because every amount below is meaningless
        // if this disagrees — and unlike the dials, it has no setter. A factory on
        // 56 denominated in anything but BEM is not a dial to correct, it is a
        // redeploy, and this is the assertion that says so before the rehearsal
        // spends four more tests describing the wrong money.
        assertEq(address(factory.quoteAsset()), BEM, "the live factory is denominated in something else: ABORT");
        assertEq(IERC20Metadata(BEM).decimals(), 8, "BEM is not 8 decimals; every figure in this file is rescaled");

        assertEq(factory.MIN_SOFT_CAP_PROD(), REHEARSAL_SOFT_CAP, "the floor moved");
        // 46.4e8, not `1.75 ether`. This assertion carried the pre-quote-asset value
        // and nothing caught it, because the whole test sits behind `_requireFork()`
        // and skips without a mainnet fork — so it is one of the handful that the
        // green suite does not actually exercise. The unit is base units of the quote
        // asset now, and `1.75 ether` is neither the right number nor the right scale.
        assertEq(factory.maxPogAllocationLimit(), 46.4e8, "PoG limit moved");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  The plan, steps 1 and 3-6, end to end at the floor
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Lower the dial, mine, create, attest, fund to exactly the floor,
    ///         `launch()` — and the live Uniswap singleton ends up holding an
    ///         initialised pool with the genesis liquidity locked in it.
    ///
    /// @dev    This is the path the mainnet run takes, and the first time it has
    ///         been executed at a 100 BEM raise. The assertions worth reading
    ///         are the two exact ones:
    ///
    ///           - `totalNativeDeposited == softCap()` exactly. The storage field
    ///             is still named `totalNativeDeposited` and now counts BEM;
    ///             `deposit` pulls the amount rather than reading `msg.value`, so
    ///             the exactness this asserts is a property of the transfer, not
    ///             of the call value.
    ///
    ///             ⚠ THIS BULLET USED TO CALL THAT `launch()`'s `>=` BOUNDARY, and
    ///               say that landing one base unit short would strand the round
    ///               silently until `LAUNCH_WINDOW` closed. **There is no such
    ///               boundary.** `launch()` gates on the caller being the creator,
    ///               the window having ended, not having launched already, the
    ///               raise being non-zero, and the 7-day window not having expired
    ///               — and nothing else. `ToshLaunchpadHook.sol` says so where the
    ///               ladder check is defined: the cap "has not gated anything since
    ///               it became a progress target".
    ///
    ///               So hitting the cap exactly is a statement about `deposit`'s
    ///               arithmetic, which is worth asserting, and not about whether
    ///               the round can open, which it always could. The real lower
    ///               bound is `RaiseTooSmallForLadder` — a raise of about 21.04 BEM,
    ///               where `shelfP0` reaches 526 and the first geometric step stops
    ///               truncating to zero. That is 5x BELOW this rehearsal's 100 BEM,
    ///               so this run clears it comfortably and does not exercise it;
    ///               `ToshV5Fuzz` is where that edge lives.
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

        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        (address tokenAddr, address hookAddr) = factory.createLaunch{value: fee}(
            "Rehearsal", "RHS", projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, GENESIS
        );
        ToshToken token = ToshToken(tokenAddr);
        ToshLaunchpadHook hook = ToshLaunchpadHook(payable(hookAddr));

        // ── Step 4: read the frozen dials back, first thing ──────────────────
        // The plan's abort condition. If `createLaunch` raced a dial change it
        // would have frozen the OLD 928.4 BEM default into this clone
        // permanently, and this is where that is caught.
        assertEq(hook.softCap(), REHEARSAL_SOFT_CAP, "clone froze the wrong soft cap: ABORT");
        assertEq(hook.perWalletCap(), factory.maxPogAllocationLimit(), "clone froze the wrong per-wallet cap");
        assertEq(hook.genesisDuration(), GENESIS, "clone froze the wrong genesis duration");
        assertEq(hook.creator(), creator, "creator is not the test wallet: launch() would be unreachable");

        // ── Step 5: attest, then fund to exactly the cap ─────────────────────
        _registerPoG(creator, REHEARSAL_SOFT_CAP);

        vm.prank(creator);
        factory.deposit(hookAddr, address(0), REHEARSAL_SOFT_CAP);

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

    /// @notice A dial change landing between quote and execution is rejected, and
    ///         now it is rejected on purpose.
    ///
    /// @dev    The plan this file was written for quantified the race and
    ///         accepted a residual: a salt ground against stale dials produced an
    ///         address that failed Uniswap V4's flag check with probability
    ///         503/512, so 98.2% of in-flight rotations reverted loudly and the
    ///         remaining ~1.8% — address still valid, clone freezing dials the
    ///         creator never agreed to — was called the case that could not be
    ///         caught in code. The mitigation was operational: never let a dial
    ///         change be in flight during `createLaunch`.
    ///
    ///         The PancakeSwap Infinity port briefly made that 1.8% into 100%,
    ///         because permissions moved to the hook's registration bitmap and
    ///         the address gate — along with `InvalidHookSalt` — went away.
    ///         `CapsChanged` replaces it deliberately, and the residual is now
    ///         zero rather than 1.8%: the check is an equality on values the
    ///         caller supplies, so nothing about it is probabilistic.
    ///
    ///         The operational rule is a belt-and-braces measure again rather
    ///         than the only control. See docs/PANCAKESWAP_INFINITY.md §11.3.
    function test_rehearsal_aDialChangeInFlightIsRefused() public {
        _requireFork();

        _applySafeStep();
        bytes32 salt = _pickSalt();

        // What the creator read, and what their transaction will carry.
        uint256 agreedCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();

        // The Safe moves the dial again, after the quote. Twice the floor, as
        // before — it has to clear `MIN_SOFT_CAP_PROD` or the setter reverts and
        // the test would pass for the wrong reason.
        vm.prank(ownerSafe);
        factory.setDefaultSoftCap(REHEARSAL_SOFT_CAP * 2);

        uint256 fee = factory.launchFee();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.CapsChanged.selector);
        factory.createLaunch{value: fee}(
            "Stale", "STL", projTreasury, projTreasury, salt, fee, agreedCap, agreedWalletCap, GENESIS
        );
    }

    /// @notice A lone depositor meeting the whole floor takes the entire genesis
    ///         tranche: 4,620,000 tokens, 22% of `MAX_SUPPLY`, for 100 BEM.
    ///
    /// @dev    Not a defect — the tranche is always pro-rata, so this is what
    ///         "one wallet, one raise" necessarily means. It is asserted because
    ///         it is the permanent consequence that decides whether the first
    ///         launch may carry a real project's name: the pool can be deepened
    ///         later by anyone via the position manager, but a cap table showing
    ///         22% of supply to one address for 100 BEM cannot be undone. The
    ///         dollar figure that used to sit here is deliberately gone: BEM's
    ///         only real market is ~1,959 tokens deep, so quoting 100 BEM in USD
    ///         would put a number on a price this raise would itself move.
    function test_rehearsal_loneDepositorTakesTheWholeGenesisTranche() public {
        _requireFork();

        _applySafeStep();

        bytes32 salt = _pickSalt();
        uint256 fee = factory.launchFee();
        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        (address tokenAddr, address hookAddr) = factory.createLaunch{value: fee}(
            "Concentration", "CNC", projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, GENESIS
        );
        ToshToken token = ToshToken(tokenAddr);
        ToshLaunchpadHook hook = ToshLaunchpadHook(payable(hookAddr));

        _registerPoG(creator, REHEARSAL_SOFT_CAP);
        vm.prank(creator);
        factory.deposit(hookAddr, address(0), REHEARSAL_SOFT_CAP);

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
