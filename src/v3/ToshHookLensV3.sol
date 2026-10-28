// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Math} from "../../lib/openzeppelin-contracts/contracts/utils/math/Math.sol";
import {GenesisCurveV3} from "./libraries/GenesisCurveV3.sol";
import {AgentIdLib} from "../libraries/AgentIdLib.sol";

interface IToshHookView {
    function hardCap() external view returns (uint256);
    function perAgentCap() external view returns (uint256);
    function genesisSold() external view returns (uint256);
    function raised() external view returns (uint256);
    function soldOutAt() external view returns (uint256);
    function genesisDeadline() external view returns (uint256);
    function launched() external view returns (bool);
    function launchStart() external view returns (uint256);
    function currentGenesisPrice() external view returns (uint256);
    function agentRegistry() external view returns (address);
    function agentSpent(bytes32 key) external view returns (uint256);
    function walletSpent(address account) external view returns (uint256);
    function minBuy() external view returns (uint256);
    function acceptsNative() external view returns (bool);
    function quoteAsset() external view returns (address);
    function projectToken() external view returns (address);
    function projectFund() external view returns (address);
    function fundAccrued() external view returns (uint256);
    function projectController() external view returns (address);
    function currentTierIndex() external view returns (uint256);
    function currentTierSold() external view returns (uint256);
    function phase2Minted() external view returns (uint256);
    function tierPriceAt(uint256 index) external view returns (uint256);
    function ADMIN_LAUNCH_WINDOW() external view returns (uint256);
    function TIER_COUNT() external view returns (uint256);
    function TIER_SIZE() external view returns (uint256);
    function tierSize() external view returns (uint256);
    function MAX_TIERS_PER_TX() external view returns (uint256);
    function tierStatus()
        external
        view
        returns (
            uint256 tierIndex,
            uint256 tierPrice,
            uint256 remaining,
            uint256 spotPrice,
            uint256 twapPrice,
            uint256 ceiling,
            bool unlocked
        );
}

/// @title  ToshHookLensV3 — stateless read helpers for ToshX hooks
/// @notice Everything here is derivable from the hook's own getters; it lives
///         outside the hook only because the hook sits at the EIP-170 limit.
///         Nothing on-chain depends on this contract.
contract ToshHookLensV3 {
    // Same names and arguments as the hook's, so they share selectors.
    error NotLaunched();
    error LadderExhausted();
    error ExceedsTierRemaining();
    error SpanTooManyShelves();
    error TierPriceAboveCeiling();
    error ZeroAmount();

    struct Tier {
        uint256 price;
        uint256 totalAmount;
        uint256 soldAmount;
    }

    struct GenesisState {
        address quoteAsset;
        address token;
        bool acceptsNative;
        uint256 minBuy;
        uint256 hardCap;
        uint256 perAgentCap;
        uint256 basePrice;
        uint256 currentPrice;
        uint256 sold;
        uint256 raised;
        uint256 genesisDeadline;
        uint256 soldOutAt;
        uint256 launchStart;
        uint256 publicLaunchAt;
        bool launched;
        address projectController;
        address projectFund;
        uint256 fundAvailable;
    }

    struct AccountState {
        bool registryOk;
        bytes32 agentKey;
        uint256 spent;
        uint256 remaining;
    }

    /// @notice Tokens and cost `pay` buys at the current point of the curve,
    ///         ignoring any individual allowance.
    function quoteGenesis(address hook, uint256 pay) external view returns (uint256 tokens, uint256 cost) {
        IToshHookView h = IToshHookView(hook);
        return GenesisCurveV3.tokensFor(h.hardCap(), h.genesisSold(), pay);
    }

    /// @notice P = hardCap / 2.25M, the curve's first price.
    function basePrice(address hook) public view returns (uint256) {
        return GenesisCurveV3.priceAt(IToshHookView(hook).hardCap(), 0);
    }

    function publicLaunchAt(address hook) public view returns (uint256) {
        IToshHookView h = IToshHookView(hook);
        return h.launchStart() + h.ADMIN_LAUNCH_WINDOW();
    }

    function genesisState(address hook) external view returns (GenesisState memory s) {
        IToshHookView h = IToshHookView(hook);
        s.quoteAsset = h.quoteAsset();
        s.token = h.projectToken();
        s.acceptsNative = h.acceptsNative();
        s.minBuy = h.minBuy();
        s.hardCap = h.hardCap();
        s.perAgentCap = h.perAgentCap();
        s.basePrice = GenesisCurveV3.priceAt(s.hardCap, 0);
        s.currentPrice = h.currentGenesisPrice();
        s.sold = h.genesisSold();
        s.raised = h.raised();
        s.genesisDeadline = h.genesisDeadline();
        s.soldOutAt = h.soldOutAt();
        s.launchStart = h.launchStart();
        s.publicLaunchAt = s.launchStart + h.ADMIN_LAUNCH_WINDOW();
        s.launched = h.launched();
        try h.projectController() returns (address c) {
            s.projectController = c;
        } catch {}
        s.projectFund = h.projectFund();
        s.fundAvailable = h.fundAccrued();
    }

    /// @notice `account`'s Agent ID standing on `hook`. `registryOk` is false
    ///         when the registry could not be read; the other fields are then 0.
    function accountState(address hook, address account) external view returns (AccountState memory a) {
        IToshHookView h = IToshHookView(hook);
        try this.agentKeyOf(h.agentRegistry(), account) returns (bytes32 key) {
            a.registryOk = true;
            a.agentKey = key;
        } catch {
            return a;
        }
        if (a.agentKey == bytes32(0)) return a;
        a.spent = h.agentSpent(a.agentKey);
        uint256 byWallet = h.walletSpent(account);
        if (byWallet > a.spent) a.spent = byWallet;
        uint256 cap = h.perAgentCap();
        a.remaining = a.spent >= cap ? 0 : cap - a.spent;
    }

    /// @notice The key an account's genesis allowance is booked under, or zero.
    ///         Reverts `AgentRegistryUnavailable` if the registry misbehaves.
    function agentKeyOf(address registry, address account) external view returns (bytes32) {
        return AgentIdLib.agentKeyOf(registry, account);
    }

    /// @notice A window of the shelf ladder.
    function getTiers(address hook, uint256 start, uint256 count) external view returns (Tier[] memory ladder) {
        IToshHookView h = IToshHookView(hook);
        uint256 tierCount = h.TIER_COUNT();
        if (start >= tierCount) return new Tier[](0);
        uint256 end = start + count;
        if (end > tierCount) end = tierCount;

        uint256 size = shelfSize(hook);
        uint256 idxNow = h.currentTierIndex();
        uint256 soldNow = h.currentTierSold();

        ladder = new Tier[](end - start);
        for (uint256 i; i < ladder.length; ++i) {
            uint256 idx = start + i;
            uint256 sold = idx < idxNow ? size : (idx == idxNow ? soldNow : 0);
            ladder[i] = Tier({price: h.tierPriceAt(idx), totalAmount: size, soldAmount: sold});
        }
    }

    /// @notice Tokens per shelf: the hook's own figure once launched, and before
    ///         that what launching on the current raise would fix it at.
    function shelfSize(address hook) public view returns (uint256) {
        IToshHookView h = IToshHookView(hook);
        if (h.launched()) return h.tierSize();
        return Math.mulDiv(h.TIER_SIZE(), h.raised(), h.hardCap(), Math.Rounding.Ceil);
    }

    /// @notice Quote cost of `mintBondingCurve(tokenAmount, ·)` on `hook`,
    ///         sweeping as many shelves as the order needs.
    ///
    /// @dev    Moved here from the hook in v3. Reproduces the mint's checks and
    ///         per-leg arithmetic leg for leg against the same ceiling
    ///         (`tierStatus().ceiling`), so a successful quote is a mint the
    ///         hook will accept in the next block at exactly this price.
    ///         Like the hook's own version it ignores the same-block lockout
    ///         and the platform halt; `maxMintable()` folds those in.
    function quoteMint(address hook, uint256 tokenAmount) external view returns (uint256 cost) {
        if (tokenAmount == 0) return 0;
        IToshHookView h = IToshHookView(hook);
        if (!h.launched()) revert NotLaunched();

        uint256 tierCount = h.TIER_COUNT();
        uint256 maxLegs = h.MAX_TIERS_PER_TX();
        (uint256 tierIndex,,,,, uint256 ceiling,) = h.tierStatus();
        if (tierIndex >= tierCount) revert LadderExhausted();

        uint256 size = h.tierSize();
        uint256 sold = h.currentTierSold();
        uint256 filled;
        uint256 legs;

        while (filled < tokenAmount) {
            if (tierIndex >= tierCount) revert ExceedsTierRemaining();
            if (++legs > maxLegs) revert SpanTooManyShelves();

            uint256 tierPrice = h.tierPriceAt(tierIndex);
            if (tierPrice > ceiling) revert TierPriceAboveCeiling();

            uint256 room = size - sold;
            uint256 take = tokenAmount - filled;
            if (take > room) take = room;

            cost += (tierPrice * take) / 1e18;
            filled += take;
            sold += take;

            if (sold == size) {
                sold = 0;
                unchecked {
                    ++tierIndex;
                }
            }
        }

        if (cost == 0) revert ZeroAmount();
    }

    /// @notice Shelf tokens still unissued across the whole ladder.
    function bondingRemaining(address hook) external view returns (uint256) {
        IToshHookView h = IToshHookView(hook);
        uint256 minted = h.phase2Minted();
        uint256 max = h.TIER_COUNT() * shelfSize(hook);
        return minted >= max ? 0 : max - minted;
    }
}
