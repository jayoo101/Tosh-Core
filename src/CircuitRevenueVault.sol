// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "../lib/openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ToshCloneLib} from "./libraries/ToshCloneLib.sol";

/// @title  CircuitRevenueVault
/// @notice A project's shelf-revenue account. The hook pays 99 % of every shelf
///         sale here, and whoever holds the matching Circuit NFT may withdraw it
///         at any time.
///
/// ── Why there is no withdrawal delay ────────────────────────────────────────
///
///   When the Circuit changes hands, `CircuitNFT` calls `settle` first, which
///   pays the quote-asset balance to the seller. A sale never carries an
///   accumulated balance, so a seller has nothing to withdraw ahead of the
///   buyer and a delay would protect nothing.
///
/// ── What this contract cannot do ────────────────────────────────────────────
///
///   There is no generic `execute`. The vault can only receive ERC-20s and pay
///   them out, so a holder cannot use it to call the hook or anything else.
///   That matters because the hook's payee is fixed to this address: an account
///   that could make arbitrary calls would be a way to act as the payee rather
///   than merely to be paid.
///
///   It has no `receive`, so native coin sent here reverts rather than being
///   stranded.
///
/// @dev    Deployed as a `ToshCloneLib` vault clone with the tokenId in its
///         bytecode. The implementation is deployed by `CircuitNFT`, which is
///         therefore `circuit`. The bare implementation refuses to run, because
///         the tokenId reader returns garbage there.
contract CircuitRevenueVault {
    using SafeERC20 for IERC20;

    IERC721 public immutable circuit;

    /// @notice The asset `settle` pays out on a transfer: the platform's quote
    ///         asset, which is what shelf revenue arrives in.
    IERC20 public immutable quoteAsset;

    address private immutable _self;

    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event Settled(address indexed to, uint256 amount);

    error NotAClone();
    error NotCircuitHolder();
    error OnlyCircuit();
    error ZeroAddress();
    error ZeroAmount();

    constructor(address quoteAsset_) {
        require(quoteAsset_ != address(0), "zero quoteAsset");
        circuit = IERC721(msg.sender);
        quoteAsset = IERC20(quoteAsset_);
        _self = address(this);
    }

    modifier onlyClone() {
        if (address(this) == _self) revert NotAClone();
        _;
    }

    /// @notice The Circuit token that controls this vault.
    function tokenId() public view returns (uint256) {
        return ToshCloneLib.argVaultTokenId();
    }

    /// @notice Current holder of the controlling Circuit, i.e. who may withdraw.
    function holder() public view returns (address) {
        return circuit.ownerOf(tokenId());
    }

    /// @notice Pay up to `amount` of `token` to `to`. Pays the lesser of
    ///         `amount` and the balance, so `type(uint256).max` withdraws all.
    function withdraw(address token, address to, uint256 amount) external onlyClone returns (uint256 paid) {
        if (msg.sender != holder()) revert NotCircuitHolder();
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 balance = IERC20(token).balanceOf(address(this));
        paid = amount < balance ? amount : balance;
        if (paid > 0) IERC20(token).safeTransfer(to, paid);
        emit Withdrawn(token, to, paid);
    }

    /// @notice Pay the whole quote-asset balance to `to`, the outgoing holder.
    ///         Called by `CircuitNFT` on every transfer, before the new owner
    ///         takes over.
    function settle(address to) external onlyClone {
        if (msg.sender != address(circuit)) revert OnlyCircuit();
        uint256 balance = quoteAsset.balanceOf(address(this));
        if (balance == 0) return;
        quoteAsset.safeTransfer(to, balance);
        emit Settled(to, balance);
    }
}
