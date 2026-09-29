// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {CircuitNFT} from "../src/CircuitNFT.sol";
import {CircuitRevenueVault} from "../src/CircuitRevenueVault.sol";
import {ToshCloneLib} from "../src/libraries/ToshCloneLib.sol";
import {MockQuoteAsset} from "./utils/MockQuoteAsset.sol";

/// @notice GrantPad: the Circuit NFT and the revenue vault it controls.
///
/// @dev    Runs against a real factory on mock AMM addresses, like
///         ToshV5Factory.t.sol — nothing here reaches a pool. Vault balances are
///         minted in directly; the shelf-sale path that fills a vault for real
///         is covered in ToshV5.t.sol.
contract ToshGrantPadTest is Test {
    address internal admin = makeAddr("admin");
    address internal developer = makeAddr("developer");
    address internal buyer = makeAddr("buyer");
    address internal stranger = makeAddr("stranger");
    address internal payout = makeAddr("payout");

    ToshFactory internal factory;
    CircuitNFT internal circuit;
    MockQuoteAsset internal quote;

    ToshLaunchpadHook internal hook;
    CircuitRevenueVault internal vault;
    uint256 internal tokenId;

    uint256 internal constant HARD_CAP = 500e8;
    uint256 internal constant WALLET_CAP = 50e8;
    uint256 internal constant REVENUE = 1_000e8;

    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event Settled(address indexed to, uint256 amount);

    function setUp() public {
        quote = new MockQuoteAsset();
        vm.prank(admin);
        factory = new ToshFactory(
            makeAddr("poolManager"),
            makeAddr("vault"),
            makeAddr("pogSigner"),
            makeAddr("platformTreasury"),
            payable(makeAddr("ladder")),
            address(quote)
        );
        circuit = CircuitNFT(factory.circuitNFT());

        (hook, tokenId) = _launch("Grant", "GRNT", developer);
        vault = CircuitRevenueVault(hook.projectAdmin());
        quote.mint(address(vault), REVENUE);
    }

    function _launch(string memory n, string memory s, address dev) internal returns (ToshLaunchpadHook h, uint256 id) {
        vm.prank(admin);
        (, address hk) = factory.createLaunch(n, s, dev, keccak256(bytes(n)), HARD_CAP, WALLET_CAP, 24 hours);
        h = ToshLaunchpadHook(payable(hk));
        id = factory.circuitOf(hk);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  CircuitNFT
    // ══════════════════════════════════════════════════════════════════════════

    function test_circuit_metadata() public view {
        assertEq(circuit.name(), "Tosh Circuit");
        assertEq(circuit.symbol(), "CIRCUIT");
        assertEq(circuit.factory(), address(factory));
    }

    function test_circuit_mintIsFactoryOnly() public {
        vm.prank(admin);
        vm.expectRevert(CircuitNFT.OnlyFactory.selector);
        circuit.mint(admin);
    }

    function test_circuit_idsAreSequentialFromOne() public {
        assertEq(tokenId, 1);
        (, uint256 second) = _launch("Second", "SCND", stranger);
        assertEq(second, 2);
        assertEq(circuit.totalMinted(), 2);
        assertEq(circuit.ownerOf(2), stranger);
    }

    function test_circuit_transfersMoveOwnership() public {
        vm.prank(developer);
        circuit.transferFrom(developer, buyer, tokenId);
        vm.prank(buyer);
        circuit.safeTransferFrom(buyer, stranger, tokenId);
        assertEq(circuit.ownerOf(tokenId), stranger);
    }

    function test_circuit_vaultOfMatchesTheDeployedVault() public view {
        assertEq(circuit.vaultOf(tokenId), address(vault));
        assertEq(circuit.vaultImplementation(), factory.vaultImplementation());
    }

    function test_circuit_hasNoBurn() public {
        vm.prank(developer);
        (bool ok,) = address(circuit).call(abi.encodeWithSignature("burn(uint256)", tokenId));
        assertFalse(ok, "no burn entry point");
        assertEq(circuit.ownerOf(tokenId), developer);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Vault wiring
    // ══════════════════════════════════════════════════════════════════════════

    function test_vault_isACloneCarryingItsTokenId() public view {
        assertEq(vault.tokenId(), tokenId);
        assertEq(address(vault).code.length, 77, "45-byte EIP-1167 proxy + 32-byte tokenId");
        assertEq(address(vault), factory.predictVaultAddress(tokenId));
        assertEq(
            address(vault), ToshCloneLib.predictVaultClone(address(factory), factory.vaultImplementation(), tokenId)
        );
    }

    function test_vault_implementationIsWired() public view {
        CircuitRevenueVault impl = CircuitRevenueVault(factory.vaultImplementation());
        assertEq(address(impl.circuit()), address(circuit));
        assertEq(address(impl.quoteAsset()), address(quote));
        assertEq(address(vault.circuit()), address(circuit), "clones read the implementation's immutables");
    }

    function test_vault_holderTracksTheNFT() public {
        assertEq(vault.holder(), developer);
        vm.prank(developer);
        circuit.transferFrom(developer, buyer, tokenId);
        assertEq(vault.holder(), buyer);
    }

    function test_vault_implementationIsInert() public {
        CircuitRevenueVault impl = CircuitRevenueVault(factory.vaultImplementation());
        vm.prank(developer);
        vm.expectRevert(CircuitRevenueVault.NotAClone.selector);
        impl.withdraw(address(quote), payout, 1);

        vm.prank(address(circuit));
        vm.expectRevert(CircuitRevenueVault.NotAClone.selector);
        impl.settle(payout);
    }

    function test_vault_refusesNativeCoin() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_vault_hasNoGenericExecute() public {
        vm.prank(developer);
        (bool ok,) =
            address(vault).call(abi.encodeWithSignature("execute(address,uint256,bytes)", address(quote), 0, ""));
        assertFalse(ok);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Withdrawing
    // ══════════════════════════════════════════════════════════════════════════

    function test_vault_holderWithdrawsImmediately() public {
        vm.expectEmit(true, true, false, true, address(vault));
        emit Withdrawn(address(quote), payout, 100e8);
        vm.prank(developer);
        uint256 paid = vault.withdraw(address(quote), payout, 100e8);

        assertEq(paid, 100e8);
        assertEq(quote.balanceOf(payout), 100e8);
        assertEq(quote.balanceOf(address(vault)), REVENUE - 100e8);
    }

    function test_vault_withdrawPaysTheLesserOfAmountAndBalance() public {
        vm.prank(developer);
        uint256 paid = vault.withdraw(address(quote), payout, type(uint256).max);
        assertEq(paid, REVENUE);
        assertEq(quote.balanceOf(address(vault)), 0);
    }

    function test_vault_withdrawFromEmptyVaultPaysNothing() public {
        vm.prank(developer);
        vault.withdraw(address(quote), payout, type(uint256).max);
        vm.prank(developer);
        assertEq(vault.withdraw(address(quote), payout, 1), 0);
    }

    function test_vault_withdrawsOtherTokensToo() public {
        MockQuoteAsset other = new MockQuoteAsset();
        other.mint(address(vault), 7e8);
        vm.prank(developer);
        vault.withdraw(address(other), payout, 7e8);
        assertEq(other.balanceOf(payout), 7e8);
    }

    function test_vault_withdrawIsHolderOnly() public {
        vm.prank(stranger);
        vm.expectRevert(CircuitRevenueVault.NotCircuitHolder.selector);
        vault.withdraw(address(quote), stranger, 1);
    }

    /// @dev The platform owner has no special access either.
    function test_vault_ownerHasNoAccess() public {
        vm.prank(admin);
        vm.expectRevert(CircuitRevenueVault.NotCircuitHolder.selector);
        vault.withdraw(address(quote), admin, REVENUE);
    }

    function test_vault_withdrawRejectsZeroToken() public {
        vm.prank(developer);
        vm.expectRevert(CircuitRevenueVault.ZeroAddress.selector);
        vault.withdraw(address(0), payout, 1);
    }

    function test_vault_withdrawRejectsZeroRecipient() public {
        vm.prank(developer);
        vm.expectRevert(CircuitRevenueVault.ZeroAddress.selector);
        vault.withdraw(address(quote), address(0), 1);
    }

    function test_vault_withdrawRejectsZeroAmount() public {
        vm.prank(developer);
        vm.expectRevert(CircuitRevenueVault.ZeroAmount.selector);
        vault.withdraw(address(quote), payout, 0);
    }

    function test_vault_settleIsCircuitOnly() public {
        vm.prank(developer);
        vm.expectRevert(CircuitRevenueVault.OnlyCircuit.selector);
        vault.settle(developer);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Selling the Circuit
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice A transfer pays the seller everything earned so far, in the same
    ///         transaction; the buyer starts from an empty vault.
    function test_transfer_settlesTheBalanceToTheSeller() public {
        vm.expectEmit(true, false, false, true, address(vault));
        emit Settled(developer, REVENUE);
        vm.prank(developer);
        circuit.transferFrom(developer, buyer, tokenId);

        assertEq(quote.balanceOf(developer), REVENUE, "seller is paid on transfer");
        assertEq(quote.balanceOf(address(vault)), 0, "buyer inherits an empty vault");
        assertEq(vault.holder(), buyer);
    }

    /// @dev Marketplaces move the NFT with an approved operator, not the owner.
    ///      The seller is still the one paid.
    function test_transfer_byApprovedOperatorStillPaysTheSeller() public {
        vm.prank(developer);
        circuit.setApprovalForAll(stranger, true);
        vm.prank(stranger);
        circuit.safeTransferFrom(developer, buyer, tokenId);

        assertEq(quote.balanceOf(developer), REVENUE);
        assertEq(quote.balanceOf(stranger), 0, "the operator is not paid");
    }

    function test_transfer_revenueAfterTheSaleBelongsToTheBuyer() public {
        vm.prank(developer);
        circuit.transferFrom(developer, buyer, tokenId);
        quote.mint(address(vault), 30e8);

        vm.prank(developer);
        vm.expectRevert(CircuitRevenueVault.NotCircuitHolder.selector);
        vault.withdraw(address(quote), developer, 30e8);

        vm.prank(buyer);
        vault.withdraw(address(quote), buyer, 30e8);
        assertEq(quote.balanceOf(buyer), 30e8);
    }

    function test_transfer_withAnEmptyVaultSucceeds() public {
        vm.prank(developer);
        vault.withdraw(address(quote), developer, type(uint256).max);
        vm.prank(developer);
        circuit.transferFrom(developer, buyer, tokenId);
        assertEq(circuit.ownerOf(tokenId), buyer);
    }

    /// @dev Only the quote asset is settled; anything else travels with the NFT.
    function test_transfer_leavesOtherTokensInTheVault() public {
        MockQuoteAsset other = new MockQuoteAsset();
        other.mint(address(vault), 7e8);
        vm.prank(developer);
        circuit.transferFrom(developer, buyer, tokenId);
        assertEq(other.balanceOf(address(vault)), 7e8);
        assertEq(other.balanceOf(developer), 0);
    }

    /// @dev A failing payout to the seller blocks the sale rather than
    ///      silently handing their balance to the buyer.
    function test_transfer_revertsIfTheSellerCannotBePaid() public {
        vm.mockCallRevert(
            address(quote), abi.encodeWithSignature("transfer(address,uint256)", developer, REVENUE), "blocked"
        );
        vm.prank(developer);
        vm.expectRevert();
        circuit.transferFrom(developer, buyer, tokenId);
        assertEq(circuit.ownerOf(tokenId), developer);
    }

    /// @dev Vaults are per Circuit: one holder cannot reach another's balance,
    ///      and selling one Circuit settles only its own vault.
    function test_vault_isolatedPerCircuit() public {
        (ToshLaunchpadHook other,) = _launch("Other", "OTHR", stranger);
        CircuitRevenueVault otherVault = CircuitRevenueVault(other.projectAdmin());
        quote.mint(address(otherVault), 5e8);

        vm.prank(developer);
        vm.expectRevert(CircuitRevenueVault.NotCircuitHolder.selector);
        otherVault.withdraw(address(quote), developer, 5e8);

        vm.prank(developer);
        circuit.transferFrom(developer, buyer, tokenId);
        assertEq(quote.balanceOf(address(otherVault)), 5e8);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Fuzz
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Across revenue and two sales, each holder is paid exactly what
    ///      arrived while they held the Circuit.
    function testFuzz_transfer_eachHolderKeepsWhatArrivedOnTheirWatch(uint96 a, uint96 b, uint96 c) public {
        vm.prank(developer);
        vault.withdraw(address(quote), developer, type(uint256).max);
        uint256 devStart = quote.balanceOf(developer);

        quote.mint(address(vault), a);
        vm.prank(developer);
        circuit.transferFrom(developer, buyer, tokenId);

        quote.mint(address(vault), b);
        vm.prank(buyer);
        circuit.transferFrom(buyer, stranger, tokenId);

        quote.mint(address(vault), c);

        assertEq(quote.balanceOf(developer) - devStart, a);
        assertEq(quote.balanceOf(buyer), b);
        assertEq(quote.balanceOf(address(vault)), c, "the current holder's share is still in the vault");
    }
}
