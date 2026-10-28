// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IToshFactoryLaunch {
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
}

interface ISafeOwners {
    function isOwner(address owner) external view returns (bool);
    function getOwners() external view returns (address[] memory);
}

/// @title  ToshLaunchGateway — lets each signer of the platform Safe list a project
/// @notice Holds `ToshFactory` ownership on the Safe's behalf. `createLaunch` is
///         open to the Safe itself and to any of its CURRENT owners, so a signer
///         can list a reviewed project from the site with their own wallet.
///         Every other owner-gated factory function is reachable only through
///         `execute`, which only the Safe can call. One gateway per factory.
///
/// @dev    A signer's key is therefore enough to list a project, but not to
///         pause, blacklist, halt, retune bounds or move ownership. Removing a
///         signer from the Safe revokes their listing right in the same
///         transaction, because `isOwner` is read live rather than copied in.
///
///         The gateway is `msg.sender` to the factory, so it is what
///         `createLaunch` records as `creator` and binds `finalSalt` to: a hook
///         salt for a gateway-listed project must be mined against this address.
contract ToshLaunchGateway {
    IToshFactoryLaunch public immutable factory;
    ISafeOwners public immutable safe;

    error NotSafe();
    error NotLauncher();
    error ZeroAddress();

    event Executed(bytes4 indexed selector);

    constructor(address factory_, address safe_) {
        if (factory_ == address(0) || safe_ == address(0)) revert ZeroAddress();
        factory = IToshFactoryLaunch(factory_);
        safe = ISafeOwners(safe_);
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

    /// @notice `ToshFactory.createLaunch`, unchanged, for the Safe or one of its owners.
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

    /// @notice Forward any call to the factory as its owner. Safe only.
    /// @dev    Reverts bubble up verbatim, so the factory's custom errors reach
    ///         the Safe's simulation unchanged.
    function execute(bytes calldata data) external onlySafe returns (bytes memory result) {
        bool ok;
        (ok, result) = address(factory).call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
        emit Executed(bytes4(data));
    }
}
