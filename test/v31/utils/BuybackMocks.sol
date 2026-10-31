// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";

/// @notice A PancakeSwap V2 pair reduced to what `ToshBuybackV31` touches:
///         reserves, an optimistic `swap` held to the 0.25 % fee invariant.
contract MockV2Pair {
    address public token0;
    address public token1;
    uint112 internal _r0;
    uint112 internal _r1;

    constructor(address t0, address t1) {
        token0 = t0;
        token1 = t1;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (_r0, _r1, uint32(block.timestamp));
    }

    function sync() public {
        _r0 = uint112(IERC20(token0).balanceOf(address(this)));
        _r1 = uint112(IERC20(token1).balanceOf(address(this)));
    }

    function swap(uint256 out0, uint256 out1, address to, bytes calldata) external {
        uint256 r0 = _r0;
        uint256 r1 = _r1;
        if (out0 > 0) IERC20(token0).transfer(to, out0);
        if (out1 > 0) IERC20(token1).transfer(to, out1);
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        uint256 in0 = b0 > r0 - out0 ? b0 - (r0 - out0) : 0;
        uint256 in1 = b1 > r1 - out1 ? b1 - (r1 - out1) : 0;
        require((b0 * 10_000 - in0 * 25) * (b1 * 10_000 - in1 * 25) >= r0 * r1 * 1e8, "K");
        sync();
    }
}

contract MockBnbUsdFeed {
    int256 public answer;
    uint256 public updatedAt;

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// @notice Stands in for TOSH's v3 hook: no pool callbacks, a pool key and a
///         TWAP the test sets.
contract MockToshHook {
    PoolKey internal _key;
    uint160 public twapSqrtPriceX96;

    function setKey(PoolKey memory key) external {
        _key = key;
    }

    function setTwap(uint160 twap) external {
        twapSqrtPriceX96 = twap;
    }

    function getPoolKey() external view returns (PoolKey memory) {
        return _key;
    }

    function getHooksRegistrationBitmap() external pure returns (uint16) {
        return 0;
    }
}
