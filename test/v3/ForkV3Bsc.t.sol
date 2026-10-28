// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {CLPoolManagerRouter} from "infinity-core/test/pool-cl/helpers/CLPoolManagerRouter.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";

import {DeployV3} from "../../script/DeployV3.s.sol";
import {DeployV3Harness} from "./DeployV3.t.sol";
import {ToshLadderTreasury} from "../../src/ToshLadderTreasury.sol";
import {ToshLaunchGateway} from "../../src/ToshLaunchGateway.sol";
import {ToshToken} from "../../src/ToshToken.sol";
import {ToshAutoLp} from "../../src/v3/ToshAutoLp.sol";
import {ToshFactoryV3} from "../../src/v3/ToshFactoryV3.sol";
import {ToshHookLensV3} from "../../src/v3/ToshHookLensV3.sol";
import {ToshLaunchpadHookV3} from "../../src/v3/ToshLaunchpadHookV3.sol";
import {IAgentRegistry} from "../../src/libraries/AgentIdLib.sol";
import {HookAddress} from "../../src/libraries/HookAddress.sol";

/// @notice Rehearsal of `script/DeployV3.s.sol` on a BSC mainnet fork: the
///         script's chain-56 checks against the live registry, WBNB, USDT and
///         the 2-of-3 platform Safe, then one BNB project from listing through
///         genesis, launch on the live Infinity singletons, a secondary buy
///         and a shelf mint. Skipped unless `BSC_RPC` is set.
///
/// @dev    Agent IDs are mocked on the live registry, so the run does not
///         depend on any real holder.
contract ForkV3BscTest is Test {
    address constant REGISTRY = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address constant VAULT = 0x238a358808379702088667322f80aC48bAd5e6c4;
    address constant CL_POOL_MANAGER = 0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b;
    address constant SAFE = 0x02DE4629129D104C63329D13A6Ca67E43db7B310;
    uint256 constant PK = 0xF0B3; // throwaway test key, holds nothing

    bool live;
    DeployV3Harness s;
    DeployV3.Stack b;
    DeployV3.Stack u;
    ToshHookLensV3 lens;
    CLPoolManagerRouter router;
    address dev = makeAddr("dev");
    address trader = makeAddr("trader");

    function setUp() public {
        string memory rpc = vm.envOr("BSC_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        live = true;

        s = new DeployV3Harness();
        (DeployV3.Params memory bp, DeployV3.Params memory up) = s.defaults();
        s.deployWith(
            PK,
            DeployV3.Env({
                deployer: vm.addr(PK),
                poolManager: CL_POOL_MANAGER,
                vault: VAULT,
                platform: SAFE,
                safe: SAFE,
                feeRecipient: SAFE,
                registry: REGISTRY,
                wbnb: WBNB,
                usdt: USDT
            }),
            56,
            bp,
            up
        );
        b = s.bnb();
        u = s.usdt();
        lens = ToshHookLensV3(s.lens());
        router = new CLPoolManagerRouter(IVault(VAULT), ICLPoolManager(CL_POOL_MANAGER));

        vm.startPrank(SAFE);
        ToshFactoryV3(b.factory).acceptOwnership();
        ToshFactoryV3(u.factory).acceptOwnership();
        ToshLadderTreasury(payable(b.treasury)).acceptOwnership();
        ToshLadderTreasury(payable(u.treasury)).acceptOwnership();
        vm.stopPrank();
    }

    function _giveId(address w) internal {
        string memory handle = vm.toString(w);
        vm.mockCall(REGISTRY, abi.encodeCall(IAgentRegistry.handleOf, (w)), abi.encode(handle));
        vm.mockCall(REGISTRY, abi.encodeCall(IAgentRegistry.ownerOfHandle, (handle)), abi.encode(w));
    }

    function _salt(ToshFactoryV3 f, uint256 hardCap, uint256 agentCap) internal view returns (bytes32 raw) {
        bytes32 initHash = f.hookInitcodeHash(dev, SAFE, hardCap, agentCap, 24 hours);
        for (uint256 i;; ++i) {
            raw = bytes32(i);
            address h = HookAddress.computeAddress(address(f), keccak256(abi.encode(SAFE, raw)), initHash);
            if (h.code.length == 0) return raw;
        }
    }

    function test_fork_v3_deployLandsOnTheLiveChain() public {
        if (!live) return;
        assertEq(ToshFactoryV3(b.factory).owner(), SAFE);
        assertEq(ToshFactoryV3(u.factory).owner(), SAFE);
        assertEq(ToshFactoryV3(b.factory).shelfCapPerAgent(), 0.7e18);
        assertEq(ToshFactoryV3(u.factory).shelfCapPerAgent(), 500e18);
        assertEq(address(ToshFactoryV3(b.factory).quoteAsset()), WBNB);
        assertEq(address(ToshFactoryV3(u.factory).quoteAsset()), USDT);
        assertEq(address(ToshAutoLp(b.autoLp).poolManager()), CL_POOL_MANAGER);
        assertEq(ToshAutoLp(u.autoLp).factory(), u.factory);

        // Handed to its gateway, the factory still takes the Safe's retune.
        ToshLaunchGateway gw = ToshLaunchGateway(u.gateway);
        vm.prank(SAFE);
        ToshFactoryV3(u.factory).transferOwnership(address(gw));
        vm.prank(SAFE);
        gw.execute(abi.encodeWithSignature("acceptOwnership()"));
        vm.prank(SAFE);
        gw.execute(abi.encodeCall(ToshFactoryV3.setShelfCapPerAgent, (300e18)));
        assertEq(ToshFactoryV3(u.factory).shelfCapPerAgent(), 300e18);
    }

    function test_fork_v3_bnbProject_genesisLaunchSwapShelf() public {
        if (!live) return;
        ToshFactoryV3 f = ToshFactoryV3(b.factory);
        bytes32 salt = _salt(f, 1e18, 0.1e18);
        vm.prank(SAFE);
        (address t, address h) = f.createLaunch("ForkV3", "FK3", dev, makeAddr("fund"), salt, 1e18, 0.1e18, 24 hours);
        ToshLaunchpadHookV3 hook = ToshLaunchpadHookV3(payable(h));
        ToshToken token = ToshToken(t);

        // Genesis: ten IDs at 0.1 BNB each, paid in native BNB.
        address[10] memory ids;
        for (uint256 i; i < 10; ++i) {
            ids[i] = vm.addr(0xB300 + i);
            _giveId(ids[i]);
            vm.deal(ids[i], 1 ether);
            vm.prank(ids[i], ids[i]);
            (uint256 got,) = hook.buyGenesis{value: 0.1 ether}(0.1 ether, 0);
            assertEq(token.balanceOf(ids[i]), got);
        }
        assertGt(hook.soldOutAt(), 0, "sold out");

        vm.warp(hook.launchStart());
        vm.prank(dev);
        hook.launch();
        assertTrue(hook.launched());
        vm.roll(vm.getBlockNumber() + 1);

        // A secondary buy on the live pool lifts spot; once the TWAP holds it,
        // the ladder opens.
        PoolKey memory key = hook.getPoolKey();
        deal(WBNB, trader, 1 ether);
        vm.startPrank(trader);
        IERC20(WBNB).approve(address(router), type(uint256).max);
        router.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: true, amountSpecified: -int256(0.02 ether), sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1
            }),
            CLPoolManagerRouter.SwapTestSettings({withdrawTokens: true, settleUsingTransfer: true}),
            ""
        );
        vm.stopPrank();
        assertGt(token.balanceOf(trader), 0, "swap paid out");
        vm.warp(vm.getBlockTimestamp() + hook.TWAP_WINDOW());
        vm.roll(vm.getBlockNumber() + 1);

        uint256 m = hook.maxMintable();
        assertGt(m, 0, "ladder open");
        if (m > hook.tierSize()) m = hook.tierSize();
        uint256 cost = lens.quoteMint(h, m);

        // No Agent ID, no shelf.
        address nobody = makeAddr("nobody-v3");
        deal(WBNB, nobody, 1 ether);
        vm.startPrank(nobody, nobody);
        IERC20(WBNB).approve(h, type(uint256).max);
        vm.expectRevert(ToshFactoryV3.NoAgentId.selector);
        hook.mintBondingCurve(m, cost);
        vm.stopPrank();

        address buyer = ids[0];
        deal(WBNB, buyer, 1 ether);
        uint256 before = token.balanceOf(buyer);
        vm.startPrank(buyer, buyer);
        IERC20(WBNB).approve(h, type(uint256).max);
        hook.mintBondingCurve(m, cost);
        vm.stopPrank();
        assertEq(token.balanceOf(buyer) - before, m);
        assertEq(f.shelfSpentByWallet(h, buyer), cost);
        assertEq(f.shelfRemaining(h, buyer), 0.7e18 - cost);

        ToshAutoLp a = ToshAutoLp(b.autoLp);
        assertGe(a.pendingQuote(h) + a.totalQuoteAdded(h), (cost * 8000) / 10_000, "80 % reached the AutoLp");
    }
}
