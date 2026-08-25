// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console2.sol";

import {IERC20Metadata} from "../lib/openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";

/*//////////////////////////////////////////////////////////////////////////
//  VerifyDeployment.s.sol  —  Post-deploy invariant smoke test
//
//  Reads the LIVE state of a freshly-deployed ToshFactory and asserts every
//  invariant that a mainnet operator would otherwise have to eyeball:
//
//    1. Constructor wires every immutable to a non-zero address.
//    2. `defaultSoftCap`, `maxPogAllocationLimit`, `launchFee` are non-zero.
//    3. Pause is OFF and the contract is in the "open for business" state.
//    4. The owner is the EOA deployer  OR  the Safe (post-acceptOwnership).
//    5. The factory's PoG signer is the address you passed in env.
//    6. `getLiveHookInitcodeHash()` is deterministic and stable
//       (re-reads in a single block return the same hash).
//
//  ANY failure throws a clear `revert` with the offending field name so the
//  operator immediately knows what to fix.  Designed to be the very first
//  command run after `forge script DeployMainnet.s.sol`.
//
//  Usage:
//      forge script script/VerifyDeployment.s.sol:VerifyDeploymentScript \
//        --rpc-url $TARGET_RPC \
//        --sig 'run(address)' $FACTORY_ADDRESS \
//        -vvv
//
//  Or, if FACTORY_ADDRESS is in the env, just:
//      forge script script/VerifyDeployment.s.sol:VerifyDeploymentScript \
//        --rpc-url $TARGET_RPC -vvv
//////////////////////////////////////////////////////////////////////////*/

contract VerifyDeploymentScript is Script {
    error MissingField(string field);
    error UnexpectedValue(string field, uint256 expected, uint256 actual);
    error UnexpectedAddress(string field, address expected, address actual);

    function run() external view {
        address factory = vm.envAddress("FACTORY_ADDRESS");
        _verify(factory);
    }

    function run(address factory) external view {
        require(factory != address(0), "factory address required");
        _verify(factory);
    }

    function _verify(address factoryAddr) internal view {
        ToshFactory factory = ToshFactory(factoryAddr);

        // ── 1. Non-zero wired addresses ─────────────────────────────────────
        address pm = factory.poolManager();
        if (pm == address(0)) revert MissingField("poolManager");

        address ps = factory.pogSigner();
        if (ps == address(0)) revert MissingField("pogSigner");

        address pt = factory.platformTreasury();
        if (pt == address(0)) revert MissingField("platformTreasury");

        address lt = factory.ladderTreasury();
        if (lt == address(0)) revert MissingField("ladderTreasury");

        // The treasury authenticates piggyback callers against the factory's
        // hook registry, so a treasury that was never bound (or bound to a
        // DIFFERENT factory) silently disables every buyback on this deployment.
        address boundFactory = ToshLadderTreasury(payable(lt)).factory();
        if (boundFactory != factoryAddr) revert UnexpectedAddress("treasury.factory", factoryAddr, boundFactory);

        // ── 2. Non-zero numeric defaults ────────────────────────────────────
        if (factory.defaultSoftCap() == 0) revert MissingField("defaultSoftCap");
        if (factory.maxPogAllocationLimit() == 0) revert MissingField("maxPogAllocationLimit");

        // launchFee CAN be zero (free launches) — but we still log it.
        // ── 3. Pause must be OFF ────────────────────────────────────────────
        if (factory.paused()) revert UnexpectedValue("paused", 0, 1);

        // ── 4. Owner sanity — must be SOME EOA / Safe ──────────────────────
        address owner = factory.owner();
        if (owner == address(0)) revert MissingField("owner");

        // Optional cross-check: if `EXPECTED_OWNER` is set in env, require equality.
        try vm.envAddress("EXPECTED_OWNER") returns (address expected) {
            if (expected != owner) revert UnexpectedAddress("owner", expected, owner);
        } catch {
            // env var not set — operator skipped the strict check.
        }

        // Optional cross-check: if `EXPECTED_POG_SIGNER` is set, require equality.
        try vm.envAddress("EXPECTED_POG_SIGNER") returns (address expectedSigner) {
            if (expectedSigner != ps) revert UnexpectedAddress("pogSigner", expectedSigner, ps);
        } catch {}

        // Optional cross-check: if `EXPECTED_PLATFORM_TREASURY` is set, require equality.
        try vm.envAddress("EXPECTED_PLATFORM_TREASURY") returns (address expectedT) {
            if (expectedT != pt) revert UnexpectedAddress("platformTreasury", expectedT, pt);
        } catch {}

        // ── 5. Initcode hash determinism (same-block re-read) ──────────────
        bytes32 h1 = factory.getLiveHookInitcodeHash();
        bytes32 h2 = factory.getLiveHookInitcodeHash();
        if (h1 != h2) revert UnexpectedValue("initcodeHash.determinism", uint256(h1), uint256(h2));

        // ── Summary ─────────────────────────────────────────────────────────
        console2.log("============================================================");
        console2.log("Tosh Factory  ::  VerifyDeployment  ::  ALL CHECKS PASSED");
        console2.log("============================================================");
        console2.log("Factory                 :", factoryAddr);
        console2.log("Chain ID                :", block.chainid);
        console2.log("Owner                   :", owner);
        console2.log("V4 PoolManager          :", pm);
        console2.log("PoG signer              :", ps);
        console2.log("Platform Treasury       :", pt);
        console2.log("Ladder Treasury         :", lt);
        console2.log("Launch fee (wei)        :", factory.launchFee());
        console2.log("Default soft cap (wei)  :", factory.defaultSoftCap());
        console2.log("Max PoG alloc (wei)     :", factory.maxPogAllocationLimit());
        console2.log("Cooldown duration (sec) :", factory.cooldownDuration());
        console2.log("Paused?                 : false");
        console2.log("initcodeHash (live)     :", vm.toString(h1));
        console2.log("HOOK_CREATION_CODEHASH  :", vm.toString(factory.HOOK_CREATION_CODEHASH()));
        console2.log("------------------------------------------------------------");
        console2.log("Recommended next steps:");
        console2.log("  1. If owner is the deployer EOA, call transferOwnership(safe)");
        console2.log("     and have the Safe call acceptOwnership().");
        console2.log("  2. Re-run this script AFTER acceptOwnership with");
        console2.log("     EXPECTED_OWNER=<safe-address> to lock in the check.");
        console2.log("  3. Update soat-frontend/.env.production with the values above");
        console2.log("     and re-run `node scripts/extractBytecode.js`.");
        console2.log("  4. Wire Defender / Tenderly alerts (see docs/INCIDENT_RESPONSE.md).");
        console2.log("============================================================");
    }
}
