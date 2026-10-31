// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {DeployV31} from "../../script/DeployV31.s.sol";
import {ToshBuybackV31} from "../../src/v31/ToshBuybackV31.sol";
import {ToshFactoryV31} from "../../src/v31/ToshFactoryV31.sol";
import {ToshLaunchpadHookV31} from "../../src/v31/ToshLaunchpadHookV31.sol";
import {HookAddress} from "../../src/libraries/HookAddress.sol";
import {DeployV31Harness} from "./DeployV31.t.sol";

/// @notice `script/DeployV31.s.sol` against chain 56 as it is: the mainnet
///         pre-flight (registry, quote assets, fee Safe, pair, feed, TOSH hook,
///         2-of-3 owner Safe), the buyback built on the live venues, and the
///         Safe accepting the factory and listing through it. Skipped unless
///         `BSC_RPC` is set.
contract ForkDeployV31BscTest is Test {
    address constant POOL_MANAGER = 0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b;
    address constant SAFE = 0x02DE4629129D104C63329D13A6Ca67E43db7B310;
    address constant REGISTRY = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address constant USDT_WBNB_V2 = 0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE;
    address constant BNB_USD = 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE;
    address constant TOSH_HOOK = 0x45F29984B980f3D076CD05e7BE72E3b357856bC8;
    address constant TOSH = 0xcb54CfBc2699c405e5C88cDec75CBa2ec8B7bfb3;
    uint256 constant PK = 0xD3B13156; // throwaway test key, holds nothing

    bool live;
    DeployV31.Env e;

    function setUp() public {
        string memory rpc = vm.envOr("BSC_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        live = true;
        (bool ok, bytes memory ret) = POOL_MANAGER.staticcall(abi.encodeWithSignature("vault()"));
        require(ok, "vault()");
        e = DeployV31.Env({
            deployer: vm.addr(PK),
            poolManager: POOL_MANAGER,
            vault: abi.decode(ret, (address)),
            safe: SAFE,
            feeRecipient: SAFE,
            registry: REGISTRY,
            wbnb: WBNB,
            usdt: USDT,
            pair: USDT_WBNB_V2,
            feed: BNB_USD,
            toshHook: TOSH_HOOK
        });
    }

    function test_fork_deployV31_onMainnet() public {
        if (!live) return;
        DeployV31Harness h = new DeployV31Harness();
        h.deployWith(PK, e, 56, h.defaults());
        DeployV31.Stack memory s = h.stack();

        ToshBuybackV31 bb = ToshBuybackV31(s.buyback);
        assertEq(address(bb.tosh()), TOSH, "burns $TOSH");
        assertGt(bb.bnbUsdPrice(), 100e18, "Chainlink answers");

        ToshFactoryV31 f = ToshFactoryV31(s.factory);
        vm.prank(SAFE);
        f.acceptOwnership();
        assertEq(f.owner(), SAFE);

        bytes32 initHash = f.hookInitcodeHash(SAFE, SAFE, 500e18, 15e18, 24 hours);
        bytes32 raw;
        for (uint256 i;; ++i) {
            raw = bytes32(i);
            address a = HookAddress.computeAddress(address(f), keccak256(abi.encode(SAFE, raw)), initHash);
            if (a.code.length == 0) break;
        }
        vm.prank(SAFE);
        (, address hook) = f.createLaunch("Fork", "FORK", SAFE, SAFE, raw, 500e18, 15e18, 24 hours);
        assertTrue(f.registeredHooks(hook));
        assertEq(ToshLaunchpadHookV31(payable(hook)).ladderTreasury(), s.buyback);
    }

    function test_fork_deployV31_refusesAForeignTreasuryVenue() public {
        if (!live) return;
        DeployV31Harness h = new DeployV31Harness();
        DeployV31.Env memory bad = e;
        bad.toshHook = USDT_WBNB_V2;
        DeployV31.Params memory p = h.defaults();
        vm.expectRevert(bytes("TOSH_HOOK is not the $TOSH hook"));
        h.deployWith(PK, bad, 56, p);
    }
}
