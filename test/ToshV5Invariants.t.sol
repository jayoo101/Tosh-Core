// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";
import {HookMiner} from "../src/libraries/HookMiner.sol";

/// @notice Stateful handler: the only contract the invariant fuzzer is allowed
///         to call.  It drives real user, creator and owner actions against a
///         fixed set of projects, and keeps ghost copies of the accounting the
///         invariants check the contracts against.
///
/// @dev    Two rules make the invariants mean something, and breaking either
///         would turn this suite into decoration:
///
///         1. **This handler never mints ETH.**  There is no `vm.deal` below.
///            Actors are funded once in `setUp` and the total ether in the
///            system is fixed from then on.  A solvency invariant checked
///            against a balance the test itself can top up proves nothing.
///
///         2. **Ghost state is written only by the handler's own entry
///            points.**  `ghostDeposited` moves in `deposit` and `refund` and
///            nowhere else.  Every owner-only function is also exposed to the
///            fuzzer, so if any of them could reach the deposit ledger the
///            ghost comparison is what catches it.
contract ToshInvariantHandler is Test {
    using MessageHashUtils for bytes32;

    ToshFactory public immutable factory;
    ToshLadderTreasury public immutable ladder;
    PoolSwapTest public immutable swapRouter;
    address public immutable admin;
    address public immutable creator;
    address public immutable projTreasury;
    uint256 private immutable pogSignerPk;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    ToshLaunchpadHook[] public hooks;
    address[] public actors;

    /// @dev Every invariant loops the hook set on every single call, so this is
    ///      a runtime bound, not a modelling choice: unbounded growth turns the
    ///      check into the dominant cost of the run.
    uint256 public constant MAX_HOOKS = 10;

    uint256 private nameNonce;

    // ─── Ghost state ──────────────────────────────────────────────────────────

    /// @dev hook => actor => the deposit this handler believes is outstanding.
    mapping(address => mapping(address => uint256)) public ghostDeposited;

    /// @dev The balance the ladder treasury must currently be at or above.
    ///
    ///      Raised by every action that sees a higher balance, and lowered by
    ///      **only** `_syncAfterSwap` — the one path on which the treasury is
    ///      allowed to spend. So the invariant built on this reads "the treasury
    ///      never loses ETH except by buying back through a swap", which is the
    ///      actual §2.2-5 claim. Before the swap actions existed it degenerated
    ///      to plain monotonicity, because no egress was reachable at all.
    uint256 public ghostTreasuryFloor;

    /// @dev Cumulative ETH observed leaving the treasury across swap actions.
    ///      Informational: `afterInvariant` prints it so a run that never armed
    ///      a buyback is distinguishable from one that did.
    uint256 public ghostBuybackOutflow;

    /// @dev Treasury ETH that left without the burn pile growing in the same
    ///      call. MUST stay zero: `_buyAndBurn` is the only egress and it takes
    ///      its output straight to `0xdead`, so ETH out with nothing burned means
    ///      a leak. This is the invariant the swap actions were added to make
    ///      reachable.
    uint256 public ghostUnexplainedTreasuryDrop;

    /// @dev Counts swaps that left the hook's same-block mint lockout open.
    ///
    ///      A state-machine property rather than a value one, which is why the
    ///      existing set could not see it: every check here is conservation of
    ///      value (`_syncAfterSwap`: each wei out matched by a burn), and a
    ///      treasury buyback satisfies conservation perfectly — the reservoir's
    ///      ETH really does buy and burn tokens. What it did NOT do was stamp
    ///      `_lastSwapBlock`, so an unprivileged `pokeBuyback` could move spot
    ///      repeatedly inside one block, invisibly, and a mint in that same
    ///      block would price off the raised ceiling.
    ///
    ///      The handler already reached that state — time advances only through
    ///      `warpShort`/`warpLong`, so a poke and a mint can share a block — and
    ///      the fuzzer walked over it in silence for want of this counter.
    uint256 public ghostSwapWithoutStamp;

    /// @dev How many times the audit above actually ran. `ghostSwapWithoutStamp
    ///      == 0` is only meaningful if something was audited, and the poke
    ///      branch is conditional on a burn landing — so without this the
    ///      invariant could hold by never looking.
    uint256 public ghostLockoutAudits;

    /// @dev token => the highest balance `0xdead` has ever held of it. Burns are
    ///      supposed to be irreversible; a token that could be recovered from
    ///      the burn address would make every "burned" figure a loan.
    mapping(address => uint256) public ghostBurnFloor;

    /// @dev Latches once `canRefund()` has ever been observed true for a hook.
    ///      Past the genesis deadline `totalEthDeposited` is frozen (deposits
    ///      are closed and `refund` does not decrement it), so refundability
    ///      must be a one-way door.
    mapping(address => bool) public ghostWasRefundable;

    /// @dev The caps each hook snapshotted at creation. Recorded per hook rather
    ///      than asserted against one constant, because the fuzzer moves
    ///      `defaultSoftCap` and `maxPogAllocationLimit` between creations — and
    ///      the property under test is that a retune cannot reach back into a
    ///      round that is already open.
    mapping(address => uint256) public ghostSoftCap;
    mapping(address => uint256) public ghostPerWalletCap;

    // ─── Call counters ────────────────────────────────────────────────────────
    //
    // `fail_on_revert = false` is correct here — most random call sequences hit
    // a legitimate phase guard — but it also means a suite where *everything*
    // reverts would pass silently.  `afterInvariant` asserts on these.

    uint256 public okCreate;
    uint256 public okDeposit;
    uint256 public okRefund;
    uint256 public okLaunch;
    uint256 public okClaimGenesis;
    uint256 public okClaimReferral;
    uint256 public okOwnerAction;
    uint256 public okWarp;
    uint256 public okSwapBuy;
    uint256 public okSwapSell;
    uint256 public okPokeBuyback;
    uint256 public okMintShelf;

    /// @dev Kept because a swallowed revert in a `fail_on_revert = false` suite
    ///      is otherwise unrecoverable: the run reports a pass and there is no
    ///      trace of why nothing happened. `afterInvariant` prints these.
    bytes public lastDepositRevert;
    bytes public lastRegisterRevert;
    bytes public lastSwapRevert;
    bytes public lastListRevert;
    bytes public lastMintRevert;

    constructor(
        ToshFactory _factory,
        ToshLadderTreasury _ladder,
        PoolSwapTest _swapRouter,
        address _admin,
        address _creator,
        address _projTreasury,
        uint256 _pogSignerPk,
        ToshLaunchpadHook[] memory _hooks,
        address[] memory _actors
    ) {
        factory = _factory;
        ladder = _ladder;
        swapRouter = _swapRouter;
        admin = _admin;
        creator = _creator;
        projTreasury = _projTreasury;
        pogSignerPk = _pogSignerPk;
        for (uint256 i; i < _hooks.length; ++i) {
            hooks.push(_hooks[i]);
            ghostSoftCap[address(_hooks[i])] = _hooks[i].softCap();
            ghostPerWalletCap[address(_hooks[i])] = _hooks[i].perWalletCap();
        }
        for (uint256 i; i < _actors.length; ++i) {
            actors.push(_actors[i]);
        }
        ghostTreasuryFloor = address(_ladder).balance;
    }

    // ─── Introspection for the invariant contract ─────────────────────────────

    function hookCount() external view returns (uint256) {
        return hooks.length;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    // ─── Internal plumbing ────────────────────────────────────────────────────

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _hook(uint256 seed) internal view returns (ToshLaunchpadHook) {
        return hooks[seed % hooks.length];
    }

    /// @dev The actor side of the same problem. A refund or a genesis claim is
    ///      addressed to one wallet, so pairing a correctly-chosen hook with an
    ///      actor who never deposited on it just reverts `NoDeposit` — which is
    ///      why the first phase-targeted run still measured zero refunds.
    function _actorWithDeposit(ToshLaunchpadHook hook, uint256 seed) internal view returns (address) {
        uint256 n = actors.length;
        uint256 start = seed % n;
        for (uint256 k; k < n; ++k) {
            address a = actors[(start + k) % n];
            if (hook.ethDeposited(a) > 0) return a;
        }
        return actors[start];
    }

    function _actorWithReferral(ToshLaunchpadHook hook, uint256 seed) internal view returns (address) {
        uint256 n = actors.length;
        uint256 start = seed % n;
        for (uint256 k; k < n; ++k) {
            address a = actors[(start + k) % n];
            if (hook.referralAccrued(a) > 0) return a;
        }
        return actors[start];
    }

    /// @dev Sells need inventory, and the only way an actor gets any is
    ///      `claimGenesis` on a launched round. Picking uniformly would spend
    ///      almost every sell on an actor holding nothing.
    function _actorWithTokens(IERC20 token, uint256 seed) internal view returns (address) {
        uint256 n = actors.length;
        uint256 start = seed % n;
        for (uint256 k; k < n; ++k) {
            address a = actors[(start + k) % n];
            if (token.balanceOf(a) > 0) return a;
        }
        return actors[start];
    }

    /// @dev Total project-token supply sitting at the burn address, across every
    ///      round. Used to answer one question: when the treasury's ETH balance
    ///      falls, did anything actually get burned?
    function _totalBurned() internal view returns (uint256 total) {
        for (uint256 i; i < hooks.length; ++i) {
            address tok = address(hooks[i].projectToken());
            if (tok != address(0)) total += IERC20(tok).balanceOf(DEAD);
        }
    }

    /// @dev Phase-targeted selection, and it is the difference between a suite
    ///      that exercises the state machine and one that does not.
    ///
    ///      A project spends at most 72 h open and then is shut forever, so once
    ///      a run has accumulated a few projects the overwhelming majority are
    ///      expired. Picking uniformly means nearly every deposit lands on a
    ///      dead round and reverts, and the phases downstream of a funded
    ///      genesis — launch, genesis claims, referral claims — are never
    ///      reached at all. Measured: uniform selection got 4 deposits and 0
    ///      launches per run.
    ///
    ///      This narrows only the *target* of each action, never whether the
    ///      action is allowed to fail: the contracts' own guards still decide
    ///      that, the calls still go through the real entry points, and the
    ///      invariants are still evaluated after every one. When no hook is in
    ///      the requested phase it falls back to a uniform pick, so the
    ///      guard-rejection paths stay sampled too.
    ///
    /// @param  phase 0 = accepting deposits, 1 = refundable, 2 = launchable,
    ///               3 = launched.
    function _hookInPhase(uint256 seed, uint8 phase) internal view returns (ToshLaunchpadHook) {
        uint256 n = hooks.length;
        uint256 start = seed % n;

        for (uint256 k; k < n; ++k) {
            ToshLaunchpadHook h = hooks[(start + k) % n];
            if (phase == 0) {
                if (!h.launched() && block.timestamp < h.genesisDeadline()) return h;
            } else if (phase == 1) {
                if (h.canRefund()) return h;
            } else if (phase == 2) {
                if (
                    !h.launched() && block.timestamp >= h.genesisDeadline()
                        && block.timestamp <= h.genesisDeadline() + h.LAUNCH_WINDOW()
                        && h.totalEthDeposited() >= h.softCap()
                ) return h;
            } else {
                if (h.launched()) return h;
            }
        }
        return hooks[start];
    }

    /// @dev Top the actor's PoG budget up so the fuzzer can keep depositing.
    ///
    ///      `pogQuota` is a lifetime HIGH-WATER CAP, not a remaining balance:
    ///      `registerPoG` only ever raises it (`if (maxAlloc > pogQuota)`) and
    ///      `deposit` gates on `quotaSpent + amount > pogQuota`. So the thing to
    ///      test against is the remaining headroom, which `eligibility()`
    ///      already computes — comparing against `pogQuota` directly reads as
    ///      "budget available" and is wrong the moment anyone has spent any.
    function _ensureQuota(address user, address hook, uint256 need) internal {
        (, uint256 remaining,) = factory.eligibility(user, hook);
        if (remaining >= need) return;

        uint256 maxAlloc = factory.maxPogAllocationLimit();
        uint256 nonce = factory.pogNonces(user);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(abi.encode(user, maxAlloc, nonce, deadline, address(factory), block.chainid))
            .toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pogSignerPk, digest);

        vm.prank(user);
        // `registerPoG` is `whenNotPaused`; while the fuzzer has the platform
        // paused this reverts and the deposit below simply will not happen.
        try factory.registerPoG(maxAlloc, deadline, nonce, abi.encodePacked(r, s, v)) {}
        catch (bytes memory reason) {
            lastRegisterRevert = reason;
        }
    }

    /// @dev Latches that hold regardless of which action just ran.
    function _syncLatches() internal {
        for (uint256 i; i < hooks.length; ++i) {
            ToshLaunchpadHook h = hooks[i];
            if (h.canRefund()) ghostWasRefundable[address(h)] = true;

            address tok = address(h.projectToken());
            if (tok != address(0)) {
                uint256 burned = IERC20(tok).balanceOf(DEAD);
                if (burned > ghostBurnFloor[tok]) ghostBurnFloor[tok] = burned;
            }
        }
    }

    /// @dev Called at the end of every entry point that is NOT a swap.
    ///
    ///      Raises the treasury floor and never lowers it, which is what gives
    ///      `invariant_treasuryOnlyLosesEthToBuybacks` its teeth: no owner
    ///      action, deposit, refund, launch, claim or time jump may leave the
    ///      reservoir smaller than the largest it has been.
    function _sync() internal {
        uint256 bal = address(ladder).balance;
        if (bal > ghostTreasuryFloor) ghostTreasuryFloor = bal;
        _syncLatches();
    }

    /// @dev Called at the end of a swap action, the only place the treasury is
    ///      permitted to spend.
    ///
    ///      Two jobs. It rebases the floor down to whatever the buyback left
    ///      behind, so the run can continue with a live constraint rather than
    ///      one permanent failure. And it audits the drop: `_buyAndBurn` is the
    ///      treasury's only egress and it sends 100% of its output to `0xdead`,
    ///      so ETH leaving without the burn pile growing in the very same call
    ///      means the money went somewhere else. That is recorded rather than
    ///      asserted here, because an assertion inside a handler aborts the
    ///      sequence instead of reporting a counterexample.
    function _syncAfterSwap(uint256 ladderBefore, uint256 burnedBefore) internal {
        uint256 bal = address(ladder).balance;
        if (bal < ladderBefore) {
            uint256 drop = ladderBefore - bal;
            ghostBuybackOutflow += drop;
            if (_totalBurned() <= burnedBefore) ghostUnexplainedTreasuryDrop += drop;
        }
        ghostTreasuryFloor = bal;
        _syncLatches();
    }

    /// @dev Any pool that was just swapped must be showing the lockout shut.
    ///      Call it only where a swap is KNOWN to have landed, so a quiet block
    ///      cannot make the counter look clean.
    function _auditLockoutStamp(ToshLaunchpadHook hook) internal {
        ++ghostLockoutAudits;
        if (hook.lastSwapBlock() != block.number) ++ghostSwapWithoutStamp;
    }

    // ─── Creator actions ──────────────────────────────────────────────────────

    /// @notice Open a new launch.
    ///
    /// @dev    This action is what makes the rest of the suite work, and leaving
    ///         it out is why the first two drafts measured zero deposits.
    ///
    ///         The clock only moves forward and a project's genesis window is at
    ///         most 72 h. With a project set fixed at `setUp`, every genesis
    ///         window in the whole run opens at t=0 and is shut for good after
    ///         the first long warp — every later deposit reverts
    ///         `GenesisExpired` and the fuzzer spends the remaining depth
    ///         confirming it. A fresh project's deadline is relative to *now*,
    ///         so with this entry point there is a live genesis window at any
    ///         point on the timeline.
    function createProject(uint256 durationSeed, uint256 feeSlack) external {
        if (hooks.length >= MAX_HOOKS) return;

        uint256[3] memory durs = [uint256(3 hours), 24 hours, 72 hours];
        uint256 dur = durs[durationSeed % 3];

        uint256 softCap = factory.defaultSoftCap();
        uint256 pogLimit = factory.maxPogAllocationLimit();
        bytes32 initcodeHash = factory.hookInitcodeHash(projTreasury, creator, softCap, pogLimit, dur);

        // Bounded much tighter than the 500k the unit tests allow. This runs
        // inside a fuzz sequence, not once per test, and a miss is free: the
        // action simply does not happen this call.
        bytes32 rawSalt;
        bool found;
        for (uint256 i; i < 20_000; ++i) {
            rawSalt = bytes32(i + feeSlack % 977);
            address predicted =
                HookMiner.computeAddress(address(factory), keccak256(abi.encode(creator, rawSalt)), initcodeHash);
            if (HookMiner.isValidHookAddress(predicted) && predicted.code.length == 0) {
                found = true;
                break;
            }
        }
        if (!found) return;

        uint256 fee = factory.launchFee();
        if (creator.balance < fee) return;

        string memory name = string(abi.encodePacked("INV", vm.toString(nameNonce++)));

        vm.prank(creator);
        try factory.createLaunch{value: fee}(name, name, projTreasury, projTreasury, rawSalt, fee, dur) returns (
            address, address h
        ) {
            ToshLaunchpadHook hook = ToshLaunchpadHook(payable(h));
            hooks.push(hook);
            // Snapshot the caps this round was opened under, so the freeze
            // invariant can hold the platform to them even after a retune.
            ghostSoftCap[h] = hook.softCap();
            ghostPerWalletCap[h] = hook.perWalletCap();
            ++okCreate;
        } catch {}

        _sync();
    }

    // ─── User actions ─────────────────────────────────────────────────────────

    function deposit(uint256 actorSeed, uint256 hookSeed, uint256 amount, uint256 referrerSeed) external {
        address user = _actor(actorSeed);
        ToshLaunchpadHook hook = _hookInPhase(hookSeed, 0);

        // Bounded to something a funded actor can actually pay, and above the
        // `ZeroAmount` floor.
        amount = bound(amount, 0.001 ether, 5 ether);
        if (user.balance < amount) return;

        // Half the deposits carry a referrer, so the referral reserve is a
        // meaningful slice of the hook's balance when the refund solvency
        // invariant is evaluated, rather than a rounding detail.
        address referrer = referrerSeed % 2 == 0 ? _actor(referrerSeed >> 8) : address(0);
        if (referrer == user) referrer = address(0);

        _ensureQuota(user, address(hook), amount);

        vm.prank(user);
        try factory.deposit{value: amount}(address(hook), referrer) {
            ghostDeposited[address(hook)][user] += amount;
            ++okDeposit;
        } catch (bytes memory reason) {
            lastDepositRevert = reason;
        }

        _sync();
    }

    function refund(uint256 actorSeed, uint256 hookSeed) external {
        ToshLaunchpadHook hook = _hookInPhase(hookSeed, 1);
        address user = _actorWithDeposit(hook, actorSeed);

        vm.prank(user);
        try hook.refund() {
            // A refund returns 100% of the deposit and zeroes the ledger slot.
            ghostDeposited[address(hook)][user] = 0;
            ++okRefund;
        } catch {}

        _sync();
    }

    function launchProject(uint256 hookSeed) external {
        ToshLaunchpadHook hook = _hookInPhase(hookSeed, 2);

        vm.prank(creator);
        try hook.launch() {
            ++okLaunch;
        } catch {}

        _sync();
    }

    function claimGenesis(uint256 actorSeed, uint256 hookSeed) external {
        ToshLaunchpadHook hook = _hookInPhase(hookSeed, 3);
        address user = _actorWithDeposit(hook, actorSeed);

        vm.prank(user);
        try hook.claimGenesis() {
            ++okClaimGenesis;
        } catch {}

        _sync();
    }

    function claimReferral(uint256 actorSeed, uint256 hookSeed) external {
        ToshLaunchpadHook hook = _hookInPhase(hookSeed, 3);
        address user = _actorWithReferral(hook, actorSeed);

        vm.prank(user);
        try hook.claimReferralReward() {
            ++okClaimReferral;
        } catch {}

        _sync();
    }

    // ─── Trading ──────────────────────────────────────────────────────────────
    //
    // These two are why the treasury invariants are worth anything.
    //
    // Every other action in this handler leaves the ladder treasury's balance
    // monotone, because its single egress — `autoPiggybackBuyback` — is
    // `onlyHook` and fires exclusively from a hook's `afterSwap`. A suite that
    // never swaps therefore proves "the treasury never pays out" by arranging
    // for the payout path to be unreachable, which is not a proof of anything.
    //
    // With swaps in the fuzzer's hands the reservoir fills from the 70 bps
    // reservoir share of the 1% buy tax (the other 30 bps is the platform's
    // cut and lands elsewhere), crosses `TRIGGER_STEP`, and ETH starts leaving on arbitrary
    // call sequences while the owner is simultaneously re-curating the ladder
    // and flipping every other switch. That is the state the one-way valve
    // claim is actually about.

    /// @notice ETH -> token through the real V4 router, against a launched pool.
    ///
    /// @dev    `zeroForOne` because native ETH is `address(0)` and therefore
    ///         always sorts to `currency0`. Exact input with an unbounded price
    ///         limit, so the whole offer fills and no ETH is left stranded in
    ///         the router.
    function swapBuy(uint256 actorSeed, uint256 hookSeed, uint256 ethIn) external {
        ToshLaunchpadHook hook = _hookInPhase(hookSeed, 3);
        if (!hook.launched()) return;

        address who = _actor(actorSeed);
        ethIn = bound(ethIn, 0.001 ether, 3 ether);
        if (who.balance < ethIn) return;

        // Read the key BEFORE the prank. `vm.prank` applies to the next call of
        // any kind, so an external getter evaluated inside the argument list
        // consumes it and the swap would run as the handler instead of as the
        // actor. See the note on `ownerAddLadderToken`.
        PoolKey memory key = hook.getPoolKey();

        uint256 ladderBefore = address(ladder).balance;
        uint256 burnedBefore = _totalBurned();

        vm.prank(who);
        try swapRouter.swap{value: ethIn}(
            key,
            SwapParams({
                zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) {
            ++okSwapBuy;
            _auditLockoutStamp(hook);
        } catch (bytes memory reason) {
            lastSwapRevert = reason;
        }

        _syncAfterSwap(ladderBefore, burnedBefore);
    }

    /// @notice The retail buy. The UI never talks to the V4 router; it calls
    ///         `mintBondingCurve`. Left out of the handler, the shelf's price
    ///         gates, same-block lockout and halt were composed against nothing
    ///         — unit and attack suites only, which is the gap §4 names.
    ///
    /// @dev    Quote first, then pay exactly that. A successful `quoteMint` is
    ///         a mint the contract will accept in the next block at exactly
    ///         this price (`ToshLaunchpadHook` says so). Same-block after a
    ///         swap, a halt, or a ceiling breach all revert for real and land
    ///         in `lastMintRevert` — those are the sequences this action exists
    ///         to put next to the owner switches.
    ///
    ///         Does not touch the treasury-outflow ghosts. A shelf mint *feeds*
    ///         the reservoir (the 1 % platform cut) and never drains it, so
    ///         `_syncAfterSwap` would treat an inflow as "nothing left" and
    ///         leave the floor behind the new balance — which is correct, and
    ///         also not worth a special case.
    function mintShelf(uint256 actorSeed, uint256 hookSeed, uint256 tokenAmount) external {
        ToshLaunchpadHook hook = _hookInPhase(hookSeed, 3);
        if (!hook.launched()) return;

        tokenAmount = bound(tokenAmount, 1e16, 1_000e18);
        address who = _actor(actorSeed);

        uint256 cost;
        try hook.quoteMint(tokenAmount) returns (uint256 quoted) {
            cost = quoted;
        } catch (bytes memory reason) {
            lastMintRevert = reason;
            return;
        }
        if (cost == 0 || who.balance < cost) return;

        vm.prank(who);
        try hook.mintBondingCurve{value: cost}(tokenAmount) {
            ++okMintShelf;
        } catch (bytes memory reason) {
            lastMintRevert = reason;
        }
    }

    /// @notice Deploy the reservoir with no swap to ride — the treasury's second
    ///         egress, and the reason this action exists.
    ///
    /// @dev    `pokeBuyback` is permissionless, so it is a door any address can
    ///         open, and it moves ETH without a swap anywhere in the call. Left
    ///         out of the handler it would be unreachable, and
    ///         `invariant_treasuryOutflowAlwaysBurns` would pass over it in
    ///         silence — which is precisely the failure this suite's own notes
    ///         describe: an invariant holding because the payout path could not
    ///         be reached rather than because it was safe.
    ///
    ///         Driven by a random actor with no role, since that is the threat
    ///         model: whatever an arbitrary caller can extract by choosing the
    ///         moment, they must extract nothing, and every wei that leaves must
    ///         still be matched by a burn.
    function pokeBuyback(uint256 actorSeed) external {
        address who = _actor(actorSeed);

        uint256 ladderBefore = address(ladder).balance;
        uint256 burnedBefore = _totalBurned();

        // Per-hook burn snapshot: the round-robin cursor decides which pool a
        // leg lands on, so a rising burn is the only signal available here for
        // WHICH pool was swapped — and the stamp audit below is only meaningful
        // against a pool that was actually swapped.
        uint256 n = hooks.length;
        uint256[] memory burnBefore = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            address tok = address(hooks[i].projectToken());
            burnBefore[i] = tok == address(0) ? 0 : IERC20(tok).balanceOf(DEAD);
        }

        vm.prank(who);
        try ladder.pokeBuyback() {
            ++okPokeBuyback;
        } catch {}

        for (uint256 i; i < n; ++i) {
            address tok = address(hooks[i].projectToken());
            if (tok == address(0)) continue;
            if (IERC20(tok).balanceOf(DEAD) > burnBefore[i]) _auditLockoutStamp(hooks[i]);
        }

        // Audited on the same terms as a swap-borne buyback: this is a
        // legitimate outflow, so the floor rebases, but an outflow with nothing
        // burned for it is still recorded as unexplained.
        _syncAfterSwap(ladderBefore, burnedBefore);
    }

    /// @notice token -> ETH, which is the direction that burns the input tax.
    ///
    /// @dev    The router pays the pool with `transferFrom(seller, manager)`, so
    ///         the seller approves the ROUTER rather than the PoolManager.
    ///         Inventory only exists after a genesis claim, hence
    ///         `_actorWithTokens`.
    function swapSell(uint256 actorSeed, uint256 hookSeed, uint256 tokensIn) external {
        ToshLaunchpadHook hook = _hookInPhase(hookSeed, 3);
        if (!hook.launched()) return;

        PoolKey memory key = hook.getPoolKey();
        IERC20 token = IERC20(Currency.unwrap(key.currency1));
        address who = _actorWithTokens(token, actorSeed);

        uint256 held = token.balanceOf(who);
        if (held == 0) return;
        tokensIn = bound(tokensIn, 1, held);

        uint256 ladderBefore = address(ladder).balance;
        uint256 burnedBefore = _totalBurned();

        vm.startPrank(who);
        token.approve(address(swapRouter), type(uint256).max);
        try swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: false, amountSpecified: -int256(tokensIn), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) {
            ++okSwapSell;
            _auditLockoutStamp(hook);
        } catch (bytes memory reason) {
            lastSwapRevert = reason;
        }
        vm.stopPrank();

        _syncAfterSwap(ladderBefore, burnedBefore);
    }

    // ─── Time ─────────────────────────────────────────────────────────────────

    /// @dev Two scales on purpose, and the split is load-bearing.
    ///
    ///      Genesis windows are 3-72 h; the zombie window is another 7 days on
    ///      top. A single coarse warp range cannot serve both ends: jumps big
    ///      enough to reach the zombie phase close every genesis window on the
    ///      first or second call, after which no deposit can ever succeed again
    ///      and the run degenerates into `GenesisExpired` — which is precisely
    ///      how the first draft of this suite managed 480 calls and zero
    ///      deposits. Jumps small enough to keep genesis open never reach the
    ///      refund phases at all, leaving those invariants vacuously true.
    ///      Both roll the block number as well as the clock. The TWAP oracle
    ///      writes one observation per block and the shelf ladder has a
    ///      same-block lockout against the last swap, so a run that advances
    ///      time while staying in block 1 forever would keep the price
    ///      reference frozen and quietly suppress the very oracle path the
    ///      buyback's price floor reads.
    function warpShort(uint256 secs) external {
        secs = bound(secs, 1 minutes, 2 hours);
        vm.warp(block.timestamp + secs);
        vm.roll(block.number + 1);
        ++okWarp;
        _sync();
    }

    function warpLong(uint256 secs) external {
        secs = bound(secs, 12 hours, 4 days);
        vm.warp(block.timestamp + secs);
        vm.roll(block.number + 1);
        ++okWarp;
        _sync();
    }

    // ─── Owner actions ────────────────────────────────────────────────────────
    //
    // Every one of these is `onlyOwner` on a live platform.  They are in the
    // fuzzer's reach on purpose: the headline claim being tested is that none
    // of them can touch a depositor's balance or the treasury's.

    function ownerPause(bool on) external {
        vm.prank(admin);
        if (on) {
            try factory.pause() {
                ++okOwnerAction;
            } catch {}
        } else {
            try factory.unpause() {
                ++okOwnerAction;
            } catch {}
        }
        _sync();
    }

    function ownerHaltLadder(uint256 hookSeed, uint256 duration, bool global) external {
        duration = bound(duration, 1, 7 days);
        address target = global ? address(0) : address(_hook(hookSeed));

        vm.prank(admin);
        try factory.haltLadderMinting(target, duration) {
            ++okOwnerAction;
        } catch {}
        _sync();
    }

    function ownerResumeLadder(uint256 hookSeed, bool global) external {
        address target = global ? address(0) : address(_hook(hookSeed));

        vm.prank(admin);
        try factory.resumeLadderMinting(target) {
            ++okOwnerAction;
        } catch {}
        _sync();
    }

    function ownerBlacklist(uint256 actorSeed, uint256 duration) external {
        address[] memory targets = new address[](1);
        targets[0] = _actor(actorSeed);
        // Capped at 2 days, not the 365 the setter allows. With four actors and
        // roughly ninety blacklist calls per run, year-long bans put every actor
        // on ice within the first few calls and the rest of the sequence just
        // re-confirms `IsBlacklisted` — which is exactly what the first version
        // of this suite did. A short ban exercises the same guard and expires,
        // so the run gets back to the paths worth stressing.
        duration = bound(duration, 1 hours, 2 days);

        vm.prank(admin);
        try factory.setBlacklist(targets, duration) {
            ++okOwnerAction;
        } catch {}
        _sync();
    }

    function ownerLiftBlacklist(uint256 actorSeed) external {
        address[] memory targets = new address[](1);
        targets[0] = _actor(actorSeed);

        vm.prank(admin);
        try factory.liftBlacklist(targets) {
            ++okOwnerAction;
        } catch {}
        _sync();
    }

    function ownerSetLaunchFee(uint256 fee) external {
        // Capped at 1 ether so the creator can keep affording to open rounds;
        // a 100-ether fee bankrupts them in a few calls and shuts off the one
        // action the rest of the sequence depends on.
        fee = bound(fee, 0, 1 ether);
        vm.prank(admin);
        try factory.setLaunchFee(fee) {
            ++okOwnerAction;
        } catch {}
        _sync();
    }

    function ownerSetDefaultSoftCap(uint256 cap) external {
        // Ceiling is 6 ETH, not the 1000 the setter allows, and the reason is
        // reachability rather than realism. Four actors on a 20-ETH rolling PoG
        // quota cannot fund a 1000-ETH round, so a retune that high permanently
        // sterilises every project created after it — and with `MAX_HOOKS` at
        // ten, a handful of those fill the whole slate with rounds that can
        // never launch, starving the post-launch invariants of subjects. The
        // property under test is that a retune cannot reach into a round that
        // is already open, and any moving value exercises that.
        cap = bound(cap, 0.01 ether, 6 ether);
        vm.prank(admin);
        try factory.setDefaultSoftCap(cap) {
            ++okOwnerAction;
        } catch {}
        _sync();
    }

    function ownerSetMaxPogAllocationLimit(uint256 limit) external {
        // Floored at 1 ether rather than 1 wei. `registerPoG` only ratchets
        // `pogQuota` upward, so a limit of a few wei permanently pins every
        // actor's budget below the minimum deposit and the rest of the run can
        // never deposit again. The invariant under test is that the owner
        // cannot touch balances, which a 1-ether floor exercises just as well.
        // Floor raised to 2 ETH now that the soft cap tops out at 6: this value
        // becomes each new round's `perWalletCap`, and four actors capped at
        // 1 ETH each cannot clear a 6-ETH soft cap no matter how long the run.
        limit = bound(limit, 2 ether, 1000 ether);
        vm.prank(admin);
        try factory.setMaxPogAllocationLimit(limit) {
            ++okOwnerAction;
        } catch {}
        _sync();
    }

    /// @dev Rotating the oracle key must not be able to strand a deposit that
    ///      is already on the books.
    function ownerSetPogSigner(uint256 seed) external {
        address newSigner = address(uint160(uint256(keccak256(abi.encode(seed)))));
        if (newSigner == address(0)) return;

        vm.prank(admin);
        try factory.setPogSigner(newSigner) {
            ++okOwnerAction;
        } catch {}

        // Restored unconditionally, outside the try. `_ensureQuota` signs with
        // the original key, so leaving a foreign signer in place would fail
        // every later registration on `InvalidSignature` and quietly end the
        // run's ability to deposit — a brick, not a finding.
        vm.prank(admin);
        factory.setPogSigner(vm.addr(pogSignerPk));

        _sync();
    }

    /// @dev The `projectToken()` read is hoisted out of the argument list on
    ///      purpose, and it is not a style preference.
    ///
    ///      `vm.prank` applies to the NEXT call, whatever it is. Written as
    ///      `vm.prank(admin); ladder.addLadderToken(address(hook.projectToken()))`
    ///      the getter is evaluated first, eats the prank, and `addLadderToken`
    ///      arrives from the handler — reverting `OwnableUnauthorizedAccount`
    ///      into the `catch` below. Both listing actions were written that way
    ///      and were silent no-ops; nobody noticed because neither was in the
    ///      `targetSelector` list until the swap work needed them.
    function ownerAddLadderToken(uint256 hookSeed) external {
        // Phase-targeted: `addLadderToken` reads the pool key back off the hook
        // and an unlaunched hook has none, so a uniform pick reverts
        // `TokenNotLaunchedHere` for however many of the ten rounds have not
        // launched — which early in a run is all of them.
        //
        // Phase 3 is "launched", which since 2026-09-11 is no longer enough:
        // `addLadderToken` also refuses a pool whose `twapSqrtPriceX96()`
        // reads zero, and that is every pool for its first `TWAP_WINDOW`.
        // Left alone, this action would only land when some unrelated
        // `warpShort`/`warpLong` draw happened to have aged the pool the
        // fuzzer then picked, so listings would be rare and correlated with
        // warps rather than explored — the same "silent no-op" shape the note
        // above describes, one layer down.  The clock is the fuzzer's to move,
        // so this does not warp; it picks from the pools already old enough.
        address token = address(_hookInPhase(hookSeed, 3).projectToken());

        vm.prank(admin);
        try ladder.addLadderToken(token) {
            ++okOwnerAction;
        } catch (bytes memory reason) {
            lastListRevert = reason;
        }
        _sync();
    }

    function ownerRemoveLadderToken(uint256 hookSeed) external {
        address token = address(_hook(hookSeed).projectToken());

        vm.prank(admin);
        try ladder.removeLadderToken(token) {
            ++okOwnerAction;
        } catch {}
        _sync();
    }
}

/// @notice Stateful invariant suite for the three load-bearing claims in
///         `docs/SECURITY_AUDIT.md` §2.2.
///
/// @dev    The 252 tests in the rest of `test/` are unit and integration tests:
///         each one asserts a property under a sequence *the author chose*.
///         This file asserts properties under sequences *nobody chose* — the
///         fuzzer composes deposits, refunds, launches, claims, time jumps and
///         every owner-only switch in arbitrary order, and the invariants below
///         must survive all of it.
///
///         The three claims, in the order the audit dossier lists them:
///
///           §2.2-1  The owner cannot reach depositor money.
///           §2.2-2  A failed genesis always refunds.
///           §2.2-5  The treasury is a one-way valve.
contract ToshV5InvariantsTest is StdInvariant, Test {
    using MessageHashUtils for bytes32;

    address internal admin = makeAddr("admin");
    address internal creator = makeAddr("creator");
    address internal platformTreasury = makeAddr("platformTreasury");
    address internal projTreasury = makeAddr("projTreasury");

    uint256 internal pogSignerPk = 0xBEEF_CAFE;
    address internal pogSigner;

    PoolManager internal poolManager;
    PoolSwapTest internal swapRouter;
    ToshLadderTreasury internal ladder;
    ToshFactory internal factory;

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    ToshInvariantHandler internal handler;
    ToshLaunchpadHook[] internal hooks;
    address[] internal actors;

    /// @dev Deliberately low. A soft cap a single deposit can clear means the
    ///      fuzzer reaches `launch()` often, which is the only way the
    ///      post-launch invariants (genesis claims, referral claims) get
    ///      exercised at all rather than sitting behind `SoftCapNotMet`.
    uint256 internal constant SOFT_CAP = 2 ether;
    uint256 internal constant POG_CAP = 20 ether;
    uint256 internal constant ACTOR_FUNDING = 100 ether;

    /// @dev The three legal genesis durations. Giving each project a different
    ///      one staggers the deadlines, so a single monotonic clock can have one
    ///      project still funding while another is already refundable — and it
    ///      keeps the constructor tuples distinct, which stops the salt miner
    ///      from handing back a colliding CREATE2 address.
    function _durations() internal pure returns (uint256[3] memory) {
        return [uint256(3 hours), 24 hours, 72 hours];
    }

    function setUp() public {
        pogSigner = vm.addr(pogSignerPk);
        poolManager = new PoolManager(admin);
        swapRouter = new PoolSwapTest(IPoolManager(address(poolManager)));

        vm.startPrank(admin);
        ladder = new ToshLadderTreasury(address(poolManager), admin);
        factory = new ToshFactory(address(poolManager), pogSigner, platformTreasury, address(ladder));
        ladder.setFactory(address(factory));

        factory.setDefaultSoftCap(SOFT_CAP);
        factory.setMaxPogAllocationLimit(POG_CAP);
        // Cooldown off: it is a per-(wallet, hook) timer orthogonal to
        // everything here, and leaving it on just bounces calls off a clock.
        factory.setCooldownDuration(0);
        // The quota window, by contrast, is left ON. `registerPoG` only
        // ratchets `pogQuota` upward, so a lifetime budget (window = 0) means
        // every actor is spent for good after ~20 ETH and a long run starves.
        // A rolling window refills as the fuzzer advances the clock, which is
        // both how the live system behaves and what keeps the sequence useful.
        factory.setQuotaWindowDuration(1 days);
        vm.stopPrank();

        actors.push(makeAddr("alice"));
        actors.push(makeAddr("bob"));
        actors.push(makeAddr("carol"));
        actors.push(makeAddr("dave"));

        // The ONLY ether ever handed to an actor. See the handler's header.
        for (uint256 i; i < actors.length; ++i) {
            vm.deal(actors[i], ACTOR_FUNDING);
            // Onboard every actor BEFORE the fuzzer can touch anything.
            //
            // `registerPoG` is `whenNotPaused`, and the fuzzer holds `pause()`.
            // If quota could only be acquired mid-run, a pause would block
            // registration and therefore every subsequent deposit — the run
            // would spend itself on `EnforcedPause` instead of on the state
            // machine. Registering up front also matches reality: users get
            // attested before an incident, not during one. `deposit` itself is
            // deliberately not pausable, so this leaves pause doing exactly what
            // it does on a live platform.
            _registerPoG(actors[i], POG_CAP);
        }
        // The creator keeps opening rounds throughout the run, each costing a
        // launch fee the fuzzer can raise to 1 ether, so this is sized for the
        // whole sequence rather than the three projects seeded below.
        vm.deal(creator, 1000 ether);

        uint256[3] memory durs = _durations();
        for (uint256 i; i < durs.length; ++i) {
            hooks.push(_createProject(durs[i]));
        }

        handler = new ToshInvariantHandler(
            factory, ladder, swapRouter, admin, creator, projTreasury, pogSignerPk, hooks, actors
        );

        // Restrict the fuzzer to the handler, then to the handler's action
        // surface. Without the selector list it also burns calls on the ghost
        // getters, which cannot move state and only dilute the run.
        targetContract(address(handler));

        // Weights, as repeated entries: the fuzzer picks a selector uniformly,
        // so listing an action once against thirty others is a decision about
        // how much of the run it gets, not just a registration.
        //
        // Written with a running index rather than hand-numbered slots. The
        // numbered version invited exactly one mistake — reusing an index and
        // silently deleting whatever action was there — and made every weight
        // change a renumbering exercise.
        bytes4[] memory selectors = new bytes4[](37);
        uint256 n;

        // Genesis phase. Everything else in the state machine is downstream of
        // somebody having deposited first, so this end is weighted heavily.
        selectors[n++] = ToshInvariantHandler.createProject.selector;
        selectors[n++] = ToshInvariantHandler.createProject.selector;
        selectors[n++] = ToshInvariantHandler.deposit.selector;
        selectors[n++] = ToshInvariantHandler.deposit.selector;
        selectors[n++] = ToshInvariantHandler.deposit.selector;
        selectors[n++] = ToshInvariantHandler.deposit.selector;
        selectors[n++] = ToshInvariantHandler.refund.selector;
        selectors[n++] = ToshInvariantHandler.refund.selector;
        selectors[n++] = ToshInvariantHandler.launchProject.selector;
        selectors[n++] = ToshInvariantHandler.launchProject.selector;

        // Genesis claims are the ONLY source of token inventory, so sells are
        // downstream of them; at a single entry they stayed at zero for whole
        // runs and `swapSell` had nothing to sell.
        selectors[n++] = ToshInvariantHandler.claimGenesis.selector;
        selectors[n++] = ToshInvariantHandler.claimGenesis.selector;
        selectors[n++] = ToshInvariantHandler.claimReferral.selector;

        selectors[n++] = ToshInvariantHandler.warpShort.selector;
        selectors[n++] = ToshInvariantHandler.warpShort.selector;
        selectors[n++] = ToshInvariantHandler.warpLong.selector;

        selectors[n++] = ToshInvariantHandler.ownerPause.selector;
        selectors[n++] = ToshInvariantHandler.ownerHaltLadder.selector;
        selectors[n++] = ToshInvariantHandler.ownerResumeLadder.selector;
        selectors[n++] = ToshInvariantHandler.ownerBlacklist.selector;
        selectors[n++] = ToshInvariantHandler.ownerLiftBlacklist.selector;
        selectors[n++] = ToshInvariantHandler.ownerSetDefaultSoftCap.selector;
        selectors[n++] = ToshInvariantHandler.ownerSetPogSigner.selector;
        selectors[n++] = ToshInvariantHandler.ownerSetLaunchFee.selector;
        selectors[n++] = ToshInvariantHandler.ownerSetMaxPogAllocationLimit.selector;

        // Buys weighted like deposits: a buyback needs the reservoir over
        // 1 ETH, and the 70 bps reservoir share of the buy-side tax is the only
        // inflow that scales with fuzzer activity rather than with project
        // count. (The tax is 100 bps; 30 of those go to the platform and never
        // reach this balance, so the arming rate is 70 bps of volume.)
        selectors[n++] = ToshInvariantHandler.swapBuy.selector;
        selectors[n++] = ToshInvariantHandler.swapBuy.selector;
        selectors[n++] = ToshInvariantHandler.swapBuy.selector;
        selectors[n++] = ToshInvariantHandler.swapSell.selector;

        // The retail path. Weighted at two so a halt / same-block / ceiling
        // sequence can sit next to a successful mint inside one run, which is
        // the composition unit tests cannot make.
        selectors[n++] = ToshInvariantHandler.mintShelf.selector;
        selectors[n++] = ToshInvariantHandler.mintShelf.selector;

        // The treasury's other egress. Weighted at two because it is the only
        // action that can drain the reservoir with no swap in the call, so it is
        // the one that would make `invariant_treasuryOutflowAlwaysBurns` say
        // something new — and at zero entries the door would exist in the
        // contract but not in the state machine.
        selectors[n++] = ToshInvariantHandler.pokeBuyback.selector;
        selectors[n++] = ToshInvariantHandler.pokeBuyback.selector;

        // Curation. Listing outweighs delisting 3:1 — at parity the two
        // cancelled out and the ladder measured empty at the end of every run,
        // which makes `autoPiggybackBuyback` return early on `total == 0` and
        // leaves the outflow invariant vacuous. Delisting stays in the mix,
        // because an owner narrowing the ladder mid-flight is the adversarial
        // case; it just no longer wins the race by default.
        selectors[n++] = ToshInvariantHandler.ownerAddLadderToken.selector;
        selectors[n++] = ToshInvariantHandler.ownerAddLadderToken.selector;
        selectors[n++] = ToshInvariantHandler.ownerAddLadderToken.selector;
        selectors[n++] = ToshInvariantHandler.ownerRemoveLadderToken.selector;

        require(n == selectors.length, "selector array length does not match the weights");
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function _registerPoG(address user, uint256 maxAlloc) internal {
        uint256 nonce = factory.pogNonces(user);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(abi.encode(user, maxAlloc, nonce, deadline, address(factory), block.chainid))
            .toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pogSignerPk, digest);

        vm.prank(user);
        factory.registerPoG(maxAlloc, deadline, nonce, abi.encodePacked(r, s, v));
    }

    /// @dev Mirrors the salt scheme in `createLaunch`: the factory salts on
    ///      `keccak256(abi.encode(msg.sender, hookSalt))`, and the initcode hash
    ///      is read back off the factory so the immutable-arg tuple cannot drift.
    function _createProject(uint256 genesisDuration) internal returns (ToshLaunchpadHook hook) {
        bytes32 initcodeHash = factory.hookInitcodeHash(
            projTreasury, creator, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), genesisDuration
        );

        bytes32 rawSalt;
        bool found;
        for (uint256 i; i < 500_000; ++i) {
            rawSalt = bytes32(i);
            address predicted =
                HookMiner.computeAddress(address(factory), keccak256(abi.encode(creator, rawSalt)), initcodeHash);
            if (HookMiner.isValidHookAddress(predicted) && predicted.code.length == 0) {
                found = true;
                break;
            }
        }
        require(found, "_createProject: no valid salt");

        uint256 fee = factory.launchFee();
        vm.prank(creator);
        (, address h) = factory.createLaunch{value: fee}(
            string(abi.encodePacked("P", vm.toString(genesisDuration))),
            string(abi.encodePacked("P", vm.toString(genesisDuration))),
            projTreasury,
            projTreasury,
            rawSalt,
            fee,
            genesisDuration
        );
        hook = ToshLaunchpadHook(payable(h));
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  §2.2-2  A failed genesis always refunds
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Every unlaunched hook holds at least enough ETH to pay out every
    ///         outstanding deposit in full, simultaneously.
    ///
    /// @dev    This is the machine-checkable form of the refund promise. It has
    ///         to be checked against the live `ethDeposited` ledger rather than
    ///         `totalEthDeposited`, because `refund()` zeroes the former and
    ///         deliberately leaves the latter alone as a gross-raise figure.
    ///
    ///         Note what is NOT subtracted: the 10% referral commission. It is
    ///         accrued as bookkeeping at deposit time but no ETH moves, and
    ///         `claimReferralReward` reverts with `NotLaunched` before launch —
    ///         so a failed round owes referrers nothing and the full balance
    ///         stays available to depositors. If someone ever makes referral
    ///         claimable pre-launch, this invariant is what should break.
    function invariant_unlaunchedHookCanPayEveryRefund() public view {
        uint256 n = handler.hookCount();
        for (uint256 i; i < n; ++i) {
            ToshLaunchpadHook hook = handler.hooks(i);
            if (hook.launched()) continue;

            uint256 owed;
            uint256 a = handler.actorCount();
            for (uint256 j; j < a; ++j) {
                owed += hook.ethDeposited(handler.actors(j));
            }

            assertGe(address(hook).balance, owed, "unlaunched hook cannot cover its outstanding deposits");
        }
    }

    /// @notice Refundability is a latch: once a round is refundable it can never
    ///         stop being refundable.
    ///
    /// @dev    Past the deadline deposits are closed and `refund()` does not
    ///         decrement `totalEthDeposited`, so the `softCapFailed` term is
    ///         frozen; the zombie term is monotone in time. If either ever went
    ///         backwards, a depositor who waited would find the exit shut.
    function invariant_refundabilityNeverRevokes() public view {
        uint256 n = handler.hookCount();
        for (uint256 i; i < n; ++i) {
            ToshLaunchpadHook hook = handler.hooks(i);
            if (!handler.ghostWasRefundable(address(hook))) continue;
            // Launching a round that was already refundable would strand every
            // depositor who had not yet taken the exit.
            assertFalse(hook.launched(), "a refundable round later launched");
            assertTrue(hook.canRefund(), "refundability was revoked");
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  §2.2-1  The owner cannot reach depositor money
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice The on-chain deposit ledger matches the handler's ghost copy,
    ///         which only user deposits and user refunds ever write.
    ///
    /// @dev    The fuzzer has `pause`, `haltLadderMinting`, `setBlacklist`,
    ///         `setPogSigner`, `setLaunchFee`, `setDefaultSoftCap` and
    ///         `setMaxPogAllocationLimit` in reach. If any of them could move,
    ///         zero or redirect a depositor's balance, the two would diverge.
    function invariant_ownerCannotMoveTheDepositLedger() public view {
        uint256 n = handler.hookCount();
        uint256 a = handler.actorCount();
        for (uint256 i; i < n; ++i) {
            ToshLaunchpadHook hook = handler.hooks(i);
            for (uint256 j; j < a; ++j) {
                address actor = handler.actors(j);
                assertEq(
                    hook.ethDeposited(actor),
                    handler.ghostDeposited(address(hook), actor),
                    "deposit ledger diverged from user-driven ghost state"
                );
            }
        }
    }

    /// @notice `softCap` and `perWalletCap` are snapshotted per hook at creation
    ///         and immutable after, so an owner retune can never move the
    ///         goalposts on a round that is already open.
    ///
    /// @dev    Checked against the value recorded when each round was opened,
    ///         not against one global constant: the fuzzer moves
    ///         `defaultSoftCap` and `maxPogAllocationLimit` between creations,
    ///         so rounds legitimately differ from each other. What must never
    ///         happen is a round's own caps changing under it.
    function invariant_perHookCapsAreFrozen() public view {
        uint256 n = handler.hookCount();
        for (uint256 i; i < n; ++i) {
            ToshLaunchpadHook hook = handler.hooks(i);
            assertEq(hook.softCap(), handler.ghostSoftCap(address(hook)), "softCap moved after the round opened");
            assertEq(
                hook.perWalletCap(),
                handler.ghostPerWalletCap(address(hook)),
                "perWalletCap moved after the round opened"
            );
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  §2.2-5  The treasury is a one-way valve
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice The treasury never loses ETH except by buying back through a
    ///         swap.
    ///
    /// @dev    The floor this checks against is raised by every non-swap action
    ///         and lowered only by `_syncAfterSwap`. So a deposit, refund,
    ///         launch, claim, time jump, ladder re-curation, pause, blacklist,
    ///         signer rotation or fee retune that made the reservoir smaller
    ///         breaks this — while a genuine piggyback buyback does not.
    ///
    ///         Note what this deliberately does NOT claim: that the balance is
    ///         monotone. It was, until the swap actions landed, but only because
    ///         the egress was unreachable. Asserting monotonicity now would be
    ///         asserting that the buyback engine never runs.
    function invariant_treasuryOnlyLosesEthToBuybacks() public view {
        assertGe(
            address(ladder).balance,
            handler.ghostTreasuryFloor(),
            "ladder treasury lost ETH outside a buyback: a withdrawal path exists"
        );
    }

    /// @notice Every wei that leaves the treasury is matched by tokens arriving
    ///         at `0xdead` in the same call.
    ///
    /// @dev    This is the sharper half of the one-way valve, and the reason the
    ///         swap and poke actions exist. `_buyAndBurn` is the treasury's only
    ///         egress and it `take`s its output directly to `DEAD_ADDRESS`, so
    ///         ETH leaving with nothing burned would mean the reservoir paid
    ///         somebody. The owner is re-curating the ladder throughout the run,
    ///         which is exactly the surface that could aim the spend at a pool
    ///         they control — the venue-derivation fix in `addLadderToken` is
    ///         what this holds to account.
    ///
    ///         `pokeBuyback` is in the mix for the same reason: it is
    ///         permissionless, so an arbitrary caller choosing the moment is
    ///         part of the threat model, and it is the only egress that runs
    ///         without a swap anywhere in the call.
    function invariant_treasuryOutflowAlwaysBurns() public view {
        assertEq(handler.ghostUnexplainedTreasuryDrop(), 0, "treasury ETH left without anything being burned for it");
    }

    /// @notice Every swap shuts the same-block mint lockout on the pool it
    ///         touched — including the treasury's own buybacks.
    ///
    /// @dev    The hole this closes was not a missing handler action but a
    ///         missing assertion. `pokeBuyback` has always been in the handler,
    ///         driven by a random unprivileged actor, and the fuzzer has always
    ///         been able to land a poke and a mint in one block. But every
    ///         invariant here was about conservation of value, and the buyback
    ///         conserved value impeccably while leaving `_lastSwapBlock`
    ///         untouched — so the run passed over a price move that reopened
    ///         the shelf gate for the cost of gas.
    function invariant_everySwapShutsTheMintLockout() public view {
        assertEq(handler.ghostSwapWithoutStamp(), 0, "a swap left the same-block mint lockout open");
    }

    /// @notice Burns are irreversible: no token ever leaves `0xdead`.
    ///
    /// @dev    Cheap, and it pins the claim the buyback accounting rests on. If
    ///         supply could be recovered from the burn address, every "burned"
    ///         figure in the protocol would be a loan rather than a
    ///         destruction — and `invariant_treasuryOutflowAlwaysBurns` above
    ///         could be satisfied by tokens that are later retrieved.
    function invariant_burnedSupplyNeverReturns() public view {
        uint256 n = handler.hookCount();
        for (uint256 i; i < n; ++i) {
            address tok = address(handler.hooks(i).projectToken());
            if (tok == address(0)) continue;
            assertGe(IERC20(tok).balanceOf(DEAD), handler.ghostBurnFloor(tok), "tokens left the burn address");
        }
    }

    /// @notice The owner never ends up holding value.
    ///
    /// @dev    `admin` owns the factory and the treasury and holds every switch
    ///         the fuzzer flips, including ladder curation. It is funded with
    ///         nothing in `setUp` and has no legitimate income: launch fees go
    ///         to the reservoir, the Phase-2 platform cut goes to the reservoir,
    ///         and the project cut goes to `projectAdmin`. So its balance must
    ///         still be zero after any sequence, and it must never come to hold
    ///         a project token.
    ///
    ///         This is the crudest possible statement of "the owner cannot take
    ///         custody" and that is the point: it needs no ghost bookkeeping to
    ///         be believed, so it cannot be wrong in the same way the ledger
    ///         ghosts could.
    function invariant_ownerNeverHoldsValue() public view {
        assertEq(admin.balance, 0, "the owner received ETH");

        uint256 n = handler.hookCount();
        for (uint256 i; i < n; ++i) {
            address tok = address(handler.hooks(i).projectToken());
            if (tok == address(0)) continue;
            assertEq(IERC20(tok).balanceOf(admin), 0, "the owner received project tokens");
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Suite self-check
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Logging ONLY, deliberately no assertions.
    ///
    ///      The obvious thing to do here is assert the fuzzer landed some
    ///      deposits, since `fail_on_revert = false` means an all-reverting run
    ///      would report a serene pass. That does not work: a failing
    ///      `afterInvariant` sends Foundry into shrinking, and the minimal
    ///      sequence it converges on trivially also has no deposits — so the
    ///      report says "no deposit ever succeeded" against a one-call
    ///      counterexample and tells you nothing about which invariant broke.
    ///      Coverage is asserted deterministically in
    ///      `test_handlerPlumbingIsLive` instead, where it cannot flake on
    ///      fuzzer luck.
    function afterInvariant() public view {
        console2.log("hooks            ", handler.hookCount());
        console2.log("ok creates       ", handler.okCreate());
        console2.log("ok deposits      ", handler.okDeposit());
        console2.log("ok refunds       ", handler.okRefund());
        console2.log("ok launches      ", handler.okLaunch());
        console2.log("ok genesis claims", handler.okClaimGenesis());
        console2.log("ok referral claims", handler.okClaimReferral());
        console2.log("ok owner actions ", handler.okOwnerAction());
        console2.log("ok warps         ", handler.okWarp());
        console2.log("ok swap buys     ", handler.okSwapBuy());
        console2.log("ok swap sells    ", handler.okSwapSell());
        console2.log("ok shelf mints   ", handler.okMintShelf());
        console2.log("ok pokes         ", handler.okPokeBuyback());
        console2.log("ladder listings  ", ladder.ladderTokenCount());
        console2.log("ladder balance   ", address(ladder).balance);
        console2.log("buyback outflow  ", handler.ghostBuybackOutflow());
        console2.logBytes(handler.lastDepositRevert());
        console2.logBytes(handler.lastRegisterRevert());
        console2.logBytes(handler.lastSwapRevert());
        console2.logBytes(handler.lastListRevert());
        console2.logBytes(handler.lastMintRevert());
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Suite self-check
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Drives the handler's entry points by hand, in an order that must
    ///         work, and asserts each one actually took effect.
    ///
    /// @dev    This is the guard against the failure mode that makes invariant
    ///         suites worthless: every handler call reverting into a swallowed
    ///         `catch`, so the invariants hold over a state machine that never
    ///         moved and the check goes green having tested nothing. It is a
    ///         plain unit test rather than a fuzz assertion precisely so it is
    ///         deterministic — if the handler's plumbing breaks, this fails with
    ///         a readable reason instead of a shrunk counterexample.
    function test_handlerPlumbingIsLive() public {
        // Genesis: a deposit must land and reach the hook's ledger.
        handler.deposit(0, 0, 1 ether, 1);
        assertEq(handler.okDeposit(), 1, "handler could not land a deposit");

        ToshLaunchpadHook h0 = handler.hooks(0);
        address alice = handler.actors(0);
        assertEq(h0.ethDeposited(alice), handler.ghostDeposited(address(h0), alice), "ghost desynced immediately");
        assertGt(h0.ethDeposited(alice), 0, "deposit did not reach the hook");

        // Owner surface must be reachable, or invariant 2.2-1 is untested.
        handler.ownerPause(true);
        handler.ownerPause(false);
        assertGt(handler.okOwnerAction(), 0, "handler could not land an owner action");

        // The clock must be able to cross a genesis deadline.
        handler.warpLong(3 days);
        assertGt(handler.okWarp(), 0, "handler could not advance the clock");
        assertTrue(h0.canRefund(), "3h project should be refundable after 3 days below its soft cap");

        // And the refund must actually pay out.
        uint256 before = alice.balance;
        handler.refund(0, 0);
        assertEq(handler.okRefund(), 1, "handler could not land a refund");
        assertGt(alice.balance, before, "refund paid nothing");
        assertEq(h0.ethDeposited(alice), 0, "ledger not cleared after refund");
    }

    /// @notice The launch path must also be reachable, or every post-launch
    ///         invariant is vacuous.
    function test_handlerCanReachLaunch() public {
        // Soft cap is 5 ETH; four actors at 5 ETH each clears it on the 72h
        // project, which is still inside its genesis window.
        for (uint256 i; i < 4; ++i) {
            handler.deposit(i, 2, 5 ether, 0);
        }
        ToshLaunchpadHook h2 = handler.hooks(2);
        assertGe(h2.totalEthDeposited(), SOFT_CAP, "could not fund past the soft cap");

        handler.warpLong(4 days); // past the 72h deadline, inside the 7d window
        handler.launchProject(2);
        assertEq(handler.okLaunch(), 1, "handler could not launch a funded project");
        assertTrue(h2.launched(), "project did not launch");
    }

    /// @notice The buyback really does fire, spend treasury ETH, and burn — so
    ///         `invariant_treasuryOutflowAlwaysBurns` is checking a path the
    ///         fuzzer can reach rather than a vacuous truth.
    ///
    /// @dev    Deterministic for the same reason as the two tests above: whether
    ///         a fuzz run happens to arm a 1-ETH reservoir is luck, and an
    ///         invariant that silently never exercises its subject is the exact
    ///         failure this suite is supposed to be immune to.
    ///
    ///         Note there is no `vm.deal` to the treasury here, unlike the
    ///         acceptance tests in `ToshV5.t.sol`. The reservoir is armed the
    ///         way production arms it — launch fees plus the reservoir's share
    ///         of the buy tax — because
    ///         topping up the pot under test would also fake the accounting the
    ///         drop audit compares against.
    function test_handlerCanReachBuybackAndBurn() public {
        // Fund and launch the 72h round, then list it so the ladder is non-empty.
        for (uint256 i; i < 4; ++i) {
            handler.deposit(i, 2, 5 ether, 0);
        }
        handler.warpLong(4 days);
        handler.launchProject(2);
        ToshLaunchpadHook h2 = handler.hooks(2);
        assertTrue(h2.launched(), "precondition: the round must launch");

        // A pool one second old reads a zero TWAP, and `addLadderToken` has
        // refused that since 2026-09-11, so the listing has to clear
        // `TWAP_WINDOW` first.  `warpShort` bounds its argument to
        // [1 min, 2 h], so 1801 lands exactly one second past the window.
        handler.warpShort(1801);

        handler.ownerAddLadderToken(2);
        assertEq(ladder.ladderTokenCount(), 1, "handler could not list a ladder token");

        // Arm the reservoir organically: the fee is an owner dial the fuzzer
        // also holds, and each new round pays it straight into the treasury.
        handler.ownerSetLaunchFee(1 ether);
        while (address(ladder).balance < ladder.TRIGGER_STEP() && handler.hookCount() < 10) {
            handler.createProject(1, 0);
        }
        assertGe(address(ladder).balance, ladder.TRIGGER_STEP(), "could not arm the buyback from launch fees");

        uint256 ladderBefore = address(ladder).balance;
        uint256 burnedBefore = IERC20(address(h2.projectToken())).balanceOf(DEAD);

        handler.swapBuy(0, 2, 0.5 ether);
        assertEq(handler.okSwapBuy(), 1, "handler could not land a swap");

        // The piggyback spent from the reservoir and the proceeds were burned.
        assertGt(handler.ghostBuybackOutflow(), 0, "the buyback never spent anything");
        assertLt(address(ladder).balance, ladderBefore, "reservoir did not fall despite a buyback");
        assertGt(IERC20(address(h2.projectToken())).balanceOf(DEAD), burnedBefore, "buyback proceeds were not burned");
        assertEq(handler.ghostUnexplainedTreasuryDrop(), 0, "outflow was not accounted for by a burn");
    }

    /// @notice Sells are reachable too, which is the direction that burns the
    ///         input tax rather than feeding the reservoir.
    function test_handlerCanReachSwapSell() public {
        for (uint256 i; i < 4; ++i) {
            handler.deposit(i, 2, 5 ether, 0);
        }
        handler.warpLong(4 days);
        handler.launchProject(2);

        // Inventory comes from a genesis claim; there is no other source.
        handler.claimGenesis(0, 2);
        assertEq(handler.okClaimGenesis(), 1, "precondition: a genesis claim must land");

        ToshLaunchpadHook h2 = handler.hooks(2);
        IERC20 token = IERC20(address(h2.projectToken()));
        address alice = handler.actors(0);
        assertGt(token.balanceOf(alice), 0, "claim paid no tokens");

        uint256 burnedBefore = token.balanceOf(DEAD);
        handler.swapSell(0, 2, token.balanceOf(alice) / 2);
        assertEq(handler.okSwapSell(), 1, "handler could not land a sell");
        assertGt(token.balanceOf(DEAD), burnedBefore, "the sell-side tax was not burned");
    }

    /// @notice The permissionless egress is reachable, so the outflow invariant
    ///         is saying something about it.
    ///
    /// @dev    A registered action that always reverts its precondition is
    ///         indistinguishable from an unregistered one, and both leave
    ///         `invariant_treasuryOutflowAlwaysBurns` vacuous on this path. This
    ///         proves the door opens: ETH leaves, tokens land at `0xdead`, and
    ///         the drop is fully accounted for — with no swap in the call and a
    ///         caller holding no role.
    function test_handlerCanReachPokeBuyback() public {
        for (uint256 i; i < 4; ++i) {
            handler.deposit(i, 2, 5 ether, 0);
        }
        handler.warpLong(4 days);
        handler.launchProject(2);

        // A pool one second old reads a zero TWAP, and `addLadderToken` has
        // refused that since 2026-09-11, so the listing has to clear
        // `TWAP_WINDOW` first.  `warpShort` bounds its argument to
        // [1 min, 2 h], so 1801 lands exactly one second past the window.
        handler.warpShort(1801);

        handler.ownerAddLadderToken(2);

        ToshLaunchpadHook h2 = handler.hooks(2);
        IERC20 token = IERC20(address(h2.projectToken()));

        // Arm the reservoir organically, the same way `test_handlerCanReach-
        // BuybackAndBurn` does — launch fees, which the fuzzer also controls.
        //
        // Not by trading: `swapBuy` caps a leg at 3 ether and only the 70 bps
        // reservoir share of the 1 % buy tax lands here, so reaching
        // `TRIGGER_STEP` still needs ~143 ether of volume — the figure did not
        // move when the tax went 70 → 100 bps, because the extra 30 bps is the
        // platform's and never touches this balance. That is still more than
        // the actors hold between them. An earlier version tried six
        // 3-ether buys and papered over the shortfall with `vm.assume` — which
        // in a non-fuzz test cannot resample, so it just failed the run.
        //
        // A few buys first, so the poke is not the pool's first touch and the
        // TWAP floor has something to anchor to.
        //
        // They have to come BEFORE the arming loop, not after. Hook 2 is already
        // listed, so a swap on it with the reservoir armed carries the buyback
        // and spends the pot straight back down — an earlier version armed and
        // then swapped, and landed at 0.828 ether wondering why.
        for (uint256 i; i < 4; ++i) {
            handler.swapBuy(i, 2, 1 ether);
        }

        handler.ownerSetLaunchFee(1 ether);
        while (address(ladder).balance < ladder.TRIGGER_STEP() && handler.hookCount() < 10) {
            handler.createProject(1, 0);
        }
        assertGe(address(ladder).balance, ladder.TRIGGER_STEP(), "precondition: the reservoir must be armed");

        // Let the market settle before poking, or the leg is refused outright.
        //
        // The four buys above moved spot well past
        // `MAX_BUYBACK_SQRT_DEVIATION_BPS` from the TWAP the pool carried when
        // it was listed, so `_buybackSqrtFloor` sits above where the buyback
        // would have to trade and `_buyAndBurn` skips the whole leg.  Measured
        // without this warp: the poke lands, `okPokeBuyback` reaches 1, and the
        // reservoir does not move a single wei off 1.828 ether.
        //
        // This is not a new fragility, it is a newly visible one.  Until
        // 2026-09-11 the listing on the line above happened one second after
        // `launch()`, so this pool's TWAP read zero for the whole test and
        // `_buybackSqrtFloor` fell back to unbounded — the poke filled because
        // nothing bounded it, not because the price was defensible.  Three
        // tests rested on that, this one included.
        //
        // A window with no swap in it is what re-anchors the reading: past
        // `TWAP_WINDOW` since the last observation, `_twapSqrtPriceX96` takes
        // its flat-price branch and reports `lastTick` outright, which is the
        // tick the fourth buy left behind.  The arming loop below does not
        // trade on this pool, so nothing disturbs that in between.
        handler.warpShort(1801);

        uint256 ladderBefore = address(ladder).balance;
        uint256 burnedBefore = token.balanceOf(DEAD);
        uint256 auditsBefore = handler.ghostLockoutAudits();

        handler.pokeBuyback(1);

        assertEq(handler.okPokeBuyback(), 1, "handler could not land a poke");
        assertLt(address(ladder).balance, ladderBefore, "the poke spent nothing");
        assertGt(token.balanceOf(DEAD), burnedBefore, "the poke's proceeds were not burned");
        assertEq(handler.ghostUnexplainedTreasuryDrop(), 0, "poke outflow was not accounted for by a burn");

        // Non-vacuity for `invariant_everySwapShutsTheMintLockout`. That
        // invariant reads a counter of FAILED audits, so it is satisfied both
        // by a correct system and by one that never audits anything — and the
        // poke branch only audits a hook whose burn rose, which is exactly the
        // condition this test has just established. Without this line the
        // invariant could go green because the treasury stopped buying.
        assertGt(handler.ghostLockoutAudits(), auditsBefore, "the poke's swap was never audited for the lockout stamp");
        assertEq(handler.ghostSwapWithoutStamp(), 0, "the poke's swap left the mint lockout open");
    }

    /// @notice The retail buy is reachable, so the same-block lockout and the
    ///         price ceiling are composed against a path the fuzzer can take
    ///         rather than only against sequences a unit test authored.
    function test_handlerCanReachMintShelf() public {
        for (uint256 i; i < 4; ++i) {
            handler.deposit(i, 2, 5 ether, 0);
        }
        handler.warpLong(4 days);
        handler.launchProject(2);
        ToshLaunchpadHook h2 = handler.hooks(2);
        assertTrue(h2.launched(), "precondition: the round must launch");

        // Shelf 0 is priced above `1.05 × p0`, so a mint against the launch
        // mark reverts `TierPriceAboveCeiling`. A buy lifts the reference
        // (and stamps the lockout); the next block is when a mint is legal.
        // That pairing — swap then mint, same-block illegal, next-block
        // legal — is the composition this action exists to put in the mix.
        handler.swapBuy(0, 2, 0.5 ether);
        assertEq(handler.okSwapBuy(), 1, "precondition: a buy must lift the reference");
        handler.warpShort(1 minutes);

        IERC20 token = IERC20(address(h2.projectToken()));
        address alice = handler.actors(0);
        uint256 heldBefore = token.balanceOf(alice);

        handler.mintShelf(0, 2, 1e18);
        assertEq(handler.okMintShelf(), 1, "handler could not land a shelf mint");
        assertGt(token.balanceOf(alice), heldBefore, "shelf mint paid no tokens");
    }
}
