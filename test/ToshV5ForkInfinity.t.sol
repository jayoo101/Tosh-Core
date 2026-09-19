// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {IVault} from "../lib/infinity-core/src/interfaces/IVault.sol";
import {ILockCallback} from "../lib/infinity-core/src/interfaces/ILockCallback.sol";
import {IPoolManager} from "../lib/infinity-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "../lib/infinity-core/src/interfaces/IHooks.sol";
import {ICLPoolManager} from "../lib/infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {PoolKey} from "../lib/infinity-core/src/types/PoolKey.sol";
import {PoolId} from "../lib/infinity-core/src/types/PoolId.sol";
import {Currency} from "../lib/infinity-core/src/types/Currency.sol";
import {BalanceDelta} from "../lib/infinity-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "../lib/infinity-core/src/types/BeforeSwapDelta.sol";
import {CLPoolParametersHelper} from "../lib/infinity-core/src/pool-cl/libraries/CLPoolParametersHelper.sol";
import {Hooks} from "../lib/infinity-core/src/libraries/Hooks.sol";
import {
    HOOKS_BEFORE_INITIALIZE_OFFSET,
    HOOKS_BEFORE_ADD_LIQUIDITY_OFFSET,
    HOOKS_BEFORE_SWAP_OFFSET,
    HOOKS_AFTER_SWAP_OFFSET,
    HOOKS_BEFORE_SWAP_RETURNS_DELTA_OFFSET
} from "../lib/infinity-core/src/pool-cl/interfaces/ICLHooks.sol";

/// @title  Spike: does this protocol's hook mechanism run on PancakeSwap Infinity?
///
/// @notice This is a SPIKE, not a port. It exists to convert the largest unknown
///         in `docs/PANCAKESWAP_INFINITY.md` §5.1 into a measured fact before any
///         production code is touched, and it is deliberately scoped to the
///         MECHANISM rather than to `ToshLaunchpadHook`'s 2,521 lines.
///
///         What that means concretely: `SpikeHook` below reproduces the four
///         things the real hook needs from the AMM, at the real pool geometry
///         (fee 3000, tick spacing 200, full range ±887200, native/token pair):
///
///           1. permissions declared WITHOUT a mined address
///           2. `beforeSwap` taking an exact basis-point cut of the input
///           3. `afterSwap` observing the swap (the same-block lockout stamp)
///           4. liquidity seeded by the hook itself through the Vault lock
///
///         It does NOT reproduce the bonding curve, the ladder treasury, the
///         refund machinery or the genesis state machine. Those are arithmetic
///         and bookkeeping that do not touch the AMM boundary, which is the only
///         thing in question here.
///
/// @dev    Reads `BSC_RPC` and skips when unset, matching `ToshV5ForkBsc.t.sol`.
///         A public dataseed endpoint is sufficient; this suite makes no
///         `eth_getLogs` calls, which is where those endpoints impose limits.
contract ToshV5ForkInfinityTest is Test {
    using CLPoolParametersHelper for bytes32;

    // PancakeSwap Infinity on BSC mainnet. Verified to carry code by
    // `test_forkInfinity_liveAddressesAreTheOnesWeWouldShipTo`; the table in
    // docs/PANCAKESWAP_INFINITY.md §7 records the sizes measured off-chain.
    address internal constant VAULT = 0x238a358808379702088667322f80aC48bAd5e6c4;
    address internal constant CL_POOL_MANAGER = 0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b;
    address internal constant CL_POSITION_MANAGER = 0x55f4c8abA71A1e923edC303eb4fEfF14608cC226;
    address internal constant UNIVERSAL_ROUTER = 0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB;

    /// @dev Not used by this protocol. Pinned only as the wrong-manager fixture
    ///      in `test_forkInfinity_aPoolMayNotNameAnotherManager`.
    address internal constant BIN_POOL_MANAGER = 0xC697d2898e0D09264376196696c51D7aBbbAA4a9;

    // Mirrors src/ToshLaunchpadHook.sol exactly. If these drift from the hook,
    // the spike stops being evidence about the hook.
    uint24 internal constant POOL_FEE = 3000;
    int24 internal constant TICK_SPACING = 200;
    int24 internal constant TICK_LOWER = -887_200;
    int24 internal constant TICK_UPPER = 887_200;

    /// @dev 70 bps, the real buy tax.
    uint256 internal constant TAX_BPS = 70;

    // Router dispatch bytes, from pancakeswap/infinity-universal-router
    // `Commands.sol` and lib/infinity-periphery `Actions.sol`.
    uint8 internal constant INFI_SWAP = 0x10;
    uint8 internal constant CL_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant SETTLE_ALL = 0x0c;
    uint8 internal constant TAKE_ALL = 0x0f;

    SpikeHook internal hook;
    SpikeToken internal token;
    SpikeSwapper internal swapper;
    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("BSC_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;

        token = new SpikeToken();
        hook = new SpikeHook(IVault(VAULT), ICLPoolManager(CL_POOL_MANAGER), address(token), TAX_BPS);
        swapper = new SpikeSwapper(IVault(VAULT), ICLPoolManager(CL_POOL_MANAGER));

        token.mint(address(hook), 1_000_000e18);
        vm.deal(address(hook), 100 ether);
        vm.deal(address(swapper), 100 ether);
    }

    modifier onFork() {
        vm.skip(!forked, "BSC_RPC unset");
        _;
    }

    // ── The addresses ──────────────────────────────────────────────────────

    function test_forkInfinity_liveAddressesAreTheOnesWeWouldShipTo() public onFork {
        assertEq(block.chainid, 56, "not forked onto BNB Smart Chain");
        assertGt(VAULT.code.length, 0, "no Infinity Vault at the published address");
        assertGt(CL_POOL_MANAGER.code.length, 0, "no CLPoolManager on BSC");
        assertGt(CL_POSITION_MANAGER.code.length, 0, "no CLPositionManager on BSC");
        assertGt(UNIVERSAL_ROUTER.code.length, 0, "no Infinity UniversalRouter on BSC");

        // The Vault is the accounting layer this protocol would have to move to;
        // assert it is the one the CLPoolManager actually answers to, rather than
        // trusting two independent entries in a docs table.
        assertEq(
            address(ICLPoolManager(CL_POOL_MANAGER).vault()),
            VAULT,
            "the CLPoolManager settles against a different Vault than we pinned"
        );
    }

    // ── The decisive one: no mined address ─────────────────────────────────

    /// @notice The finding that decides whether `src/libraries/HookAddress.sol` and
    ///         everything hanging off it can be deleted.
    ///
    ///         Uniswap V4 reads a hook's permissions out of the low bits of its
    ///         ADDRESS, which is the sole reason this repository owns a CREATE2
    ///         salt miner. The assertion below is the interesting half: the hook
    ///         is deployed at whatever address `new` happened to give it, those
    ///         low bits do NOT spell its permissions, and Infinity initializes
    ///         the pool anyway.
    function test_forkInfinity_hookNeedsNoMinedAddress() public onFork {
        uint16 declared = hook.getHooksRegistrationBitmap();

        // What Uniswap V4 would have demanded of this address, and what it is.
        uint160 addressBits = uint160(address(hook)) & uint160((1 << 14) - 1);
        assertTrue(
            addressBits != uint160(declared),
            "the unmined address coincidentally encodes the permissions -- rerun, this proves nothing"
        );

        hook.seedPool(_sqrtPriceOne(), 1e18);

        (uint160 sqrtPriceX96,,,) = ICLPoolManager(CL_POOL_MANAGER).getSlot0(hook.poolId());
        assertGt(sqrtPriceX96, 0, "pool did not initialize against an unmined hook address");
        assertGt(ICLPoolManager(CL_POOL_MANAGER).getLiquidity(hook.poolId()), 0, "no liquidity was seeded");
    }

    /// @notice The other half of the same claim: the bitmap is genuinely the
    ///         gate, so dropping address mining does not drop the check.
    ///
    ///         Declaring a bitmap in `parameters` that disagrees with the hook's
    ///         own `getHooksRegistrationBitmap()` must be refused. If this passed
    ///         silently, permissions would be unenforced on Infinity and the port
    ///         would be trading one silent failure for another.
    function test_forkInfinity_bitmapMismatchIsRejected() public onFork {
        PoolKey memory bad = hook.poolKey();
        // Flip `beforeSwap` off in the key while the hook still advertises it.
        bad.parameters = bytes32(uint256(hook.getHooksRegistrationBitmap() & ~uint16(1 << HOOKS_BEFORE_SWAP_OFFSET)))
            .setTickSpacing(TICK_SPACING);

        vm.expectRevert(Hooks.HookConfigValidationError.selector);
        ICLPoolManager(CL_POOL_MANAGER).initialize(bad, _sqrtPriceOne());
    }

    // ── The mechanism ─────────────────────────────────────────────────────

    /// @notice `beforeSwap` returning a delta is how the real hook takes its buy
    ///         tax. Asserted to the wei against the live CLPoolManager, because
    ///         "the swap succeeded" is exactly the observation that misled the
    ///         Uniswap-era router work — see scripts/checkV4RouterTuple.mjs.
    function test_forkInfinity_beforeSwapTakesTheExactCut() public onFork {
        hook.seedPool(_sqrtPriceOne(), 1e18);

        uint256 amountIn = 1 ether;
        uint256 expectedCut = (amountIn * TAX_BPS) / 10_000;

        uint256 before = hook.taxCollected();
        swapper.buy(hook.poolKey(), amountIn, "");

        assertEq(hook.taxCollected() - before, expectedCut, "the hook's cut is not exactly 70 bps of the input");
        assertGt(expectedCut, 0, "a zero cut would make the assertion above vacuous");
    }

    /// @notice Keeps the assertion above from being a coincidence.
    ///
    ///         70 bps of 1 ether is 0.007, and there are other numbers in that
    ///         neighbourhood that a swap produces on its own — the pool's own
    ///         0.30% fee among them. A single-rate test cannot tell "the hook
    ///         took our cut" from "something took roughly that much". So this
    ///         runs a second hook at a deliberately different rate and asserts
    ///         the cut moves to match it, which only the hook can cause.
    function test_forkInfinity_theCutTracksTheHooksOwnRate() public onFork {
        uint256 otherBps = 500;
        SpikeHook other = new SpikeHook(IVault(VAULT), ICLPoolManager(CL_POOL_MANAGER), address(token), otherBps);
        token.mint(address(other), 1_000_000e18);
        vm.deal(address(other), 100 ether);
        other.seedPool(_sqrtPriceOne(), 1e18);

        uint256 amountIn = 1 ether;
        swapper.buy(other.poolKey(), amountIn, "");

        assertEq(other.taxCollected(), (amountIn * otherBps) / 10_000, "the cut did not follow the hook's own rate");
        assertTrue(
            (amountIn * otherBps) / 10_000 != (amountIn * TAX_BPS) / 10_000,
            "the two rates collide, so this proves nothing"
        );
    }

    /// @notice The same-block lockout depends on `afterSwap` running at all. A
    ///         registered callback that is never invoked is the quiet failure
    ///         this asserts against.
    function test_forkInfinity_afterSwapObservesTheSwap() public onFork {
        hook.seedPool(_sqrtPriceOne(), 1e18);

        assertEq(hook.lastSwapBlock(), 0, "stamped before any swap happened");
        swapper.buy(hook.poolKey(), 1 ether, "");
        assertEq(hook.lastSwapBlock(), uint48(block.number), "afterSwap did not run, so the lockout would not arm");
    }

    /// @notice `hookData` surviving the trip is the property whose loss is
    ///         silent. Driven through the CLPoolManager here rather than through
    ///         Infinity's UniversalRouter, which is a separate calldata layout
    ///         and a separate measurement — recorded as still-open in
    ///         docs/PANCAKESWAP_INFINITY.md.
    function test_forkInfinity_hookDataArrivesIntact() public onFork {
        hook.seedPool(_sqrtPriceOne(), 1e18);

        bytes memory payload = abi.encode(uint256(0xC0FFEE), address(this));
        swapper.buy(hook.poolKey(), 1 ether, payload);

        assertEq(hook.lastHookData(), payload, "hookData was dropped or truncated on the way to the hook");
    }

    /// @notice `SpikeHook`'s own pool is native-coin/token, so its `currency0` is
    ///         zero. Asserted because every other test in this suite reads
    ///         `key.currency0` and would pass against a pool wired differently.
    ///
    /// @dev    ⚠ THIS IS THE FIXTURE'S SHAPE AND NO LONGER PRODUCTION'S. The
    ///           docstring here used to open "Production pools are native-coin/
    ///           token, so `currency0` is zero. Several arguments in this
    ///           repository lean on that" — true when written, false since the
    ///           quote asset became BEM, and misleading in the specific way that
    ///           matters: a reader checking whether the protocol's `currency0` is
    ///           zero would find a green fork test appearing to confirm it.
    ///
    ///           Production pools are BEM/token, and BEM is `currency0` because
    ///           `createLaunch` grinds the token's salt to sort above it. That
    ///           ordering is asserted in `ToshV5Fork.t.sol`
    ///           (`test_fork_lifecycleAgainstLivePoolManager`, against real BEM's
    ///           address), which is the suite that fixtures the real hook. This
    ///           one deliberately does not — see the contract docstring: it is
    ///           scoped to the Infinity mechanism, not to `ToshLaunchpadHook`.
    function test_forkInfinity_poolIsNativeCoinAndToken() public onFork {
        PoolKey memory key = hook.poolKey();
        assertEq(Currency.unwrap(key.currency0), address(0), "currency0 is not the native coin");
        assertEq(Currency.unwrap(key.currency1), address(token), "currency1 is not our token");
        assertEq(address(key.poolManager), CL_POOL_MANAGER, "pool bound to the wrong manager");
        assertEq(key.parameters.getTickSpacing(), TICK_SPACING, "tick spacing did not survive the bytes32 packing");
    }

    /// @notice `PoolKey` gained a `poolManager` field, so a pool can now name a
    ///         manager other than the one it is being created on. `BinPoolManager`
    ///         is deployed on this chain, which makes that a realistic slip rather
    ///         than a hypothetical.
    ///
    ///         Worth asserting because the benign outcome was plausible: `PoolId`
    ///         hashes the whole key, so a mismatched `poolManager` could have
    ///         quietly produced a DIFFERENT pool instead of an error. It does not
    ///         — `CLPoolManager` checks the field and reverts `PoolManagerMismatch`.
    ///         Named explicitly, because a bare `expectRevert` here would also
    ///         have passed on "that address has no code", which proves nothing.
    function test_forkInfinity_aPoolMayNotNameAnotherManager() public onFork {
        PoolKey memory bad = hook.poolKey();
        bad.poolManager = IPoolManager(BIN_POOL_MANAGER);

        vm.expectRevert(ICLPoolManager.PoolManagerMismatch.selector);
        ICLPoolManager(CL_POOL_MANAGER).initialize(bad, _sqrtPriceOne());
    }

    // ── The router path ───────────────────────────────────────────────────

    /// @notice A real buy through the live Infinity `UniversalRouter`, which is
    ///         how buyers actually arrive. The spike's other swaps take the Vault
    ///         lock directly, which is how the hook and treasury work internally
    ///         but is not the public path.
    function test_forkInfinity_buyThroughRealUniversalRouter() public onFork {
        hook.seedPool(_sqrtPriceOne(), 1e18);

        uint256 amountIn = 1 ether;
        uint256 expectedCut = (amountIn * TAX_BPS) / 10_000;
        uint256 taxBefore = hook.taxCollected();

        // Built before the prank: an argument that is itself an external call
        // is evaluated first and would consume it, sending the output to this
        // contract instead of the buyer.
        bytes[] memory inputs = _routerInputs(hook.poolKey(), amountIn, "");

        address buyer = makeAddr("buyer");
        vm.deal(buyer, 10 ether);

        vm.prank(buyer);
        IInfinityUniversalRouter(UNIVERSAL_ROUTER).execute{value: amountIn}(
            abi.encodePacked(bytes1(uint8(INFI_SWAP))), inputs
        );

        assertEq(hook.taxCollected() - taxBefore, expectedCut, "the tax is not exact through the real router");
        // `TAKE_ALL` pays `msgSender()`, which the router resolves to whoever
        // took its reentrancy lock in `execute` -- the buyer, not the router.
        // The frontend needs no sweep step to collect the output.
        assertGt(token.balanceOf(buyer), 0, "the buyer received no tokens");
        assertEq(token.balanceOf(UNIVERSAL_ROUTER), 0, "output stranded on the router");
    }

    /// @notice `hookData` surviving the ROUTER is a different claim from
    ///         surviving `CLPoolManager.swap`, and it is the one whose loss is
    ///         silent: the decoder is a raw calldata pointer cast (§9.3), so a
    ///         mis-shaped tuple is reinterpreted rather than rejected, and empty
    ///         `hookData` looks exactly like a working swap.
    function test_forkInfinity_hookDataSurvivesTheRouter() public onFork {
        hook.seedPool(_sqrtPriceOne(), 1e18);

        bytes memory payload = abi.encode(uint256(0xBEEF), address(this));
        bytes[] memory inputs = _routerInputs(hook.poolKey(), 1 ether, payload);

        address buyer = makeAddr("buyer");
        vm.deal(buyer, 10 ether);

        vm.prank(buyer);
        IInfinityUniversalRouter(UNIVERSAL_ROUTER).execute{value: 1 ether}(
            abi.encodePacked(bytes1(uint8(INFI_SWAP))), inputs
        );

        assertEq(hook.lastHookData(), payload, "the router dropped or truncated hookData");
    }

    /// @notice The near-miss worth measuring, and the reason this test exists at
    ///         all rather than a reading of the docs.
    ///
    ///         Infinity's decoder and Uniswap's are the SAME hazard — both cast a
    ///         raw calldata pointer with no length check beyond a floor — and
    ///         both floors are the same number, `0x160`. Uniswap gets there as
    ///         PoolKey(5) + bool + uint128 + uint128 + uint256 minHopPriceX36 +
    ///         bytes; Infinity as PoolKey(6) + bool + uint128 + uint128 + bytes.
    ///         Identical encoded size, different meanings. So the length floor
    ///         cannot tell the two apart, and the naive conclusion is that
    ///         sending one to the other is silent.
    ///
    ///         It is not, and the reason is worth recording because it is luck
    ///         rather than design: Uniswap's `fee` sits at the head slot Infinity
    ///         reads as `poolManager`, and `poolManager` is validated. So the
    ///         mismatch reverts instead of settling a wrong swap. Do not
    ///         generalise it — the protection is one field in one position.
    function test_forkInfinity_theUniswapShapedTupleIsNotInterchangeable() public onFork {
        hook.seedPool(_sqrtPriceOne(), 1e18);

        PoolKey memory key = hook.poolKey();
        UniShapedParams memory wrong = UniShapedParams({
            poolKey: UniShapedPoolKey({
                currency0: address(0),
                currency1: address(token),
                hooks: address(hook),
                fee: POOL_FEE,
                tickSpacing: TICK_SPACING
            }),
            zeroForOne: true,
            amountIn: uint128(1 ether),
            amountOutMinimum: 0,
            minHopPriceX36: 0,
            hookData: ""
        });

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(wrong);
        params[1] = abi.encode(key.currency0, uint256(1 ether));
        params[2] = abi.encode(key.currency1, uint256(0));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(
            abi.encodePacked(
                bytes1(uint8(CL_SWAP_EXACT_IN_SINGLE)), bytes1(uint8(SETTLE_ALL)), bytes1(uint8(TAKE_ALL))
            ),
            params
        );

        address buyer = makeAddr("buyer");
        vm.deal(buyer, 10 ether);

        vm.prank(buyer);
        (bool ok,) = UNIVERSAL_ROUTER.call{value: 1 ether}(
            abi.encodeWithSelector(
                IInfinityUniversalRouter.execute.selector, abi.encodePacked(bytes1(uint8(INFI_SWAP))), inputs
            )
        );

        assertFalse(
            ok, "a Uniswap-shaped tuple was ACCEPTED by Infinity's decoder -- it settled a swap we did not describe"
        );
        assertEq(hook.taxCollected(), 0, "the hook took a cut on a call that should never have reached a swap");
    }

    /// @notice The floor itself. One slot short of `0x160` must be refused,
    ///         because past the floor the decoder reads whatever follows.
    function test_forkInfinity_aShortTupleIsRefusedByTheLengthFloor() public onFork {
        hook.seedPool(_sqrtPriceOne(), 1e18);

        bytes[] memory params = new bytes[](1);
        // 10 slots where the decoder's floor demands 11.
        params[0] = new bytes(0x140);

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(bytes1(uint8(CL_SWAP_EXACT_IN_SINGLE))), params);

        vm.expectRevert();
        IInfinityUniversalRouter(UNIVERSAL_ROUTER).execute{value: 1 ether}(
            abi.encodePacked(bytes1(uint8(INFI_SWAP))), inputs
        );
    }

    /// @dev `INFI_SWAP`'s input is `abi.encode(bytes actions, bytes[] params)`,
    ///      the same shape as Uniswap's `V4_SWAP`. Swap, then settle the native
    ///      debt, then take the token credit.
    function _routerInputs(PoolKey memory key, uint256 amountIn, bytes memory hookData)
        internal
        pure
        returns (bytes[] memory inputs)
    {
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            CLSwapExactInputSingleParams({
                poolKey: key, zeroForOne: true, amountIn: uint128(amountIn), amountOutMinimum: 0, hookData: hookData
            })
        );
        params[1] = abi.encode(key.currency0, amountIn);
        params[2] = abi.encode(key.currency1, uint256(0));

        inputs = new bytes[](1);
        inputs[0] = abi.encode(
            abi.encodePacked(
                bytes1(uint8(CL_SWAP_EXACT_IN_SINGLE)), bytes1(uint8(SETTLE_ALL)), bytes1(uint8(TAKE_ALL))
            ),
            params
        );
    }

    /// @dev sqrt(1) in Q64.96.
    function _sqrtPriceOne() internal pure returns (uint160) {
        return 79_228_162_514_264_337_593_543_950_336;
    }
}

interface IInfinityUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs) external payable;
}

/// @dev Mirrors `ICLRouterBase.CLSwapExactInputSingleParams` from
///      lib/infinity-periphery. Restated rather than imported because
///      infinity-periphery reaches infinity-core through an `infinity-core/`
///      prefix, and adding that remapping moves every production contract's
///      metadata hash -- measured, see docs/PANCAKESWAP_INFINITY.md §3.4.
///
///      A restated tuple is the exact hazard scripts/checkV4RouterTuple.mjs was
///      written for, so it is pinned there against the vendored source. The
///      inner `PoolKey` is the real infinity-core type, which keeps the six
///      members that matter most out of the hand-roll.
struct CLSwapExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    bytes hookData;
}

/// @dev What this repository encodes for Uniswap V4 today, restated only so
///      `test_forkInfinity_theUniswapShapedTupleIsNotInterchangeable` can send
///      it somewhere it does not belong. Never used for a real call.
struct UniShapedPoolKey {
    address currency0;
    address currency1;
    address hooks;
    uint24 fee;
    int24 tickSpacing;
}

struct UniShapedParams {
    UniShapedPoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    uint256 minHopPriceX36;
    bytes hookData;
}

// ───────────────────────────────────────────────────────────────────────────
// Spike fixtures
// ───────────────────────────────────────────────────────────────────────────

/// @dev Minimal ERC20. Deliberately not `ToshToken` — the spike is about the AMM
///      boundary, and a plain token keeps the failure surface there.
contract SpikeToken {
    string public name = "Spike";
    string public symbol = "SPK";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (from != msg.sender) allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev The four AMM-boundary behaviours the real hook needs, and nothing else.
///      Permissions are declared by bitmap, which is the point.
contract SpikeHook is ILockCallback {
    using CLPoolParametersHelper for bytes32;

    IVault internal immutable vault;
    ICLPoolManager internal immutable clPoolManager;
    address internal immutable token;
    uint256 internal immutable taxBps;

    uint256 public taxCollected;
    uint48 public lastSwapBlock;
    bytes public lastHookData;

    int24 internal constant TICK_SPACING = 200;
    int24 internal constant TICK_LOWER = -887_200;
    int24 internal constant TICK_UPPER = 887_200;
    uint24 internal constant POOL_FEE = 3000;

    error NotVault();
    error NotPoolManager();
    error OnlyHookMayProvideLiquidity();

    constructor(IVault vault_, ICLPoolManager clPoolManager_, address token_, uint256 taxBps_) {
        vault = vault_;
        clPoolManager = clPoolManager_;
        token = token_;
        taxBps = taxBps_;
    }

    receive() external payable {}

    /// @notice Infinity's replacement for Uniswap V4's address bits. `initialize`
    ///         checks this against `poolKey.parameters` and refuses a mismatch.
    function getHooksRegistrationBitmap() public pure returns (uint16) {
        return uint16(
            (1 << HOOKS_BEFORE_INITIALIZE_OFFSET) | (1 << HOOKS_BEFORE_ADD_LIQUIDITY_OFFSET)
                | (1 << HOOKS_BEFORE_SWAP_OFFSET) | (1 << HOOKS_AFTER_SWAP_OFFSET)
                | (1 << HOOKS_BEFORE_SWAP_RETURNS_DELTA_OFFSET)
        );
    }

    function poolKey() public view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            hooks: IHooks(address(this)),
            poolManager: IPoolManager(address(clPoolManager)),
            fee: POOL_FEE,
            parameters: bytes32(uint256(getHooksRegistrationBitmap())).setTickSpacing(TICK_SPACING)
        });
    }

    function poolId() external view returns (PoolId) {
        return poolKey().toId();
    }

    // ── Seeding, through the Vault lock ───────────────────────────────────

    function seedPool(uint160 sqrtPriceX96, uint128 liquidity) external {
        vault.lock(abi.encode(sqrtPriceX96, liquidity));
    }

    function lockAcquired(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(vault)) revert NotVault();
        (uint160 sqrtPriceX96, uint128 liquidity) = abi.decode(data, (uint160, uint128));

        PoolKey memory key = poolKey();
        clPoolManager.initialize(key, sqrtPriceX96);

        (BalanceDelta delta,) = clPoolManager.modifyLiquidity(
            key,
            ICLPoolManager.ModifyLiquidityParams({
                tickLower: TICK_LOWER,
                tickUpper: TICK_UPPER,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );

        _settle(key.currency0, delta.amount0());
        _settle(key.currency1, delta.amount1());
        return "";
    }

    /// @dev Negative delta is owed to the Vault, positive is owed to us. The
    ///      native and ERC20 paths differ: native rides along with `settle`,
    ///      an ERC20 needs `sync` then a transfer then `settle`.
    function _settle(Currency currency, int128 amount) internal {
        if (amount == 0) return;
        if (amount > 0) {
            vault.take(currency, address(this), uint128(amount));
            return;
        }
        uint256 owed = uint256(uint128(-amount));
        address addr = Currency.unwrap(currency);
        if (addr == address(0)) {
            vault.settle{value: owed}();
        } else {
            vault.sync(currency);
            SpikeToken(addr).transfer(address(vault), owed);
            vault.settle();
        }
    }

    // ── Callbacks ─────────────────────────────────────────────────────────

    modifier onlyPoolManager() {
        if (msg.sender != address(clPoolManager)) revert NotPoolManager();
        _;
    }

    function beforeInitialize(address, PoolKey calldata, uint160) external view onlyPoolManager returns (bytes4) {
        return SpikeHook.beforeInitialize.selector;
    }

    /// @dev Genesis liquidity is the hook's, same as production.
    function beforeAddLiquidity(
        address sender,
        PoolKey calldata,
        ICLPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external view onlyPoolManager returns (bytes4) {
        if (sender != address(this)) {
            revert OnlyHookMayProvideLiquidity();
        }
        return SpikeHook.beforeAddLiquidity.selector;
    }

    /// @notice The buy tax. Takes `taxBps` of the specified input before the
    ///         pool sees it, and claims the credit as a Vault balance so the
    ///         swap settles.
    function beforeSwap(
        address,
        PoolKey calldata key,
        ICLPoolManager.SwapParams calldata params,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        lastHookData = hookData;

        // Exact-input only, which is what a buy is. `amountSpecified < 0` is
        // exact input; anything else is left untaxed here rather than guessed at.
        if (params.amountSpecified >= 0) {
            return (SpikeHook.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);
        }

        uint256 amountIn = uint256(-params.amountSpecified);
        uint256 cut = (amountIn * taxBps) / 10_000;
        if (cut == 0) return (SpikeHook.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);

        Currency specified = params.zeroForOne ? key.currency0 : key.currency1;
        vault.mint(address(this), specified, cut);
        taxCollected += cut;

        return (SpikeHook.beforeSwap.selector, toBeforeSwapDelta(int128(int256(cut)), 0), 0);
    }

    /// @notice The lockout stamp. Cheap, and the thing whose absence would be
    ///         invisible until someone minted against a moved price.
    function afterSwap(address, PoolKey calldata, ICLPoolManager.SwapParams calldata, BalanceDelta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        lastSwapBlock = uint48(block.number);
        return (SpikeHook.afterSwap.selector, int128(0));
    }
}

/// @dev Drives a swap the way a router would: take the Vault lock, swap, settle.
contract SpikeSwapper is ILockCallback {
    IVault internal immutable vault;
    ICLPoolManager internal immutable clPoolManager;

    constructor(IVault vault_, ICLPoolManager clPoolManager_) {
        vault = vault_;
        clPoolManager = clPoolManager_;
    }

    receive() external payable {}

    function buy(PoolKey memory key, uint256 amountIn, bytes memory hookData) external {
        vault.lock(abi.encode(key, amountIn, hookData));
    }

    function lockAcquired(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(vault), "not vault");
        (PoolKey memory key, uint256 amountIn, bytes memory hookData) = abi.decode(data, (PoolKey, uint256, bytes));

        BalanceDelta delta = clPoolManager.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: 4_295_128_740 // just above TickMath.MIN_SQRT_RATIO
            }),
            hookData
        );

        _settle(key.currency0, delta.amount0());
        _settle(key.currency1, delta.amount1());
        return "";
    }

    function _settle(Currency currency, int128 amount) internal {
        if (amount == 0) return;
        if (amount > 0) {
            vault.take(currency, address(this), uint128(amount));
            return;
        }
        uint256 owed = uint256(uint128(-amount));
        address addr = Currency.unwrap(currency);
        if (addr == address(0)) {
            vault.settle{value: owed}();
        } else {
            vault.sync(currency);
            SpikeToken(addr).transfer(address(vault), owed);
            vault.settle();
        }
    }
}
