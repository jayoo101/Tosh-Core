// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {IHooks} from "infinity-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "infinity-core/src/interfaces/IPoolManager.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {CLPoolParametersHelper} from "infinity-core/src/pool-cl/libraries/CLPoolParametersHelper.sol";

import {V31Base} from "./utils/V31Base.sol";
import {MockV2Pair, MockBnbUsdFeed, MockToshHook} from "./utils/BuybackMocks.sol";
import {MockQuoteAsset} from "../utils/MockQuoteAsset.sol";
import {ToshBuybackV31} from "../../src/v31/ToshBuybackV31.sol";
import {ToshFactoryV31} from "../../src/v31/ToshFactoryV31.sol";
import {ToshLaunchpadHookV31} from "../../src/v31/ToshLaunchpadHookV31.sol";
import {ToshMintVesting} from "../../src/v31/ToshMintVesting.sol";
import {ToshAutoLp} from "../../src/v3/ToshAutoLp.sol";

contract BuybackV31Test is V31Base {
    using CLPoolParametersHelper for bytes32;

    uint256 internal constant STEP = 180e18;
    uint160 internal constant SQRT_10000 = 100 << 96; // 10 000 TOSH per WBNB

    MockQuoteAsset internal wbnb;
    MockQuoteAsset internal tosh;
    MockToshHook internal toshHook;
    PoolKey internal toshKey;
    MockV2Pair internal pair;
    MockBnbUsdFeed internal feed;
    ToshBuybackV31 internal buyback;
    ToshFactoryV31 internal ladderFactory;

    function setUp() public override {
        super.setUp();
        ladderFactory = factory;

        MockQuoteAsset a = new MockQuoteAsset();
        MockQuoteAsset b = new MockQuoteAsset();
        (wbnb, tosh) = address(a) < address(b) ? (a, b) : (b, a);

        toshHook = new MockToshHook();
        toshKey = PoolKey({
            currency0: Currency.wrap(address(wbnb)),
            currency1: Currency.wrap(address(tosh)),
            hooks: IHooks(address(toshHook)),
            poolManager: IPoolManager(address(poolManager)),
            fee: 2000,
            parameters: bytes32(0).setTickSpacing(200)
        });
        toshHook.setKey(toshKey);
        toshHook.setTwap(SQRT_10000);
        poolManager.initialize(toshKey, SQRT_10000);
        wbnb.mint(address(this), 1_000e18);
        tosh.mint(address(this), 100_000_000e18);
        wbnb.approve(address(router), type(uint256).max);
        tosh.approve(address(router), type(uint256).max);
        router.modifyPosition(
            toshKey,
            ICLPoolManager.ModifyLiquidityParams({
                tickLower: -887200, tickUpper: 887200, liquidityDelta: 1e22, salt: bytes32(0)
            }),
            ""
        );

        pair = new MockV2Pair(address(quote), address(wbnb));
        quote.mint(address(pair), 7_000_000e18);
        wbnb.mint(address(pair), 10_000e18);
        pair.sync();
        feed = new MockBnbUsdFeed();
        feed.set(700e8, block.timestamp);

        buyback = new ToshBuybackV31(
            address(poolManager),
            address(vault),
            address(quote),
            address(wbnb),
            address(pair),
            address(feed),
            address(toshHook),
            STEP
        );

        // A v3.1 stack whose hooks pay and poke the buyback.
        treasuryOverride = address(buyback);
        vm.startPrank(admin);
        autoLp = new ToshAutoLp(address(vault), address(poolManager));
        vesting = new ToshMintVesting();
        factory = _deployFactory();
        autoLp.setFactory(address(factory));
        vesting.setFactory(address(factory));
        vm.stopPrank();
        buyback.setFactory(address(factory));
    }

    function _deadTosh() internal view returns (uint256) {
        return tosh.balanceOf(DEAD);
    }

    // ─── Wiring ───────────────────────────────────────────────────────────────

    function test_constructor_refusesWrongPairOrPool() public {
        MockV2Pair other = new MockV2Pair(address(quote), address(tosh));
        vm.expectRevert(ToshBuybackV31.BadPair.selector);
        new ToshBuybackV31(
            address(poolManager),
            address(vault),
            address(quote),
            address(wbnb),
            address(other),
            address(feed),
            address(toshHook),
            STEP
        );

        MockToshHook wrong = new MockToshHook();
        wrong.setKey(toshKey); // names the other hook
        vm.expectRevert(ToshBuybackV31.BadPoolKey.selector);
        new ToshBuybackV31(
            address(poolManager),
            address(vault),
            address(quote),
            address(wbnb),
            address(pair),
            address(feed),
            address(wrong),
            STEP
        );
    }

    function test_constructor_refusesAVaultOrPoolManagerMismatch() public {
        vm.expectRevert(ToshBuybackV31.BadVault.selector);
        new ToshBuybackV31(
            address(poolManager),
            address(0xBEEF),
            address(quote),
            address(wbnb),
            address(pair),
            address(feed),
            address(toshHook),
            STEP
        );

        MockToshHook elsewhere = new MockToshHook();
        PoolKey memory k = toshKey;
        k.hooks = IHooks(address(elsewhere));
        k.poolManager = IPoolManager(address(0xBEEF));
        elsewhere.setKey(k);
        vm.expectRevert(ToshBuybackV31.BadPoolKey.selector);
        new ToshBuybackV31(
            address(poolManager),
            address(vault),
            address(quote),
            address(wbnb),
            address(pair),
            address(feed),
            address(elsewhere),
            STEP
        );
    }

    function test_setFactory_onceByDeployerForItsOwnHooks() public {
        ToshBuybackV31 fresh = new ToshBuybackV31(
            address(poolManager),
            address(vault),
            address(quote),
            address(wbnb),
            address(pair),
            address(feed),
            address(toshHook),
            STEP
        );
        vm.prank(alice);
        vm.expectRevert(ToshBuybackV31.OnlyDeployer.selector);
        fresh.setFactory(address(factory));
        vm.expectRevert(ToshBuybackV31.FactoryMismatch.selector);
        fresh.setFactory(address(factory)); // wired to `buyback`, not `fresh`
        vm.expectRevert(ToshBuybackV31.FactoryMismatch.selector);
        fresh.setFactory(address(ladderFactory));

        vm.expectRevert(ToshBuybackV31.FactoryAlreadySet.selector);
        buyback.setFactory(address(factory));
        assertEq(buyback.tosh().balanceOf(address(0)), 0);
        assertEq(address(buyback.tosh()), address(tosh), "TOSH read from the pool key");
    }

    function test_autoPoke_onlyRegisteredHooks() public {
        vm.prank(alice);
        vm.expectRevert(ToshBuybackV31.OnlyHook.selector);
        buyback.autoPiggybackBuyback();
    }

    function test_hookReadsTriggerStep() public {
        (, ToshLaunchpadHookV31 h) = _create("Omega", HARD_CAP);
        assertEq(h.ladderTreasury(), address(buyback));
        assertEq(buyback.TRIGGER_STEP(), STEP);
    }

    // ─── Legs ─────────────────────────────────────────────────────────────────

    function test_poke_unarmedReverts() public {
        quote.mint(address(buyback), STEP - 1);
        vm.expectRevert(ToshBuybackV31.NotArmed.selector);
        buyback.pokeBuyback();
    }

    function test_poke_convertsThenBurns() public {
        quote.mint(address(buyback), 1_000e18);
        (bool burnLeg, uint256 amount) = buyback.nextLeg();
        assertFalse(burnLeg);
        assertEq(amount, 500e18, "half the balance");

        buyback.pokeBuyback();
        assertEq(quote.balanceOf(address(buyback)), 500e18);
        uint256 bnb = wbnb.balanceOf(address(buyback));
        assertApproxEqRel(bnb, uint256(500e18) * 9975 / 10_000 / 700, 1e15, "V2 fill at ~700");
        assertFalse(buyback.piggybackActive());

        (burnLeg, amount) = buyback.nextLeg();
        assertTrue(burnLeg);
        assertEq(amount, bnb);

        vm.roll(block.number + 1);
        buyback.pokeBuyback();
        // 0.5 % of a 100-WBNB pool caps the leg at 0.5 WBNB.
        assertEq(bnb - wbnb.balanceOf(address(buyback)), 0.5e18, "depth-capped");
        assertApproxEqRel(_deadTosh(), 0.5e18 * 10_000 * 99 / 100, 2e16, "TOSH burned at ~10 000/WBNB");
        assertEq(tosh.balanceOf(address(buyback)), 0, "nothing held");
    }

    function test_convert_cappedByPairDepth() public {
        quote.mint(address(buyback), 100_000e18);
        buyback.pokeBuyback();
        assertEq(100_000e18 - quote.balanceOf(address(buyback)), 35_000e18, "0.5 % of 7M USDT");
    }

    function test_convert_refusesAFillWorseThanChainlink() public {
        feed.set(600e8, block.timestamp); // the pair charges 700 for a 600 BNB
        quote.mint(address(buyback), 1_000e18);
        vm.expectEmit(address(buyback));
        emit ToshBuybackV31.LegSkipped(false, 500e18);
        buyback.pokeBuyback();
        assertEq(quote.balanceOf(address(buyback)), 1_000e18);
        assertEq(wbnb.balanceOf(address(buyback)), 0);
    }

    function test_convert_toleratesOnlyFeeImpactAndSlack() public {
        // 1.4 % under Chainlink: inside the old flat 2 %, beyond 0.25 % fee + impact + 0.5 %.
        feed.set(690e8, block.timestamp);
        quote.mint(address(buyback), 1_000e18);
        vm.expectEmit(address(buyback));
        emit ToshBuybackV31.LegSkipped(false, 500e18);
        buyback.pokeBuyback();
        assertEq(wbnb.balanceOf(address(buyback)), 0);

        feed.set(697e8, block.timestamp); // 0.68 % under: fee + slack covers it
        buyback.pokeBuyback();
        assertGt(wbnb.balanceOf(address(buyback)), 0);
    }

    function test_poke_convertsWhenTheBurnLegCannotRun() public {
        wbnb.mint(address(buyback), 0.2e18);
        quote.mint(address(buyback), 1_000e18);
        toshHook.setTwap(0); // the burn leg reverts TwapNotMature
        vm.expectEmit(address(buyback));
        emit ToshBuybackV31.LegSkipped(true, 0.2e18);
        buyback.pokeBuyback();
        assertEq(quote.balanceOf(address(buyback)), 500e18, "converted instead");
        assertEq(_deadTosh(), 0);
    }

    function test_convert_refusesAStaleOracle() public {
        vm.warp(block.timestamp + 1 hours + 1);
        quote.mint(address(buyback), 1_000e18);
        buyback.pokeBuyback();
        assertEq(quote.balanceOf(address(buyback)), 1_000e18);
        vm.expectRevert(ToshBuybackV31.OracleStale.selector);
        buyback.bnbUsdPrice();
    }

    function test_burn_refusesWhenSpotIsAboveTheTwap() public {
        wbnb.mint(address(buyback), 0.2e18);
        toshHook.setTwap(uint160(uint256(SQRT_10000) * 101 / 100)); // spot sits ~2 % dearer
        buyback.pokeBuyback();
        assertEq(wbnb.balanceOf(address(buyback)), 0.2e18);
        assertEq(_deadTosh(), 0);

        toshHook.setTwap(0);
        buyback.pokeBuyback();
        assertEq(_deadTosh(), 0, "no TWAP, no leg");
    }

    function test_burn_oneLegPerBlock() public {
        wbnb.mint(address(buyback), 2e18);
        buyback.pokeBuyback();
        uint256 burned = _deadTosh();
        assertGt(burned, 0);
        vm.expectEmit(address(buyback));
        emit ToshBuybackV31.LegSkipped(true, 1.5e18);
        buyback.pokeBuyback();
        assertEq(_deadTosh(), burned);
        vm.roll(block.number + 1);
        buyback.pokeBuyback();
        assertGt(_deadTosh(), burned);
    }

    // ─── Riding a v3.1 swap ───────────────────────────────────────────────────

    function test_piggyback_ridesProjectSwaps() public {
        (, ToshLaunchpadHookV31 h) = _create("Omega", HARD_CAP);
        _sellOut(h);
        _launch(h);

        quote.mint(address(buyback), 1_000e18);
        vm.expectEmit(false, false, false, false, address(buyback));
        emit ToshBuybackV31.Converted(0, 0);
        _swapBuy(h, trader, 10e18);
        assertGt(wbnb.balanceOf(address(buyback)), 0, "convert leg rode the swap");
        assertFalse(buyback.piggybackActive());

        uint256 bnb = wbnb.balanceOf(address(buyback));
        vm.roll(vm.getBlockNumber() + 1);
        _swapBuy(h, trader, 10e18);
        assertEq(_deadTosh(), 0, "a swap never carries the burn leg");
        assertGe(wbnb.balanceOf(address(buyback)), bnb, "it may convert again, never burn");

        buyback.pokeBuyback();
        assertGt(_deadTosh(), 0, "a poke does, in its own lock");
    }

    function test_l2MintFeedsTheBuyback() public {
        (, ToshLaunchpadHookV31 h) = _create("Omega", HARD_CAP);
        _sellOut(h);
        _launch(h);
        uint256 before = quote.balanceOf(address(buyback));
        vm.prank(alice);
        h.mintL2(100e18, 0);
        // 1 % of the mint, plus the buy tax on whatever AutoLp bought with it.
        assertGe(quote.balanceOf(address(buyback)) - before, 1e18);
    }
}
