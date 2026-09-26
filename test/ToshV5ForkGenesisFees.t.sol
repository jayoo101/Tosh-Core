// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {IERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {ICLPoolManager} from "../lib/infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {PoolKey} from "../lib/infinity-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "../lib/infinity-core/src/types/PoolId.sol";

import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";

interface IFactoryImpl {
    function hookImplementation() external view returns (address);
}

/// @title  `collectGenesisFees` against the live BSC pools.
///
/// @notice The deployed hooks predate the sweep, so this swaps the current
///         implementation's code in under the live one (`vm.etch`) and sweeps
///         the fees each live genesis position has actually accrued, on the
///         real Vault and CLPoolManager.
///
///         What that proves: the zero-delta `modifyLiquidity` settles on
///         Infinity as deployed, moves no liquidity, pays the quote leg to the
///         treasury and burns the token leg — and how much is stranded today.
///
///         The etch is only sound if the storage layout did not move between
///         the deployed source and this one, so each project's storage is read
///         before and after it and must agree.
///
/// @dev    Reads `BSC_RPC` and skips when unset, like the other fork suites.
contract ToshV5ForkGenesisFeesTest is Test {
    using PoolIdLibrary for PoolKey;

    address internal constant FACTORY = 0x20dE906A96FfB89BE6fd6267A0876A68017792F7;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    int24 internal constant TICK_LOWER = -887200;
    int24 internal constant TICK_UPPER = 887200;

    /// @dev Every project on the live factory, from `/api/projects`.
    address[10] internal HOOKS = [
        0x94335Bc7BcF3b63C4deffA6Dd4bb5e09689384fe, // TO
        0xF4c1006bC617D80A18e6898e1E728c9C6918040e, // TEST2
        0x8148be336318b23DC903D27A13cfaDD4da6BA27a, // SANBIN
        0xd6bA876498a4d021eEBF170224c98A23E3d52f7f, // PIRATE CAT
        0x63cfEC6EcE44418048deA45c8590E1E202D7acC0, // TAP
        0x1245ec462504E553520154c6210198eD6831CC9A, // TOSHX
        0x3A26055C9Ba49D80F5649e34A35626016Ba38271, // BEM
        0xDD4b5c433c6abA2B6d62958B069C7401e04A4Ede, // BEMCAT
        0xfF2519eBb5b553bf3A7A0C00799a0E1840c27724, // QMT
        0x079c9A95C431671b4f6B7D5d8D94A5c58C88119a // TEST
    ];

    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("BSC_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
    }

    modifier onFork() {
        vm.skip(!forked, "BSC_RPC unset");
        _;
    }

    struct Snapshot {
        bool launched;
        uint256 totalNative;
        address token;
        address creator;
        uint256 lastSwapBlock;
    }

    function _snap(ToshLaunchpadHook h) internal view returns (Snapshot memory s) {
        s.launched = h.launched();
        s.totalNative = h.totalNativeDeposited();
        s.token = address(h.projectToken());
        s.creator = h.creator();
        s.lastSwapBlock = h.lastSwapBlock();
    }

    /// @dev Put the current implementation's code at the live implementation's
    ///      address, built with the live constructor arguments so every
    ///      immutable matches.
    function _upgradeInPlace() internal {
        ToshLaunchpadHook live = ToshLaunchpadHook(HOOKS[0]);
        ToshLaunchpadHook fresh = new ToshLaunchpadHook(
            address(live.poolManager()),
            address(live.vault()),
            live.factory(),
            live.ladderTreasury(),
            live.platformFeeRecipient(),
            address(live.quoteAsset())
        );
        vm.etch(IFactoryImpl(FACTORY).hookImplementation(), address(fresh).code);
    }

    function test_forkGenesisFees_sweepsEveryLivePosition() public onFork {
        Snapshot[10] memory before;
        for (uint256 i; i < HOOKS.length; ++i) {
            before[i] = _snap(ToshLaunchpadHook(HOOKS[i]));
        }

        _upgradeInPlace();

        ToshLaunchpadHook any = ToshLaunchpadHook(HOOKS[0]);
        IERC20 quote = any.quoteAsset();
        address treasury = any.ladderTreasury();
        ICLPoolManager pm = any.poolManager();
        uint256 totalQuote;
        uint256 swept;

        for (uint256 i; i < HOOKS.length; ++i) {
            ToshLaunchpadHook h = ToshLaunchpadHook(HOOKS[i]);
            Snapshot memory s = _snap(h);
            assertEq(s.launched, before[i].launched, "storage moved: launched");
            assertEq(s.totalNative, before[i].totalNative, "storage moved: totalNativeDeposited");
            assertEq(s.token, before[i].token, "storage moved: projectToken");
            assertEq(s.creator, before[i].creator, "storage moved: creator");
            assertEq(s.lastSwapBlock, before[i].lastSwapBlock, "storage moved: lastSwapBlock");

            if (!s.launched) {
                vm.expectRevert(ToshLaunchpadHook.NotLaunched.selector);
                h.collectGenesisFees();
                continue;
            }

            IERC20 token = IERC20(s.token);
            uint128 liq = pm.getLiquidity(h.getPoolKey().toId(), address(h), TICK_LOWER, TICK_UPPER, bytes32(0));
            uint256 tBefore = quote.balanceOf(treasury);
            uint256 dBefore = token.balanceOf(DEAD);
            uint256 hq = quote.balanceOf(address(h));
            uint256 ht = token.balanceOf(address(h));

            vm.prank(makeAddr("anyone"));
            h.collectGenesisFees();

            uint256 q = quote.balanceOf(treasury) - tBefore;
            uint256 t = token.balanceOf(DEAD) - dBefore;
            assertEq(
                pm.getLiquidity(h.getPoolKey().toId(), address(h), TICK_LOWER, TICK_UPPER, bytes32(0)),
                liq,
                "the sweep moved genesis liquidity"
            );
            assertEq(quote.balanceOf(address(h)), hq, "hook quote balance moved");
            assertEq(token.balanceOf(address(h)), ht, "hook token balance moved");

            // Repeat: nothing left.
            h.collectGenesisFees();
            assertEq(quote.balanceOf(treasury) - tBefore, q, "second sweep paid again");

            console2.log("hook", address(h));
            console2.log("  quote to treasury (8 dp)", q);
            console2.log("  tokens burned (18 dp)   ", t);
            totalQuote += q;
            ++swept;
        }

        console2.log("launched positions swept", swept);
        console2.log("total quote to treasury (8 dp)", totalQuote);
        assertGt(swept, 0, "fixture: no launched project on the live factory");
    }
}
