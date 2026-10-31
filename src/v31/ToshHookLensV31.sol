// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {GenesisCurveV3} from "../v3/libraries/GenesisCurveV3.sol";
import {AgentIdLib} from "../libraries/AgentIdLib.sol";
import {L2CurveV31} from "./libraries/L2CurveV31.sol";

interface IToshHookViewV31 {
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
    function quoteAsset() external view returns (address);
    function projectToken() external view returns (address);
    function projectFund() external view returns (address);
    function fundAccrued() external view returns (uint256);
    function projectController() external view returns (address);
    function ADMIN_LAUNCH_WINDOW() external view returns (uint256);
    function factory() external view returns (address);
    function mintVesting() external view returns (address);
    function p0() external view returns (uint256);
    function l2Supply() external view returns (uint256);
    function l2Price() external view returns (uint256);
    function l2Quota() external view returns (uint256);
    function l2State() external view returns (uint256 minted, uint256 lastMintAt, uint256 lastPrice);
    function l2Remaining() external view returns (uint256);
}

interface IToshFactoryViewV31 {
    function shelfRemaining(address hook, address account) external view returns (uint256);
    function ladderMintingHalted(address hook) external view returns (bool);
}

interface IToshMintVestingViewV31 {
    function lockOf(address hook, address account)
        external
        view
        returns (uint256 total, uint256 claimed, uint256 start, uint256 claimable);
}

/// @title  ToshHookLensV31 — stateless read helpers for v3.1 hooks
/// @notice Everything here is derivable from the hook's own getters; it lives
///         outside the hook only because the hook sits at the EIP-170 limit.
///         Nothing on-chain depends on this contract.
contract ToshHookLensV31 {
    struct GenesisState {
        address quoteAsset;
        address token;
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

    struct L2State {
        bool launched;
        bool halted;
        uint256 p0;
        uint256 price;
        uint256 lastPrice;
        uint256 lastMintAt;
        uint256 minted;
        /// @dev Idle-burned, including a burn that is due but unsettled.
        uint256 burned;
        /// @dev `supply − minted − burned`, what a mint can still take.
        uint256 remaining;
        uint256 supply;
        uint256 quota;
    }

    struct L2Account {
        /// @dev Most `account` may pay right now: 0 once it has minted or
        ///      without an Agent ID, else min(factory cap, hook quota).
        uint256 mintable;
        uint256 lockedTotal;
        uint256 claimed;
        uint256 lockStart;
        uint256 claimable;
    }

    /// @notice Tokens and cost `pay` buys at the current point of the genesis
    ///         curve, ignoring any individual allowance.
    function quoteGenesis(address hook, uint256 pay) external view returns (uint256 tokens, uint256 cost) {
        IToshHookViewV31 h = IToshHookViewV31(hook);
        return GenesisCurveV3.tokensFor(h.hardCap(), h.genesisSold(), pay);
    }

    /// @notice P = hardCap / 225M, the genesis curve's first price.
    function basePrice(address hook) public view returns (uint256) {
        return GenesisCurveV3.priceAt(IToshHookViewV31(hook).hardCap(), 0);
    }

    function publicLaunchAt(address hook) public view returns (uint256) {
        IToshHookViewV31 h = IToshHookViewV31(hook);
        return h.launchStart() + h.ADMIN_LAUNCH_WINDOW();
    }

    function genesisState(address hook) external view returns (GenesisState memory s) {
        IToshHookViewV31 h = IToshHookViewV31(hook);
        s.quoteAsset = h.quoteAsset();
        s.token = h.projectToken();
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

    /// @notice `account`'s genesis Agent ID standing on `hook`. `registryOk`
    ///         is false when the registry could not be read.
    function accountState(address hook, address account) external view returns (AccountState memory a) {
        IToshHookViewV31 h = IToshHookViewV31(hook);
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

    /// @notice The key an account's allowances are booked under, or zero.
    function agentKeyOf(address registry, address account) external view returns (bytes32) {
        return AgentIdLib.agentKeyOf(registry, account);
    }

    /// @notice What `mintL2(pay, 0)` would lock and charge if it landed now.
    ///         Zeroes before launch, for `pay == 0` and once nothing is left
    ///         to mint, sold or burned.
    function quoteL2(address hook, uint256 pay)
        external
        view
        returns (uint256 tokens, uint256 cost, uint256 priceAfter)
    {
        IToshHookViewV31 h = IToshHookViewV31(hook);
        if (!h.launched() || pay == 0) return (0, 0, 0);
        uint256 left = h.l2Remaining();
        if (left == 0) return (0, 0, 0);
        uint256 supply = h.l2Supply();
        return L2CurveV31.quote(h.l2Price(), supply - left, supply, pay);
    }

    function l2State(address hook) external view returns (L2State memory s) {
        IToshHookViewV31 h = IToshHookViewV31(hook);
        s.launched = h.launched();
        s.halted = IToshFactoryViewV31(h.factory()).ladderMintingHalted(hook);
        s.quota = h.l2Quota();
        if (!s.launched) return s;
        s.p0 = h.p0();
        s.price = h.l2Price();
        (s.minted, s.lastMintAt, s.lastPrice) = h.l2State();
        s.supply = h.l2Supply();
        s.remaining = h.l2Remaining();
        s.burned = s.supply - s.minted - s.remaining;
    }

    function l2Account(address hook, address account) external view returns (L2Account memory a) {
        IToshHookViewV31 h = IToshHookViewV31(hook);
        uint256 cap = IToshFactoryViewV31(h.factory()).shelfRemaining(hook, account);
        uint256 quota = h.l2Quota();
        a.mintable = cap < quota ? cap : quota;
        (a.lockedTotal, a.claimed, a.lockStart, a.claimable) =
            IToshMintVestingViewV31(h.mintVesting()).lockOf(hook, account);
    }
}
