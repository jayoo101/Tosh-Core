// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {V2BaseV3} from "./utils/V2BaseV3.sol";
import {MockAgentRegistryV3} from "./utils/MockAgentRegistryV3.sol";
import {ToshLaunchpadHookV3} from "../../src/v3/ToshLaunchpadHookV3.sol";
import {ToshToken} from "../../src/ToshToken.sol";
import {ToshFactoryV3} from "../../src/v3/ToshFactoryV3.sol";
import {CircuitNFT} from "../../src/CircuitNFT.sol";
import {GenesisCurveV3} from "../../src/v3/libraries/GenesisCurveV3.sol";

contract LaunchTestV3 is V2BaseV3 {
    ToshToken token;
    ToshLaunchpadHookV3 hook;

    function setUp() public override {
        super.setUp();
        (token, hook) = _create();
    }

    function test_revert_nothingRaised() public {
        vm.warp(hook.genesisDeadline() + 3 days);
        vm.expectRevert(ToshLaunchpadHookV3.NothingRaised.selector);
        hook.launch();
    }

    function test_revert_genesisStillActive() public {
        _buy(hook, alice, 1e18);
        vm.prank(dev);
        vm.expectRevert(ToshLaunchpadHookV3.GenesisActive.selector);
        hook.launch();
    }

    function test_adminWindow_thenAnyone() public {
        _buy(hook, alice, 1e18);
        vm.warp(hook.genesisDeadline());

        vm.prank(trader);
        vm.expectRevert(ToshLaunchpadHookV3.AdminLaunchWindow.selector);
        hook.launch();

        vm.warp(hook.genesisDeadline() + 48 hours - 1);
        vm.prank(trader);
        vm.expectRevert(ToshLaunchpadHookV3.AdminLaunchWindow.selector);
        hook.launch();

        vm.warp(hook.genesisDeadline() + 48 hours);
        vm.prank(trader);
        hook.launch();
        assertTrue(hook.launched());
        assertTrue(token.tradingOpen());
    }

    function test_adminMayLaunchInWindow() public {
        _buy(hook, alice, 1e18);
        vm.warp(hook.genesisDeadline());
        vm.prank(dev);
        hook.launch();
        assertTrue(hook.launched());
    }

    function test_soldOut_startsTheClockEarly() public {
        _sellOut(hook);
        uint256 t = hook.soldOutAt();
        assertLt(t + 48 hours, hook.genesisDeadline() + 48 hours);
        assertEq(hook.launchStart(), t);
        assertEq(lens.publicLaunchAt(address(hook)), t + 48 hours);
        vm.warp(t + 48 hours);
        vm.prank(trader);
        hook.launch();
    }

    function test_controllerFollowsTheNft() public {
        _buy(hook, alice, 1e18);
        vm.warp(hook.genesisDeadline());
        CircuitNFT nft = CircuitNFT(factory.circuitNFT());
        uint256 id = factory.circuitOf(address(hook));
        vm.prank(dev);
        nft.transferFrom(dev, bob, id);
        assertEq(hook.projectController(), bob);

        vm.prank(dev);
        vm.expectRevert(ToshLaunchpadHookV3.AdminLaunchWindow.selector);
        hook.launch();
        vm.prank(bob);
        hook.launch();
    }

    function _assertOpening(uint256 raised) internal view {
        uint256 p = GenesisCurveV3.priceAt(HARD_CAP, 0);
        assertApproxEqRel(hook.p0(), 2 * p, 1e12, "p0 = 2P");
        assertEq(hook.tierPriceAt(0), hook.p0(), "first shelf at 2P");
        assertEq(token.totalSupply(), hook.GENESIS_SUPPLY(), "the genesis block minted in total");
        uint256 lpTokens = hook.GENESIS_SUPPLY() - hook.genesisSold() - token.balanceOf(DEAD);
        assertApproxEqRel(lpTokens, raised * 8 / 10 * 1e18 / (2 * p), 1e12, "L = 0.8R / 2P");
    }

    function test_partialRaise_opensAt2PAndBurnsTheRest() public {
        _buy(hook, alice, 5e18);
        _buy(hook, bob, 5e18);
        uint256 raised = hook.raised();
        _launchAsAdmin(hook);
        _assertOpening(raised);
        assertGt(token.balanceOf(DEAD), 2_000_000e18, "most is burned");
    }

    function test_soldOut_opensAt2PAndBurnsNearlyNothing() public {
        _sellOut(hook);
        uint256 raised = hook.raised();
        _launchAsAdmin(hook);
        _assertOpening(raised);
        assertLt(token.balanceOf(DEAD), 1e18);
    }

    function test_donation_cannotMoveP0_andGoesToPlatform() public {
        _buy(hook, alice, 5e18);
        quote.mint(address(hook), 50e18);
        uint256 platformBefore = quote.balanceOf(platform);
        uint256 fundOwed = hook.fundAccrued();
        _launchAsAdmin(hook);
        assertApproxEqRel(hook.p0(), 2 * GenesisCurveV3.priceAt(HARD_CAP, 0), 1e12);
        assertGe(quote.balanceOf(platform) - platformBefore, 50e18);
        assertEq(quote.balanceOf(address(hook)), fundOwed, "only the fund stays");
    }

    function test_launch_ignoresRegistryAndPlatformBrakes() public {
        _buy(hook, alice, 1e18);
        registry.setMode(MockAgentRegistryV3.Mode.Revert);
        vm.startPrank(admin);
        factory.pause();
        factory.setGenesisPaused(address(0), true);
        factory.haltLadderMinting(address(0), 7 days);
        vm.stopPrank();
        vm.warp(hook.genesisDeadline() + 48 hours);
        vm.prank(trader);
        hook.launch();
        assertTrue(hook.launched());
    }

    function test_revert_doubleLaunch() public {
        _buy(hook, alice, 1e18);
        _launchAsAdmin(hook);
        vm.prank(dev);
        vm.expectRevert(ToshLaunchpadHookV3.AlreadyLaunched.selector);
        hook.launch();
    }

    function test_fund_controllerWithdrawsAndRedirects() public {
        _buy(hook, alice, 5e18);
        uint256 owed = hook.fundAccrued();
        assertEq(owed, hook.raised() / 5);

        vm.prank(trader);
        vm.expectRevert(ToshLaunchpadHookV3.OnlyProjectController.selector);
        hook.withdrawFund();

        vm.prank(dev);
        hook.withdrawFund();
        assertEq(quote.balanceOf(fund), owed, "real-time 20 %");

        address fund2 = makeAddr("fund2");
        vm.prank(dev);
        hook.setProjectFund(fund2);
        _buy(hook, bob, 5e18);
        vm.prank(dev);
        hook.withdrawFund();
        assertGt(quote.balanceOf(fund2), 0);
        assertEq(hook.fundWithdrawn(), quote.balanceOf(fund) + quote.balanceOf(fund2));
    }

    function test_afterLaunch_poolTrades() public {
        _buy(hook, alice, 5e18);
        _launchAsAdmin(hook);
        _nextBlock();

        uint256 before = token.balanceOf(trader);
        _swapBuy(hook, trader, 0.5e18);
        assertGt(token.balanceOf(trader), before, "buy");

        _nextBlock();
        uint256 qBefore = quote.balanceOf(alice);
        _swapSell(hook, alice, token.balanceOf(alice) / 4);
        assertGt(quote.balanceOf(alice), qBefore, "sell");
    }

    function test_shelfLadder_firstShelfAt2P_openFromTheNextBlock() public {
        _buy(hook, alice, 5e18);
        _launchAsAdmin(hook);

        uint256 cost = lens.quoteMint(address(hook), 1e18);
        vm.prank(bob, bob);
        vm.expectRevert();
        hook.mintBondingCurve(1e18, cost);

        _nextBlock();
        (uint256 tierPrice,,,,, bool unlocked) = _status(hook);
        assertEq(tierPrice, hook.p0());
        assertTrue(unlocked, "shelf 0 level with the pool");

        uint256 amount = hook.tierSize() / 2;
        cost = lens.quoteMint(address(hook), amount);
        uint256 adminBefore = quote.balanceOf(hook.projectAdmin());
        vm.prank(bob, bob);
        hook.mintBondingCurve(amount, cost);
        assertEq(token.balanceOf(bob), amount);
        assertGt(quote.balanceOf(hook.projectAdmin()), adminBefore, "99 % to the Circuit vault");
    }

    function test_afterLaunch_genesisClosed() public {
        _buy(hook, alice, 1e18);
        _launchAsAdmin(hook);
        vm.prank(bob, bob);
        vm.expectRevert(ToshLaunchpadHookV3.AlreadyLaunched.selector);
        hook.buyGenesis(1e18, 0);
    }

    function test_releaseAbandonedName() public {
        vm.expectRevert(ToshFactoryV3.NameStillHeld.selector);
        factory.releaseAbandonedName(address(hook));
        vm.warp(hook.genesisDeadline());
        factory.releaseAbandonedName(address(hook));
        (ToshToken t2,) = _create("Alpha", HARD_CAP, AGENT_CAP);
        assertTrue(address(t2) != address(token));
    }

    function test_quoteMint_revertsBeforeLaunch() public {
        vm.expectRevert(ToshLaunchpadHookV3.NotLaunched.selector);
        lens.quoteMint(address(hook), 1e18);
    }

    function test_circuit_transferSettlesGenesisFund() public {
        _buy(hook, alice, 5e18);
        uint256 accrued = hook.fundAccrued();
        assertGt(accrued, 0);
        vm.prank(dev);
        hook.setProjectFund(dev);
        uint256 devBefore = quote.balanceOf(dev);

        CircuitNFT nft = CircuitNFT(factory.circuitNFT());
        uint256 id = factory.circuitOf(address(hook));
        vm.prank(dev);
        nft.transferFrom(dev, carol, id);

        assertEq(hook.projectController(), carol);
        assertEq(hook.projectFund(), carol);
        assertEq(hook.fundAccrued(), 0);
        assertEq(quote.balanceOf(dev) - devBefore, accrued);
    }

    function test_releaseAbandonedName_refusedOnceRaised() public {
        _buy(hook, alice, 1e18);
        vm.warp(hook.genesisDeadline() + 30 days);
        vm.expectRevert(ToshFactoryV3.NameStillHeld.selector);
        factory.releaseAbandonedName(address(hook));
    }
}
