// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ToshBuybackV31} from "../../src/v31/ToshBuybackV31.sol";

/// @notice `ToshBuybackV31` against the live chain-56 venues: PancakeSwap V2
///         USDT/WBNB, Chainlink BNB/USD, and $TOSH's own Infinity pool.
///         Skipped unless `BSC_RPC` is set.
contract ForkBuybackV31BscTest is Test {
    address constant POOL_MANAGER = 0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b;
    address constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant USDT_WBNB_V2 = 0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE;
    address constant BNB_USD = 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE;
    address constant TOSH_HOOK = 0x45F29984B980f3D076CD05e7BE72E3b357856bC8;
    address constant TOSH = 0xcb54CfBc2699c405e5C88cDec75CBa2ec8B7bfb3;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    bool live;
    ToshBuybackV31 buyback;

    function setUp() public {
        string memory rpc = vm.envOr("BSC_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        live = true;
        (bool ok, bytes memory ret) = POOL_MANAGER.staticcall(abi.encodeWithSignature("vault()"));
        require(ok, "vault()");
        buyback = new ToshBuybackV31(
            POOL_MANAGER,
            abi.decode(ret, (address)),
            USDT,
            WBNB,
            USDT_WBNB_V2,
            BNB_USD,
            TOSH_HOOK,
            180e18,
            address(this)
        );
    }

    function test_fork_wiring() public view {
        if (!live) return;
        assertEq(address(buyback.tosh()), TOSH);
        assertGt(buyback.bnbUsdPrice(), 100e18, "Chainlink answers in 1e18");
    }

    function test_fork_convertsThenBurnsTosh() public {
        if (!live) return;
        deal(USDT, address(buyback), 400e18);
        buyback.pokeBuyback();
        uint256 bnb = IERC20(WBNB).balanceOf(address(buyback));
        assertApproxEqRel(bnb * buyback.bnbUsdPrice() / 1e18, 200e18, 0.01e18, "half converted near Chainlink");

        uint256 deadBefore = IERC20(TOSH).balanceOf(DEAD);
        vm.roll(block.number + 1);
        buyback.pokeBuyback();
        assertLt(IERC20(WBNB).balanceOf(address(buyback)), bnb, "burn leg spent WBNB");
        assertGt(IERC20(TOSH).balanceOf(DEAD), deadBefore, "TOSH burned");
        assertEq(IERC20(TOSH).balanceOf(address(buyback)), 0);
    }
}
