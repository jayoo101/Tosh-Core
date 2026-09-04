#!/usr/bin/env node
/*
 * extractAbis.js
 * ──────────────
 * Regenerates `soat-frontend/src/app/lib/abis.ts` from the current Foundry
 * artifacts so the frontend ABI, constructor tuple, and CREATE2 miner never
 * drift from the contracts.
 *
 * Usage (from repository root, after `forge build`):
 *     node scripts/extractAbis.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUTS      = [
    path.join(REPO_ROOT, 'soat-frontend', 'src', 'app', 'lib', 'abis.ts'),
];

function loadAbi(rel) {
    const p = path.join(REPO_ROOT, 'out', rel);
    if (!fs.existsSync(p)) {
        console.error('[extractAbis] missing artifact: ' + p);
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(p, 'utf8')).abi;
}

const factoryAbi  = loadAbi(path.join('ToshFactory.sol', 'ToshFactory.json'));
const hookAbi     = loadAbi(path.join('ToshLaunchpadHook.sol', 'ToshLaunchpadHook.json'));
const treasuryAbi = loadAbi(path.join('ToshLadderTreasury.sol', 'ToshLadderTreasury.json'));

const header = `// AUTO-GENERATED from Foundry artifacts — do not edit by hand.
// Source: out/ToshFactory.sol/ToshFactory.json
//         out/ToshLaunchpadHook.sol/ToshLaunchpadHook.json
//         out/ToshLadderTreasury.sol/ToshLadderTreasury.json
//
// Regenerate after any contract ABI change:
//   1. forge build
//   2. node scripts/extractAbis.js
//
// v5.0 wire-level notes the miner / launch UI MUST honour:
//   • Factory constructor is 4-arg: (poolManager, pogSigner, platformTreasury, ladderTreasury)
//   • createLaunch is payable (native ETH launch fee)
//   • deposit(hook, referrer) is payable
//   • createLaunch takes genesisDuration (3h / 24h / 72h, in seconds); it is part
//     of the hook initcode, so the salt must be mined against the SAME window
//   • hookInitcodeHash is 5-arg: (projectTreasury, creator, softCap,
//     perWalletCap, genesisDuration).  projectAdmin was REMOVED by the EIP-1167
//     clone refactor — it is mutable by design and set at initialisation, so it
//     no longer moves the mined address.  This changed the selector
//     (0x53ced9da -> 0x42b973ff), so a factory deployed before that refactor
//     answers the OLD signature and reverts on this one.  If the launch page
//     reports 'hookInitcodeHash reverted', check hookImplementation() first:
//     it exists only on clone-era factories, and the real fix is a redeploy.
//   • Hook constructor is 4-arg: (poolManager, factory, ladderTreasury,
//     platformFeeRecipient).  It builds the shared IMPLEMENTATION; per-project
//     config lives in the clone's immutable args, not in a constructor call.
//   • mintBondingCurve(tokenAmount) is payable; quoteMint returns ETH cost
//   • Hook address mask is 0x20CC
//   • Swap tax is TAX_BPS = 100 (1.00 % of the swap INPUT), on top of the
//     0.30 % POOL_FEE that V4 pays to LPs — total trader friction is 1.30 %.
//     The buy leg SPLITS it: PLATFORM_SWAP_FEE_BPS (30) of the ETH input goes
//     to platformFeeRecipient and emits PlatformSwapFeePaid, the remaining
//     70 bps goes to the ladder treasury and emits BuyTaxToTreasury.  The sell
//     leg is NOT split: the full 100 bps of the token input is burned and
//     emits SellTaxBurned.  An indexer summing platform revenue must read
//     PlatformSwapFeePaid only, and must not treat BuyTaxToTreasury as the
//     whole tax.
//   • platformTreasury is a VIEW with no setter — it is immutable, and equals
//     ToshLaunchpadHook(factory.hookImplementation()).platformFeeRecipient().
//     setPlatformTreasury and the TreasuryUpdated event no longer exist.
//   • Treasury owner surface is curation ONLY: addLadderToken / removeLadderToken.
//     There is no withdraw path — do not go looking for one in the admin UI.
`;

const erc20 = `export const ERC20_ABI = [
  { name: "approve",   type: "function", stateMutability: "nonpayable",
    inputs:  [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  { name: "allowance", type: "function", stateMutability: "view",
    inputs:  [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs:  [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  { name: "name",      type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "string" }] },
  { name: "symbol",    type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "string" }] },
  { name: "decimals",  type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint8" }] },
] as const
`;

function dump(name, abi) {
    return `export const ${name} = ${JSON.stringify(abi, null, 2)} as const\n`;
}

const content =
    header +
    '\n' + dump('FACTORY_ABI', factoryAbi) +
    '\n' + dump('HOOK_ABI', hookAbi) +
    '\n' + dump('TREASURY_ABI', treasuryAbi) +
    '\n' + erc20;

for (const OUT of OUTS) {
    const rel = path.relative(REPO_ROOT, OUT);
    if (fs.existsSync(OUT) && fs.readFileSync(OUT, 'utf8') === content) {
        console.log('[extractAbis] already in sync: ' + rel);
        continue;
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, content);
    console.log('[extractAbis] wrote ' + rel);
}
console.log('[extractAbis] FACTORY_ABI items:  ' + factoryAbi.length);
console.log('[extractAbis] HOOK_ABI items:     ' + hookAbi.length);
console.log('[extractAbis] TREASURY_ABI items: ' + treasuryAbi.length);
