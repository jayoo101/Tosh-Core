// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ToshBidBook} from "../src/ToshBidBook.sol";
import {ToshAutoLp} from "../src/v3/ToshAutoLp.sol";
import {ToshLaunchGatewayV3} from "../src/v3/ToshLaunchGatewayV3.sol";
import {ToshBuybackV31} from "../src/v31/ToshBuybackV31.sol";
import {ToshFactoryV31} from "../src/v31/ToshFactoryV31.sol";
import {ToshHookLensV31} from "../src/v31/ToshHookLensV31.sol";
import {ToshLaunchpadHookV31} from "../src/v31/ToshLaunchpadHookV31.sol";
import {ToshMintVesting} from "../src/v31/ToshMintVesting.sol";

interface IInfinityVaultGetterV31 {
    function vault() external view returns (address);
}

interface ISafeOwnersV31 {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}

// ─────────────────────────────────────────────────────────────────────────────
//  ToshX v3.1: one USDT stack beside the live v3 one. A new bid book (the v3
//  book binds its factories once), the v3.1 lens, the TOSH buyback, an
//  AutoLp, the 8-hour mint vesting, the hook implementation, the factory and
//  its Safe gateway.
//
//  The buyback is both the ladder treasury and the platform fee recipient:
//  every quote the platform earns (L2 mint 1%, buy tax 0.4%, genesis LP fees,
//  launch surplus) buys TOSH and burns it. It has no owner.
//
//  Required:
//    PRIVATE_KEY               deployer; holds no role afterwards
//    TARGET_CHAIN_ID           56 or 97
//    INFINITY_CL_POOL_MANAGER  PancakeSwap Infinity CLPoolManager
//    INFINITY_VAULT            the Vault that manager reports
//    PROD_OWNER_SAFE           receives factory ownership (2-step)
//    FEE_RECIPIENT             bid-book fees (immutable)
//    AGENT_REGISTRY            Binance Agent ID registry
//    WBNB, USDT                the buyback's legs; USDT is the quote asset
//    USDT_WBNB_PAIR            PancakeSwap V2 pair the buyback converts on
//    BNB_USD_FEED              Chainlink BNB/USD, the conversion's bound
//    TOSH_HOOK                 $TOSH's launch hook, the burn leg's pool
//
//  Optional (defaults in brackets, quote units), prefixed so a variable left
//  over from a v3 deploy cannot leak in:
//    V31_MIN_BUY [5e18]         V31_HARDCAP_MIN [500e18]   V31_HARDCAP_MAX [20000e18]
//    V31_AGENTCAP_MIN [15e18]   V31_AGENTCAP_MAX [15e18]   genesis per Agent ID
//    V31_SHELF_CAP [200e18]     L2 quote one Agent ID may pay on one project
//    V31_TRIGGER_STEP [180e18]  USDT the buyback waits for between legs
//    DEPLOY_TAG [v3.1]
//
//  On chain 56 the registry, quote assets, fee recipient, pair, feed and TOSH
//  hook are asserted against the known mainnet addresses, and the owner Safe
//  must be 2-of-3.
//
//    forge script script/DeployV31.s.sol --rpc-url $RPC --broadcast --verify
//
//  Addresses are written to `deployments/<DEPLOY_TAG>-<chainId>.json`.
//  After broadcast the Safe must `acceptOwnership()` on the factory, then
//  (optionally) hand it to its gateway:
//  `node scripts/v2SafeAccept.mjs <chainId> --tag=v3.1 [--handoff]`.
//  The frontend then takes `usdtFactory` and `lens` as NEXT_PUBLIC_V31_FACTORY
//  and NEXT_PUBLIC_V31_LENS.
// ─────────────────────────────────────────────────────────────────────────────
contract DeployV31 is Script {
    address internal constant MAINNET_AGENT_REGISTRY = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;
    address internal constant MAINNET_WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address internal constant MAINNET_USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant MAINNET_FEE_SAFE = 0x02DE4629129D104C63329D13A6Ca67E43db7B310;
    address internal constant MAINNET_USDT_WBNB_V2 = 0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE;
    address internal constant MAINNET_BNB_USD = 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE;
    address internal constant MAINNET_TOSH_HOOK = 0x45F29984B980f3D076CD05e7BE72E3b357856bC8;
    uint256 internal constant MAINNET_SAFE_OWNERS = 3;
    uint256 internal constant MAINNET_SAFE_THRESHOLD = 2;

    struct Env {
        address deployer;
        address poolManager;
        address vault;
        address safe;
        address feeRecipient;
        address registry;
        address wbnb;
        address usdt;
        address pair;
        address feed;
        address toshHook;
    }

    struct Params {
        uint256 minBuy;
        uint256 minHardCap;
        uint256 maxHardCap;
        uint256 minAgentCap;
        uint256 maxAgentCap;
        uint256 shelfCap;
        uint256 triggerStep;
    }

    struct Stack {
        address bidBook;
        address lens;
        address buyback;
        address autoLp;
        address vesting;
        address hookImplementation;
        address factory;
        address gateway;
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        Env memory e = _readEnv(pk);
        _validate(e, vm.envUint("TARGET_CHAIN_ID"));
        _deploy(pk, e, _params("V31_", _defaults()));
    }

    function _defaults() internal pure returns (Params memory) {
        return Params({
            minBuy: 5e18,
            minHardCap: 500e18,
            maxHardCap: 20_000e18,
            minAgentCap: 15e18,
            maxAgentCap: 15e18,
            shelfCap: 200e18,
            triggerStep: 180e18
        });
    }

    function _params(string memory pre, Params memory d) internal view returns (Params memory p) {
        p.minBuy = vm.envOr(string.concat(pre, "MIN_BUY"), d.minBuy);
        p.minHardCap = vm.envOr(string.concat(pre, "HARDCAP_MIN"), d.minHardCap);
        p.maxHardCap = vm.envOr(string.concat(pre, "HARDCAP_MAX"), d.maxHardCap);
        p.minAgentCap = vm.envOr(string.concat(pre, "AGENTCAP_MIN"), d.minAgentCap);
        p.maxAgentCap = vm.envOr(string.concat(pre, "AGENTCAP_MAX"), d.maxAgentCap);
        p.shelfCap = vm.envOr(string.concat(pre, "SHELF_CAP"), d.shelfCap);
        p.triggerStep = vm.envOr(string.concat(pre, "TRIGGER_STEP"), d.triggerStep);
    }

    function _readEnv(uint256 pk) internal view returns (Env memory e) {
        e.deployer = vm.addr(pk);
        e.poolManager = vm.envAddress("INFINITY_CL_POOL_MANAGER");
        e.vault = vm.envAddress("INFINITY_VAULT");
        e.safe = vm.envAddress("PROD_OWNER_SAFE");
        e.feeRecipient = vm.envAddress("FEE_RECIPIENT");
        e.registry = vm.envAddress("AGENT_REGISTRY");
        e.wbnb = vm.envAddress("WBNB");
        e.usdt = vm.envAddress("USDT");
        e.pair = vm.envAddress("USDT_WBNB_PAIR");
        e.feed = vm.envAddress("BNB_USD_FEED");
        e.toshHook = vm.envAddress("TOSH_HOOK");
    }

    function _validate(Env memory e, uint256 target) internal view {
        require(block.chainid == target, "chain id mismatch: wrong --rpc-url");
        require(target == 56 || target == 97, "TARGET_CHAIN_ID must be 56 or 97");
        require(e.poolManager.code.length > 0 && e.vault.code.length > 0, "Infinity addresses hold no code");
        require(IInfinityVaultGetterV31(e.poolManager).vault() == e.vault, "INFINITY_VAULT does not match the manager");
        require(e.feeRecipient != address(0), "fee recipient unset");
        require(
            e.safe.code.length > 0 && ISafeOwnersV31(e.safe).getOwners().length > 0, "PROD_OWNER_SAFE is not a Safe"
        );
        require(e.safe != e.deployer && e.feeRecipient != e.deployer, "deployer must hold no role");
        require(e.registry.code.length > 0, "AGENT_REGISTRY holds no code");
        require(e.wbnb.code.length > 0 && e.usdt.code.length > 0, "quote assets hold no code");
        require(
            e.pair.code.length > 0 && e.feed.code.length > 0 && e.toshHook.code.length > 0,
            "buyback venues hold no code"
        );

        if (target == 56) {
            require(e.registry == MAINNET_AGENT_REGISTRY, "AGENT_REGISTRY is not the Binance registry");
            require(e.wbnb == MAINNET_WBNB, "WBNB mismatch");
            require(e.usdt == MAINNET_USDT, "USDT mismatch");
            require(e.feeRecipient == MAINNET_FEE_SAFE, "FEE_RECIPIENT is not the platform fee Safe");
            require(e.pair == MAINNET_USDT_WBNB_V2, "USDT_WBNB_PAIR mismatch");
            require(e.feed == MAINNET_BNB_USD, "BNB_USD_FEED is not Chainlink BNB/USD");
            require(e.toshHook == MAINNET_TOSH_HOOK, "TOSH_HOOK is not the $TOSH hook");
            require(
                ISafeOwnersV31(e.safe).getOwners().length == MAINNET_SAFE_OWNERS
                    && ISafeOwnersV31(e.safe).getThreshold() == MAINNET_SAFE_THRESHOLD,
                "PROD_OWNER_SAFE is not 2-of-3"
            );
        }
    }

    function _deploy(uint256 pk, Env memory e, Params memory p) internal {
        require(p.shelfCap > 0 && p.triggerStep > 0, "zero shelf cap or trigger step");
        require(p.minBuy <= p.minAgentCap, "agent cap below min buy");

        vm.startBroadcast(pk);
        Stack memory s;
        ToshBidBook book = new ToshBidBook(e.feeRecipient);
        s.bidBook = address(book);
        s.lens = address(new ToshHookLensV31());
        ToshBuybackV31 buyback =
            new ToshBuybackV31(e.poolManager, e.vault, e.usdt, e.wbnb, e.pair, e.feed, e.toshHook, p.triggerStep);
        s.buyback = address(buyback);
        ToshAutoLp autoLp = new ToshAutoLp(e.vault, e.poolManager);
        s.autoLp = address(autoLp);
        ToshMintVesting vesting = new ToshMintVesting();
        s.vesting = address(vesting);

        address predicted = vm.computeCreateAddress(e.deployer, vm.getNonce(e.deployer) + 1);
        s.hookImplementation = address(
            new ToshLaunchpadHookV31(
                e.poolManager,
                e.vault,
                predicted,
                s.buyback,
                s.buyback,
                e.usdt,
                e.registry,
                p.minBuy,
                s.autoLp,
                s.vesting
            )
        );
        ToshFactoryV31 factory = new ToshFactoryV31(
            ToshFactoryV31.Config({
                hookImplementation: s.hookImplementation,
                poolManager: e.poolManager,
                vault: e.vault,
                platformTreasury: s.buyback,
                ladderTreasury: s.buyback,
                quoteAsset: e.usdt,
                bidBook: s.bidBook,
                agentRegistry: e.registry,
                minBuy: p.minBuy,
                acceptsNative: false,
                minHardCap: p.minHardCap,
                maxHardCap: p.maxHardCap,
                minAgentCap: p.minAgentCap,
                maxAgentCap: p.maxAgentCap,
                shelfCapPerAgent: p.shelfCap
            })
        );
        require(address(factory) == predicted, "factory address prediction");
        s.factory = address(factory);

        buyback.setFactory(s.factory);
        autoLp.setFactory(s.factory);
        vesting.setFactory(s.factory);
        address[] memory fs = new address[](1);
        fs[0] = s.factory;
        book.initialize(fs);
        s.gateway = address(new ToshLaunchGatewayV3(s.factory, e.safe));
        factory.transferOwnership(e.safe);
        vm.stopBroadcast();

        _check(s, e);
        _log(s);
        _write(s);
    }

    /// @dev Read back from chain: every link the stack's contracts hold to each other.
    function _check(Stack memory s, Env memory e) internal view {
        ToshFactoryV31 f = ToshFactoryV31(s.factory);
        ToshLaunchpadHookV31 impl = ToshLaunchpadHookV31(payable(s.hookImplementation));
        require(f.hookImplementation() == s.hookImplementation, "factory -> impl");
        require(impl.factory() == s.factory && impl.autoLp() == s.autoLp, "impl -> factory, autoLp");
        require(impl.mintVesting() == s.vesting, "impl -> vesting");
        require(impl.ladderTreasury() == s.buyback && impl.platformFeeRecipient() == s.buyback, "impl -> buyback");
        require(f.ladderTreasury() == s.buyback && f.platformTreasury() == s.buyback, "factory -> buyback");
        require(f.bidBook() == s.bidBook, "factory -> book");
        require(ToshBuybackV31(s.buyback).factory() == s.factory, "buyback -> factory");
        require(ToshAutoLp(s.autoLp).factory() == s.factory, "autoLp -> factory");
        require(ToshMintVesting(s.vesting).factory() == s.factory, "vesting -> factory");
        require(ToshBidBook(s.bidBook).initialized(), "book initialized");
        require(ToshBidBook(s.bidBook).factories()[0] == s.factory, "book -> factory");
        require(address(ToshLaunchGatewayV3(s.gateway).factory()) == s.factory, "gateway -> factory");
        require(f.owner() == e.deployer && f.pendingOwner() == e.safe, "factory pending Safe");
    }

    function _log(Stack memory s) internal pure {
        console2.log("ToshBidBook (v3.1) :", s.bidBook);
        console2.log("ToshHookLensV31    :", s.lens);
        console2.log("ToshBuybackV31     :", s.buyback);
        console2.log("ToshAutoLp         :", s.autoLp);
        console2.log("ToshMintVesting    :", s.vesting);
        console2.log("USDT hook impl     :", s.hookImplementation);
        console2.log("USDT factory       :", s.factory);
        console2.log("USDT gateway       :", s.gateway);
        console2.log("NEXT: Safe accepts ownership of the factory.");
    }

    function _write(Stack memory s) internal virtual {
        string memory k = "v31";
        vm.serializeAddress(k, "bidBook", s.bidBook);
        vm.serializeAddress(k, "lens", s.lens);
        vm.serializeAddress(k, "buyback", s.buyback);
        vm.serializeAddress(k, "usdtAutoLp", s.autoLp);
        vm.serializeAddress(k, "mintVesting", s.vesting);
        vm.serializeAddress(k, "usdtHookImplementation", s.hookImplementation);
        vm.serializeAddress(k, "usdtFactory", s.factory);
        string memory json = vm.serializeAddress(k, "usdtGateway", s.gateway);
        string memory tag = vm.envOr("DEPLOY_TAG", string("v3.1"));
        vm.writeJson(json, string.concat("./deployments/", tag, "-", vm.toString(block.chainid), ".json"));
    }
}
