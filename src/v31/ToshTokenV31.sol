// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "../../lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "../../lib/openzeppelin-contracts/contracts/access/AccessControl.sol";
import {WalletLib} from "../libraries/WalletLib.sol";

/// @title  ToshTokenV31
/// @notice ERC-20 minted on demand by exactly one address: its launch hook.
///
///         The v3.1 copy of `ToshTokenV3`, identical but for `MAX_SUPPLY`:
///         a v3.1 launch mints at most 1 billion tokens. `ToshTokenV3` stays
///         as v3 deployed it.
///
/// ── Roles ───────────────────────────────────────────────────────────────────
///
///   The factory deploys the token with NO roles granted, then calls
///   `initialize(hook, name, symbol)` once to give `MINTER_ROLE` to the hook.
///
///   `DEFAULT_ADMIN_ROLE` is never granted to anyone, which is the load-bearing
///   part: `grantRole` and `revokeRole` are both admin-gated, so with the admin
///   slot permanently vacant the minter set is frozen at exactly one address
///   for the life of the token.  Not even the factory can add a second minter.
///
///   There is no `migrateMinter`, and the hook exposes no path that forwards
///   `MINTER_ROLE`.  That is the Immutable Pact: a logic bug in a deployed hook
///   cannot be patched by pointing the token at a v5.1 hook, and unsold ladder
///   supply can never be reminted elsewhere.  The cost is real and is accepted
///   so that neither the creator nor the platform can inflate supply after
///   launch.
///
/// ── v5.1: each token is an EIP-1167 clone ───────────────────────────────────
///
///   The Pact used to be stated as "there is no proxy", and that phrasing is now
///   wrong while the guarantee behind it is unchanged.  Every token is a 45-byte
///   minimal proxy delegating to one shared implementation, which cut 677,400
///   gas of code deposit per launch down to 9,000.
///
///   What matters is which kind of proxy.  This is EIP-1167: the implementation
///   address is baked into the clone's own runtime bytecode.  There is no admin
///   slot, no `upgradeTo`, no storage-slot indirection, and `ToshFactory`
///   holds the implementation as an `immutable` with no setter.  Nobody — not
///   the creator, not the platform owner — can change the logic behind a
///   deployed token.  It buys the byte saving and introduces none of the
///   governance surface people associate with the word "proxy".
///
///   Isolation is likewise untouched: balances, `totalSupply`, the `MINTER_ROLE`
///   grant and the `hook` binding all live in each clone's own storage, so
///   MAX_SUPPLY is enforced per project exactly as before.
///
///   The one thing a clone cannot do is run a constructor, so `name` and
///   `symbol` — being strings, they could never have been packed into bytecode
///   anyway — moved into storage written by `initialize`.  `factory` is
///   platform-global and stays an ordinary immutable on the implementation,
///   which under DELEGATECALL resolves from the implementation's code.
///
/// ── Supply ──────────────────────────────────────────────────────────────────
///
///   Genesis    270,000,000  sold on the curve, plus the opening pool
///   Shelf      730,000,000  × raised / hardCap, minted along the L2 curve
///   ─────────────────────────────────────────────────────────────────────────
///   Total    1,000,000,000  = MAX_SUPPLY, enforced on every `mint`
///
///   A sold-out raise that also sells its whole shelf lands exactly on
///   MAX_SUPPLY. The check in `mint` is the backstop, not the mechanism.
///
/// ── Why not pre-mint the whole supply? ──────────────────────────────────────
///
///   1B sitting in one contract reads as a single address holding 100 % of
///   supply in every block explorer, which is indistinguishable from a rug
///   setup at a glance.  Minting on demand keeps the visible supply equal to
///   the supply people actually paid for.
///
/// ── v2: closed until launch ─────────────────────────────────────────────────
///
///   Genesis buyers receive tokens the moment they pay, but there is no pool
///   until `launch()`, and the point of that is lost if a market can form
///   anyway. Until the hook calls `openTrading()` a transfer must be a wallet
///   moving its own tokens to another wallet, which is exactly:
///
///     from == tx.origin          the signer is moving their own balance, so
///                                no contract or constructor is spending on
///                                anyone's behalf
///     caller is from or BID_BOOK the only spender allowed is the bid book,
///                                which holds its own caller to tx.origin
///     to is a wallet             no code, or only an EIP-7702 designator
///                                (`WalletLib`); excludes deployed contracts
///     to is a registered receiver
///
///   EIP-7702 accounts pass as both sender and receiver. Their delegate code
///   cannot become a pool: tokens leave an account only in a transaction that
///   account signed, so no one else can draw on its balance. What it does
///   allow is settling a private trade atomically, which an escrow contract
///   reading balances can already approximate across two transactions.
///
///   The last line closes what the code check cannot: a CREATE2 address has
///   no code until it is deployed, so it would pass as a wallet, take tokens,
///   and only then become a contract able to sell claims on them. Registering
///   requires sending a transaction from the address itself, and an address
///   nobody holds a key for can never do that. Genesis buyers and bidders are
///   registered automatically by the hook and the bid book, which have
///   already established that they are the transaction's origin.
///
///   Mints (`from == 0`) are exempt: they come only from the hook. After
///   `openTrading()` none of this runs and the token is a plain ERC-20.
///
contract ToshTokenV31 is ERC20, AccessControl {
    // ─── Roles ────────────────────────────────────────────────────────────────

    /// @notice Role that permits calling mint(). Granted exclusively to the Hook.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    // ─── Supply constants ─────────────────────────────────────────────────────

    /// @notice Absolute hard cap enforced at mint-time.
    ///         Genesis (270M) + shelf (730M) = 1B.
    uint256 public constant MAX_SUPPLY = 1_000_000_000e18;

    // ─── Immutables ───────────────────────────────────────────────────────────

    /// @dev Factory that deployed this token.
    address public immutable factory;

    /// @notice The one spender allowed before launch. Platform-wide, so it
    ///         lives on the implementation and every clone resolves the same.
    address public immutable bidBook;

    // ─── Single-write state ───────────────────────────────────────────────────

    /// @notice Hook that was granted MINTER_ROLE. Set once by initialize().
    address public hook;

    /// @notice False until the hook launches the pool; one-way.
    bool public tradingOpen;

    /// @notice Addresses allowed to receive a pre-launch transfer. Append-only.
    mapping(address => bool) public isReceiver;

    /// @dev Written once by `initialize` and surfaced through the `name()` and
    ///      `symbol()` overrides below.  OpenZeppelin keeps its own `_name` and
    ///      `_symbol` private and only ever assigns them in its constructor,
    ///      which a clone does not run — so these shadow them rather than
    ///      reusing them.
    string private _tokenName;
    string private _tokenSymbol;

    // ─── Errors ───────────────────────────────────────────────────────────────

    error OnlyFactory();
    error AlreadyInitialized();
    error MaxSupplyExceeded();
    error OnlyHook();
    error OnlyRegistrar();
    error NotAWallet();
    error TransferRestricted();
    error ReceiverNotRegistered(address to);
    error ApprovalRestricted();

    event TradingOpened();
    event ReceiverRegistered(address indexed account);

    // ─── Constructor ──────────────────────────────────────────────────────────

    /// @dev Runs ONCE PER PLATFORM, for the shared implementation; every project
    ///      token is a clone of it and runs no constructor at all.
    ///
    ///      The empty strings handed to `ERC20` are the implementation's own
    ///      unused metadata — see `name()`.
    ///
    ///      AccessControl is initialised with NO roles granted to anyone, which
    ///      is what stops any party (factory, deployer) from later granting them.
    constructor(address factory_, address bidBook_) ERC20("", "") {
        require(factory_ != address(0), "zero factory");
        require(bidBook_ != address(0), "zero bidBook");
        factory = factory_;
        bidBook = bidBook_;
    }

    // ─── Factory initialisation ───────────────────────────────────────────────

    /// @notice Name and symbol this token reports.
    ///
    /// @dev    Overridden to read the storage `initialize` wrote, because clones
    ///         run no constructor and OpenZeppelin's `_name` / `_symbol` are only
    ///         ever assigned in one.  Behaviour is identical to a constructor-set
    ///         ERC-20 from the first moment any external caller can observe it:
    ///         `createLaunch` deploys and initialises in the same transaction, so
    ///         the empty window is not reachable.
    function name() public view override returns (string memory) {
        return _tokenName;
    }

    function symbol() public view override returns (string memory) {
        return _tokenSymbol;
    }

    /// @notice Set this token's metadata, bind it to its Hook, and grant
    ///         MINTER_ROLE exclusively.
    ///
    ///         Called exactly once by ToshFactory immediately after deploying the Hook.
    ///         Post-call invariants:
    ///           • hook_ has MINTER_ROLE (can call mint).
    ///           • No DEFAULT_ADMIN_ROLE exists anywhere → no one can grant new roles.
    ///           • name() / symbol() are frozen: this is their only writer.
    ///
    /// @param hook_    The ToshLaunchpadHook that will be the sole minter.
    /// @param name_    ERC-20 name.
    /// @param symbol_  ERC-20 symbol.
    function initialize(address hook_, string calldata name_, string calldata symbol_) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (hook != address(0)) revert AlreadyInitialized();
        require(hook_ != address(0), "zero hook");
        require(bytes(name_).length != 0 && bytes(symbol_).length != 0, "empty metadata");

        hook = hook_;
        _tokenName = name_;
        _tokenSymbol = symbol_;
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

    // ─── Pre-launch gate ──────────────────────────────────────────────────────

    /// @notice Lift every transfer restriction, permanently. Hook-only, and the
    ///         hook calls it from `launch()` before it mints the pool's side.
    function openTrading() external {
        if (msg.sender != hook) revert OnlyHook();
        if (tradingOpen) return;
        tradingOpen = true;
        emit TradingOpened();
    }

    /// @notice Make the calling wallet eligible to receive pre-launch transfers.
    function registerReceiver() external {
        if (msg.sender != tx.origin) revert NotAWallet();
        _register(msg.sender);
    }

    /// @notice Register a wallet the hook or bid book has already verified is
    ///         the origin of the current transaction.
    function registerFor(address account) external {
        if (msg.sender != hook && msg.sender != bidBook) revert OnlyRegistrar();
        _register(account);
    }

    function _register(address account) private {
        if (isReceiver[account]) return;
        isReceiver[account] = true;
        emit ReceiverRegistered(account);
    }

    function approve(address spender, uint256 value) public override returns (bool) {
        if (!tradingOpen && spender != bidBook) revert ApprovalRestricted();
        return super.approve(spender, value);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (!tradingOpen && from != address(0)) {
            address caller = _msgSender();
            if (from != tx.origin || (caller != from && caller != bidBook) || !WalletLib.isWallet(to)) {
                revert TransferRestricted();
            }
            if (!isReceiver[to]) revert ReceiverNotRegistered(to);
        }
        super._update(from, to, value);
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
