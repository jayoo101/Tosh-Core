// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IToshFactoryV3Gate {
    function createLaunch(
        string calldata name,
        string calldata symbol,
        address developer,
        address projectFund,
        bytes32 hookSalt,
        uint256 hardCap,
        uint256 perAgentCap,
        uint256 genesisDuration
    ) external returns (address token, address hook);
    function haltLadderMinting(address hook, uint256 duration) external;
    function registeredHooks(address hook) external view returns (bool);
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function MAX_HALT_DURATION() external view returns (uint256);
}

interface ISafeOwnersV3 {
    function isOwner(address owner) external view returns (bool);
    function getOwners() external view returns (address[] memory);
}

/// @title  ToshLaunchGatewayV3 — `ToshLaunchGateway` plus a ladder halt nobody can lift
/// @notice Holds `ToshFactoryV3` ownership on the Safe's behalf, exactly like the
///         gateway it replaces: `createLaunch` for the Safe or any current
///         owner, every other owner function through `execute`, Safe only.
///
///         What it adds is `haltForever`. The factory's shelf brake lapses after
///         at most `MAX_HALT_DURATION`, so on its own it cannot promise a
///         project's supply is final. Once the Safe calls `haltForever(hook)`:
///           • `renewHalt` re-arms the full window, and ANYONE may call it, so
///             keeping the halt alive needs no key and no signer;
///           • `execute` refuses `resumeLadderMinting(hook)` and any
///             `haltLadderMinting(hook, …)`, the only calls that could clear or
///             shorten it;
///           • `execute` refuses `transferOwnership`, so the factory cannot be
///             moved to an owner without these rules.
///         None of this can be undone, by the Safe or anyone else.
///
/// @dev    The halt is live only while someone renews it inside each window;
///         `haltedUntil` tells a keeper when. A lapse resumes minting until the
///         next `renewHalt`, it does not end the promise.
///
///         The global halt (`hook == address(0)`) and `resumeLadderMinting(0)`
///         stay available: the factory ORs the two halts, so neither can reopen
///         a project halted here.
contract ToshLaunchGatewayV3 {
    IToshFactoryV3Gate public immutable factory;
    ISafeOwnersV3 public immutable safe;

    /// @notice The window `haltForever` and `renewHalt` arm, the factory's cap.
    uint256 public immutable haltWindow;

    /// @notice Whether `hook`'s shelf is halted for good.
    mapping(address hook => bool) public haltedForever;

    /// @notice Every hook halted for good, in the order it was halted.
    address[] internal _haltedHooks;

    error NotSafe();
    error NotLauncher();
    error ZeroAddress();
    error NotFactoryOwner();
    error OwnershipPending();
    error HookNotRegistered();
    error AlreadyHaltedForever();
    error NotHaltedForever();
    error HaltIsPermanent();
    error OwnershipLocked();

    event Executed(bytes4 indexed selector);
    event HaltedForever(address indexed hook);
    event HaltRenewed(address indexed hook, uint256 until);

    constructor(address factory_, address safe_) {
        if (factory_ == address(0) || safe_ == address(0)) revert ZeroAddress();
        factory = IToshFactoryV3Gate(factory_);
        safe = ISafeOwnersV3(safe_);
        haltWindow = IToshFactoryV3Gate(factory_).MAX_HALT_DURATION();
    }

    modifier onlySafe() {
        if (msg.sender != address(safe)) revert NotSafe();
        _;
    }

    modifier onlyLauncher() {
        if (!canLaunch(msg.sender)) revert NotLauncher();
        _;
    }

    /// @notice Whether `account` may call `createLaunch` here.
    function canLaunch(address account) public view returns (bool) {
        return account == address(safe) || safe.isOwner(account);
    }

    /// @notice The Safe's owners, so a reader that asks a contract creator who
    ///         stands behind it gets the same answer it would from the Safe.
    function getOwners() external view returns (address[] memory) {
        return safe.getOwners();
    }

    /// @notice `ToshFactoryV3.createLaunch`, unchanged, for the Safe or one of its owners.
    function createLaunch(
        string calldata name,
        string calldata symbol,
        address developer,
        address projectFund,
        bytes32 hookSalt,
        uint256 hardCap,
        uint256 perAgentCap,
        uint256 genesisDuration
    ) external onlyLauncher returns (address token, address hook) {
        return factory.createLaunch(
            name, symbol, developer, projectFund, hookSalt, hardCap, perAgentCap, genesisDuration
        );
    }

    /// @notice Forward a call to the factory as its owner. Safe only.
    /// @dev    Reverts bubble up verbatim, so the factory's custom errors reach
    ///         the Safe's simulation unchanged.
    function execute(bytes calldata data) external onlySafe returns (bytes memory result) {
        _guard(data);
        bool ok;
        (ok, result) = address(factory).call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
        emit Executed(bytes4(data));
    }

    /// @notice Stop `hook`'s shelf minting for good. Safe only, irreversible.
    /// @dev    Refused while an ownership transfer is pending: an owner accepted
    ///         after this call would not be bound by `execute`'s rules.
    function haltForever(address hook) external onlySafe {
        if (factory.owner() != address(this)) revert NotFactoryOwner();
        if (factory.pendingOwner() != address(0)) revert OwnershipPending();
        if (!factory.registeredHooks(hook)) revert HookNotRegistered();
        if (haltedForever[hook]) revert AlreadyHaltedForever();
        haltedForever[hook] = true;
        _haltedHooks.push(hook);
        emit HaltedForever(hook);
        _renew(hook);
    }

    /// @notice Re-arm `hook`'s halt for a full window. Anyone may call.
    function renewHalt(address hook) external {
        if (!haltedForever[hook]) revert NotHaltedForever();
        _renew(hook);
    }

    /// @notice `renewHalt` for every hook halted for good. Anyone may call.
    function renewAll() external {
        uint256 n = _haltedHooks.length;
        for (uint256 i; i < n; ++i) {
            _renew(_haltedHooks[i]);
        }
    }

    /// @notice Every hook halted for good.
    function haltedHooks() external view returns (address[] memory) {
        return _haltedHooks;
    }

    function _renew(address hook) private {
        factory.haltLadderMinting(hook, haltWindow);
        emit HaltRenewed(hook, block.timestamp + haltWindow);
    }

    function _guard(bytes calldata data) private view {
        if (data.length < 4) return;
        bytes4 sel = bytes4(data[:4]);
        if (sel == IOwnable2Step.transferOwnership.selector) {
            if (_haltedHooks.length != 0) revert OwnershipLocked();
        } else if (
            sel == IHaltSelectors.resumeLadderMinting.selector || sel == IHaltSelectors.haltLadderMinting.selector
        ) {
            address hook = abi.decode(data[4:], (address));
            if (haltedForever[hook]) revert HaltIsPermanent();
        }
    }
}

interface IOwnable2Step {
    function transferOwnership(address newOwner) external;
}

interface IHaltSelectors {
    function haltLadderMinting(address hook, uint256 duration) external;
    function resumeLadderMinting(address hook) external;
}
