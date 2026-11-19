// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vault} from "infinity-core/src/Vault.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {CLPoolManager} from "infinity-core/src/pool-cl/CLPoolManager.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {CLPoolManagerRouter} from "infinity-core/test/pool-cl/helpers/CLPoolManagerRouter.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {IHooks} from "infinity-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "infinity-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";
import {CLPoolParametersHelper} from "infinity-core/src/pool-cl/libraries/CLPoolParametersHelper.sol";

import {DeployV31} from "../../script/DeployV31.s.sol";
import {ToshBidBook} from "../../src/ToshBidBook.sol";
import {ToshAutoLp} from "../../src/v3/ToshAutoLp.sol";
import {ToshLaunchGatewayV3} from "../../src/v3/ToshLaunchGatewayV3.sol";
import {ToshBuybackV31} from "../../src/v31/ToshBuybackV31.sol";
import {ToshFactoryV31} from "../../src/v31/ToshFactoryV31.sol";
import {ToshLaunchpadHookV31} from "../../src/v31/ToshLaunchpadHookV31.sol";
import {ToshMintVesting} from "../../src/v31/ToshMintVesting.sol";
import {HookAddress} from "../../src/libraries/HookAddress.sol";
import {MockQuoteAsset} from "../utils/MockQuoteAsset.sol";
import {MockAgentRegistryV3} from "../v3/utils/MockAgentRegistryV3.sol";
import {MockSafeV3} from "../v3/FactoryV2.t.sol";
import {MockBnbUsdFeed, MockToshHook, MockV2Pair} from "./utils/BuybackMocks.sol";

/// @dev The real script, with the deployment record kept in memory instead of
///      written to `deployments/`.
contract DeployV31Harness is DeployV31 {
    Stack internal _s;

    function _write(Stack memory s) internal override {
        _s = s;
    }

    /// @dev `run` without the process environment, so no suite races another
    ///      over shared variables. Same checks, same deploy.
    function deployWith(uint256 pk, Env memory e, uint256 target, Params memory p) external {
        _validate(e, target);
        _deploy(pk, e, p);
    }

    function defaults() external pure returns (Params memory) {
        return _defaults();
    }

    function paramsFrom(string memory prefix) external view returns (Params memory) {
        return _params(prefix, _defaults());
    }

    function stack() external view returns (Stack memory) {
        return _s;
    }

    function verify(Stack memory s, Env memory e, Params memory p) external view returns (string memory) {
        return _verify(s, e, p);
    }
}

/// @notice `script/DeployV31.s.sol` end to end against a local Infinity: every
///         pre-flight refusal, the wiring it leaves, the Safe's accept and
///         gateway handoff, and a project run through genesis, launch, an L2
///         mint and a taxed buy on the deployed stack.
contract DeployV31Test is Test {
    using CLPoolParametersHelper for bytes32;

    uint256 constant PK = 0xD3B131; // throwaway test key, holds nothing
    address deployer;
    MockSafeV3 safe;
    address feeRecipient = makeAddr("feeRecipient");
    address dev = makeAddr("dev");
    address fund = makeAddr("fund");
    Vault vault;
    CLPoolManager manager;
    CLPoolManagerRouter router;
    MockAgentRegistryV3 registry;
    MockQuoteAsset wbnb;
    MockQuoteAsset usdt;
    MockV2Pair pair;
    MockBnbUsdFeed feed;
    MockToshHook toshHook;

    function setUp() public {
        deployer = vm.addr(PK);
        vm.chainId(97);
        vault = new Vault();
        manager = new CLPoolManager(IVault(address(vault)));
        vault.registerApp(address(manager));
        router = new CLPoolManagerRouter(IVault(address(vault)), ICLPoolManager(address(manager)));
        registry = new MockAgentRegistryV3();
        usdt = new MockQuoteAsset();
        wbnb = new MockQuoteAsset();
        safe = new MockSafeV3();
        safe.add(makeAddr("signer"));

        pair = new MockV2Pair(address(usdt), address(wbnb));
        feed = new MockBnbUsdFeed();
        feed.set(700e8, block.timestamp);
        MockQuoteAsset tosh = new MockQuoteAsset();
        toshHook = new MockToshHook();
        toshHook.setKey(
            PoolKey({
                currency0: Currency.wrap(address(wbnb)),
                currency1: Currency.wrap(address(tosh)),
                hooks: IHooks(address(toshHook)),
                poolManager: IPoolManager(address(manager)),
                fee: 2000,
                parameters: bytes32(0).setTickSpacing(200)
            })
        );
    }

    function _e() internal view returns (DeployV31.Env memory) {
        return DeployV31.Env({
            deployer: deployer,
            poolManager: address(manager),
            vault: address(vault),
            safe: address(safe),
            feeRecipient: feeRecipient,
            registry: address(registry),
            wbnb: address(wbnb),
            usdt: address(usdt),
            pair: address(pair),
            feed: address(feed),
            toshHook: address(toshHook)
        });
    }

    function _expectRefusal(DeployV31.Env memory e, uint256 target, string memory reason) internal {
        DeployV31Harness h = new DeployV31Harness();
        DeployV31.Params memory p = h.defaults();
        vm.expectRevert(bytes(reason));
        h.deployWith(PK, e, target, p);
    }

    function _expectParamRefusal(DeployV31.Params memory p, string memory reason) internal {
        DeployV31Harness h = new DeployV31Harness();
        vm.expectRevert(bytes(reason));
        h.deployWith(PK, _e(), 97, p);
    }

    function test_deployV31_refusesEveryBadEnvironment() public {
        DeployV31.Env memory e = _e();
        _expectRefusal(e, 56, "chain id mismatch: wrong --rpc-url");
        e.vault = address(wbnb);
        _expectRefusal(e, 97, "INFINITY_VAULT does not match the manager");
        e = _e();
        e.feeRecipient = address(0);
        _expectRefusal(e, 97, "fee recipient unset");
        e = _e();
        e.safe = makeAddr("eoa");
        _expectRefusal(e, 97, "PROD_OWNER_SAFE is not a Safe");
        e = _e();
        e.feeRecipient = deployer;
        _expectRefusal(e, 97, "deployer must hold no role");
        e = _e();
        e.registry = makeAddr("empty");
        _expectRefusal(e, 97, "AGENT_REGISTRY holds no code");
        e = _e();
        e.usdt = makeAddr("empty");
        _expectRefusal(e, 97, "quote assets hold no code");
        e = _e();
        e.pair = makeAddr("empty");
        _expectRefusal(e, 97, "buyback venues hold no code");
        e = _e();
        e.toshHook = makeAddr("empty");
        _expectRefusal(e, 97, "buyback venues hold no code");

        vm.chainId(1);
        _expectRefusal(_e(), 1, "TARGET_CHAIN_ID must be 56 or 97");
        vm.chainId(56);
        _expectRefusal(_e(), 56, "AGENT_REGISTRY is not the Binance registry");
        vm.chainId(97);

        DeployV31.Params memory p = new DeployV31Harness().defaults();
        p.shelfCap = 0;
        _expectParamRefusal(p, "zero shelf cap or trigger step");
        p = new DeployV31Harness().defaults();
        p.triggerStep = 0;
        _expectParamRefusal(p, "zero shelf cap or trigger step");
        p = new DeployV31Harness().defaults();
        p.minAgentCap = 4e18;
        _expectParamRefusal(p, "agent cap below min buy");
    }

    function test_deployV31_paramsReadTheirOwnPrefix() public {
        DeployV31Harness h = new DeployV31Harness();
        DeployV31.Params memory d = h.defaults();
        assertEq(d.minBuy, 5e18);
        assertEq(d.minHardCap, 500e18);
        assertEq(d.maxHardCap, 20_000e18);
        assertEq(d.minAgentCap, 15e18);
        assertEq(d.maxAgentCap, 15e18);
        assertEq(d.shelfCap, 200e18);
        assertEq(d.triggerStep, 180e18);

        vm.setEnv("V31TEST_SHELF_CAP", "123000000000000000000");
        DeployV31.Params memory p = h.paramsFrom("V31TEST_");
        assertEq(p.shelfCap, 123e18, "read from the environment");
        assertEq(p.minBuy, 5e18, "unset keys fall back to the defaults");
        assertEq(p.maxHardCap, 20_000e18);
    }

    function _deployed() internal returns (DeployV31.Stack memory s) {
        DeployV31Harness h = new DeployV31Harness();
        h.deployWith(PK, _e(), 97, h.defaults());
        s = h.stack();
    }

    function test_deployV31_wiresTheStack() public {
        DeployV31.Stack memory s = _deployed();
        ToshFactoryV31 f = ToshFactoryV31(s.factory);
        ToshLaunchpadHookV31 impl = ToshLaunchpadHookV31(payable(s.hookImplementation));
        ToshBuybackV31 bb = ToshBuybackV31(s.buyback);

        assertEq(address(f.quoteAsset()), address(usdt));
        assertFalse(f.acceptsNative());
        assertEq(f.minBuy(), 5e18);
        assertEq(f.minHardCap(), 500e18);
        assertEq(f.maxHardCap(), 20_000e18);
        assertEq(f.minAgentCap(), 15e18);
        assertEq(f.maxAgentCap(), 15e18);
        assertEq(f.shelfCapPerAgent(), 200e18);
        assertEq(f.agentRegistry(), address(registry));
        assertEq(f.bidBook(), s.bidBook);

        // Platform revenue and the ladder both route to the buyback.
        assertEq(f.platformTreasury(), s.buyback);
        assertEq(f.ladderTreasury(), s.buyback);
        assertEq(impl.platformFeeRecipient(), s.buyback);
        assertEq(impl.ladderTreasury(), s.buyback);
        assertEq(impl.PIGGYBACK_TRIGGER_STEP(), 180e18);
        assertEq(bb.rescuer(), _e().safe, "only the Safe can rescue");
        assertEq(impl.mintVesting(), s.vesting);
        assertEq(impl.autoLp(), s.autoLp);

        assertEq(bb.factory(), s.factory);
        assertEq(bb.TRIGGER_STEP(), 180e18);
        assertEq(bb.toshHook(), address(toshHook));
        assertEq(address(bb.pair()), address(pair));
        assertEq(address(bb.bnbUsdFeed()), address(feed));
        assertEq(ToshAutoLp(s.autoLp).factory(), s.factory);
        assertEq(ToshMintVesting(s.vesting).factory(), s.factory);

        ToshBidBook book = ToshBidBook(s.bidBook);
        assertEq(book.factories().length, 1);
        assertEq(book.factories()[0], s.factory);
        assertEq(book.feeRecipient(), feeRecipient);

        ToshLaunchGatewayV3 gw = ToshLaunchGatewayV3(s.gateway);
        assertEq(address(gw.factory()), s.factory);
        assertEq(address(gw.safe()), address(safe));

        assertEq(f.owner(), deployer, "two-step: the deployer until the Safe accepts");
        assertEq(f.pendingOwner(), address(safe));

        // Every one-shot binding is spent, so the deployer can rebind nothing.
        vm.startPrank(deployer);
        vm.expectRevert(ToshBuybackV31.FactoryAlreadySet.selector);
        bb.setFactory(s.factory);
        vm.expectRevert(ToshMintVesting.FactoryAlreadySet.selector);
        ToshMintVesting(s.vesting).setFactory(s.factory);
        vm.stopPrank();
    }

    function test_deployV31_safeTakesOverAndAProjectRunsEndToEnd() public {
        DeployV31.Stack memory s = _deployed();
        ToshFactoryV31 f = ToshFactoryV31(s.factory);

        safe.exec(s.factory, abi.encodeWithSignature("acceptOwnership()"));
        assertEq(f.owner(), address(safe), "the deployer keeps nothing");

        // The Safe lists a 500 USDT project at 15 USDT per Agent ID.
        bytes32 salt = _salt(f, 500e18);
        bytes memory ret = safe.exec(
            s.factory,
            abi.encodeCall(ToshFactoryV31.createLaunch, ("Deployed", "DPL", dev, fund, salt, 500e18, 15e18, 24 hours))
        );
        (, address h) = abi.decode(ret, (address, address));
        ToshLaunchpadHookV31 hook = ToshLaunchpadHookV31(payable(h));
        assertTrue(f.registeredHooks(h));

        // Genesis: 34 Agent IDs sell it out.
        uint256 i;
        while (hook.soldOutAt() == 0) {
            address w = vm.addr(0xA000 + i++);
            registry.setHandle(w, vm.toString(w));
            usdt.mint(w, 100e18);
            vm.startPrank(w, w);
            usdt.approve(h, type(uint256).max);
            hook.buyGenesis(type(uint256).max, 0);
            vm.stopPrank();
        }
        assertApproxEqAbs(hook.raised(), 500e18, 1e6, "the curve's rounding, a few wei");

        vm.warp(hook.launchStart());
        vm.prank(dev);
        hook.launch();
        assertTrue(hook.launched());

        // One L2 mint: 1% to the buyback, the tokens to the 8-hour lock.
        address minter = vm.addr(0xB001);
        registry.setHandle(minter, "minter");
        usdt.mint(minter, 100e18);
        uint256 bbBefore = usdt.balanceOf(s.buyback);
        vm.startPrank(minter, minter);
        usdt.approve(h, type(uint256).max);
        (uint256 tokens, uint256 cost) = hook.mintL2(hook.l2Quota(), 0);
        vm.stopPrank();
        assertEq(cost, hook.raised() / 10, "quota is 10% of the raise");
        assertEq(usdt.balanceOf(s.buyback) - bbBefore, cost / 100, "1% of the mint to the buyback");
        (uint256 locked,,,) = ToshMintVesting(s.vesting).lockOf(h, minter);
        assertEq(locked, tokens);

        // A taxed buy pays the buyback its 0.4%.
        address trader = makeAddr("trader");
        usdt.mint(trader, 1_000e18);
        bbBefore = usdt.balanceOf(s.buyback);
        PoolKey memory key = hook.getPoolKey();
        vm.startPrank(trader);
        usdt.approve(address(router), type(uint256).max);
        router.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: true, amountSpecified: -int256(100e18), sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1
            }),
            CLPoolManagerRouter.SwapTestSettings({withdrawTokens: true, settleUsingTransfer: true}),
            ""
        );
        vm.stopPrank();
        assertGt(usdt.balanceOf(s.buyback), bbBefore, "buy tax reached the buyback");

        // After the gateway handoff the Safe still retunes the L2 cap.
        ToshLaunchGatewayV3 gw = ToshLaunchGatewayV3(s.gateway);
        safe.exec(s.factory, abi.encodeCall(f.transferOwnership, (address(gw))));
        safe.exec(address(gw), abi.encodeCall(gw.execute, (abi.encodeWithSignature("acceptOwnership()"))));
        assertEq(f.owner(), address(gw));
        safe.exec(
            address(gw), abi.encodeCall(gw.execute, (abi.encodeCall(ToshFactoryV31.setShelfCapPerAgent, (300e18))))
        );
        assertEq(f.shelfCapPerAgent(), 300e18);
    }

    function test_verifyV31_readsEachOwnershipStageAndRefusesDrift() public {
        DeployV31Harness h = new DeployV31Harness();
        DeployV31.Params memory p = h.defaults();
        h.deployWith(PK, _e(), 97, p);
        DeployV31.Stack memory s = h.stack();
        ToshFactoryV31 f = ToshFactoryV31(s.factory);
        ToshLaunchGatewayV3 gw = ToshLaunchGatewayV3(s.gateway);

        assertEq(h.verify(s, _e(), p), "owned by the deployer, pending the Safe's acceptOwnership");
        safe.exec(s.factory, abi.encodeWithSignature("acceptOwnership()"));
        assertEq(h.verify(s, _e(), p), "owned by the Safe; gateway handoff not done yet");
        safe.exec(s.factory, abi.encodeCall(f.transferOwnership, (address(gw))));
        vm.expectRevert("Safe-owned factory with a pending transfer");
        h.verify(s, _e(), p);
        safe.exec(address(gw), abi.encodeCall(gw.execute, (abi.encodeWithSignature("acceptOwnership()"))));
        assertEq(h.verify(s, _e(), p), "owned by the gateway (Safe-controlled)");

        DeployV31.Params memory q = h.defaults();
        q.shelfCap = 300e18;
        vm.expectRevert("factory min buy, shelf cap");
        h.verify(s, _e(), q);
        q = h.defaults();
        q.triggerStep = 1e18;
        vm.expectRevert("buyback trigger step");
        h.verify(s, _e(), q);

        DeployV31.Env memory e = _e();
        e.feed = makeAddr("otherFeed");
        vm.expectRevert("buyback venues");
        h.verify(s, e, p);
        e = _e();
        e.feeRecipient = makeAddr("otherRecipient");
        vm.expectRevert();
        h.verify(s, e, p);

        vm.prank(address(safe));
        ToshBuybackV31(s.buyback).requestRescue(address(usdt), address(safe));
        vm.expectRevert("a rescue is pending on the buyback");
        h.verify(s, _e(), p);

        s.lens = makeAddr("empty");
        vm.expectRevert("a recorded address holds no code");
        h.verify(s, _e(), p);
    }

    function _salt(ToshFactoryV31 f, uint256 hardCap) internal view returns (bytes32 raw) {
        bytes32 initHash = f.hookInitcodeHash(dev, address(safe), hardCap, 15e18, 24 hours);
        for (uint256 i;; ++i) {
            raw = bytes32(i);
            address h = HookAddress.computeAddress(address(f), keccak256(abi.encode(address(safe), raw)), initHash);
            if (h.code.length == 0) return raw;
        }
    }
}
