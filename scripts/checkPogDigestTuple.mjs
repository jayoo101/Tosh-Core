#!/usr/bin/env node
/*
 * checkPogDigestTuple.mjs
 * ───────────────────────
 * Holds the three independent implementations of the PoG attestation digest
 * against each other.
 *
 * The digest is built in three languages:
 *
 *   1. Solidity  `src/ToshFactory.sol`               — registerPoG, the verifier
 *   2. viem      `soat-frontend/.../sign-allocation` — the production signer
 *   3. ethers    `scripts/pogSigner.ts`              — the operator signer
 *
 * Nothing connects them. No shared schema, no generated types, no test that
 * signs with one and recovers with the other. Reorder two fields or widen one
 * in Solidity and BOTH signers keep emitting well-formed signatures — they just
 * recover to an address that is not `pogSigner`, so every `registerPoG` in
 * production reverts with `InvalidSignature` and the allocation gate is dead
 * for every user at once. Both sides compile. Every Solidity test stays green,
 * because the tests sign with Solidity.
 *
 * The ordering here is genuinely easy to get wrong, which is why this exists:
 * the function's parameters are (maxAlloc, deadline, nonce, signature) but the
 * digest is (sender, maxAlloc, NONCE, DEADLINE, contract, chainId). Nonce and
 * deadline swap places between the signature and the tuple. Anyone rebuilding
 * the digest from the function signature — the obvious thing to do — gets it
 * backwards, and the result still type-checks in all three languages.
 *
 * ── What this proves, and what it does not ──────────────────────────────────
 *
 * Solidity is the ground truth: the field list is PARSED out of `abi.encode`
 * and each expression resolved to its ABI type, rather than restated here. If
 * the contract changes, this guard's expectation changes with it and the TS
 * sides are what go red. That is the `checkHookMinerTuple.mjs` pattern, and it
 * is the whole point — a guard holding two copies of a list it wrote itself
 * agrees with itself forever.
 *
 * It does NOT execute anything. It cannot prove the three produce identical
 * bytes for the same inputs; it proves they encode the same types in the same
 * order with the same values, plus that all three still frame with EIP-191
 * rather than one of them having quietly moved to EIP-712.
 *
 * Usage:  node scripts/checkPogDigestTuple.mjs
 * Exits non-zero on drift, so it can gate CI.
 */

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOLIDITY = 'src/ToshFactory.sol';
const VIEM = 'soat-frontend/src/app/api/sign-allocation/route.ts';
const ETHERS = 'scripts/pogSigner.ts';

const problems = [];
const fail = (m) => problems.push(m);

function read(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    console.error(`[checkPogDigestTuple] missing file: ${rel}`);
    process.exit(1);
  }
  return fs.readFileSync(p, 'utf8');
}

/**
 * Expressions Solidity can put in `abi.encode` whose ABI type is not written
 * down at the call site. Anything not here must resolve to a named parameter.
 */
const BUILTIN_TYPES = {
  'msg.sender': { type: 'address', semantic: 'sender' },
  'address(this)': { type: 'address', semantic: 'contract' },
  'block.chainid': { type: 'uint256', semantic: 'chainId' },
};

// ─── 1. Ground truth: parse the Solidity digest ──────────────────────────────

const sol = read(SOLIDITY);

const fnMatch = sol.match(/function\s+registerPoG\s*\(([^)]*)\)/);
if (!fnMatch) {
  fail(`${SOLIDITY}: no \`function registerPoG(\` — was it renamed? This guard cannot find its ground truth.`);
}

/** name -> abi type, for the function's own parameters. */
const paramTypes = {};
if (fnMatch) {
  for (const raw of fnMatch[1].split(',')) {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    paramTypes[parts[parts.length - 1]] = parts[0];
  }
}

const encMatch = sol.match(/keccak256\(\s*abi\.encode\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*\)/);
if (!encMatch) {
  fail(`${SOLIDITY}: could not find \`keccak256(abi.encode(...))\` in registerPoG.`);
}

/** [{ expr, type, semantic }] in encoding order, derived from Solidity. */
const truth = [];
if (encMatch) {
  const args = encMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
  for (const expr of args) {
    if (BUILTIN_TYPES[expr]) {
      truth.push({ expr, ...BUILTIN_TYPES[expr] });
    } else if (paramTypes[expr]) {
      truth.push({ expr, type: paramTypes[expr], semantic: expr });
    } else {
      fail(
        `${SOLIDITY}: cannot resolve the ABI type of \`${expr}\` in the digest. ` +
          `It is neither a registerPoG parameter nor a known builtin — teach this guard about it ` +
          `rather than deleting the check.`,
      );
    }
  }
}

if (truth.length === 0 && problems.length === 0) {
  fail(`${SOLIDITY}: parsed an EMPTY digest tuple. That cannot be right; the parser is broken.`);
}

// ─── 2. viem side ────────────────────────────────────────────────────────────

const viem = read(VIEM);

const viemCall = viem.match(/encodeAbiParameters\(\s*\[([\s\S]*?)\]\s*,\s*\[([\s\S]*?)\]\s*\)/);
if (!viemCall) {
  fail(`${VIEM}: no \`encodeAbiParameters([...], [...])\` found. If the digest moved, point this guard at it.`);
}

const viemFields = viemCall
  ? [...viemCall[1].matchAll(/\{\s*name:\s*'([^']+)'\s*,\s*type:\s*'([^']+)'\s*\}/g)].map((m) => ({
      name: m[1],
      type: m[2],
    }))
  : [];

const viemValues = viemCall
  ? viemCall[2]
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, '').trim().replace(/,$/, ''))
      .filter(Boolean)
  : [];

// ─── 3. ethers side ──────────────────────────────────────────────────────────

const ethersSrc = read(ETHERS);

const ethersCall = ethersSrc.match(/coder\.encode\(\s*\[([^\]]*)\]\s*,\s*\[([\s\S]*?)\]\s*\)/);
if (!ethersCall) {
  fail(`${ETHERS}: no \`coder.encode([...], [...])\` found. If the digest moved, point this guard at it.`);
}

const ethersTypes = ethersCall
  ? [...ethersCall[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  : [];

const ethersValues = ethersCall
  ? ethersCall[2]
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, '').trim().replace(/,$/, ''))
      .filter(Boolean)
  : [];

// ─── 4. Compare types, in order, against Solidity ────────────────────────────

function compareTypes(label, actual) {
  if (actual.length !== truth.length) {
    fail(
      `${label}: the digest has ${actual.length} field(s) but Solidity encodes ${truth.length}.\n` +
        `    Solidity: ${truth.map((t) => t.type).join(', ')}\n` +
        `    ${label}: ${actual.join(', ')}`,
    );
    return;
  }
  for (let i = 0; i < truth.length; i++) {
    if (actual[i] !== truth[i].type) {
      fail(
        `${label}: slot ${i} is \`${actual[i]}\`, but Solidity encodes \`${truth[i].expr}\` as \`${truth[i].type}\`.\n` +
          `    Solidity: ${truth.map((t) => t.type).join(', ')}\n` +
          `    ${label}: ${actual.join(', ')}`,
      );
    }
  }
}

if (truth.length > 0) {
  if (viemCall) compareTypes(VIEM, viemFields.map((f) => f.type));
  if (ethersCall) compareTypes(ETHERS, ethersTypes);
}

// ─── 5. Compare VALUES positionally ──────────────────────────────────────────
//
// Types alone are not enough: five of the six fields are `uint256`/`address`
// pairs, so swapping `nonce` and `deadline` — the exact mistake the parameter
// ordering invites — is invisible to a type check. Each slot's value
// expression must mention the thing Solidity puts there.

const SEMANTIC_HINTS = {
  sender: /user|sender|account|wallet/i,
  contract: /contract|factory/i,
  chainId: /chain/i,
  maxAlloc: /maxalloc|alloc/i,
  nonce: /nonce/i,
  deadline: /deadline|expir/i,
};

function compareValues(label, values) {
  if (values.length !== truth.length) {
    fail(`${label}: ${values.length} value expression(s) against ${truth.length} Solidity fields.`);
    return;
  }
  for (let i = 0; i < truth.length; i++) {
    const hint = SEMANTIC_HINTS[truth[i].semantic];
    if (!hint) continue;
    if (!hint.test(values[i])) {
      fail(
        `${label}: slot ${i} should carry \`${truth[i].semantic}\` (Solidity: \`${truth[i].expr}\`), ` +
          `but the expression there is \`${values[i]}\`.\n` +
          `    A swap here type-checks on both sides and produces a valid signature that recovers ` +
          `to the wrong address.\n` +
          `    Solidity order: ${truth.map((t) => t.semantic).join(', ')}`,
      );
    }
  }
}

if (truth.length > 0) {
  if (viemCall) compareValues(VIEM, viemValues);
  if (ethersCall) compareValues(ETHERS, ethersValues);

  // The viem side names its fields; if the names disagree with Solidity's
  // ordering, the tuple is right but the next reader will be misled.
  for (let i = 0; i < Math.min(viemFields.length, truth.length); i++) {
    const hint = SEMANTIC_HINTS[truth[i].semantic];
    if (hint && !hint.test(viemFields[i].name)) {
      fail(
        `${VIEM}: slot ${i} is NAMED \`${viemFields[i].name}\` but Solidity puts ` +
          `\`${truth[i].semantic}\` there. The bytes may be right; the label is not.`,
      );
    }
  }
}

// ─── 6. All three must still frame with EIP-191 ──────────────────────────────
//
// A digest that matches field-for-field still fails to recover if one side
// changes how it wraps the hash. Moving one signer to EIP-712 typed data would
// be a reasonable-looking change with exactly the same blast radius.

const FRAMING = [
  [SOLIDITY, sol, /toEthSignedMessageHash\(\)/, '`.toEthSignedMessageHash()`'],
  [VIEM, viem, /signMessage\(\s*\{\s*message:\s*\{\s*raw:/, '`signMessage({ message: { raw: … } })`'],
  [ETHERS, ethersSrc, /signMessage\(\s*ethers\.getBytes\(/, '`signMessage(ethers.getBytes(…))`'],
];

for (const [label, src, re, what] of FRAMING) {
  if (!re.test(src)) {
    fail(
      `${label}: ${what} is gone. All three sides must frame the digest with EIP-191 — ` +
        `if one moves to EIP-712 the tuple can still match perfectly and every signature ` +
        `still recovers to the wrong address.`,
    );
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────

if (problems.length > 0) {
  console.error('\n[checkPogDigestTuple] FAILED — the PoG attestation digest has drifted:\n');
  for (const p of problems) console.error('  • ' + p + '\n');
  console.error(
    '  A mismatch here is not a partial outage. Every registerPoG reverts with\n' +
      '  InvalidSignature, for every user, until the signers are redeployed.\n',
  );
  process.exit(1);
}

console.log(
  `[checkPogDigestTuple] OK — ${truth.length} fields agree across Solidity, viem and ethers:\n` +
    `    ${truth.map((t, i) => `${i}:${t.semantic}(${t.type})`).join('  ')}`,
);
