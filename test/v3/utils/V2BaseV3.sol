// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Vault} from "infinity-core/src/Vault.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {CLPoolManager} from "infinity-core/src/pool-cl/CLPoolManager.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {CLPoolManagerRouter} from "infinity-core/test/pool-cl/helpers/CLPoolManagerRouter.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";

import {ToshFactoryV3} from "../../../src/v3/ToshFactoryV3.sol";
import {ToshLaunchpadHookV3} from "../../../src/v3/ToshLaunchpadHookV3.sol";
import {ToshLadderTreasury} from "../../../src/ToshLadderTreasury.sol";
import {ToshToken} from "../../../src/ToshToken.sol";
import {ToshBidBook} from "../../../src/ToshBidBook.sol";
import {ToshHookLensV3} from "../../../src/v3/ToshHookLensV3.sol";
import {ToshAutoLp} from "../../../src/v3/ToshAutoLp.sol";
import {CircuitNFT} from "../../../src/CircuitNFT.sol";
import {HookAddress} from "../../../src/libraries/HookAddress.sol";
import {MockQuoteAsset} from "../../utils/MockQuoteAsset.sol";
import {MockAgentRegistryV3} from "./MockAgentRegistryV3.sol";

/// @notice Shared v2 fixture: one WBNB-style stack on a real Infinity Vault and
///         CLPoolManager, the shared bid book, and a mock Agent ID registry.
abstract contract V2BaseV3 is Test {
    address internal admin = makeAddr("admin");
    address internal dev = makeAddr("dev");
    address internal fund = makeAddr("fund");
    address internal feeSafe = makeAddr("feeSafe");
    address internal platform = makeAddr("platform");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave"); // no Agent ID
    address internal trader = makeAddr("trader");

    uint256 internal constant HARD_CAP = 100e18;
    uint256 internal constant AGENT_CAP = 5e18;
    uint256 internal constant MIN_BUY = 0.01e18;
    uint256 internal constant DURATION = 24 hours;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    Vault internal vault;
    CLPoolManager internal poolManager;
    CLPoolManagerRouter internal router;
    MockQuoteAsset internal quote;
    MockAgentRegistryV3 internal registry;
    ToshLadderTreasury internal ladder;
    ToshBidBook internal book;
    ToshFactoryV3 internal factory;
    ToshHookLensV3 internal lens;
    ToshAutoLp internal autoLp;

    function setUp() public virtual {
        vault = new Vault();
        poolManager = new CLPoolManager(IVault(address(vault)));
        vault.registerApp(address(poolManager));
        router = new CLPoolManagerRouter(IVault(address(vault)), ICLPoolManager(address(poolManager)));
        quote = new MockQuoteAsset();
        registry = new MockAgentRegistryV3();
        lens = new ToshHookLensV3();

        vm.startPrank(admin);
        book = new ToshBidBook(feeSafe);
        ladder =
            new ToshLadderTreasury(address(poolManager), address(vault), admin, address(quote), address(0), 0.3 ether);
        autoLp = new ToshAutoLp(address(vault), address(poolManager));
        factory = _deployFactory(address(quote), MIN_BUY, true);
        ladder.setFactory(address(factory));
        autoLp.setFactory(address(factory));
        address[] memory fs = new address[](1);
        fs[0] = address(factory);
        book.initialize(fs);
        vm.stopPrank();

        address[6] memory actors = [alice, bob, carol, dave, trader, dev];
        for (uint256 i; i < actors.length; ++i) {
            quote.mint(actors[i], 10_000e18);
            vm.deal(actors[i], 1_000 ether);
            vm.prank(actors[i]);
            quote.approve(address(router), type(uint256).max);
        }
        registry.setHandle(alice, "alice");
        registry.setHandle(bob, "bob");
        registry.setHandle(carol, "carol");
    }

    /// @dev Must run inside `vm.startPrank(admin)`: the implementation and the
    ///      factory are deployed back to back so the factory's address can be
    ///      predicted from the deployer's nonce.
    function _deployFactory(address quote_, uint256 minBuy_, bool native_) internal returns (ToshFactoryV3 f) {
        address predicted = vm.computeCreateAddress(admin, vm.getNonce(admin) + 1);
        ToshLaunchpadHookV3 impl = new ToshLaunchpadHookV3(
            address(poolManager),
            address(vault),
            predicted,
            address(ladder),
            platform,
            quote_,
            address(registry),
            minBuy_,
            native_,
            address(autoLp)
        );
        f = new ToshFactoryV3(
            ToshFactoryV3.Config({
                hookImplementation: address(impl),
                poolManager: address(poolManager),
                vault: address(vault),
                platformTreasury: platform,
                ladderTreasury: address(ladder),
                quoteAsset: quote_,
                bidBook: address(book),
                agentRegistry: address(registry),
                minBuy: minBuy_,
                acceptsNative: native_,
                minHardCap: 1e18,
                maxHardCap: 10_000e18,
                minAgentCap: minBuy_,
                maxAgentCap: 1_000e18
            })
        );
        require(address(f) == predicted, "factory address prediction");
    }

    // ─── Project helpers ──────────────────────────────────────────────────────

    function _pickSalt(uint256 hardCap, uint256 agentCap, uint256 duration) internal view returns (bytes32 raw) {
        bytes32 initHash = factory.hookInitcodeHash(dev, admin, hardCap, agentCap, duration);
        for (uint256 i;; ++i) {
            raw = bytes32(i);
            if (
                HookAddress.computeAddress(address(factory), keccak256(abi.encode(admin, raw)), initHash).code.length
                    == 0
            ) {
                return raw;
            }
        }
    }

    function _create(string memory name, uint256 hardCap, uint256 agentCap)
        internal
        returns (ToshToken token, ToshLaunchpadHookV3 hook)
    {
        bytes32 salt = _pickSalt(hardCap, agentCap, DURATION);
        vm.prank(admin);
        (address t, address h) = factory.createLaunch(name, name, dev, fund, salt, hardCap, agentCap, DURATION);
        token = ToshToken(t);
        hook = ToshLaunchpadHookV3(payable(h));
        address[6] memory actors = [alice, bob, carol, dave, trader, dev];
        for (uint256 i; i < actors.length; ++i) {
            vm.startPrank(actors[i]);
            quote.approve(h, type(uint256).max);
            quote.approve(address(book), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _create() internal returns (ToshToken token, ToshLaunchpadHookV3 hook) {
        return _create("Alpha", HARD_CAP, AGENT_CAP);
    }

    function _buy(ToshLaunchpadHookV3 hook, address who, uint256 pay) internal returns (uint256 tokens, uint256 cost) {
        vm.prank(who, who);
        return hook.buyGenesis(pay, 0);
    }

    /// @dev Give `n` fresh Agent IDs and spend each one's full cap until the
    ///      sale sells out.
    function _sellOut(ToshLaunchpadHookV3 hook) internal {
        uint256 i;
        while (hook.soldOutAt() == 0) {
            address w = vm.addr(0xA000 + i++);
            registry.setHandle(w, vm.toString(w));
            quote.mint(w, 1_000e18);
            vm.startPrank(w, w);
            quote.approve(address(hook), type(uint256).max);
            hook.buyGenesis(type(uint256).max, 0);
            vm.stopPrank();
        }
    }

    function _launchAsAdmin(ToshLaunchpadHookV3 hook) internal {
        if (block.timestamp < hook.launchStart()) vm.warp(hook.launchStart());
        vm.prank(dev);
        hook.launch();
    }

    function _nextBlock() internal {
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _swapBuy(ToshLaunchpadHookV3 hook, address who, uint256 quoteIn) internal {
        PoolKey memory key = hook.getPoolKey();
        vm.prank(who);
        router.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: true, amountSpecified: -int256(quoteIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1
            }),
            CLPoolManagerRouter.SwapTestSettings({withdrawTokens: true, settleUsingTransfer: true}),
            ""
        );
    }

    function _swapSell(ToshLaunchpadHookV3 hook, address who, uint256 tokensIn) internal {
        PoolKey memory key = hook.getPoolKey();
        vm.startPrank(who);
        IERC20(Currency.unwrap(key.currency1)).approve(address(router), type(uint256).max);
        router.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: false, amountSpecified: -int256(tokensIn), sqrtPriceLimitX96: TickMath.MAX_SQRT_RATIO - 1
            }),
            CLPoolManagerRouter.SwapTestSettings({withdrawTokens: true, settleUsingTransfer: true}),
            ""
        );
        vm.stopPrank();
    }

    function _spot(ToshLaunchpadHookV3 hook) internal view returns (uint256) {
        (, uint256 spot,,,,) = _status(hook);
        return spot;
    }

    function _status(ToshLaunchpadHookV3 hook)
        internal
        view
        returns (uint256 tierPrice, uint256 spot, uint256 twap, uint256 ceiling, uint256 remaining, bool unlocked)
    {
        uint256 idx;
        (idx, tierPrice, remaining, spot, twap, ceiling, unlocked) = hook.tierStatus();
    }
}
