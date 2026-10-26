// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {V2Base} from "./utils/V2Base.sol";
import {ToshLaunchpadHook} from "../../src/ToshLaunchpadHook.sol";
import {ToshToken} from "../../src/ToshToken.sol";
import {ToshBidBook} from "../../src/ToshBidBook.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract BidBookTest is V2Base {
    ToshToken token;
    ToshLaunchpadHook hook;

    function setUp() public override {
        super.setUp();
        (token, hook) = _create();
        _buy(hook, alice, 5e18);
        vm.prank(alice, alice);
        token.approve(address(book), type(uint256).max);
    }

    function _place(address who, uint256 price, uint256 qty) internal returns (uint256 id) {
        vm.prank(who, who);
        return book.placeBid(address(hook), price, qty);
    }

    function _fill1(address seller, uint256 id, uint256 q) internal returns (uint256 out) {
        uint256[] memory ids = new uint256[](1);
        uint256[] memory qs = new uint256[](1);
        ids[0] = id;
        qs[0] = q;
        vm.prank(seller, seller);
        (out,) = book.fill(address(hook), ids, qs, 0);
    }

    function _assertSolvent() internal view {
        assertEq(book.escrowTotal(address(quote)) + book.feesAccrued(address(quote)), quote.balanceOf(address(book)));
    }

    function test_place_locksEscrowAndRegistersBidder() public {
        uint256 price = hook.currentGenesisPrice();
        uint256 qty = 10_000e18;
        uint256 before = quote.balanceOf(dave);
        uint256 id = _place(dave, price, qty);
        uint256 gross = Math.mulDiv(price, qty, 1e18, Math.Rounding.Ceil);
        uint256 escrow = gross + Math.mulDiv(gross, 100, 10_000, Math.Rounding.Ceil);
        assertEq(before - quote.balanceOf(dave), escrow);
        assertEq(book.escrowFor(price, qty), escrow);
        assertTrue(token.isReceiver(dave), "no Agent ID needed, receiver registered");
        (address bidder,,,,,,, uint256 esc) = book.bids(id);
        assertEq(bidder, dave);
        assertEq(esc, escrow);
        _assertSolvent();
    }

    function test_revert_place_belowGenesisPrice() public {
        uint256 p = hook.currentGenesisPrice();
        vm.prank(dave, dave);
        vm.expectRevert(ToshBidBook.PriceBelowGenesis.selector);
        book.placeBid(address(hook), p - 1, 10_000e18);
    }

    function test_revert_place_belowMinBid() public {
        uint256 p = hook.currentGenesisPrice();
        uint256 qty = (MIN_BUY - 1) * 1e18 / p;
        vm.prank(dave, dave);
        vm.expectRevert(ToshBidBook.BelowMinBid.selector);
        book.placeBid(address(hook), p, qty);
    }

    function test_revert_place_contractOrUnknown() public {
        uint256 p = hook.currentGenesisPrice();
        vm.prank(dave);
        vm.expectRevert(ToshBidBook.NotAWallet.selector);
        book.placeBid(address(hook), p, 10_000e18);
        vm.prank(dave, dave);
        vm.expectRevert(ToshBidBook.UnknownHook.selector);
        book.placeBid(address(0xBEEF), p, 10_000e18);
    }

    function test_fill_full_feesBothSides() public {
        uint256 price = hook.currentGenesisPrice() * 12 / 10;
        uint256 qty = 20_000e18;
        uint256 id = _place(dave, price, qty);
        (,,,,,,, uint256 escrow) = book.bids(id);

        uint256 aliceQuote = quote.balanceOf(alice);
        uint256 out = _fill1(alice, id, qty);
        uint256 gross = Math.mulDiv(price, qty, 1e18, Math.Rounding.Ceil);
        assertEq(out, gross - gross / 100);
        assertEq(quote.balanceOf(alice) - aliceQuote, out);
        assertEq(token.balanceOf(dave), qty, "tokens go seller -> bidder");
        assertEq(book.feesAccrued(address(quote)), escrow - out, "both fees accrued");
        (,,,,,, uint256 filled, uint256 left) = book.bids(id);
        assertEq(filled, qty);
        assertEq(left, 0);
        _assertSolvent();

        book.sweepFees(address(quote));
        assertEq(quote.balanceOf(feeSafe), escrow - out);
        assertEq(quote.balanceOf(address(book)), 0);
    }

    function testFuzz_partialFills_sumToTheWhole(uint256 seed, uint8 parts) public {
        uint256 price = hook.currentGenesisPrice() + (seed % 1e12);
        uint256 qty = 30_000e18 + (seed % 1e21);
        uint256 id = _place(dave, price, qty);
        (,,,,,,, uint256 escrow) = book.bids(id);

        uint256 n = bound(parts, 1, 12);
        uint256 out;
        uint256 done;
        for (uint256 i; i < n; ++i) {
            uint256 q = i == n - 1 ? qty - done : bound(uint256(keccak256(abi.encode(seed, i))), 1e18, (qty - done) / 2);
            if (q == 0) continue;
            out += _fill1(alice, id, q);
            done += q;
            _assertSolvent();
        }
        (,,,,,, uint256 filled, uint256 left) = book.bids(id);
        assertEq(filled, qty);
        assertEq(left, 0, "escrow exactly exhausted");
        assertEq(out + book.feesAccrued(address(quote)), escrow);
    }

    function test_fill_skipsBelowFloorAndDelegatedBidders() public {
        uint256 p0 = hook.currentGenesisPrice();
        uint256 cheap = _place(dave, p0, 10_000e18);
        uint256 delegated = _place(trader, p0 * 2, 10_000e18);
        uint256 good = _place(carol, p0 * 2, 10_000e18);

        // Curve moves up past cheap / 0.9.
        for (uint256 i; i < 8; ++i) {
            address w = vm.addr(0xB000 + i);
            registry.setHandle(w, vm.toString(w));
            quote.mint(w, 10e18);
            vm.startPrank(w, w);
            quote.approve(address(hook), type(uint256).max);
            hook.buyGenesis(5e18, 0);
            vm.stopPrank();
        }
        assertLt(p0, book.fillFloor(address(hook)));
        vm.etch(trader, abi.encodePacked(hex"ef0100", address(0xBEEF)));

        uint256[] memory ids = new uint256[](3);
        uint256[] memory qs = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (cheap, delegated, good);
        (qs[0], qs[1], qs[2]) = (10_000e18, 10_000e18, 10_000e18);
        vm.prank(alice, alice);
        (, uint256 totalQty) = book.fill(address(hook), ids, qs, 0);
        assertEq(totalQty, 10_000e18, "only the good bid");
        assertEq(token.balanceOf(carol), 10_000e18);
        _assertSolvent();
    }

    function test_fill_clampsToRemaining_andMinOut() public {
        uint256 id = _place(dave, hook.currentGenesisPrice(), 10_000e18);
        uint256[] memory ids = new uint256[](1);
        uint256[] memory qs = new uint256[](1);
        ids[0] = id;
        qs[0] = 50_000e18;
        uint256 expect = book.quoteFill(id, 10_000e18);
        vm.prank(alice, alice);
        vm.expectRevert(ToshBidBook.InsufficientOutput.selector);
        book.fill(address(hook), ids, qs, expect + 1);
        vm.prank(alice, alice);
        (uint256 out, uint256 q) = book.fill(address(hook), ids, qs, expect);
        assertEq(q, 10_000e18);
        assertEq(out, expect);

        vm.prank(alice, alice);
        vm.expectRevert(ToshBidBook.NothingFilled.selector);
        book.fill(address(hook), ids, qs, 0);
    }

    function test_cancel_refundsRemaining() public {
        uint256 id = _place(dave, hook.currentGenesisPrice(), 10_000e18);
        _fill1(alice, id, 4_000e18);
        (,,,,,,, uint256 left) = book.bids(id);
        uint256 before = quote.balanceOf(dave);

        vm.prank(alice);
        vm.expectRevert(ToshBidBook.NotBidder.selector);
        book.cancelBid(id);

        vm.prank(dave);
        book.cancelBid(id);
        assertEq(quote.balanceOf(dave) - before, left);
        vm.prank(dave);
        vm.expectRevert(ToshBidBook.BidClosed.selector);
        book.cancelBid(id);
        _assertSolvent();
    }

    function test_afterLaunch_cancelOnly() public {
        uint256 id = _place(dave, hook.currentGenesisPrice(), 10_000e18);
        _launchAsAdmin(hook);

        uint256 p = hook.currentGenesisPrice();
        vm.prank(carol, carol);
        vm.expectRevert(ToshBidBook.Launched.selector);
        book.placeBid(address(hook), p, 10_000e18);

        uint256[] memory ids = new uint256[](1);
        uint256[] memory qs = new uint256[](1);
        ids[0] = id;
        qs[0] = 1e18;
        vm.prank(alice, alice);
        vm.expectRevert(ToshBidBook.Launched.selector);
        book.fill(address(hook), ids, qs, 0);

        vm.prank(dave);
        book.cancelBid(id);
        _assertSolvent();
    }

    function test_revert_initializeTwiceOrByOthers() public {
        address[] memory fs = new address[](0);
        vm.prank(admin);
        vm.expectRevert(ToshBidBook.AlreadyInitialized.selector);
        book.initialize(fs);
        vm.expectRevert(ToshBidBook.OnlyDeployer.selector);
        book.initialize(fs);
    }
}
