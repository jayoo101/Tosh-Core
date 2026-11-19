// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {OuroborosToken} from "../src/ouroboros/OuroborosToken.sol";
import {OuroborosMint} from "../src/ouroboros/OuroborosMint.sol";
import {OuroborosBidBook} from "../src/ouroboros/OuroborosBidBook.sol";
import {
    MockUsdt,
    MockV2Pair,
    MockV2Factory,
    MockV2Router,
    MockFeed,
    MockRegistry
} from "../test/ouroboros/utils/OuroMocks.sol";

/// @notice Ouroboros on anvil against mock Pancake, USDT, Chainlink and Agent
///         registry, for exercising the frontend. Every anvil default account
///         gets an Agent ID and 100,000 mock USDT.
///
///   forge script script/DeployOuroborosLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract DeployOuroborosLocal is Script {
    function run() external {
        require(block.chainid == 31337, "anvil only");
        uint256 deployerKey = _anvilKey(0);
        address deployer = vm.addr(deployerKey);
        uint64 l1Start = uint64(block.timestamp + 60);
        uint64 l2Start = l1Start + 2 hours + 1 days;

        vm.startBroadcast(deployerKey);
        MockUsdt usdt = new MockUsdt();
        MockV2Factory factory = new MockV2Factory();
        address wbnb = address(0xB0B);
        MockV2Router router = new MockV2Router(address(factory), wbnb, usdt);
        router.setUsdtPerBnb(600 ether);
        MockFeed feed = new MockFeed();
        feed.set(600e8, block.timestamp);
        MockRegistry registry = new MockRegistry();

        OuroborosToken token = new OuroborosToken(address(usdt), address(router), deployer, new address[](0));
        address pair = factory.createPair(address(token), address(usdt));
        OuroborosMint mint = new OuroborosMint(
            OuroborosMint.Config({
                token: token,
                usdt: address(usdt),
                wbnb: wbnb,
                router: address(router),
                pair: pair,
                agentRegistry: address(registry),
                bnbUsdFeed: address(feed),
                treasury: deployer,
                owner: deployer,
                l1Start: l1Start,
                l2Start: l2Start
            })
        );
        OuroborosBidBook book = mint.bidBook();
        token.wire(address(mint), pair, l2Start);

        for (uint256 i; i < 10; ++i) {
            address a = vm.addr(_anvilKey(i));
            registry.setHandle(a, string.concat("anvil", vm.toString(i), ".ai"));
            usdt.mint(a, 100_000 ether);
        }
        vm.stopBroadcast();

        console2.log("NEXT_PUBLIC_OURO_TOKEN=%s", address(token));
        console2.log("NEXT_PUBLIC_OURO_MINT=%s", address(mint));
        console2.log("NEXT_PUBLIC_OURO_BIDBOOK=%s", address(book));
        console2.log("NEXT_PUBLIC_OURO_PAIR=%s", pair);
        console2.log("NEXT_PUBLIC_OURO_USDT=%s", address(usdt));
        console2.log("NEXT_PUBLIC_OURO_TREASURY=%s", deployer);
        console2.log("ROUTER=%s", address(router));
        console2.log("FEED=%s", address(feed));
    }

    function _anvilKey(uint256 i) internal pure returns (uint256) {
        return vm.deriveKey("test test test test test test test test test test test junk", uint32(i));
    }
}
