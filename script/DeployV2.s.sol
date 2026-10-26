// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ToshBidBook} from "../src/ToshBidBook.sol";
import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshHookLens} from "../src/ToshHookLens.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";
import {ToshLaunchGateway} from "../src/ToshLaunchGateway.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";

interface IInfinityVaultGetter {
    function vault() external view returns (address);
}

interface ISafeOwners {
    function getOwners() external view returns (address[] memory);
}

// ─────────────────────────────────────────────────────────────────────────────
//  ToshX v2: the shared bid book, one stack per quote asset (WBNB and USDT),
//  the lens, and one Safe gateway per factory.
//
//  Required:
//    PRIVATE_KEY               deployer; holds no role afterwards
//    TARGET_CHAIN_ID           56 or 97
//    INFINITY_CL_POOL_MANAGER  PancakeSwap Infinity CLPoolManager
//    INFINITY_VAULT            the Vault that manager reports
//    PLATFORM_TREASURY         0.30 % swap cut and launch surplus (immutable)
//    PROD_OWNER_SAFE           receives factory + treasury ownership (2-step)
//    FEE_RECIPIENT             bid-book fees (immutable)
//    AGENT_REGISTRY            Binance Agent ID registry
//    WBNB, USDT                quote assets
//
//  Optional (defaults in brackets, quote units):
//    BNB_MIN_BUY [0.01e18]  BNB_HARDCAP_MIN [1e18]   BNB_HARDCAP_MAX [500e18]
//    BNB_AGENTCAP_MIN [0.01e18]  BNB_AGENTCAP_MAX [50e18]
//    USDT_MIN_BUY [5e18]    USDT_HARDCAP_MIN [500e18] USDT_HARDCAP_MAX [300000e18]
//    USDT_AGENTCAP_MIN [5e18]    USDT_AGENTCAP_MAX [30000e18]
//
//  On chain 56 the registry, WBNB, USDT and fee recipient are asserted against
//  the known mainnet addresses.
//
//    forge script script/DeployV2.s.sol --rpc-url $RPC --broadcast --verify
//
//  After broadcast the Safe must `acceptOwnership()` on both factories and both
//  treasuries, then (optionally) hand each factory to its gateway:
//  `factory.transferOwnership(gateway)` + `gateway.execute(acceptOwnership())`.
// ─────────────────────────────────────────────────────────────────────────────
contract DeployV2 is Script {
    address internal constant MAINNET_AGENT_REGISTRY = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;
    address internal constant MAINNET_WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address internal constant MAINNET_USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant MAINNET_FEE_SAFE = 0x02DE4629129D104C63329D13A6Ca67E43db7B310;

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

    struct Stack {
        address treasury;
        address hookImplementation;
        address factory;
        address gateway;
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        Env memory e = _loadEnv(pk);

        vm.startBroadcast(pk);
        ToshBidBook book = new ToshBidBook(e.feeRecipient);
        ToshHookLens lens = new ToshHookLens();

        Stack memory bnb = _deployStack(
            e,
            address(book),
            e.wbnb,
            true,
            vm.envOr("BNB_MIN_BUY", uint256(0.01e18)),
            [
                vm.envOr("BNB_HARDCAP_MIN", uint256(1e18)),
                vm.envOr("BNB_HARDCAP_MAX", uint256(500e18)),
                vm.envOr("BNB_AGENTCAP_MIN", uint256(0.01e18)),
                vm.envOr("BNB_AGENTCAP_MAX", uint256(50e18))
            ]
        );
        Stack memory usdt = _deployStack(
            e,
            address(book),
            e.usdt,
            false,
            vm.envOr("USDT_MIN_BUY", uint256(5e18)),
            [
                vm.envOr("USDT_HARDCAP_MIN", uint256(500e18)),
                vm.envOr("USDT_HARDCAP_MAX", uint256(300_000e18)),
                vm.envOr("USDT_AGENTCAP_MIN", uint256(5e18)),
                vm.envOr("USDT_AGENTCAP_MAX", uint256(30_000e18))
            ]
        );

        address[] memory fs = new address[](2);
        (fs[0], fs[1]) = (bnb.factory, usdt.factory);
        book.initialize(fs);
        vm.stopBroadcast();

        require(book.initialized() && book.factoryOf(address(0)) == address(0), "book wiring");

        _log(book, lens, bnb, usdt);
        _write(book, lens, bnb, usdt);
    }

    function _loadEnv(uint256 pk) internal view returns (Env memory e) {
        e.deployer = vm.addr(pk);
        uint256 target = vm.envUint("TARGET_CHAIN_ID");
        require(block.chainid == target, "chain id mismatch: wrong --rpc-url");
        require(target == 56 || target == 97, "TARGET_CHAIN_ID must be 56 or 97");

        e.poolManager = vm.envAddress("INFINITY_CL_POOL_MANAGER");
        e.vault = vm.envAddress("INFINITY_VAULT");
        require(e.poolManager.code.length > 0 && e.vault.code.length > 0, "Infinity addresses hold no code");
        require(IInfinityVaultGetter(e.poolManager).vault() == e.vault, "INFINITY_VAULT does not match the manager");

        e.platform = vm.envAddress("PLATFORM_TREASURY");
        e.safe = vm.envAddress("PROD_OWNER_SAFE");
        e.feeRecipient = vm.envAddress("FEE_RECIPIENT");
        e.registry = vm.envAddress("AGENT_REGISTRY");
        e.wbnb = vm.envAddress("WBNB");
        e.usdt = vm.envAddress("USDT");
        require(e.platform != address(0) && e.feeRecipient != address(0), "fee recipients unset");
        require(e.safe.code.length > 0 && ISafeOwners(e.safe).getOwners().length > 0, "PROD_OWNER_SAFE is not a Safe");
        require(e.safe != e.deployer && e.platform != e.deployer, "deployer must hold no role");
        require(e.registry.code.length > 0, "AGENT_REGISTRY holds no code");
        require(e.wbnb.code.length > 0 && e.usdt.code.length > 0, "quote assets hold no code");

        if (target == 56) {
            require(e.registry == MAINNET_AGENT_REGISTRY, "AGENT_REGISTRY is not the Binance registry");
            require(e.wbnb == MAINNET_WBNB, "WBNB mismatch");
            require(e.usdt == MAINNET_USDT, "USDT mismatch");
            require(e.feeRecipient == MAINNET_FEE_SAFE, "FEE_RECIPIENT is not the platform fee Safe");
        }
    }

    function _deployStack(
        Env memory e,
        address book,
        address quote,
        bool native,
        uint256 minBuy,
        uint256[4] memory bounds
    ) internal returns (Stack memory s) {
        ToshLadderTreasury treasury = new ToshLadderTreasury(e.poolManager, e.vault, e.deployer, quote, address(0));
        s.treasury = address(treasury);

        address predicted = vm.computeCreateAddress(e.deployer, vm.getNonce(e.deployer) + 1);
        s.hookImplementation = address(
            new ToshLaunchpadHook(
                e.poolManager, e.vault, predicted, s.treasury, e.platform, quote, e.registry, minBuy, native
            )
        );
        ToshFactory factory = new ToshFactory(
            ToshFactory.Config({
                hookImplementation: s.hookImplementation,
                poolManager: e.poolManager,
                vault: e.vault,
                platformTreasury: e.platform,
                ladderTreasury: s.treasury,
                quoteAsset: quote,
                bidBook: book,
                agentRegistry: e.registry,
                minBuy: minBuy,
                acceptsNative: native,
                minHardCap: bounds[0],
                maxHardCap: bounds[1],
                minAgentCap: bounds[2],
                maxAgentCap: bounds[3]
            })
        );
        require(address(factory) == predicted, "factory address prediction");
        s.factory = address(factory);

        treasury.setFactory(s.factory);
        s.gateway = address(new ToshLaunchGateway(s.factory, e.safe));
        factory.transferOwnership(e.safe);
        treasury.transferOwnership(e.safe);
    }

    function _log(ToshBidBook book, ToshHookLens lens, Stack memory bnb, Stack memory usdt) internal pure {
        console2.log("ToshBidBook        :", address(book));
        console2.log("ToshHookLens       :", address(lens));
        console2.log("BNB  factory       :", bnb.factory);
        console2.log("BNB  treasury      :", bnb.treasury);
        console2.log("BNB  hook impl     :", bnb.hookImplementation);
        console2.log("BNB  gateway       :", bnb.gateway);
        console2.log("USDT factory       :", usdt.factory);
        console2.log("USDT treasury      :", usdt.treasury);
        console2.log("USDT hook impl     :", usdt.hookImplementation);
        console2.log("USDT gateway       :", usdt.gateway);
        console2.log("NEXT: Safe accepts ownership of both factories and both treasuries.");
    }

    function _write(ToshBidBook book, ToshHookLens lens, Stack memory bnb, Stack memory usdt) internal {
        string memory k = "v2";
        vm.serializeAddress(k, "bidBook", address(book));
        vm.serializeAddress(k, "lens", address(lens));
        vm.serializeAddress(k, "bnbFactory", bnb.factory);
        vm.serializeAddress(k, "bnbTreasury", bnb.treasury);
        vm.serializeAddress(k, "bnbGateway", bnb.gateway);
        vm.serializeAddress(k, "usdtFactory", usdt.factory);
        vm.serializeAddress(k, "usdtTreasury", usdt.treasury);
        string memory json = vm.serializeAddress(k, "usdtGateway", usdt.gateway);
        vm.writeJson(json, string.concat("./deployments/v2-", vm.toString(block.chainid), ".json"));
    }
}
