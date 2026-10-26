// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {GenesisCurve} from "./libraries/GenesisCurve.sol";
import {AgentIdLib} from "./libraries/AgentIdLib.sol";

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
    function BONDING_MAX() external view returns (uint256);
}

/// @title  ToshHookLens — stateless read helpers for ToshX hooks
/// @notice Everything here is derivable from the hook's own getters; it lives
///         outside the hook only because the hook sits at the EIP-170 limit.
///         Nothing on-chain depends on this contract.
contract ToshHookLens {
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
        return GenesisCurve.tokensFor(h.hardCap(), h.genesisSold(), pay);
    }

    /// @notice P = hardCap / 7M, the curve's first price.
    function basePrice(address hook) public view returns (uint256) {
        return GenesisCurve.priceAt(IToshHookView(hook).hardCap(), 0);
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
        s.basePrice = GenesisCurve.priceAt(s.hardCap, 0);
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

        uint256 size = h.TIER_SIZE();
        uint256 idxNow = h.currentTierIndex();
        uint256 soldNow = h.currentTierSold();

        ladder = new Tier[](end - start);
        for (uint256 i; i < ladder.length; ++i) {
            uint256 idx = start + i;
            uint256 sold = idx < idxNow ? size : (idx == idxNow ? soldNow : 0);
            ladder[i] = Tier({price: h.tierPriceAt(idx), totalAmount: size, soldAmount: sold});
        }
    }

    /// @notice Shelf tokens still unissued across the whole ladder.
    function bondingRemaining(address hook) external view returns (uint256) {
        IToshHookView h = IToshHookView(hook);
        uint256 minted = h.phase2Minted();
        uint256 max = h.BONDING_MAX();
        return minted >= max ? 0 : max - minted;
    }
}
