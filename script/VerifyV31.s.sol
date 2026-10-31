// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";

import {DeployV31} from "./DeployV31.s.sol";

// ─────────────────────────────────────────────────────────────────────────────
//  VerifyV31 — read a broadcast v3.1 stack back from the chain.
//
//  `DeployV31` checks its wiring inside the run that deploys it, which forge
//  simulates before it broadcasts. This reads what actually landed, from
//  `deployments/<DEPLOY_TAG>-<chainId>.json`, against the same environment and
//  `V31_` parameters, and reports how far ownership has got. Reads only; no
//  key needed.
//
//    forge script script/VerifyV31.s.sol --rpc-url $BSC_RPC
//
//  Env: the DeployV31 addresses (TARGET_CHAIN_ID, INFINITY_CL_POOL_MANAGER,
//  INFINITY_VAULT, PROD_OWNER_SAFE, FEE_RECIPIENT, AGENT_REGISTRY, WBNB, USDT,
//  USDT_WBNB_PAIR, BNB_USD_FEED, TOSH_HOOK), any `V31_` overrides used at
//  deploy, and optionally DEPLOY_TAG (default `v3.1`).
// ─────────────────────────────────────────────────────────────────────────────
contract VerifyV31 is DeployV31 {
    function run() external view override {
        Env memory e = _readEnvFor(address(0));
        _validate(e, vm.envUint("TARGET_CHAIN_ID"));
        string memory tag = vm.envOr("DEPLOY_TAG", string("v3.1"));
        string memory json = vm.readFile(string.concat("./deployments/", tag, "-", vm.toString(block.chainid), ".json"));
        Stack memory s = Stack({
            bidBook: vm.parseJsonAddress(json, ".bidBook"),
            lens: vm.parseJsonAddress(json, ".lens"),
            buyback: vm.parseJsonAddress(json, ".buyback"),
            autoLp: vm.parseJsonAddress(json, ".usdtAutoLp"),
            vesting: vm.parseJsonAddress(json, ".mintVesting"),
            hookImplementation: vm.parseJsonAddress(json, ".usdtHookImplementation"),
            factory: vm.parseJsonAddress(json, ".usdtFactory"),
            gateway: vm.parseJsonAddress(json, ".usdtGateway")
        });
        string memory stage = _verify(s, e, _params("V31_", _defaults()));
        _log(s);
        console2.log("VERIFIED. Factory:", stage);
    }
}
