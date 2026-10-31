// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "../../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "../../lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

interface IToshMintVestingHook {
    function projectToken() external view returns (address);
    function mintVesting() external view returns (address);
}

interface IToshMintVestingFactory {
    function registeredHooks(address hook) external view returns (bool);
    function hookImplementation() external view returns (address);
}

/// @title  ToshMintVesting
/// @notice Holds every v3.1 L2 mint and releases it linearly over 8 hours,
///         one step per minute (1/480 each).
///
///         One record per wallet per project. The hook mints the tokens here
///         and calls `lock` in the same transaction; the factory already
///         refuses a second L2 mint by the same wallet or Agent ID on a
///         project, so a record is never topped up. The beneficiary claims
///         whatever has unlocked, any time, as often as they like.
///
///         No owner, no admin withdrawal: tokens leave only to the wallet they
///         were locked for.
contract ToshMintVesting {
    using SafeERC20 for IERC20;

    uint256 public constant DURATION = 8 hours;
    uint256 public constant STEP = 1 minutes;
    uint256 public constant STEPS = DURATION / STEP;

    struct Lock {
        uint128 total;
        uint128 claimed;
        uint64 start;
    }

    address public immutable deployer;
    address public factory;

    mapping(address hook => mapping(address account => Lock)) internal _locks;

    event FactorySet(address indexed factory);
    event Locked(address indexed hook, address indexed account, uint256 amount, uint256 start);
    event Claimed(address indexed hook, address indexed account, uint256 amount);

    error ZeroAddress();
    error OnlyDeployer();
    error FactoryAlreadySet();
    error FactoryMismatch();
    error UnknownHook();
    error AlreadyLocked();
    error ZeroAmount();
    error NothingToClaim();

    constructor() {
        deployer = msg.sender;
    }

    /// @notice Bind the factory whose hooks may lock. Its hook implementation
    ///         must name this contract, so a factory built for another vesting
    ///         contract is refused.
    function setFactory(address factory_) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (factory != address(0)) revert FactoryAlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        if (IToshMintVestingHook(IToshMintVestingFactory(factory_).hookImplementation()).mintVesting() != address(this))
        {
            revert FactoryMismatch();
        }
        factory = factory_;
        emit FactorySet(factory_);
    }

    /// @notice Open `account`'s record on the calling hook. The hook has
    ///         already minted `amount` of its token to this contract.
    function lock(address account, uint256 amount) external {
        address f = factory;
        if (f == address(0) || !IToshMintVestingFactory(f).registeredHooks(msg.sender)) revert UnknownHook();
        if (amount == 0) revert ZeroAmount();
        Lock storage l = _locks[msg.sender][account];
        if (l.total != 0) revert AlreadyLocked();
        // forge-lint: disable-next-line(unsafe-typecast) — bounded by the token's 1e27 MAX_SUPPLY
        l.total = uint128(amount);
        l.start = uint64(block.timestamp);
        emit Locked(msg.sender, account, amount, block.timestamp);
    }

    /// @notice Send the caller everything unlocked so far on `hook`.
    function claim(address hook) external returns (uint256 amount) {
        return _claim(hook, msg.sender);
    }

    /// @notice Send `account` everything unlocked so far on `hook`. Anyone may
    ///         call it, for a minter that cannot make the call itself; the
    ///         tokens only ever go to `account`.
    function claimFor(address hook, address account) external returns (uint256 amount) {
        return _claim(hook, account);
    }

    function _claim(address hook, address account) internal returns (uint256 amount) {
        Lock storage l = _locks[hook][account];
        amount = _vested(l) - l.claimed;
        if (amount == 0) revert NothingToClaim();
        // forge-lint: disable-next-line(unsafe-typecast) — amount ≤ total, a uint128
        l.claimed += uint128(amount);
        IERC20(IToshMintVestingHook(hook).projectToken()).safeTransfer(account, amount);
        emit Claimed(hook, account, amount);
    }

    /// @notice `account`'s record on `hook`, plus what it may claim now.
    function lockOf(address hook, address account)
        external
        view
        returns (uint256 total, uint256 claimed, uint256 start, uint256 claimable)
    {
        Lock storage l = _locks[hook][account];
        total = l.total;
        claimed = l.claimed;
        start = l.start;
        claimable = _vested(l) - claimed;
    }

    /// @dev Unlocked so far: whole minutes elapsed, capped at `STEPS`.
    function _vested(Lock storage l) internal view returns (uint256) {
        uint256 total = l.total;
        if (total == 0) return 0;
        uint256 steps = (block.timestamp - l.start) / STEP;
        if (steps >= STEPS) return total;
        return (total * steps) / STEPS;
    }
}
