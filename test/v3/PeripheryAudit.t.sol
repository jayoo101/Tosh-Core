// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {ILockCallback} from "infinity-core/src/interfaces/ILockCallback.sol";

import {V2BaseV3} from "./utils/V2BaseV3.sol";
import {ToshLaunchpadHookV3} from "../../src/v3/ToshLaunchpadHookV3.sol";
import {ToshToken} from "../../src/ToshToken.sol";
import {ToshFactoryV3} from "../../src/v3/ToshFactoryV3.sol";
import {ToshBidBook} from "../../src/ToshBidBook.sol";
import {ToshLaunchGateway} from "../../src/ToshLaunchGateway.sol";
import {CircuitNFT} from "../../src/CircuitNFT.sol";
import {CircuitRevenueVault} from "../../src/CircuitRevenueVault.sol";

// ─── Attack / scenario helpers ───────────────────────────────────────────────

/// @dev Minimal escrow-style NFT market: seller lists, buyer pays, market moves
///      the NFT. Stands in for Seaport/OpenSea/any OTC escrow where the BUYER
///      submits the transaction that performs the transfer.
contract NaiveCircuitMarketV3 {
    IERC20 public immutable quote;
    CircuitNFT public immutable nft;
    mapping(uint256 => uint256) public priceOf;
    mapping(uint256 => address) public sellerOf;

    constructor(IERC20 q, CircuitNFT n) {
        quote = q;
        nft = n;
    }

    function list(uint256 id, uint256 price) external {
        require(nft.ownerOf(id) == msg.sender, "not owner");
        priceOf[id] = price;
        sellerOf[id] = msg.sender;
    }

    function buy(uint256 id) external {
        address seller = sellerOf[id];
        require(seller != address(0), "not listed");
        delete sellerOf[id];
        quote.transferFrom(msg.sender, seller, priceOf[id]);
        nft.transferFrom(seller, msg.sender, id);
    }
}

/// @dev Buyer that executes the purchase from inside its own Infinity Vault
///      lock. Any address may open a lock; while it is open the hook's
///      `collectGenesisFees` (which needs its own lock) reverts, and
///      `CircuitNFT._update` swallows that revert.
contract LockingCircuitBuyerV3 is ILockCallback {
    IVault public immutable vault;
    NaiveCircuitMarketV3 public immutable market;

    constructor(IVault v, NaiveCircuitMarketV3 m) {
        vault = v;
        market = m;
    }

    function attack(uint256 id) external {
        market.quote().approve(address(market), type(uint256).max);
        vault.lock(abi.encode(id));
    }

    function lockAcquired(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(vault), "vault only");
        market.buy(abi.decode(data, (uint256)));
        return "";
    }

    function harvest(ToshLaunchpadHookV3 hook, CircuitRevenueVault rv, address to) external returns (uint256) {
        hook.collectGenesisFees();
        return rv.withdraw(address(market.quote()), to, type(uint256).max);
    }
}

contract MockSafeV3 {
    mapping(address => bool) public isOwner;
    address[] internal _owners;

    function addOwner(address o) external {
        isOwner[o] = true;
        _owners.push(o);
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function exec(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory r) = target.call(data);
        require(ok, "exec failed");
        return r;
    }
}

/// @dev Contract that tries to act on a holder's behalf pre-launch.
contract ProxyMoverV3 {
    function move(ToshToken t, address to, uint256 amt) external {
        t.transfer(to, amt);
    }

    function pull(ToshToken t, address from, address to, uint256 amt) external {
        t.transferFrom(from, to, amt);
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

contract PeripheryAuditTestV3 is V2BaseV3 {
    ToshToken token;
    ToshLaunchpadHookV3 hook;
    CircuitNFT nft;
    uint256 circuitId;
    CircuitRevenueVault rv;

    function setUp() public override {
        super.setUp();
        (token, hook) = _create();
        _buy(hook, alice, 5e18);
        _buy(hook, bob, 5e18);
        nft = CircuitNFT(factory.circuitNFT());
        circuitId = factory.circuitOf(address(hook));
        rv = CircuitRevenueVault(hook.projectAdmin());
    }

    function _launchAndAccrueFees() internal {
        _launchAsAdmin(hook);
        _nextBlock();
        _swapBuy(hook, trader, 20e18);
        _nextBlock();
        _swapSell(hook, alice, 50_000e18);
        _nextBlock();
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  F-1  CircuitNFT: buyer suppresses the pre-transfer fee sweep
    // ═════════════════════════════════════════════════════════════════════════

    function test_F1_vaultLockCannotSkipSellerFeeSweep() public {
        _launchAndAccrueFees();
        assertEq(quote.balanceOf(address(rv)), 0, "vault empty before the sale");

        NaiveCircuitMarketV3 market = new NaiveCircuitMarketV3(IERC20(address(quote)), nft);
        uint256 price = 1e18;
        vm.startPrank(dev);
        nft.approve(address(market), circuitId);
        market.list(circuitId, price);
        vm.stopPrank();

        // ── Control: an honest buyer. Seller receives price + accrued fees.
        uint256 snap = vm.snapshotState();
        address honest = makeAddr("honestBuyer");
        quote.mint(honest, price);
        uint256 devBefore = quote.balanceOf(dev);
        vm.startPrank(honest);
        quote.approve(address(market), price);
        market.buy(circuitId);
        vm.stopPrank();
        uint256 honestSellerGain = quote.balanceOf(dev) - devBefore;
        uint256 fees = honestSellerGain - price;
        assertGt(fees, 0, "pool fees were swept to the seller");
        console2.log("honest sale: seller gain", honestSellerGain, "fees", fees);
        vm.revertToState(snap);

        // ── Attack: buyer purchases from inside its own Vault lock.
        LockingCircuitBuyerV3 attacker = new LockingCircuitBuyerV3(IVault(address(vault)), market);
        quote.mint(address(attacker), price);
        vm.expectRevert(CircuitNFT.FeeSweepFailed.selector);
        attacker.attack(circuitId);
        assertEq(nft.ownerOf(circuitId), dev, "the sale cannot complete without the sweep");
    }

    /// Variant: OOG griefing of the try/catch. Measures whether the 63/64 rule
    /// leaves enough gas for `settle` after `collectGenesisFees` runs out.
    function test_F1b_gasGriefVariantFeasibility() public {
        _launchAndAccrueFees();
        uint256 g = gasleft();
        hook.collectGenesisFees();
        uint256 collectGas = g - gasleft();
        _swapBuy(hook, trader, 1e18);
        _nextBlock();
        // transfer with sweep
        g = gasleft();
        vm.prank(dev);
        nft.transferFrom(dev, carol, circuitId);
        uint256 transferGas = g - gasleft();
        console2.log("collectGenesisFees gas", collectGas);
        console2.log("full Circuit transfer gas", transferGas);
        // OOG-in-try is only viable when collect > 63 * (gas needed after it).
        // Settle alone costs > 5k, so collect would need > ~315k+.
        console2.log("collect/63 threshold", collectGas / 63);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  F-2  Gateway: one Safe signer lists and permanently squats a name
    // ═════════════════════════════════════════════════════════════════════════

    function test_F2_singleSignerSquatIsReleasableOnlyBySafe() public {
        MockSafeV3 safe = new MockSafeV3();
        address rogue = makeAddr("rogueSigner");
        safe.addOwner(rogue);
        ToshLaunchGateway gw = new ToshLaunchGateway(address(factory), address(safe));
        vm.prank(admin);
        factory.transferOwnership(address(gw));
        safe.exec(
            address(gw), abi.encodeCall(ToshLaunchGateway.execute, (abi.encodeWithSignature("acceptOwnership()")))
        );
        assertEq(factory.owner(), address(gw));

        // One signer, no Safe threshold, names itself developer and fund.
        vm.prank(rogue);
        (address t, address h) =
            gw.createLaunch("Binance", "BNB", rogue, rogue, bytes32(uint256(777)), HARD_CAP, AGENT_CAP, DURATION);
        ToshLaunchpadHookV3 hh = ToshLaunchpadHookV3(payable(h));
        assertEq(nft.ownerOf(factory.circuitOf(h)), rogue);

        // A single minBuy makes raised != 0, so releaseAbandonedName can never fire.
        vm.prank(alice);
        quote.approve(h, type(uint256).max);
        vm.prank(alice, alice);
        hh.buyGenesis(MIN_BUY, 0);
        vm.warp(hh.genesisDeadline() + 30 days);
        vm.expectRevert(ToshFactoryV3.NameStillHeld.selector);
        factory.releaseAbandonedName(h);

        // The genuine project can no longer use the name/symbol pair.
        vm.prank(address(safe));
        vm.expectRevert(ToshFactoryV3.NameTaken.selector);
        gw.createLaunch("Binance", "BNB", dev, fund, bytes32(uint256(778)), HARD_CAP, AGENT_CAP, DURATION);
        t;

        // The signer alone cannot free it; the Safe can.
        bytes memory release = abi.encodeCall(ToshFactoryV3.releaseName, (h));
        vm.prank(rogue);
        vm.expectRevert(ToshLaunchGateway.NotSafe.selector);
        gw.execute(release);

        bytes32 key = factory.hookNameKey(h);
        assertTrue(factory.nameTaken(key));
        safe.exec(address(gw), abi.encodeCall(ToshLaunchGateway.execute, (release)));
        assertFalse(factory.nameTaken(key), "the Safe freed the squatted name");
        assertEq(factory.hookNameKey(h), bytes32(0));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice));
        factory.releaseName(h);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Sound-area checks (expected to hold)
    // ═════════════════════════════════════════════════════════════════════════

    function test_S1_token_preLaunchRestrictionsHold() public {
        uint256 amt = 1_000e18;

        // to a contract (pool / vault / router)
        vm.prank(alice, alice);
        vm.expectRevert(ToshToken.TransferRestricted.selector);
        token.transfer(address(vault), amt);

        // to an undeployed (CREATE2-predictable) address that never registered
        address future = address(uint160(uint256(keccak256("future-pair"))));
        vm.prank(alice, alice);
        vm.expectRevert(abi.encodeWithSelector(ToshToken.ReceiverNotRegistered.selector, future));
        token.transfer(future, amt);

        // approve any spender but the bid book
        vm.prank(alice, alice);
        vm.expectRevert(ToshToken.ApprovalRestricted.selector);
        token.approve(address(router), amt);

        // a contract cannot register itself as receiver
        ProxyMoverV3 pm = new ProxyMoverV3();
        vm.prank(address(pm));
        vm.expectRevert(ToshToken.NotAWallet.selector);
        token.registerReceiver();

        // a contract cannot move a holder's balance even when the holder is tx.origin
        vm.prank(address(pm), alice);
        vm.expectRevert(ToshToken.TransferRestricted.selector);
        token.transfer(bob, amt);

        // not tx.origin: alice's tokens moved in a tx someone else signed
        vm.prank(alice, bob);
        vm.expectRevert(ToshToken.TransferRestricted.selector);
        token.transfer(bob, amt);

        // bid-book allowance cannot be used by a third party
        vm.prank(alice, alice);
        token.approve(address(book), type(uint256).max);
        vm.prank(address(book), bob);
        vm.expectRevert(ToshToken.TransferRestricted.selector);
        token.transferFrom(alice, bob, amt);

        // registry is only writable by hook / bid book
        vm.prank(trader);
        vm.expectRevert(ToshToken.OnlyRegistrar.selector);
        token.registerFor(address(pm));

        // initialize / openTrading fenced
        vm.expectRevert(ToshToken.OnlyFactory.selector);
        token.initialize(address(this), "x", "x");
        vm.expectRevert(ToshToken.OnlyHook.selector);
        token.openTrading();

        // wallet-to-registered-wallet works
        vm.prank(alice, alice);
        token.transfer(bob, amt);
    }

    /// Escrow is exact under arbitrary partial-fill sequences and cancellation.
    function testFuzz_S2_bidBookEscrowExactUnderSplits(uint256 priceMul, uint256 qty, uint256 s1, uint256 s2) public {
        uint256 p0 = hook.currentGenesisPrice();
        uint256 price = p0 + bound(priceMul, 0, 10 * p0);
        qty = bound(qty, 1_000e18, 20_000e18);
        vm.prank(alice, alice);
        token.approve(address(book), type(uint256).max);

        uint256 dBefore = quote.balanceOf(dave);
        vm.prank(dave, dave);
        uint256 id = book.placeBid(address(hook), price, qty);
        uint256 escrow = dBefore - quote.balanceOf(dave);

        uint256 q1 = bound(s1, 1e18, qty - 1e18);
        uint256 q2 = bound(s2, 1, qty - q1);
        if (q2 < 1e18 && q2 != qty - q1) q2 = qty - q1;

        uint256 aBefore = quote.balanceOf(alice);
        uint256[] memory ids = new uint256[](2);
        uint256[] memory qs = new uint256[](2);
        ids[0] = id;
        ids[1] = id;
        qs[0] = q1;
        qs[1] = q2;
        vm.prank(alice, alice);
        book.fill(address(hook), ids, qs, 0);
        uint256 sellerOut = quote.balanceOf(alice) - aBefore;

        vm.prank(dave, dave);
        if (q1 + q2 == qty) {
            vm.expectRevert(ToshBidBook.BidClosed.selector);
            book.cancelBid(id);
        } else {
            book.cancelBid(id);
        }
        uint256 refund = quote.balanceOf(dave) - (dBefore - escrow);
        uint256 fees = book.feesAccrued(address(quote));
        assertEq(sellerOut + fees + refund, escrow, "escrow conserved to the wei");
        assertEq(token.balanceOf(dave), q1 + q2);
        assertEq(book.escrowTotal(address(quote)), 0);
        assertEq(quote.balanceOf(address(book)), fees);
        uint256 gross = Math.mulDiv(price, q1 + q2, 1e18, Math.Rounding.Ceil);
        assertLe(sellerOut, gross, "seller never gets more than ceil(price*qty)");
    }

    /// Bid book after launch: fills/placements closed, cancel always available.
    function test_S3_bidBookPostLaunchCancelOnly() public {
        uint256 p = hook.currentGenesisPrice();
        vm.prank(dave, dave);
        uint256 id = book.placeBid(address(hook), p, 5_000e18);
        _launchAsAdmin(hook);
        vm.prank(dave, dave);
        vm.expectRevert(ToshBidBook.Launched.selector);
        book.placeBid(address(hook), p * 2, 5_000e18);
        uint256[] memory ids = new uint256[](1);
        uint256[] memory qs = new uint256[](1);
        ids[0] = id;
        qs[0] = 5_000e18;
        vm.prank(alice, alice);
        vm.expectRevert(ToshBidBook.Launched.selector);
        book.fill(address(hook), ids, qs, 0);
        uint256 b = quote.balanceOf(dave);
        vm.prank(dave, dave);
        book.cancelBid(id);
        assertGt(quote.balanceOf(dave), b);
        // another user cannot cancel/steal
        vm.prank(bob, bob);
        vm.expectRevert(ToshBidBook.NotBidder.selector);
        book.cancelBid(id);
    }

    /// Factory / clone surfaces: owner-gated, single-init, CREATE2 collisions revert.
    function test_S4_factoryAndCloneFences() public {
        vm.prank(trader);
        vm.expectRevert();
        factory.createLaunch("X", "X", dev, fund, bytes32(0), HARD_CAP, AGENT_CAP, DURATION);

        // re-init of hook / token / vault impossible
        vm.expectRevert();
        hook.initializeToken(address(token), address(this), address(this));
        vm.prank(address(factory));
        vm.expectRevert(ToshToken.AlreadyInitialized.selector);
        token.initialize(address(this), "x", "x");

        // token implementation cannot be initialised by anyone but the factory
        ToshToken impl = ToshToken(factory.tokenImplementation());
        vm.expectRevert(ToshToken.OnlyFactory.selector);
        impl.initialize(address(this), "x", "x");

        // same hookSalt + params a second time collides and reverts cleanly
        bytes32 salt = bytes32(uint256(4242));
        vm.prank(admin);
        factory.createLaunch("Gamma", "G", dev, fund, salt, HARD_CAP, AGENT_CAP, DURATION);
        vm.prank(admin);
        vm.expectRevert();
        factory.createLaunch("Delta", "D", dev, fund, salt, HARD_CAP, AGENT_CAP, DURATION);

        // vault settle fenced
        vm.expectRevert(CircuitRevenueVault.OnlyCircuit.selector);
        rv.settle(address(this));
    }
}
