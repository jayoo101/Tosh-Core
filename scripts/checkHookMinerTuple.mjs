// Pins the frontend CREATE2 miner's constructor tuple to the compiled hook.
//
// `test_hookBytecode_inSyncWithArtifact` already guards the BYTECODE half of
// the initcode. This guards the other half — the encoded constructor args.
//
// The failure this exists to catch is silent and total: if Solidity's
// constructor gains, loses, or reorders a field and `hookMiner.ts` is not
// updated to match, the miner still produces a perfectly well-formed salt. It
// is just a salt for a different initcode, so the predicted address never
// materialises and EVERY createLaunch from the UI reverts with
// `InvalidHookSalt`. Nothing in the type system or the test suite notices,
// because both sides compile and run fine in isolation.
//
// Two things are checked:
//   • the abi type list the miner encodes, in order — this is what actually
//     determines the bytes, so a mismatch here means a wrong hash;
//   • the miner's TS parameter names against the constructor's argument names,
//     in order — the types alone cannot catch two same-typed fields being
//     swapped (six consecutive addresses), which encodes identically but
//     deploys a hook with, say, creator and treasury transposed.
//
// Usage:  node scripts/checkHookMinerTuple.mjs

import { readFileSync } from 'node:fs';

const ARTIFACT = 'out/ToshLaunchpadHook.sol/ToshLaunchpadHook.json';
const MINER = 'soat-frontend/src/app/lib/hookMiner.ts';

const failures = [];
const ok = [];

// ── Solidity side ───────────────────────────────────────────────────────────
const abi = JSON.parse(readFileSync(ARTIFACT, 'utf8')).abi;
const ctor = abi.find((e) => e.type === 'constructor');
if (!ctor) {
  console.error(`FAIL  no constructor in ${ARTIFACT} — run \`forge build\``);
  process.exit(1);
}

const solTypes = ctor.inputs.map((i) => i.type);
// `_poolManager` -> `poolManager`, to compare against the TS parameter names.
const solNames = ctor.inputs.map((i) => i.name.replace(/^_/, ''));

// ── TypeScript side ─────────────────────────────────────────────────────────
const miner = readFileSync(MINER, 'utf8');

const parsed = miner.match(/parseAbiParameters\(\s*"([^"]+)"\s*\)/);
if (!parsed) {
  console.error(`FAIL  no parseAbiParameters("...") literal found in ${MINER}`);
  process.exit(1);
}
const tsTypes = parsed[1].split(',').map((s) => s.trim());

// The exported entry point whose parameters mirror the constructor. Its first
// parameter is the bytecode, which is not a constructor field.
const fnMatch = miner.match(/export function computeHookInitcodeHash\(([\s\S]*?)\):/);
if (!fnMatch) {
  console.error(`FAIL  computeHookInitcodeHash not found in ${MINER}`);
  process.exit(1);
}
const tsNames = fnMatch[1]
  .split('\n')
  .map((line) => line.match(/^\s*([A-Za-z0-9_]+)\s*:/))
  .filter(Boolean)
  .map((m) => m[1])
  .filter((n) => n !== 'hookBytecode');

// ── Compare ─────────────────────────────────────────────────────────────────
function compare(label, expected, actual) {
  if (expected.length !== actual.length) {
    failures.push(
      `${label}: arity mismatch — Solidity has ${expected.length}, hookMiner.ts has ${actual.length}\n` +
        `        solidity: ${expected.join(', ')}\n` +
        `        frontend: ${actual.join(', ')}`
    );
    return;
  }
  const diffs = expected
    .map((e, i) => (e === actual[i] ? null : `  [${i}] solidity=${e}  frontend=${actual[i]}`))
    .filter(Boolean);
  if (diffs.length) {
    failures.push(`${label}: ${diffs.length} field(s) differ\n${diffs.join('\n')}`);
  } else {
    ok.push(`${label}: ${expected.length} fields match`);
  }
}

compare('encoded abi types', solTypes, tsTypes);
compare('constructor field order', solNames, tsNames);

// ── Report ──────────────────────────────────────────────────────────────────
for (const line of ok) console.log(`PASS  ${line}`);

if (failures.length) {
  console.error('');
  for (const f of failures) console.error(`FAIL  ${f}`);
  console.error(
    '\nThe frontend salt miner no longer matches the hook constructor.\n' +
      `Update ${MINER} (both computeHookInitcodeHash and its\n` +
      'computeBundledHookInitcodeHash wrapper) to mirror the tuple, or every\n' +
      'createLaunch from the UI will revert with InvalidHookSalt.'
  );
  process.exit(1);
}

console.log('\nhookMiner.ts constructor tuple is in sync with the compiled hook.');
