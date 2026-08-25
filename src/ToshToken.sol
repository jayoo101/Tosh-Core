// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "../lib/openzeppelin-contracts/contracts/access/AccessControl.sol";

/// @title  ToshToken
/// @notice ERC-20 minted on demand by exactly one address: its launch hook.
///
/// ── Roles ───────────────────────────────────────────────────────────────────
///
///   The factory deploys the token with NO roles granted, then calls
///   `initialize(hook)` once to give `MINTER_ROLE` to the hook.
///
///   `DEFAULT_ADMIN_ROLE` is never granted to anyone, which is the load-bearing
///   part: `grantRole` and `revokeRole` are both admin-gated, so with the admin
///   slot permanently vacant the minter set is frozen at exactly one address
///   for the life of the token.  Not even the factory can add a second minter.
///
///   There is no proxy, no `migrateMinter`, and the hook exposes no path that
///   forwards `MINTER_ROLE`.  That is the Immutable Pact: a logic bug in a
///   deployed hook cannot be patched by pointing the token at a v5.1 hook, and
///   unsold ladder supply can never be reminted elsewhere.  The cost is real
///   and is accepted so that neither the creator nor the platform can inflate
///   supply after launch.
///
/// ── Supply ──────────────────────────────────────────────────────────────────
///
///   Genesis  8,400,000  minted in one call when the hook runs `launch()`
///   Ladder  12,600,000  minted per purchase across 4000 shelves of 3,150
///   ─────────────────────────────────────────────────────────────────────
///   Total   21,000,000  = MAX_SUPPLY, enforced on every `mint`
///
///   The ladder is discrete and finite, so the cap is exactly reachable: a
///   fully sold ladder lands on MAX_SUPPLY rather than approaching it.  The
///   check in `mint` is the backstop, not the mechanism.
///
/// ── Why not pre-mint the whole supply? ──────────────────────────────────────
///
///   21M sitting in one contract reads as a single address holding 100 % of
///   supply in every block explorer, which is indistinguishable from a rug
///   setup at a glance.  Minting on demand keeps the visible supply equal to
///   the supply people actually paid for.
///
contract ToshToken is ERC20, AccessControl {
    // ─── Roles ────────────────────────────────────────────────────────────────

    /// @notice Role that permits calling mint(). Granted exclusively to the Hook.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    // ─── Supply constants ─────────────────────────────────────────────────────

    /// @notice Absolute hard cap enforced at mint-time.
    ///         Phase 1 (8.4M genesis) + Phase 2 (12.6M bonding) = 21M.
    uint256 public constant MAX_SUPPLY = 21_000_000e18;

    // ─── Immutables ───────────────────────────────────────────────────────────

    /// @dev Factory that deployed this token.
    address public immutable factory;

    // ─── Single-write state ───────────────────────────────────────────────────

    /// @notice Hook that was granted MINTER_ROLE. Set once by initialize().
    address public hook;

    // ─── Errors ───────────────────────────────────────────────────────────────

    error OnlyFactory();
    error AlreadyInitialized();
    error MaxSupplyExceeded();

    // ─── Constructor ──────────────────────────────────────────────────────────

    /// @dev AccessControl constructor is called implicitly.
    ///      No DEFAULT_ADMIN_ROLE is granted here — intentional design.
    constructor(string memory name_, string memory symbol_, address factory_) ERC20(name_, symbol_) {
        require(factory_ != address(0), "zero factory");
        factory = factory_;
        // AccessControl is initialized with NO roles granted to anyone.
        // This prevents any party (factory, deployer) from later granting roles.
    }

    // ─── Factory initialisation ───────────────────────────────────────────────

    /// @notice Bind this token to its Hook and grant MINTER_ROLE exclusively.
    ///
    ///         Called exactly once by ToshFactory immediately after deploying the Hook.
    ///         Post-call invariants:
    ///           • hook_ has MINTER_ROLE (can call mint).
    ///           • No DEFAULT_ADMIN_ROLE exists anywhere → no one can grant new roles.
    ///
    /// @param hook_  The ToshLaunchpadHook that will be the sole minter.
    function initialize(address hook_) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (hook != address(0)) revert AlreadyInitialized();
        require(hook_ != address(0), "zero hook");

        hook = hook_;
        _grantRole(MINTER_ROLE, hook_);

        // DEFAULT_ADMIN_ROLE is left vacant — no party can ever call grantRole
        // or revokeRole on MINTER_ROLE.  Only renounceRole (self-revocation) works.
    }

    // ─── Minting (Hook-exclusive) ─────────────────────────────────────────────

    /// @notice Mint `amount` tokens to `to`.
    ///         Reverts if totalSupply() + amount would exceed MAX_SUPPLY.
    ///         Only callable by the address holding MINTER_ROLE (the Hook).
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (totalSupply() + amount > MAX_SUPPLY) revert MaxSupplyExceeded();
        _mint(to, amount);
    }

    // NOTE: there is deliberately no kill-switch here.  A `renounceMinterRole`
    // once existed and was documented as an emergency escape hatch, but only
    // MINTER_ROLE could call it, MINTER_ROLE belongs solely to the hook, and
    // the hook has no code path that calls it — so on a deployed system nobody
    // could ever reach it.  Its tests passed only because they forged the hook
    // as caller.  Rather than leave a safety control that does not exist, it
    // was removed.  Supply is bounded by MAX_SUPPLY in `mint`, which needs no
    // one to intervene.
}
