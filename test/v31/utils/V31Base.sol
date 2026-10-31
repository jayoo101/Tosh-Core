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

import {ToshFactoryV31} from "../../../src/v31/ToshFactoryV31.sol";
import {ToshLaunchpadHookV31} from "../../../src/v31/ToshLaunchpadHookV31.sol";
import {ToshTokenV31} from "../../../src/v31/ToshTokenV31.sol";
import {ToshMintVesting} from "../../../src/v31/ToshMintVesting.sol";
import {ToshHookLensV31} from "../../../src/v31/ToshHookLensV31.sol";
import {ToshLadderTreasury} from "../../../src/ToshLadderTreasury.sol";
import {ToshBidBook} from "../../../src/ToshBidBook.sol";
import {ToshAutoLp} from "../../../src/v3/ToshAutoLp.sol";
import {HookAddress} from "../../../src/libraries/HookAddress.sol";
import {MockQuoteAsset} from "../../utils/MockQuoteAsset.sol";
import {MockAgentRegistryV3} from "../../v3/utils/MockAgentRegistryV3.sol";

/// @notice Shared v3.1 fixture: a USDT-style stack on a real Infinity Vault and
///         CLPoolManager, with the 8-hour mint vesting contract.
abstract contract V31Base is Test {
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

    uint256 internal constant HARD_CAP = 1_000e18;
    uint256 internal constant AGENT_CAP = 15e18;
    uint256 internal constant MIN_BUY = 5e18;
    uint256 internal constant SHELF_CAP = 200e18;
    uint256 internal constant DURATION = 24 hours;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    Vault internal vault;
    CLPoolManager internal poolManager;
    CLPoolManagerRouter internal router;
    MockQuoteAsset internal quote;
    MockAgentRegistryV3 internal registry;
    ToshLadderTreasury internal ladder;
    ToshBidBook internal book;
    ToshFactoryV31 internal factory;
    ToshHookLensV31 internal lens;
    ToshAutoLp internal autoLp;
    ToshMintVesting internal vesting;
    /// @dev Set before `_deployFactory` to wire a treasury other than `ladder`.
    address internal treasuryOverride;

    function setUp() public virtual {
        vault = new Vault();
        poolManager = new CLPoolManager(IVault(address(vault)));
        vault.registerApp(address(poolManager));
        router = new CLPoolManagerRouter(IVault(address(vault)), ICLPoolManager(address(poolManager)));
        quote = new MockQuoteAsset();
        registry = new MockAgentRegistryV3();
        lens = new ToshHookLensV31();

        vm.startPrank(admin);
        book = new ToshBidBook(feeSafe);
        ladder =
            new ToshLadderTreasury(address(poolManager), address(vault), admin, address(quote), address(0), 0.3 ether);
        autoLp = new ToshAutoLp(address(vault), address(poolManager));
        vesting = new ToshMintVesting();
        factory = _deployFactory();
        ladder.setFactory(address(factory));
        autoLp.setFactory(address(factory));
        vesting.setFactory(address(factory));
        address[] memory fs = new address[](1);
        fs[0] = address(factory);
        book.initialize(fs);
        vm.stopPrank();

        address[6] memory actors = [alice, bob, carol, dave, trader, dev];
        for (uint256 i; i < actors.length; ++i) {
            quote.mint(actors[i], 100_000e18);
            vm.prank(actors[i]);
            quote.approve(address(router), type(uint256).max);
        }
        registry.setHandle(alice, "alice");
        registry.setHandle(bob, "bob");
        registry.setHandle(carol, "carol");
    }

    /// @dev Must run inside `vm.startPrank(admin)`.
    function _deployFactory() internal returns (ToshFactoryV31 f) {
        address predicted = vm.computeCreateAddress(admin, vm.getNonce(admin) + 1);
        address treasury = treasuryOverride == address(0) ? address(ladder) : treasuryOverride;
        ToshLaunchpadHookV31 impl = new ToshLaunchpadHookV31(
            address(poolManager),
            address(vault),
            predicted,
            treasury,
            platform,
            address(quote),
            address(registry),
            MIN_BUY,
            address(autoLp),
            address(vesting)
        );
        f = new ToshFactoryV31(
            ToshFactoryV31.Config({
                hookImplementation: address(impl),
                poolManager: address(poolManager),
                vault: address(vault),
                platformTreasury: platform,
                ladderTreasury: treasury,
                quoteAsset: address(quote),
                bidBook: address(book),
                agentRegistry: address(registry),
                minBuy: MIN_BUY,
                acceptsNative: false,
                minHardCap: 500e18,
                maxHardCap: 20_000e18,
                minAgentCap: MIN_BUY,
                maxAgentCap: 1_000e18,
                shelfCapPerAgent: SHELF_CAP
            })
        );
        require(address(f) == predicted, "factory address prediction");
    }

    // ─── Project helpers ──────────────────────────────────────────────────────

    function _pickSalt(uint256 hardCap, uint256 agentCap) internal view returns (bytes32 raw) {
        bytes32 initHash = factory.hookInitcodeHash(dev, admin, hardCap, agentCap, DURATION);
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

    function _create(string memory name, uint256 hardCap)
        internal
        returns (ToshTokenV31 token, ToshLaunchpadHookV31 hook)
    {
        bytes32 salt = _pickSalt(hardCap, AGENT_CAP);
        vm.prank(admin);
        (address t, address h) = factory.createLaunch(name, name, dev, fund, salt, hardCap, AGENT_CAP, DURATION);
        token = ToshTokenV31(t);
        hook = ToshLaunchpadHookV31(h);
        address[6] memory actors = [alice, bob, carol, dave, trader, dev];
        for (uint256 i; i < actors.length; ++i) {
            vm.prank(actors[i]);
            quote.approve(h, type(uint256).max);
        }
    }

    /// @dev Spend fresh Agent IDs' full genesis caps until the sale sells out.
    function _sellOut(ToshLaunchpadHookV31 hook) internal {
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

    function _launch(ToshLaunchpadHookV31 hook) internal {
        if (block.timestamp < hook.launchStart()) vm.warp(hook.launchStart());
        vm.prank(dev);
        hook.launch();
    }

    /// @dev A sold-out, launched project on `HARD_CAP`.
    function _launched() internal returns (ToshTokenV31 token, ToshLaunchpadHookV31 hook) {
        (token, hook) = _create("Alpha", HARD_CAP);
        _sellOut(hook);
        _launch(hook);
    }

    /// @dev A wallet with its own Agent ID, funded and approved for `hook`.
    function _agent(ToshLaunchpadHookV31 hook, uint256 seed) internal returns (address w) {
        w = vm.addr(0xB000 + seed);
        registry.setHandle(w, vm.toString(w));
        quote.mint(w, 100_000e18);
        vm.prank(w);
        quote.approve(address(hook), type(uint256).max);
    }

    function _swapSell(ToshLaunchpadHookV31 hook, address who, uint256 tokensIn) internal {
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

    function _swapBuy(ToshLaunchpadHookV31 hook, address who, uint256 quoteIn) internal {
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
}
