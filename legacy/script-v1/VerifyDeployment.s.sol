// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console2.sol";

import {IERC20Metadata} from "../lib/openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {CircuitNFT} from "../src/CircuitNFT.sol";
import {CircuitRevenueVault} from "../src/CircuitRevenueVault.sol";

/*//////////////////////////////////////////////////////////////////////////
//  VerifyDeployment.s.sol  —  Post-deploy invariant smoke test
//
//  Reads the LIVE state of a freshly-deployed ToshFactory and asserts every
//  invariant that a mainnet operator would otherwise have to eyeball:
//
//    1. Constructor wires every immutable to a non-zero address.
//    2. `maxPogAllocationLimit` is non-zero.
//    3. Pause is in the state EXPECTED_PAUSED declares (default: off). During
//       the post-broadcast pause window, that means EXPECTED_PAUSED=true.
//    4. The owner is the EOA deployer  OR  the Safe (post-acceptOwnership).
//    5. The factory's PoG signer is the address you passed in env.
//    6. The Circuit NFT is minted only by this factory, and the vault
//       implementation checks ownership against that same NFT.
//    7. `factory.platformTreasury()` equals the hook implementation's
//       `platformFeeRecipient` — the address that is actually paid 0.30 % of
//       every buy. Both are immutable, so divergence is unfixable and silent.
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
//  Or, if FACTORY_ADDRESS is in the env. The contract declares both `run()`
//  and `run(address)`, so forge cannot pick an entry point from the ABI
//  alone and needs `--sig`. Without it the command fails with
//  "Multiple functions with the same name 'run' found in the ABI":
//      forge script script/VerifyDeployment.s.sol:VerifyDeploymentScript \
//        --rpc-url $TARGET_RPC \
//        --sig 'run()' \
//        -vvv
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

        // The factory RECORDS the platform's payout address; the hook
        // implementation is what actually PAYS it, from its own
        // `platformFeeRecipient` immutable, on every buy. Both are wired from
        // the same constructor argument via `HookDeployLib.deployImplementation`,
        // so they can only disagree if that wiring regressed — but if they ever
        // do, every operator who reads the factory to confirm where the money
        // goes gets a confident, wrong answer, while 0.30 % of every buy on
        // every pool keeps landing somewhere else. Neither address is settable,
        // so the only remedy would be a factory redeploy. Worth one call here.
        address impl = factory.hookImplementation();
        if (impl == address(0)) revert MissingField("hookImplementation");

        address hookRecipient = ToshLaunchpadHook(payable(impl)).platformFeeRecipient();
        if (hookRecipient != pt) revert UnexpectedAddress("hook.platformFeeRecipient", pt, hookRecipient);

        // The treasury authenticates piggyback callers against the factory's
        // hook registry, so a treasury that was never bound (or bound to a
        // DIFFERENT factory) silently disables every buyback on this deployment.
        address boundFactory = ToshLadderTreasury(payable(lt)).factory();
        if (boundFactory != factoryAddr) revert UnexpectedAddress("treasury.factory", factoryAddr, boundFactory);

        // ── 2. Non-zero numeric defaults ────────────────────────────────────
        if (factory.maxPogAllocationLimit() == 0) revert MissingField("maxPogAllocationLimit");

        // ── 3. Pause must be the state the operator is expecting ────────────
        // A deployment that is open for business is unpaused, so that stays the
        // default. But this script is meant to run BEFORE the deployment opens,
        // and the runbook now pauses in the same breath as the broadcast: step 0
        // pauses, step 10 unpauses, and everything in between — including this
        // check — happens with the brake on. Verifying an already-live factory
        // is the wrong order; the point is to find a wrong immutable while
        // redeploying is still an option.
        //
        // So the expectation is declared rather than assumed, the same way
        // EXPECTED_OWNER below is. Set EXPECTED_PAUSED=true inside the window.
        bool pausedNow = factory.paused();
        bool pausedWanted = vm.envOr("EXPECTED_PAUSED", false);
        if (pausedNow != pausedWanted) {
            if (pausedNow) {
                console2.log("paused() is true but EXPECTED_PAUSED is false (or unset).");
                console2.log("  Inside the post-broadcast pause window, re-run with EXPECTED_PAUSED=true.");
            } else {
                console2.log("paused() is false but EXPECTED_PAUSED is true.");
                console2.log("  Someone unpaused early, or the window already closed.");
            }
            revert UnexpectedValue("paused", pausedWanted ? 1 : 0, pausedNow ? 1 : 0);
        }

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

        // ── 5. Circuit wiring ───────────────────────────────────────────────
        address circuit = factory.circuitNFT();
        if (circuit == address(0)) revert MissingField("circuitNFT");
        address minter = CircuitNFT(circuit).factory();
        if (minter != factoryAddr) revert UnexpectedAddress("circuitNFT.factory", factoryAddr, minter);
        address vaultImpl = factory.vaultImplementation();
        if (vaultImpl == address(0)) revert MissingField("vaultImplementation");
        address vaultCircuit = address(CircuitRevenueVault(vaultImpl).circuit());
        if (vaultCircuit != circuit) revert UnexpectedAddress("vaultImplementation.circuit", circuit, vaultCircuit);
        address nftVaultImpl = CircuitNFT(circuit).vaultImplementation();
        if (nftVaultImpl != vaultImpl) {
            revert UnexpectedAddress("circuitNFT.vaultImplementation", vaultImpl, nftVaultImpl);
        }
        address vaultQuote = address(CircuitRevenueVault(vaultImpl).quoteAsset());
        if (vaultQuote != address(factory.quoteAsset())) {
            revert UnexpectedAddress("vaultImplementation.quoteAsset", address(factory.quoteAsset()), vaultQuote);
        }

        // ── Summary ─────────────────────────────────────────────────────────
        console2.log("============================================================");
        console2.log("Tosh Factory  ::  VerifyDeployment  ::  ALL CHECKS PASSED");
        console2.log("============================================================");
        console2.log("Factory                 :", factoryAddr);
        console2.log("Chain ID                :", block.chainid);
        console2.log("Owner                   :", owner);
        console2.log("Infinity CLPoolManager  :", pm);
        console2.log("PoG signer              :", ps);
        console2.log("Platform Treasury       :", pt);
        console2.log("  (== hook.platformFeeRecipient, takes 0.30% of every buy)");
        console2.log("Hook implementation     :", impl);
        console2.log("Ladder Treasury         :", lt);
        console2.log("Circuit NFT             :", circuit);
        console2.log("Vault implementation    :", vaultImpl);
        console2.log("Max PoG alloc (wei)     :", factory.maxPogAllocationLimit());
        console2.log("Cooldown duration (sec) :", factory.cooldownDuration());
        // Read, not asserted. This line used to be the literal "false", which
        // was true by construction back when the check above could only pass
        // on an unpaused factory. It now reports a state that really varies,
        // and a summary claiming the brake is off while it is on is the exact
        // misreading that gets step 10 skipped.
        console2.log("Paused?                 :", factory.paused());
        // The on-chain CODEHASH vs local-build comparison is
        // `script/RecomputeInitcodeHash.s.sol`, on demand against a live RPC.
        console2.log("HOOK_CREATION_CODEHASH  :", vm.toString(factory.HOOK_CREATION_CODEHASH()));
        console2.log("------------------------------------------------------------");
        console2.log("Recommended next steps:");
        console2.log("  1. If owner is the deployer EOA, call transferOwnership(safe)");
        console2.log("     and have the Safe call acceptOwnership().");
        console2.log("  2. Re-run this script AFTER acceptOwnership with");
        console2.log("     EXPECTED_OWNER=<safe-address> to lock in the check.");
        console2.log("  3. Update soat-frontend/.env.production with the values above");
        console2.log("     and re-run `node scripts/extractAbis.js`.");
        console2.log("  4. Confirm monitoring/watch.mjs is pointed at these addresses.");
        console2.log("============================================================");
    }
}
