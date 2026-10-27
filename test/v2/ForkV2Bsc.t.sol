// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ToshBidBook} from "../../src/ToshBidBook.sol";
import {ToshFactory} from "../../src/ToshFactory.sol";
import {ToshHookLens} from "../../src/ToshHookLens.sol";
import {ToshLadderTreasury} from "../../src/ToshLadderTreasury.sol";
import {ToshLaunchpadHook} from "../../src/ToshLaunchpadHook.sol";
import {ToshToken} from "../../src/ToshToken.sol";
import {AgentIdLib} from "../../src/libraries/AgentIdLib.sol";

contract AcceptsNative {
    receive() external payable {}
}

/// @notice BSC mainnet fork: the real Binance Agent ID registry, WBNB and
///         PancakeSwap Infinity. Skipped unless `BSC_RPC` is set.
///         `AGENT_ID_HOLDER` (optional) names an address that owns an Agent ID,
///         enabling the positive path.
contract ForkV2BscTest is Test {
    address constant REGISTRY = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant VAULT = 0x238a358808379702088667322f80aC48bAd5e6c4;
    address constant CL_POOL_MANAGER = 0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b;

    bool live;
    address admin = makeAddr("admin");
    ToshFactory factory;
    ToshLaunchpadHook hook;
    ToshToken token;
    ToshHookLens lens;

    function setUp() public {
        string memory rpc = vm.envOr("BSC_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        live = true;

        vm.startPrank(admin);
        ToshBidBook book = new ToshBidBook(makeAddr("fee"));
        ToshLadderTreasury ladder = new ToshLadderTreasury(CL_POOL_MANAGER, VAULT, admin, WBNB, address(0));
        address predicted = vm.computeCreateAddress(admin, vm.getNonce(admin) + 1);
        ToshLaunchpadHook impl = new ToshLaunchpadHook(
            CL_POOL_MANAGER, VAULT, predicted, address(ladder), makeAddr("platform"), WBNB, REGISTRY, 0.01e18, true
        );
        factory = new ToshFactory(
            ToshFactory.Config({
                hookImplementation: address(impl),
                poolManager: CL_POOL_MANAGER,
                vault: VAULT,
                platformTreasury: makeAddr("platform"),
                ladderTreasury: address(ladder),
                quoteAsset: WBNB,
                bidBook: address(book),
                agentRegistry: REGISTRY,
                minBuy: 0.01e18,
                acceptsNative: true,
                minHardCap: 1e18,
                maxHardCap: 500e18,
                minAgentCap: 0.01e18,
                maxAgentCap: 50e18
            })
        );
        ladder.setFactory(address(factory));
        address[] memory fs = new address[](1);
        fs[0] = address(factory);
        book.initialize(fs);
        (address t, address h) =
            factory.createLaunch("ForkX", "FKX", makeAddr("dev"), makeAddr("fund"), bytes32(0), 10e18, 1e18, 24 hours);
        vm.stopPrank();
        token = ToshToken(t);
        hook = ToshLaunchpadHook(payable(h));
        lens = new ToshHookLens();
    }

    function test_fork_registryReadsDecode() public {
        if (!live) return;
        address nobody = makeAddr("nobody-without-agent-id");
        assertEq(AgentIdLib.agentKeyOf(REGISTRY, nobody), bytes32(0));
        ToshHookLens.AccountState memory a = lens.accountState(address(hook), nobody);
        assertTrue(a.registryOk, "registry answered within the gas bound");

        vm.deal(nobody, 1 ether);
        vm.prank(nobody, nobody);
        vm.expectRevert(ToshLaunchpadHook.NoAgentId.selector);
        hook.buyGenesis{value: 0.1 ether}(0.1 ether, 0);
    }

    function test_fork_holderBuysWithNativeBnb() public {
        if (!live) return;
        address holder = vm.envOr("AGENT_ID_HOLDER", address(0));
        if (holder == address(0)) return;
        assertTrue(AgentIdLib.agentKeyOf(REGISTRY, holder) != bytes32(0), "holder resolves to a key");
        if (holder.code.length != 0) {
            emit log("AGENT_ID_HOLDER has code: a 7702 delegation is accepted, a contract is not");
            if (holder.code.length != 23) return;
        }
        _buyAndLaunch(holder);
    }

    function test_fork_delegatedHolderBuysWithNativeBnb() public {
        if (!live) return;
        address holder = vm.envOr("AGENT_ID_HOLDER", address(0));
        if (holder == address(0) || holder.code.length != 0) return;
        vm.etch(holder, abi.encodePacked(hex"ef0100", address(new AcceptsNative())));
        _buyAndLaunch(holder);
    }

    function _buyAndLaunch(address holder) internal {
        vm.deal(holder, 1 ether);
        vm.prank(holder, holder);
        (uint256 tokens, uint256 cost) = hook.buyGenesis{value: 0.5 ether}(0.5 ether, 0);
        assertGt(tokens, 0);
        assertEq(token.balanceOf(holder), tokens);
        assertLe(cost, 0.5 ether);

        vm.warp(hook.genesisDeadline() + 48 hours);
        hook.launch();
        assertTrue(hook.launched());
    }
}
