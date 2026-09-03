#!/usr/bin/env node
/*
 * checkPoolGeometry.mjs
 * ─────────────────────
 * Pins the pool geometry the frontend hard-codes to the hook that actually
 * defines it.
 *
 * `soat-frontend/src/lib/contracts.ts` declares:
 *
 *     export const TICK_LOWER   = -887_200
 *     export const TICK_UPPER   =  887_200
 *     export const POOL_FEE     =  3000
 *     export const TICK_SPACING =  200
 *
 * with the comment "mirroring the hook's genesis position". Nothing enforced
 * the mirror. These four numbers ARE the `PoolKey` the LP panel builds and the
 * range it mints into: get any of them wrong and the key hashes to a pool id
 * that does not exist, so every deposit reverts — not for one user, for all of
 * them, with the UI showing no sign of trouble until the wallet rejects.
 *
 * ── Why the existing checks did not cover this ──────────────────────────────
 *
 * `checkLpActions.ts` looked like it did, and that is the interesting part. It
 * asserts the decoded payload's fee/tickSpacing/tickLower/tickUpper against
 * `POOL_FEE`/`TICK_SPACING`/`TICK_LOWER`/`TICK_UPPER` — imported from
 * `contracts.ts`, the same constants the payload was built from. It genuinely
 * verifies that each value lands in the right calldata SLOT, which is worth
 * having. On the VALUE it agrees with itself for any value.
 *
 * Measured, not assumed: with TICK_SPACING 200→60, POOL_FEE 3000→500 and
 * TICK_LOWER −887200→−887220 applied together, `forge test --isolate`, both
 * TypeScript guards, `checkLpActionsAbi.mjs`, `tsc --noEmit` and `next build`
 * all passed.
 *
 * `checkV4Math.ts` reaches the hook, but only for `SQRT_PRICE_LOWER/UPPER`,
 * which live in `v4Math.ts` as literals and are pinned separately by
 * `test/ToshV5LpMathVectors.t.sol`. They are a different pair of numbers that
 * happen to describe the same range, with nothing tying the two descriptions
 * together. This guard anchors the tick side; that test anchors the sqrt side;
 * both now point at the same hook constants, which is what makes them agree.
 *
 * ── Ground truth ────────────────────────────────────────────────────────────
 *
 * Parsed out of `src/ToshLaunchpadHook.sol`, not restated here. Two of the four
 * are `internal constant` with no getter and no ABI entry, so reading the
 * source is the only way to obtain them without retyping them — and retyping
 * them is the failure this guard exists to prevent.
 *
 * Usage:  node scripts/checkPoolGeometry.mjs
 * Exits non-zero on drift, so it can gate CI.
 */

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HOOK = 'src/ToshLaunchpadHook.sol';
const FRONTEND = 'soat-frontend/src/lib/contracts.ts';

/** The four numbers that make up the PoolKey and the genesis range. */
const FIELDS = ['TICK_LOWER', 'TICK_UPPER', 'POOL_FEE', 'TICK_SPACING'];

const problems = [];
const fail = (m) => problems.push(m);

function read(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    console.error(`[checkPoolGeometry] missing file: ${rel}`);
    process.exit(1);
  }
  return fs.readFileSync(p, 'utf8');
}

/** Strip `_` digit separators and parse. Both languages allow them. */
function toInt(raw) {
  const n = Number(raw.replace(/_/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ─── Ground truth: the hook ──────────────────────────────────────────────────

const hook = read(HOOK);
const solidity = {};

for (const name of FIELDS) {
  // e.g. `int24 public constant TICK_SPACING = 200;`
  //      `int24 internal constant TICK_LOWER = -887200;`
  const re = new RegExp(
    `\\b(u?int\\d*)\\s+(?:public|internal|private)?\\s*constant\\s+${name}\\s*=\\s*(-?[0-9_]+)\\s*;`,
  );
  const m = hook.match(re);
  if (!m) {
    fail(
      `${HOOK}: no \`constant ${name}\` found. If it was renamed or made non-constant, ` +
        `update this guard deliberately — do not delete the check, it is the only thing ` +
        `holding the frontend's PoolKey to this contract.`,
    );
    continue;
  }
  const v = toInt(m[2]);
  if (v === null) {
    fail(`${HOOK}: could not parse \`${name} = ${m[2]}\`.`);
    continue;
  }
  solidity[name] = { value: v, declaredType: m[1] };
}

// ─── The frontend's copy ─────────────────────────────────────────────────────

const fe = read(FRONTEND);
const frontend = {};

for (const name of FIELDS) {
  const m = fe.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(-?[0-9_]+)`));
  if (!m) {
    fail(
      `${FRONTEND}: no \`export const ${name}\` found. If the LP panel now derives it, ` +
        `point this guard at the new source rather than dropping the field.`,
    );
    continue;
  }
  const v = toInt(m[1]);
  if (v === null) {
    fail(`${FRONTEND}: could not parse \`${name} = ${m[1]}\`.`);
    continue;
  }
  frontend[name] = v;
}

// ─── Compare ─────────────────────────────────────────────────────────────────

const CONSEQUENCE = {
  TICK_LOWER: 'the mint lands on a range the genesis position does not occupy',
  TICK_UPPER: 'the mint lands on a range the genesis position does not occupy',
  POOL_FEE: 'the PoolKey hashes to a pool id that was never initialised, so every deposit reverts',
  TICK_SPACING:
    'the PoolKey hashes to a pool id that was never initialised, and the tick bounds stop being aligned',
};

for (const name of FIELDS) {
  if (!(name in solidity) || !(name in frontend)) continue;
  if (solidity[name].value !== frontend[name]) {
    fail(
      `${name}: hook says ${solidity[name].value}, frontend says ${frontend[name]}.\n` +
        `    Consequence: ${CONSEQUENCE[name]}.\n` +
        `    The hook is authoritative — it is what initialised the pool. Change ${FRONTEND}.`,
    );
  }
}

// Tick bounds must sit on the spacing grid, or V4 rejects the position outright.
// Checked against the SOLIDITY values so this stays true even while the two
// sides disagree, and so it says something the equality check above does not.
if (solidity.TICK_LOWER && solidity.TICK_UPPER && solidity.TICK_SPACING) {
  const spacing = solidity.TICK_SPACING.value;
  for (const name of ['TICK_LOWER', 'TICK_UPPER']) {
    if (solidity[name].value % spacing !== 0) {
      fail(
        `${HOOK}: ${name} (${solidity[name].value}) is not a multiple of TICK_SPACING (${spacing}). ` +
          `V4 rejects an unaligned position, so the genesis LP mint in \`launch()\` would revert.`,
      );
    }
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────

if (problems.length > 0) {
  console.error('\n[checkPoolGeometry] FAILED — the frontend pool geometry no longer mirrors the hook:\n');
  for (const p of problems) console.error('  • ' + p + '\n');
  process.exit(1);
}

console.log(
  '[checkPoolGeometry] OK — frontend mirrors the hook: ' +
    FIELDS.map((f) => `${f}=${solidity[f].value}`).join('  '),
);
