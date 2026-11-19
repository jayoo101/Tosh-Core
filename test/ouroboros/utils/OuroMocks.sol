// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract MockUsdt is ERC20 {
    constructor() ERC20("Tether USD", "USDT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice PancakeSwap V2 pair semantics in 0.8: reserves, 0.25 % fee
///         invariant, LP minting, skim and sync.
contract MockV2Pair {
    uint256 public constant MINIMUM_LIQUIDITY = 1000;

    address public token0;
    address public token1;
    uint112 internal _r0;
    uint112 internal _r1;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (_r0, _r1, uint32(block.timestamp));
    }

    function sync() public {
        _r0 = uint112(IERC20(token0).balanceOf(address(this)));
        _r1 = uint112(IERC20(token1).balanceOf(address(this)));
    }

    function skim(address to) external {
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        IERC20(token0).transfer(to, b0 - _r0);
        IERC20(token1).transfer(to, b1 - _r1);
    }

    function mint(address to) external returns (uint256 liquidity) {
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        uint256 a0 = b0 - _r0;
        uint256 a1 = b1 - _r1;
        if (totalSupply == 0) {
            liquidity = Math.sqrt(a0 * a1) - MINIMUM_LIQUIDITY;
            totalSupply = MINIMUM_LIQUIDITY;
            balanceOf[address(0)] = MINIMUM_LIQUIDITY;
        } else {
            liquidity = Math.min(a0 * totalSupply / _r0, a1 * totalSupply / _r1);
        }
        require(liquidity > 0, "INSUFFICIENT_LIQUIDITY_MINTED");
        totalSupply += liquidity;
        balanceOf[to] += liquidity;
        sync();
    }

    function swap(uint256 out0, uint256 out1, address to, bytes calldata) external {
        uint256 r0 = _r0;
        uint256 r1 = _r1;
        require(out0 < r0 && out1 < r1, "LIQ");
        if (out0 > 0) IERC20(token0).transfer(to, out0);
        if (out1 > 0) IERC20(token1).transfer(to, out1);
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        uint256 in0 = b0 > r0 - out0 ? b0 - (r0 - out0) : 0;
        uint256 in1 = b1 > r1 - out1 ? b1 - (r1 - out1) : 0;
        require(in0 > 0 || in1 > 0, "INPUT");
        require((b0 * 10_000 - in0 * 25) * (b1 * 10_000 - in1 * 25) >= r0 * r1 * 1e8, "K");
        sync();
    }
}

contract MockV2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function createPair(address a, address b) external returns (address p) {
        require(getPair[a][b] == address(0), "EXISTS");
        p = address(new MockV2Pair(a, b));
        getPair[a][b] = p;
        getPair[b][a] = p;
    }
}

/// @notice Router: fee-on-transfer token→token swaps through real pairs, and
///         BNB→USDT at a fixed rate the test sets (BNB/USDT is not under test).
contract MockV2Router {
    address public immutable factory;
    address public immutable WETH;
    MockUsdt public immutable usdt;
    uint256 public usdtPerBnb;

    constructor(address factory_, address weth_, MockUsdt usdt_) {
        factory = factory_;
        WETH = weth_;
        usdt = usdt_;
    }

    function setUsdtPerBnb(uint256 rate) external {
        usdtPerBnb = rate;
    }

    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256)
        external
        payable
        returns (uint256[] memory amounts)
    {
        require(path[0] == WETH && path[1] == address(usdt), "PATH");
        uint256 out = msg.value * usdtPerBnb / 1 ether;
        require(out >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        usdt.mint(to, out);
        amounts = new uint256[](2);
        amounts[0] = msg.value;
        amounts[1] = out;
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external {
        MockV2Pair p = MockV2Pair(MockV2Factory(factory).getPair(path[0], path[1]));
        IERC20(path[0]).transferFrom(msg.sender, address(p), amountIn);
        (uint112 r0, uint112 r1,) = p.getReserves();
        bool zeroIn = p.token0() == path[0];
        (uint256 rIn, uint256 rOut) = zeroIn ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 input = IERC20(path[0]).balanceOf(address(p)) - rIn;
        uint256 out = input * 9975 * rOut / (rIn * 10_000 + input * 9975);
        uint256 before = IERC20(path[1]).balanceOf(to);
        p.swap(zeroIn ? 0 : out, zeroIn ? out : 0, to, "");
        require(IERC20(path[1]).balanceOf(to) - before >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
    }
}

contract MockFeed {
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

/// @notice A pool of some other AMM that names `token` through one getter,
///         optionally indexed (`coins(i)`); every other call reverts.
contract MockOddPool {
    bytes4 internal immutable _sel;
    address internal immutable _token;
    bool internal immutable _indexed;
    uint256 internal immutable _index;

    constructor(string memory sig, address token_, bool indexed_, uint256 index_) {
        _sel = bytes4(keccak256(bytes(sig)));
        _token = token_;
        _indexed = indexed_;
        _index = index_;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        require(data.length >= 4 && bytes4(data[:4]) == _sel, "no such getter");
        if (_indexed) require(data.length == 36 && abi.decode(data[4:], (uint256)) == _index, "other coin");
        return abi.encode(_token);
    }
}

/// @notice The one Safe read `OuroborosMint.isSeeder` makes.
contract MockSafe {
    mapping(address => bool) public isOwner;

    function setOwner(address a, bool on) external {
        isOwner[a] = on;
    }
}

contract MockRegistry {
    mapping(address => string) internal _handles;
    mapping(bytes32 => address) internal _owners;

    function setHandle(address account, string calldata handle) external {
        _handles[account] = handle;
        _owners[keccak256(bytes(handle))] = account;
    }

    function handleOf(address account) external view returns (string memory) {
        return _handles[account];
    }

    function ownerOfHandle(string calldata handle) external view returns (address) {
        return _owners[keccak256(bytes(handle))];
    }
}
