#!/usr/bin/env node
/*
 * e2eLaunchFlow.mjs
 * ─────────────────
 * Drive a real `createLaunch` against a live node using the FRONTEND's own salt
 * and address code, and assert the hook lands exactly where it said it would.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The Solidity suite proves `createLaunch` is correct given a good salt. It
 * cannot prove the UI produces one, because the UI predicts in TypeScript
 * against a hash it reads over JSON-RPC. That seam — TS prediction, wire
 * encoding, live factory globals — is where the EIP-1167 clone refactor actually
 * broke things, and nothing executed it end to end until this script.
 *
 * IT MATTERS MORE SINCE THE PORT, not less. Under Uniswap V4 a wrong prediction
 * almost always failed the permission mask and reverted, so a broken UI was
 * loud. PancakeSwap Infinity has no mask, so the same mistake now deploys
 * successfully at an address the UI cannot name — and this script is the only
 * thing that executes the comparison against a real chain.
 *
 * `checkCloneInitcodeTuple.mjs` is the static half: it pins hookAddress.ts to
 * ToshCloneLib's SOURCE. This is the dynamic half: it pins hookAddress.ts to a
 * DEPLOYED factory's answer, then spends real gas proving the prediction. A
 * layout change that both files make consistently would pass the static guard
 * and still be wrong on-chain if the deployed factory is a different build;
 * only this catches that.
 *
 * It imports `soat-frontend/src/app/lib/hookAddress.ts` directly, on purpose.
 * Re-implementing the prediction here would test this file against itself and
 * prove nothing about what the browser does.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   node scripts/e2eLaunchFlow.mjs --factory 0x...
 *   node scripts/e2eLaunchFlow.mjs --factory 0x... --rpc <url> --duration 10800
 *
 * Defaults target a local anvil with account #0. It broadcasts a transaction
 * and costs the launch fee, so point it at a devnet or a testnet you own.
 *
 * ── The key never comes from argv ───────────────────────────────────────────
 *
 * `--pk` used to be accepted and no longer is. On Windows every argv value
 * lands in PowerShell history, which is how a deployer key leaked here once
 * already. Off a local endpoint the key must arrive through
 * `LAUNCH_CREATOR_PRIVATE_KEY` or `PRIVATE_KEY`, resolved by `loadRoleEnv` from
 * `.env.production` then `.env`. Anvil's published account #0 stays the default
 * for localhost only, where it is not a secret and never will be.
 *
 * ── This script names projects, and names are permanent ─────────────────────
 *
 * `nameTaken` is only released by `releaseAbandonedName`, which requires the
 * launch to have FAILED. A run that succeeds holds its generated `E2E Clone …`
 * name forever, so against a chain whose directory anyone will read, pass
 * `--name`/`--symbol` deliberately rather than letting the stamp decide.
 */

import {
  createPublicClient, createWalletClient, http, parseAbi,
  parseEventLogs, formatUnits, getAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { loadRoleEnv } from './loadRoleEnv.mjs';

import {
  computeHookInitcodeHash,
  pickHookSalt,
  GENESIS_DURATION_FAST,
  GENESIS_DURATION_STANDARD,
  GENESIS_DURATION_SLOW,
} from '../soat-frontend/src/app/lib/hookAddress.ts';

// Anvil account #0 — published in its startup banner, not a secret.
const ANVIL_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const FACTORY_ABI = parseAbi([
  'function hookImplementation() view returns (address)',
  'function defaultSoftCap() view returns (uint256)',
  'function maxPogAllocationLimit() view returns (uint256)',
  'function launchFee() view returns (uint256)',
  'function hookInitcodeHash(address projectTreasury, address creator, uint256 softCap, uint256 perWalletCap, uint256 genesisDuration) view returns (bytes32)',
  'function verifyHookDeployment(address hook, address creator, address projectTreasury, uint256 softCap, uint256 perWalletCap, uint256 genesisDuration, bytes32 rawSalt) view returns (bool)',
  'function registeredHooks(address) view returns (bool)',
  'function quoteAsset() view returns (address)',
  'function createLaunch(string name, string symbol, address projectTreasury, address projectAdmin, bytes32 hookSalt, uint256 expectedFee, uint256 expectedSoftCap, uint256 expectedWalletCap, uint256 genesisDuration) returns (address token, address hook)',
  'event LaunchCreated(uint256 indexed launchId, address indexed token, address indexed hook, address creator, string name, string symbol)',
]);

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

/** Quote-asset amounts are 8-decimal. `formatEther` here would print a 9.28 fee as 9.28e-10. */
const quoteAmt = (units) => formatUnits(units, 8);

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

let failed = 0;
function check(label, pass, detail) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failed++;
}

async function main() {
  const rpc = arg('rpc', 'http://127.0.0.1:8545');
  const factoryArg = arg('factory');
  const duration = BigInt(arg('duration', GENESIS_DURATION_STANDARD.toString()));

  if (!factoryArg) {
    console.error('usage: node scripts/e2eLaunchFlow.mjs --factory 0x... [--rpc url] [--name N --symbol S] [--duration 10800|86400|259200]');
    console.error('       signing key: LAUNCH_CREATOR_PRIVATE_KEY, else PRIVATE_KEY (never on the command line)');
    process.exit(2);
  }

  if (process.argv.includes('--pk')) {
    console.error('✗ --pk is no longer accepted: on Windows it goes straight into shell history.');
    console.error('  Set LAUNCH_CREATOR_PRIVATE_KEY (or PRIVATE_KEY) in the environment or .env.production.');
    process.exit(2);
  }

  // Anvil's key is the default only where it is published and worthless.
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/|$)/.test(rpc);
  loadRoleEnv(['LAUNCH_CREATOR_PRIVATE_KEY', 'PRIVATE_KEY']);
  const pk = process.env.LAUNCH_CREATOR_PRIVATE_KEY
    ?? process.env.PRIVATE_KEY
    ?? (isLocal ? ANVIL_PK : undefined);

  if (!pk) {
    console.error(`✗ no signing key, and ${rpc} is not a local endpoint where anvil's published key would do.`);
    console.error('  Set LAUNCH_CREATOR_PRIVATE_KEY or PRIVATE_KEY. This script broadcasts and spends the launch fee.');
    process.exit(2);
  }
  const factory = getAddress(factoryArg);

  const allowed = [GENESIS_DURATION_FAST, GENESIS_DURATION_STANDARD, GENESIS_DURATION_SLOW];
  if (!allowed.includes(duration)) {
    console.error(`--duration must be one of ${allowed.join(' | ')} (got ${duration})`);
    process.exit(2);
  }

  const account = privateKeyToAccount(pk);
  const pub = createPublicClient({ transport: http(rpc) });
  const wallet = createWalletClient({ account, transport: http(rpc) });
  const chainId = await pub.getChainId();

  const creator = account.address;
  // Mirrors the launch UI, which passes the connected wallet as both the
  // project treasury and the creator.
  const projectTreasury = creator;

  console.log(`chain ${chainId} · factory ${factory} · creator ${creator}\n`);

  const read = (functionName, args = []) =>
    pub.readContract({ address: factory, abi: FACTORY_ABI, functionName, args });

  // ── 1. The clone-era discriminator ────────────────────────────────────────
  // A factory built before the clone refactor has no implementation to point
  // at, so this read is what separates "wrong build deployed" from every other
  // failure. Checking it first turns that into one clear line instead of a
  // bare `execution reverted` three steps later.
  let implementation;
  try {
    implementation = await read('hookImplementation');
    check('factory is clone-era (hookImplementation answers)', true, implementation);
  } catch {
    check('factory is clone-era (hookImplementation answers)', false,
      'reverted — this factory predates the EIP-1167 refactor; redeploy it');
    process.exit(1);
  }

  const [softCap, perWalletCap, launchFee, quote] = await Promise.all([
    read('defaultSoftCap'), read('maxPogAllocationLimit'), read('launchFee'), read('quoteAsset'),
  ]);
  const [quoteDecimals, quoteSymbol] = await Promise.all([
    pub.readContract({ address: quote, abi: ERC20_ABI, functionName: 'decimals' }),
    pub.readContract({ address: quote, abi: ERC20_ABI, functionName: 'symbol' }),
  ]);
  check('factory.quoteAsset() is an 8-decimal token', quoteDecimals === 8,
    `${quote} · ${quoteSymbol} · ${quoteDecimals} decimals`);
  if (quoteDecimals !== 8) process.exit(1);
  console.log(`      quote ${quoteSymbol} ${quote}`);
  console.log(`      softCap ${quoteAmt(softCap)} ${quoteSymbol} · perWalletCap ${quoteAmt(perWalletCap)} ${quoteSymbol} · fee ${quoteAmt(launchFee)} ${quoteSymbol}\n`);

  // ── 2. TS prediction vs the live factory ──────────────────────────────────
  const chainHash = await read('hookInitcodeHash', [projectTreasury, creator, softCap, perWalletCap, duration]);
  const localHash = computeHookInitcodeHash(implementation, creator, projectTreasury, softCap, perWalletCap, duration);
  check('hookAddress.ts initcode hash matches the deployed factory', chainHash === localHash,
    chainHash === localHash ? chainHash : `chain ${chainHash} vs local ${localHash}`);
  if (chainHash !== localHash) {
    console.error('\nThe frontend would predict against a different initcode than the factory builds.');
    process.exit(1);
  }

  // ── 3. Pick a salt, using the frontend's own code ──────────────────────────
  // This step used to assert the prediction carried Uniswap V4's 0x20CC
  // permission mask and to report how long the search took. Neither exists any
  // more: PancakeSwap Infinity reads permissions from the hook's bitmap, so any
  // salt is admissible and `pickHookSalt` returns immediately. What is still
  // worth asserting — that the address is free — is checked here, because
  // `createLaunch` on an occupied address fails with a bare `DeployFailed`.
  const { rawSalt, hookAddress: predicted } = pickHookSalt(factory, creator, chainHash);
  const occupant = await pub.getCode({ address: predicted });
  check('predicted address is unoccupied', !occupant || occupant === '0x',
    !occupant || occupant === '0x' ? predicted : `${predicted} already holds code`);
  if (occupant && occupant !== '0x') process.exit(1);

  // ── 4. Spend the gas ──────────────────────────────────────────────────────
  // Stamped rather than fixed, because `nameTaken` is permanent and a constant
  // would make this script single-use against any given chain. Override with
  // `--name`/`--symbol` anywhere the directory is public: a run that SUCCEEDS
  // holds the name forever, since only a failed launch can release it.
  const stamp = Date.now().toString(36).toUpperCase();
  const name = arg('name', `E2E Clone ${stamp}`);
  const symbol = arg('symbol', `E2E${stamp.slice(-3)}`);

  // The fee is PULLED. Sending `value: launchFee` used to fund the call and now
  // donates native coin to a function that does not read `msg.value`. The
  // allowance has to land first, for exactly the fee, against the factory.
  const allowance = await pub.readContract({
    address: quote, abi: ERC20_ABI, functionName: 'allowance', args: [creator, factory],
  });
  if (allowance < launchFee) {
    const approveHash = await wallet.writeContract({
      address: quote, abi: ERC20_ABI, functionName: 'approve',
      args: [factory, launchFee], chain: null,
    });
    const approveReceipt = await pub.waitForTransactionReceipt({ hash: approveHash });
    check('approved the factory for the launch fee', approveReceipt.status === 'success',
      `${quoteAmt(launchFee)} ${quoteSymbol} · ${approveHash}`);
    if (approveReceipt.status !== 'success') process.exit(1);
  } else {
    check('factory already has the fee allowance', true, `${quoteAmt(allowance)} ${quoteSymbol}`);
  }

  let gasEstimate;
  try {
    gasEstimate = await pub.estimateContractGas({
      address: factory, abi: FACTORY_ABI, functionName: 'createLaunch',
      args: [name, symbol, projectTreasury, creator, rawSalt, launchFee, softCap, perWalletCap, duration],
      account,
    });
    check('createLaunch estimates (salt accepted by the live factory)', true, `${gasEstimate.toLocaleString()} gas`);
  } catch (e) {
    check('createLaunch estimates (salt accepted by the live factory)', false,
      (e.shortMessage ?? e.message ?? '').split('\n')[0]);
    process.exit(1);
  }

  const hash = await wallet.writeContract({
    address: factory, abi: FACTORY_ABI, functionName: 'createLaunch',
    args: [name, symbol, projectTreasury, creator, rawSalt, launchFee, softCap, perWalletCap, duration],
    chain: null, gas: (gasEstimate * 12n) / 10n,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  check('createLaunch confirmed', receipt.status === 'success', `${receipt.gasUsed.toLocaleString()} gas · ${hash}`);
  if (receipt.status !== 'success') process.exit(1);

  // ── 5. The address the UI promised is the address that exists ─────────────
  // THE LOAD-BEARING CHECK, now that no permission mask backs it up. See the
  // note at the top: a mismatch here used to be a revert and is now a silent
  // success at an unpredicted address.
  const [event] = parseEventLogs({ abi: FACTORY_ABI, eventName: 'LaunchCreated', logs: receipt.logs });
  const deployed = event.args.hook;
  check('deployed hook == predicted address', getAddress(deployed) === getAddress(predicted),
    getAddress(deployed) === getAddress(predicted) ? deployed : `predicted ${predicted}, got ${deployed}`);

  const code = await pub.getCode({ address: deployed });
  // 121 runtime bytes = 45 proxy + 76 immutable args; anything else means the
  // clone stub returned the wrong length and the args are misaligned.
  check('hook runtime is a 121-byte clone', code !== undefined && (code.length - 2) / 2 === 121,
    `${code ? (code.length - 2) / 2 : 0} bytes`);

  const [registered, verified] = await Promise.all([
    read('registeredHooks', [deployed]),
    read('verifyHookDeployment', [deployed, creator, projectTreasury, softCap, perWalletCap, duration, rawSalt]),
  ]);
  check('factory registered the hook', registered === true);
  check('verifyHookDeployment agrees', verified === true);

  console.log(`\ntoken ${event.args.token}\nhook  ${deployed}`);
  console.log(failed === 0
    ? '\nEnd-to-end clone launch flow is green.'
    : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
