// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "../lib/openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {CircuitRevenueVault} from "./CircuitRevenueVault.sol";
import {ToshCloneLib} from "./libraries/ToshCloneLib.sol";

/// @title  CircuitNFT
/// @notice One token per launch, held by the project's developer. Holding it is
///         what controls that project's `CircuitRevenueVault`, which receives
///         99 % of every shelf sale. It carries no power over the project's
///         token, pool or hook.
///
/// ── Selling a Circuit sells future revenue only ─────────────────────────────
///
///   Every transfer first sweeps the project's genesis pool fees into the vault
///   (skipped before launch, when there are none; after launch a sweep that
///   reverts reverts the transfer), then
///   pays the vault's quote-asset balance to the sender, then pays the hook's
///   accrued 20 % genesis fund to the address it currently names and points
///   the fund at the buyer. Revenue earned up to the transfer belongs to the
///   seller and arrives in the same transaction; the buyer starts from an
///   empty vault and a fund address they control. A buyer therefore has
///   nothing to check before buying, and the vault needs no withdrawal delay:
///   there is no accumulated balance for a seller to pull out from under a
///   pending sale.
///
///   Only the quote asset is settled. Anything else sent to a vault stays there
///   and moves with the NFT; the holder can withdraw it at any time.
///
///   If the quote asset refuses to pay the sender (a token-level blacklist, for
///   instance), the transfer reverts. The NFT is then stuck with that holder,
///   who can still withdraw.
///
/// @dev    Deployed by `ToshFactory`'s constructor, which is the only minter.
///         This constructor in turn deploys the shared vault implementation, so
///         each token's vault address is derived rather than stored: it is the
///         factory's CREATE2 vault clone for that token id.
///
///         There is no burn path. OpenZeppelin exposes none publicly and this
///         contract adds none, so a revenue right cannot be destroyed along
///         with the vault access it grants.
contract CircuitNFT is ERC721 {
    address public immutable factory;

    /// @notice The implementation every vault clone delegates to.
    address public immutable vaultImplementation;

    /// @notice Number of tokens minted. Token ids run from 1 to this value.
    uint256 public totalMinted;

    error OnlyFactory();
    error FeeSweepFailed();

    constructor(address factory_, address quoteAsset_) ERC721("Tosh Circuit", "CIRCUIT") {
        require(factory_ != address(0), "zero factory");
        factory = factory_;
        vaultImplementation = address(new CircuitRevenueVault(quoteAsset_));
    }

    /// @notice The revenue vault `tokenId` controls. Deployed by the factory in
    ///         the same transaction as the mint.
    function vaultOf(uint256 tokenId) public view returns (address) {
        return ToshCloneLib.predictVaultClone(factory, vaultImplementation, tokenId);
    }

    /// @notice Mint the next Circuit to `to`.
    ///
    /// @dev    `_mint`, not `_safeMint`. The receiver check would call into
    ///         `to` in the middle of `createLaunch`, and `to` is an address the
    ///         platform typed into a form. The factory rejects the zero address;
    ///         a developer who names a contract that cannot move ERC-721s loses
    ///         the ability to trade the right, not to withdraw from the vault.
    function mint(address to) external returns (uint256 tokenId) {
        if (msg.sender != factory) revert OnlyFactory();
        tokenId = ++totalMinted;
        _mint(to, tokenId);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0)) {
            ICircuitHook hook = ICircuitHook(ICircuitFactory(factory).hookOfCircuit(tokenId));
            // Before launch there are no fees and the sweep reverts by design.
            // After it, a failed sweep is not "nothing to collect": a caller
            // holding the Vault's lock makes it fail on purpose, and the fees
            // it left behind would land in the buyer's vault.
            try hook.collectGenesisFees() {}
            catch {
                if (hook.launched()) revert FeeSweepFailed();
            }
            CircuitRevenueVault(vaultOf(tokenId)).settle(from);
            ICircuitFactory(factory).settleProjectFund(tokenId, to);
        }
    }
}

interface ICircuitFactory {
    function hookOfCircuit(uint256 tokenId) external view returns (address);
    function settleProjectFund(uint256 tokenId, address newFund) external;
}

interface ICircuitHook {
    function collectGenesisFees() external;
    function launched() external view returns (bool);
}
