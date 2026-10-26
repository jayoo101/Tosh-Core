// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {V2Base} from "./utils/V2Base.sol";
import {ToshLaunchpadHook} from "../../src/ToshLaunchpadHook.sol";
import {ToshToken} from "../../src/ToshToken.sol";
import {ToshBidBook} from "../../src/ToshBidBook.sol";
import {MockQuoteAsset} from "../utils/MockQuoteAsset.sol";

contract BidBookHandler is Test {
    ToshBidBook book;
    ToshLaunchpadHook hook;
    ToshToken token;
    MockQuoteAsset quote;
    address[] actors;
    uint256[] public ids;

    constructor(ToshBidBook b, ToshLaunchpadHook h, ToshToken t, MockQuoteAsset q, address[] memory a) {
        (book, hook, token, quote, actors) = (b, h, t, q, a);
    }

    function place(uint256 who, uint256 premium, uint256 qty) external {
        address a = actors[who % actors.length];
        uint256 price = hook.currentGenesisPrice() + bound(premium, 0, 1e13);
        qty = bound(qty, 1_000e18, 50_000e18);
        vm.prank(a, a);
        ids.push(book.placeBid(address(hook), price, qty));
    }

    function fill(uint256 who, uint256 pick, uint256 qty) external {
        if (ids.length == 0) return;
        address a = actors[who % actors.length];
        uint256[] memory xs = new uint256[](1);
        uint256[] memory qs = new uint256[](1);
        xs[0] = ids[pick % ids.length];
        qs[0] = bound(qty, 1e18, 60_000e18);
        uint256 bal = token.balanceOf(a);
        if (qs[0] > bal) qs[0] = bal;
        vm.prank(a, a);
        try book.fill(address(hook), xs, qs, 0) {} catch {}
    }

    function cancel(uint256 pick) external {
        if (ids.length == 0) return;
        uint256 id = ids[pick % ids.length];
        (address bidder,,,,,,,) = book.bids(id);
        vm.prank(bidder);
        try book.cancelBid(id) {} catch {}
    }

    function sweep() external {
        book.sweepFees(address(quote));
    }
}

contract BidBookInvariantTest is V2Base {
    BidBookHandler handler;

    function setUp() public override {
        super.setUp();
        (ToshToken token, ToshLaunchpadHook hook) = _create();
        address[] memory a = new address[](3);
        (a[0], a[1], a[2]) = (alice, bob, carol);
        for (uint256 i; i < 3; ++i) {
            _buy(hook, a[i], 5e18);
            vm.prank(a[i], a[i]);
            token.approve(address(book), type(uint256).max);
        }
        handler = new BidBookHandler(book, hook, token, quote, a);
        targetContract(address(handler));
    }

    function invariant_escrowPlusFeesEqualsBalance() public view {
        assertEq(book.escrowTotal(address(quote)) + book.feesAccrued(address(quote)), quote.balanceOf(address(book)));
    }
}
