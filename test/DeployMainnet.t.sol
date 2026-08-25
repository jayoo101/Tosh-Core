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
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";

contract DeployMainnetTest is Test {
    /// @dev Base mainnet, the chain this script is actually meant for.
    uint256 internal constant TARGET_CHAIN = 8453;

    DeployMainnetScript internal script;

    uint256 internal deployerPk = 0xBEEFCAFE;
    address internal deployer;

    address internal pogSigner = makeAddr("kms-pog-signer");
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
}
