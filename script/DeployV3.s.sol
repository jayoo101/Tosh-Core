// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ToshBidBook} from "../src/ToshBidBook.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";
import {ToshLaunchGateway} from "../src/ToshLaunchGateway.sol";
import {ToshAutoLp} from "../src/v3/ToshAutoLp.sol";
import {ToshFactoryV3} from "../src/v3/ToshFactoryV3.sol";
import {ToshHookLensV3} from "../src/v3/ToshHookLensV3.sol";
import {ToshLaunchpadHookV3} from "../src/v3/ToshLaunchpadHookV3.sol";

interface IInfinityVaultGetterV3 {
    function vault() external view returns (address);
}

interface ISafeOwnersV3 {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}

// ─────────────────────────────────────────────────────────────────────────────
//  ToshX v3: a new bid book, one stack per quote asset (WBNB and USDT), the
//  v3 lens, and one Safe gateway per factory. Nothing v2 is reused: the bid
//  book, the ladder treasuries and the AutoLp each bind to their factories
//  once, so v3 stands beside v2 rather than inside it.
//
//  A stack is a ladder treasury, a ToshAutoLp, the hook implementation, the
//  factory and its gateway. The AutoLp and the treasury are bound to the
//  factory after it exists; the implementation is deployed against the
//  factory's predicted address and the factory checks it field by field.
//
//  Required:
//    PRIVATE_KEY               deployer; holds no role afterwards
//    TARGET_CHAIN_ID           56 or 97
//    INFINITY_CL_POOL_MANAGER  PancakeSwap Infinity CLPoolManager
//    INFINITY_VAULT            the Vault that manager reports
//    PLATFORM_TREASURY         genesis LP quote fees and launch surplus (immutable)
//    PROD_OWNER_SAFE           receives factory + treasury ownership (2-step)
//    FEE_RECIPIENT             bid-book fees (immutable)
//    AGENT_REGISTRY            Binance Agent ID registry
//    WBNB, USDT                quote assets
//
//  Optional (defaults in brackets, quote units; the same as live v2 unless
//  noted):
//    BNB_MIN_BUY [0.01e18]  BNB_HARDCAP_MIN [1e18]   BNB_HARDCAP_MAX [500e18]
//    BNB_AGENTCAP_MIN [0.1e18]   BNB_AGENTCAP_MAX [0.1e18]
//    USDT_MIN_BUY [5e18]    USDT_HARDCAP_MIN [500e18] USDT_HARDCAP_MAX [300000e18]
//    USDT_AGENTCAP_MIN [5e18]    USDT_AGENTCAP_MAX [30000e18]
//    BNB_TRIGGER_STEP [0.3e18]   USDT_TRIGGER_STEP [180e18]
//    BNB_SHELF_CAP [0.7e18]      USDT_SHELF_CAP [500e18]    (new in v3)
//      lifetime quote one Agent ID may spend on one project's shelves; the
//      Safe can change it later with setShelfCapPerAgent.
//
//  On chain 56 the registry, WBNB, USDT and fee recipient are asserted against
//  the known mainnet addresses, and the owner Safe must be 2-of-3.
//
//    forge script script/DeployV3.s.sol --rpc-url $RPC --broadcast --verify
//
//  After broadcast the Safe must `acceptOwnership()` on both factories and both
//  treasuries, then (optionally) hand each factory to its gateway.
//  `node scripts/v2SafeAccept.mjs <chainId> --v3 [--handoff]` writes both steps
//  as one Safe Transaction Builder batch from `deployments/v3-<chainId>.json`.
// ─────────────────────────────────────────────────────────────────────────────
contract DeployV3 is Script {
    address internal constant MAINNET_AGENT_REGISTRY = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;
    address internal constant MAINNET_WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address internal constant MAINNET_USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant MAINNET_FEE_SAFE = 0x02DE4629129D104C63329D13A6Ca67E43db7B310;
    uint256 internal constant MAINNET_SAFE_OWNERS = 3;
    uint256 internal constant MAINNET_SAFE_THRESHOLD = 2;

    struct Env {
        address deployer;
        address poolManager;
        address vault;
        address platform;
        address safe;
        address feeRecipient;
        address registry;
        address wbnb;
        address usdt;
    }

    /// @dev minBuy, hard-cap min/max, agent-cap min/max, trigger step, shelf cap.
    struct Params {
        uint256 minBuy;
        uint256 minHardCap;
        uint256 maxHardCap;
        uint256 minAgentCap;
        uint256 maxAgentCap;
        uint256 triggerStep;
        uint256 shelfCap;
    }

    struct Stack {
        address treasury;
        address autoLp;
        address hookImplementation;
        address factory;
        address gateway;
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        Env memory e = _readEnv(pk);
        _validate(e, vm.envUint("TARGET_CHAIN_ID"));
        _deploy(pk, e, _params("BNB_", _bnbDefaults()), _params("USDT_", _usdtDefaults()));
    }

    function _bnbDefaults() internal pure returns (Params memory) {
        return Params({
            minBuy: 0.01e18,
            minHardCap: 1e18,
            maxHardCap: 500e18,
            minAgentCap: 0.1e18,
            maxAgentCap: 0.1e18,
            triggerStep: 0.3e18,
            shelfCap: 0.7e18
        });
    }

    function _usdtDefaults() internal pure returns (Params memory) {
        return Params({
            minBuy: 5e18,
            minHardCap: 500e18,
            maxHardCap: 300_000e18,
            minAgentCap: 5e18,
            maxAgentCap: 30_000e18,
            triggerStep: 180e18,
            shelfCap: 500e18
        });
    }

    function _params(string memory pre, Params memory d) internal view returns (Params memory p) {
        p.minBuy = vm.envOr(string.concat(pre, "MIN_BUY"), d.minBuy);
        p.minHardCap = vm.envOr(string.concat(pre, "HARDCAP_MIN"), d.minHardCap);
        p.maxHardCap = vm.envOr(string.concat(pre, "HARDCAP_MAX"), d.maxHardCap);
        p.minAgentCap = vm.envOr(string.concat(pre, "AGENTCAP_MIN"), d.minAgentCap);
        p.maxAgentCap = vm.envOr(string.concat(pre, "AGENTCAP_MAX"), d.maxAgentCap);
        p.triggerStep = vm.envOr(string.concat(pre, "TRIGGER_STEP"), d.triggerStep);
        p.shelfCap = vm.envOr(string.concat(pre, "SHELF_CAP"), d.shelfCap);
    }

    function _deploy(uint256 pk, Env memory e, Params memory bp, Params memory up) internal {
        require(bp.shelfCap >= bp.minBuy && up.shelfCap >= up.minBuy, "shelf cap below minBuy");

        vm.startBroadcast(pk);
        ToshBidBook book = new ToshBidBook(e.feeRecipient);
        ToshHookLensV3 lens = new ToshHookLensV3();
        Stack memory bnb = _deployStack(e, address(book), e.wbnb, true, bp);
        Stack memory usdt = _deployStack(e, address(book), e.usdt, false, up);
        address[] memory fs = new address[](2);
        (fs[0], fs[1]) = (bnb.factory, usdt.factory);
        book.initialize(fs);
        vm.stopBroadcast();

        require(book.initialized() && book.factoryOf(address(0)) == address(0), "book wiring");
        _check(bnb);
        _check(usdt);

        _log(book, lens, bnb, usdt);
        _write(book, lens, bnb, usdt);
    }

    function _readEnv(uint256 pk) internal view returns (Env memory e) {
        e.deployer = vm.addr(pk);
        e.poolManager = vm.envAddress("INFINITY_CL_POOL_MANAGER");
        e.vault = vm.envAddress("INFINITY_VAULT");
        e.platform = vm.envAddress("PLATFORM_TREASURY");
        e.safe = vm.envAddress("PROD_OWNER_SAFE");
        e.feeRecipient = vm.envAddress("FEE_RECIPIENT");
        e.registry = vm.envAddress("AGENT_REGISTRY");
        e.wbnb = vm.envAddress("WBNB");
        e.usdt = vm.envAddress("USDT");
    }

    function _validate(Env memory e, uint256 target) internal view {
        require(block.chainid == target, "chain id mismatch: wrong --rpc-url");
        require(target == 56 || target == 97, "TARGET_CHAIN_ID must be 56 or 97");
        require(e.poolManager.code.length > 0 && e.vault.code.length > 0, "Infinity addresses hold no code");
        require(IInfinityVaultGetterV3(e.poolManager).vault() == e.vault, "INFINITY_VAULT does not match the manager");
        require(e.platform != address(0) && e.feeRecipient != address(0), "fee recipients unset");
        require(e.safe.code.length > 0 && ISafeOwnersV3(e.safe).getOwners().length > 0, "PROD_OWNER_SAFE is not a Safe");
        require(e.safe != e.deployer && e.platform != e.deployer, "deployer must hold no role");
        require(e.registry.code.length > 0, "AGENT_REGISTRY holds no code");
        require(e.wbnb.code.length > 0 && e.usdt.code.length > 0, "quote assets hold no code");

        if (target == 56) {
            require(e.registry == MAINNET_AGENT_REGISTRY, "AGENT_REGISTRY is not the Binance registry");
            require(e.wbnb == MAINNET_WBNB, "WBNB mismatch");
            require(e.usdt == MAINNET_USDT, "USDT mismatch");
            require(e.feeRecipient == MAINNET_FEE_SAFE, "FEE_RECIPIENT is not the platform fee Safe");
            require(
                ISafeOwnersV3(e.safe).getOwners().length == MAINNET_SAFE_OWNERS
                    && ISafeOwnersV3(e.safe).getThreshold() == MAINNET_SAFE_THRESHOLD,
                "PROD_OWNER_SAFE is not 2-of-3"
            );
        }
    }

    function _deployStack(Env memory e, address book, address quote, bool native, Params memory p)
        internal
        returns (Stack memory s)
    {
        ToshLadderTreasury treasury =
            new ToshLadderTreasury(e.poolManager, e.vault, e.deployer, quote, address(0), p.triggerStep);
        s.treasury = address(treasury);
        ToshAutoLp autoLp = new ToshAutoLp(e.vault, e.poolManager);
        s.autoLp = address(autoLp);

        address predicted = vm.computeCreateAddress(e.deployer, vm.getNonce(e.deployer) + 1);
        s.hookImplementation = address(
            new ToshLaunchpadHookV3(
                e.poolManager, e.vault, predicted, s.treasury, e.platform, quote, e.registry, p.minBuy, native, s.autoLp
            )
        );
        ToshFactoryV3 factory = new ToshFactoryV3(
            ToshFactoryV3.Config({
                hookImplementation: s.hookImplementation,
                poolManager: e.poolManager,
                vault: e.vault,
                platformTreasury: e.platform,
                ladderTreasury: s.treasury,
                quoteAsset: quote,
                bidBook: book,
                agentRegistry: e.registry,
                minBuy: p.minBuy,
                acceptsNative: native,
                minHardCap: p.minHardCap,
                maxHardCap: p.maxHardCap,
                minAgentCap: p.minAgentCap,
                maxAgentCap: p.maxAgentCap,
                shelfCapPerAgent: p.shelfCap
            })
        );
        require(address(factory) == predicted, "factory address prediction");
        s.factory = address(factory);

        treasury.setFactory(s.factory);
        autoLp.setFactory(s.factory);
        s.gateway = address(new ToshLaunchGateway(s.factory, e.safe));
        factory.transferOwnership(e.safe);
        treasury.transferOwnership(e.safe);
    }

    /// @dev Read back from chain: every link a stack's contracts hold to each other.
    function _check(Stack memory s) internal view {
        ToshLaunchpadHookV3 impl = ToshLaunchpadHookV3(payable(s.hookImplementation));
        require(ToshFactoryV3(s.factory).hookImplementation() == s.hookImplementation, "factory -> impl");
        require(impl.factory() == s.factory && impl.autoLp() == s.autoLp, "impl -> factory, autoLp");
        require(ToshAutoLp(s.autoLp).factory() == s.factory, "autoLp -> factory");
        require(ToshLadderTreasury(payable(s.treasury)).factory() == s.factory, "treasury -> factory");
        require(address(ToshLaunchGateway(s.gateway).factory()) == s.factory, "gateway -> factory");
    }

    function _log(ToshBidBook book, ToshHookLensV3 lens, Stack memory bnb, Stack memory usdt) internal pure {
        console2.log("ToshBidBook (v3)   :", address(book));
        console2.log("ToshHookLensV3     :", address(lens));
        console2.log("BNB  factory       :", bnb.factory);
        console2.log("BNB  treasury      :", bnb.treasury);
        console2.log("BNB  autoLp        :", bnb.autoLp);
        console2.log("BNB  hook impl     :", bnb.hookImplementation);
        console2.log("BNB  gateway       :", bnb.gateway);
        console2.log("USDT factory       :", usdt.factory);
        console2.log("USDT treasury      :", usdt.treasury);
        console2.log("USDT autoLp        :", usdt.autoLp);
        console2.log("USDT hook impl     :", usdt.hookImplementation);
        console2.log("USDT gateway       :", usdt.gateway);
        console2.log("NEXT: Safe accepts ownership of both factories and both treasuries.");
    }

    function _write(ToshBidBook book, ToshHookLensV3 lens, Stack memory bnb, Stack memory usdt) internal virtual {
        string memory k = "v3";
        vm.serializeAddress(k, "bidBook", address(book));
        vm.serializeAddress(k, "lens", address(lens));
        vm.serializeAddress(k, "bnbFactory", bnb.factory);
        vm.serializeAddress(k, "bnbTreasury", bnb.treasury);
        vm.serializeAddress(k, "bnbAutoLp", bnb.autoLp);
        vm.serializeAddress(k, "bnbHookImplementation", bnb.hookImplementation);
        vm.serializeAddress(k, "bnbGateway", bnb.gateway);
        vm.serializeAddress(k, "usdtFactory", usdt.factory);
        vm.serializeAddress(k, "usdtTreasury", usdt.treasury);
        vm.serializeAddress(k, "usdtAutoLp", usdt.autoLp);
        vm.serializeAddress(k, "usdtHookImplementation", usdt.hookImplementation);
        string memory json = vm.serializeAddress(k, "usdtGateway", usdt.gateway);
        vm.writeJson(json, string.concat("./deployments/v3-", vm.toString(block.chainid), ".json"));
    }
}
