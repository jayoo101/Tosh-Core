// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "forge-std/console2.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";

// ---------------------------------------------------------------------------
// DeployScript -- BSC testnet (97), PancakeSwap Infinity
// ---------------------------------------------------------------------------
// TESTNET ONLY.  This script leaves the factory and the treasury owned by the
// deployer EOA with no multisig handoff, which is fine for a staging chain and
// is NOT acceptable anywhere real.  Use script/DeployMainnet.s.sol for
// production; it performs the Ownable2Step transfer to a Safe.
//
// Base Sepolia (84532) -> Robinhood testnet (46630) -> here.  This target is the
// first of the three that is a REAL testnet for the AMM the protocol ships
// against: Uniswap V4 never deployed to BSC testnet, so the Robinhood-era
// rehearsal could only ever run against a mainnet fork.  Infinity is on 97, and
// that is the whole reason for the port.
//
// The address book is NOT shared between 97 and 56.  It was on Robinhood, where
// 46630 and 4663 carried identical V4 addresses, and that made a rehearsal here
// exercise the mainnet addresses unchanged.  Infinity's four contracts differ on
// every chain, so 97 proves the mechanism and NOT the mainnet address book —
// `test/ToshV5Fork.t.sol` is what checks the 56 addresses.
//
// Verification is Etherscan v2, which covers BSC 56 and 97 under one key.  The
// Robinhood era used Blockscout because 46630 was served by neither Etherscan
// nor Basescan; that constraint is gone, and the key is now needed anyway for
// the PoG gas scanner.
//
// Required env vars (copy .env.example -> .env and fill in):
//   PRIVATE_KEY               -- deployer key (must hold testnet BNB; faucet at
//                                https://www.bnbchain.org/en/testnet-faucet)
//   INFINITY_CL_POOL_MANAGER  -- Infinity CLPoolManager on 97 (0x36A12c...199d4)
//   INFINITY_VAULT            -- Infinity Vault on 97 (0x2CdB3E...b79dD).  Both
//                                are required: the manager runs the pool, the
//                                Vault holds every balance
//   POG_SIGNER_ADDRESS        -- address whose private key signs PoG attestations
//   PLATFORM_TREASURY         -- recipient of the 0.30 % platform cut of every
//                                buy.  NO DEFAULT, and immutable once deployed
//
// Deploy command:
//   forge script script/Deploy.s.sol:DeployScript \
//     --rpc-url bsc_testnet \
//     --broadcast \
//     --verify \
//     -vvvv
//
// `bsc_testnet` is a foundry.toml rpc_endpoints alias, so it reads BSC_TESTNET_RPC
// from .env without the shell having to export anything -- which on PowerShell
// there is no `source` for.
// ---------------------------------------------------------------------------
contract DeployScript is Script {
    function run() external {
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);

        // The manifest below claims BSC testnet; make that true rather than
        // decorative, so a stale --rpc-url cannot quietly deploy elsewhere.
        //
        // 97 rather than 46630 since the PancakeSwap Infinity port: Infinity is
        // deployed on BSC testnet, which is the whole reason for the move —
        // Uniswap V4 never shipped there, so the previous target could only ever
        // be rehearsed against a mainnet fork.
        require(block.chainid == 97, "Deploy.s.sol is BNB Smart Chain testnet (97) only");

        address poolManager = vm.envAddress("INFINITY_CL_POOL_MANAGER");

        // Infinity splits Uniswap V4's PoolManager in two: the manager owns
        // pool state, the Vault owns balances and the lock. Both addresses are
        // immutable on the factory and on every hook it deploys, and a mismatched
        // pair is not a config error but a redeployment — `CLPoolManager` and
        // `Vault` each reject the other's counterparty, so a wrong pairing
        // bricks every launch rather than misbehaving quietly.
        address vault = vm.envAddress("INFINITY_VAULT");
        require(vault != address(0), "INFINITY_VAULT unset");

        address pogSigner = vm.envOr("POG_SIGNER_ADDRESS", deployer);

        // REQUIRED, no default.  This used to be `vm.envOr(..., deployer)`,
        // which was harmless while `platformTreasury` received nothing — it was
        // a metadata field on no money path.  It now takes 0.30 % of the ETH
        // input of every buy on every pool, so defaulting it would silently
        // route the platform's revenue to whichever key happened to broadcast.
        //
        // It is also IMMUTABLE on both the factory and the hook implementation:
        // there is no setter, and correcting a mistake here means redeploying
        // the whole factory. Getting it wrong is not a config error, it is a
        // migration.
        //
        // It must accept ETH unconditionally. `poolManager.take` performs a raw
        // value transfer and this path is NOT fault-isolated, so a recipient
        // whose `receive()` can revert bricks every buy on every pool.
        address platformTreasury = vm.envAddress("PLATFORM_TREASURY");
        require(platformTreasury != address(0), "PLATFORM_TREASURY unset");
        _refuseWellKnownKey(platformTreasury);

        console2.log("============================================================");
        console2.log("Tosh Fair Launchpad v5.0 -- BNB Smart Chain testnet Deployment");
        console2.log("============================================================");
        console2.log("Deployer         :", deployer);
        console2.log("CLPoolManager    :", poolManager);
        console2.log("Vault            :", vault);
        console2.log("PoG Signer       :", pogSigner);
        console2.log("Platform Treasury (0.30% of buys, IMMUTABLE):", platformTreasury);
        console2.log("------------------------------------------------------------");

        vm.startBroadcast(deployerPk);

        // ── 1. ToshLadderTreasury ─────────────────────────────────────────────
        // Must exist BEFORE the factory: the factory takes its address as an
        // immutable constructor argument, and every hook inherits it from there.
        ToshLadderTreasury treasury = new ToshLadderTreasury(poolManager, vault, deployer);
        console2.log("ToshLadderTreasury deployed:", address(treasury));

        // ── 2. ToshFactory ────────────────────────────────────────────────────
        ToshFactory factory = new ToshFactory(
            poolManager, // _poolManager      (Infinity CLPoolManager)
            vault, // _vault            (Infinity Vault)
            pogSigner, // _pogSigner        (PoG oracle backend)
            platformTreasury, // _platformTreasury
            address(treasury) // _ladderTreasury   (buyback reservoir)
        );
        console2.log("ToshFactory deployed:", address(factory));

        // ── 3. Close the loop ─────────────────────────────────────────────────
        // The treasury authenticates piggyback callers against the factory's
        // `registeredHooks` map, so it needs the factory address.  One-shot.
        treasury.setFactory(address(factory));
        console2.log("Treasury bound to factory");

        vm.stopBroadcast();

        // ── 4. Print deployment manifest ──────────────────────────────────────
        // Sentinel-address hash, 24h window.  Useful as a build fingerprint,
        // useless for predicting a real launch: see step 3 below for the hash
        // that actually matches the address `createLaunch` will deploy to.
        bytes32 sentinelInitcodeHash = factory.getLiveHookInitcodeHash();

        console2.log("============================================================");
        console2.log("DEPLOYMENT COMPLETE -- copy these into your .env / frontend");
        console2.log("============================================================");
        console2.log("FACTORY_ADDRESS  =", address(factory));
        console2.log("TREASURY_ADDRESS =", address(treasury));
        console2.log("CHAIN_ID         = 97 (BSC testnet)");
        console2.log("Sentinel 24h initcode hash (build fingerprint, NOT a launch's hash):");
        console2.logBytes32(sentinelInitcodeHash);
        console2.log("============================================================");
        console2.log("");
        console2.log("NEXT STEPS:");
        console2.log("1. Update soat-frontend/.env.local:");
        console2.log("     NEXT_PUBLIC_FACTORY_ADDRESS, NEXT_PUBLIC_TREASURY_ADDRESS");
        console2.log("2. Regenerate soat-frontend/src/app/lib/abis.ts if any signature moved:");
        console2.log("     forge build && node scripts/extractAbis.js");
        // ⚠ THIS STEP USED TO SAY "SALT MINING", and telling an operator to mine
        //   would now send them looking for a rule that no longer exists.
        //   Uniswap V4 read a hook's permissions from its address, so a salt had
        //   to land on the 0x20CC mask.  Infinity asks the hook for
        //   `getHooksRegistrationBitmap()`, and `ToshFactory` checks no address
        //   bits at all -- any salt is admissible.
        //
        //   What replaced the search is a check the search used to imply: the
        //   predicted address has to be UNOCCUPIED.  And what replaced the mask's
        //   accidental protection against a stale quote is explicit --
        //   `expectedSoftCap` / `expectedWalletCap`, which revert `CapsChanged`.
        console2.log("3. Predicting a launch's hook address (NO MINING -- any salt lands):");
        console2.log("     initcodeHash = factory.hookInitcodeHash(");
        console2.log("                      projTreasury, creator, softCap, perWalletCap, duration)");
        console2.log("     duration MUST be the creator's choice: 3h / 24h / 72h");
        console2.log("     softCap and perWalletCap MUST be the factory's CURRENT values,");
        console2.log("       and MUST be passed to createLaunch as expectedSoftCap /");
        console2.log("       expectedWalletCap or it reverts CapsChanged");
        console2.log("     finalSalt    = keccak256(abi.encode(creator, bytes32(s)))");
        console2.log("     predicted    = HookMiner.computeAddress(factory, finalSalt, initcodeHash)");
        console2.log("     the only test on `predicted` is that it holds no code yet");
        console2.log("4. createLaunch is PAYABLE -- send `launchFee` (default 0.35 BNB) as msg.value.");
        console2.log("5. deposit(hook, referrer) is PAYABLE -- send the native coin, no ERC20 approve.");
        console2.log("6. Curate the buyback ladder: treasury.addLadderToken(token).");
        console2.log("     The pool is derived from the token's hook -- listing a token this");
        console2.log("     factory did not launch is rejected.");
        console2.log("============================================================");
    }

    /// @dev Refuse an address whose private key is public knowledge.
    ///
    ///      ⚠ THIS CAUGHT A REAL DEPLOY, on 97, and the shape is what makes it
    ///        worth a check rather than a note. `.env` named the intended
    ///        treasury. A PowerShell session left over from local Anvil work
    ///        still exported `PLATFORM_TREASURY=0x7099…dc79C8` — Anvil's account
    ///        #1 — and Foundry lets the process environment shadow `.env`. So the
    ///        file was right, the deploy was wrong, and the log agreed with the
    ///        deploy. Nothing reconciled the two.
    ///
    ///        `require(!= address(0))` cannot see this: the address is perfectly
    ///        well-formed, it accepts value unconditionally, and every invariant
    ///        check downstream passes. It is wrong only in a way the deploy
    ///        script has no other way to know — the key is in every Foundry
    ///        install on earth.
    ///
    ///        On 97 that cost nothing. On 56 it would have been permanent: this
    ///        address takes 0.30 % of the native input of every buy on every
    ///        pool, it is immutable on both the factory and the hook
    ///        implementation, and anyone who has ever run `anvil` could sweep it.
    ///        The fix is not "remember to unset the variable" — it is to make the
    ///        one class of address we can recognise impossible to deploy.
    ///
    ///      Scope, stated so the check is not mistaken for more than it is: these
    ///      are the first ten accounts of Foundry's default test mnemonic
    ///      ("test test … junk"), which is what a stale local session leaves
    ///      behind. It does NOT verify that a passing address is one you control.
    function _refuseWellKnownKey(address who) internal pure {
        address[10] memory anvil = [
            0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266,
            0x70997970C51812dc3A010C7d01b50e0d17dc79C8,
            0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC,
            0x90F79bf6EB2c4f870365E785982E1f101E93b906,
            0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65,
            0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc,
            0x976EA74026E726554dB657fA54763abd0C3a0aa9,
            0x14dC79964da2C08b23698B3D3cc7Ca32193d9955,
            0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f,
            0xa0Ee7A142d267C1f36714E4a8F75612F20a79720
        ];
        for (uint256 i = 0; i < anvil.length; i++) {
            require(who != anvil[i], "PLATFORM_TREASURY is an Anvil test account -- its key is public");
        }
    }
}
