// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////////////////
//  DeployMainnet.t.sol
//
//  CI-grade verification that the mainnet deploy script
//  (`script/DeployMainnet.s.sol`) produces a healthy production-ready
//  factory + ladder treasury and correctly queues Ownable2Step handoff
//  to the Safe.
//////////////////////////////////////////////////////////////////////////*/

import {Test} from "forge-std/Test.sol";
import {DeployMainnetScript} from "../script/DeployMainnet.s.sol";
import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";

contract DeployMainnetTest is Test {
    /// @dev Robinhood Chain — the chain this script is meant for
    ///      (docs/ROBINHOOD_MIGRATION.md). This constant has tracked three
    ///      answers now: 8453, then 1, now 4663. That churn is the argument for
    ///      the guard being chain-agnostic and env-driven rather than hard-coded
    ///      in the script — the value here only has to agree with what
    ///      production will authorise, and changing targets stays a one-line
    ///      edit in two places instead of a rewrite.
    uint256 internal constant TARGET_CHAIN = 4663;

    DeployMainnetScript internal script;

    uint256 internal deployerPk = 0xBEEFCAFE;
    address internal deployer;

    address internal pogSigner = makeAddr("pog-signer");
    address internal platformTreasury = makeAddr("gnosis-safe-treasury");
    address internal prodOwnerSafe = makeAddr("gnosis-safe-owner");

    PoolManager internal poolManager;

    function setUp() public {
        deployer = vm.addr(deployerPk);

        poolManager = new PoolManager(address(this));

        vm.setEnv("PRIVATE_KEY", vm.toString(bytes32(deployerPk)));
        vm.setEnv("V4_POOL_MANAGER", vm.toString(address(poolManager)));
        vm.setEnv("POG_SIGNER_ADDRESS", vm.toString(pogSigner));
        vm.setEnv("PLATFORM_TREASURY", vm.toString(platformTreasury));
        vm.setEnv("PROD_OWNER_SAFE", vm.toString(prodOwnerSafe));

        // Fixed, and never rewritten per test: `setEnv` mutates the process
        // environment, which is outside the state snapshot Forge reverts
        // between tests, so a per-test value would leak into its neighbours.
        // The chain is varied with `vm.chainId` instead, which IS reverted.
        vm.setEnv("TARGET_CHAIN_ID", vm.toString(TARGET_CHAIN));

        vm.deal(deployer, 1 ether);

        script = new DeployMainnetScript();
    }

    /// @notice The chain guard is the last thing standing between a stale
    ///         `--rpc-url` and a real, ownable, fee-taking factory on the wrong
    ///         network, so it gets its own test rather than riding along.
    function test_run_refusesToBroadcastOnTheWrongChain() public {
        vm.chainId(TARGET_CHAIN + 1);

        vm.expectRevert(bytes("chain id mismatch: wrong --rpc-url for this deploy"));
        script.run();
    }

    function test_run_deploysFactoryAndQueuesOwnershipHandoff() public {
        vm.chainId(TARGET_CHAIN);

        // Treasury is CREATE'd first (nonce N), factory second (N+1).
        uint256 nonce = vm.getNonce(deployer);
        address treasuryAddr = vm.computeCreateAddress(deployer, nonce);
        address factoryAddr = vm.computeCreateAddress(deployer, nonce + 1);

        script.run();

        assertTrue(treasuryAddr.code.length > 0, "treasury not deployed at predicted address");
        assertTrue(factoryAddr.code.length > 0, "factory not deployed at predicted address");

        ToshFactory factory = ToshFactory(factoryAddr);
        ToshLadderTreasury treasury = ToshLadderTreasury(payable(treasuryAddr));

        assertEq(factory.poolManager(), address(poolManager), "poolManager mismatch");
        assertEq(factory.pogSigner(), pogSigner, "pogSigner mismatch");
        assertEq(factory.platformTreasury(), platformTreasury, "platformTreasury mismatch");
        assertEq(factory.ladderTreasury(), treasuryAddr, "ladderTreasury mismatch");
        assertEq(address(treasury.poolManager()), address(poolManager), "treasury poolManager mismatch");
        assertEq(treasury.factory(), factoryAddr, "treasury factory loop not closed");

        assertEq(factory.owner(), deployer, "factory owner should still be deployer (step 1 of 2)");
        assertEq(factory.pendingOwner(), prodOwnerSafe, "factory pendingOwner should be Safe");
        assertEq(treasury.owner(), deployer, "treasury owner should still be deployer");
        assertEq(treasury.pendingOwner(), prodOwnerSafe, "treasury pendingOwner should be Safe");

        vm.prank(prodOwnerSafe);
        factory.acceptOwnership();
        vm.prank(prodOwnerSafe);
        treasury.acceptOwnership();

        assertEq(factory.owner(), prodOwnerSafe, "factory owner should be Safe after acceptance");
        assertEq(factory.pendingOwner(), address(0), "factory pendingOwner should clear");
        assertEq(treasury.owner(), prodOwnerSafe, "treasury owner should be Safe after acceptance");
        assertEq(treasury.pendingOwner(), address(0), "treasury pendingOwner should clear");

        vm.prank(deployer);
        vm.expectRevert();
        factory.pause();
    }

    function test_requireDistinctRoles_refusesPogSignerEqualToDeployer() public {
        vm.expectRevert(bytes("POG_SIGNER_ADDRESS must not equal deployer"));
        script.requireDistinctRoles(deployer, deployer, prodOwnerSafe, platformTreasury);
    }

    function test_requireDistinctRoles_refusesSafeEqualToDeployer() public {
        vm.expectRevert(bytes("PROD_OWNER_SAFE must NOT equal deployer EOA"));
        script.requireDistinctRoles(deployer, pogSigner, deployer, platformTreasury);
    }

    /// @dev `platformTreasury` is now the recipient of 0.30 % of every buy and
    ///      is immutable on both the factory and the hook implementation.
    ///      Pointing it at the deployer key sends the platform's whole swap
    ///      revenue to a hot single-signature EOA with no way to correct it
    ///      short of redeploying the factory — which is precisely the failure
    ///      the old `vm.envOr("PLATFORM_TREASURY", deployer)` default would
    ///      have produced silently on a forgotten env var.
    function test_requireDistinctRoles_refusesPlatformTreasuryEqualToDeployer() public {
        vm.expectRevert(bytes("PLATFORM_TREASURY must NOT equal deployer EOA"));
        script.requireDistinctRoles(deployer, pogSigner, prodOwnerSafe, deployer);
    }

    /// @dev And not the PoG signer either: that key is online by design, so it
    ///      is a strictly worse home for revenue than the deployer.
    function test_requireDistinctRoles_refusesPlatformTreasuryEqualToPogSigner() public {
        vm.expectRevert(bytes("PLATFORM_TREASURY must NOT equal the PoG signer"));
        script.requireDistinctRoles(deployer, pogSigner, prodOwnerSafe, pogSigner);
    }

    function test_requireDistinctRoles_acceptsDistinct() public view {
        script.requireDistinctRoles(deployer, pogSigner, prodOwnerSafe, platformTreasury);
    }

    /// @dev The anti-divergence guard, at the deployment layer rather than the
    ///      unit layer: the address the operator put in `PLATFORM_TREASURY` has
    ///      to be the one the hook will actually pay on every buy. The factory
    ///      records it; the hook implementation pays it. Both are immutable and
    ///      both come from this one env var, so if `HookDeployLib` ever stopped
    ///      forwarding it, the factory would keep reporting the right answer
    ///      while every swap paid someone else.
    function test_deploy_wiresPlatformTreasuryIntoTheHookImplementation() public {
        vm.chainId(TARGET_CHAIN);

        uint256 nonce = vm.getNonce(deployer);
        ToshFactory factory = ToshFactory(vm.computeCreateAddress(deployer, nonce + 1));

        script.run();

        ToshLaunchpadHook impl = ToshLaunchpadHook(payable(factory.hookImplementation()));
        assertEq(impl.platformFeeRecipient(), payable(platformTreasury), "hook must pay the address we deployed with");
        assertEq(impl.platformFeeRecipient(), payable(factory.platformTreasury()), "and the factory must agree");
    }
}
