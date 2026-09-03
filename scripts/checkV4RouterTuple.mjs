// Pins the V4 router calldata layout this repository encodes against the layout
// the DEPLOYED UniversalRouter decodes — and pins the fact that nothing outside
// test/ encodes it at all.
//
// ── What changed at the Robinhood cutover ──────────────────────────────────
//
// This guard used to enforce the opposite of what it enforces now, and the
// inversion is worth stating because the diff otherwise reads like a mistake.
//
// Ethereum's UniversalRouter predates this repository's copy of v4-periphery.
// Its `ExactInputSingleParams` has five fields; `lib/` has six, having gained
// `minHopPriceX36` between `amountOutMinimum` and `hookData`. So the fork suite
// hand-rolled a five-field struct to match the chain, and this guard's job was
// to keep the hand-roll and `lib/` DIFFERENT.
//
// Robinhood Chain's router (0x8876789976dEcBfCbBbe364623C63652db8C0904, chains
// 4663 and 46630) is the same stock Uniswap contract from a NEWER build. It has
// the six fields. It agrees with `lib/`. So the hand-roll became the wrong one,
// the fork suite now imports `IV4Router.ExactInputSingleParams` directly, and
// this guard's job is to keep the two the SAME.
//
// ── The drift this exists to catch ─────────────────────────────────────────
//
// The agreement is not a property of the world. It is two versions that happen
// to line up in August 2026: `lib/v4-periphery` is a submodule that will be
// bumped, and the router on chain is immutable. The next field Uniswap adds to
// this struct reopens exactly the gap the Ethereum era lived in, pointing the
// other way — the fork suite would encode seven fields at a six-field decoder.
//
// ── Why the failure mode makes a static guard the only workable defence ────
//
// The deployed decoder is a raw calldata pointer cast with no length check:
//
//   swapParams := add(params.offset, calldataload(params.offset))
//
// It reads each field at a fixed offset from the tuple start. A tuple with the
// wrong number of fields is not rejected, it is REINTERPRETED, and every field
// up to the first divergence still decodes correctly — so the call proceeds.
//
// The Ethereum-era mismatch was measured rather than assumed, and the result
// generalises to any future one. Encoding the five-field tuple at the SIX-field
// decoder now deployed on Robinhood:
//
//   the decoder reads head slot 8 as minHopPriceX36. In the short tuple that
//   slot holds hookData's offset, 0x120 = 288. Nonzero, so the price check
//   runs — but 288 in X36 fixed point is 4.2e-9, and every real price clears
//   it. Then it reads head slot 9 as hookData's offset. That is the tail's
//   length word, 0, which points back at the tuple start, whose first word is
//   currency0 — zero for a native-ETH pool — read as a length. Empty hookData.
//
//   Net: the swap SUCCEEDS, with the right amounts and a silently discarded
//   hookData. No revert, no event, no compile-time warning.
//
// Verified: `test_fork_deployedRouterReadsTheSixthField` in ToshV5Fork.t.sol is
// the only test in that file the five-field encoding fails. The buy, the exact
// 70 bps tax and the slippage bound all still pass under it. That is the whole
// argument for this guard — the expensive, slow, against-the-real-chain test
// suite does not catch this on its own, because the calldata is wrong in a way
// that produces correct-looking results.
//
// Every pool this protocol creates is native-ETH/token, so `currency0` is
// always zero and we are always in the quiet case.
//
// ── What this checks ───────────────────────────────────────────────────────
//
//   1. test/ToshV5Fork.t.sol imports the vendored struct and does NOT carry a
//      hand-rolled copy. A reappearing hand-roll is drift by definition now.
//   2. lib/v4-periphery's tuple still MATCHES the deployed one — and when it
//      stops, reports which head slot the deployed decoder will misread and
//      what the new layout parks there.
//   3. The vendored decoder's minimum-length floor still agrees with the
//      vendored field count, so a `lib/` bump that moves one and not the other
//      cannot slip through.
//   4. Any non-test source that builds V4 router calldata does so through the
//      vendored Solidity struct, which checks 2-3 have already pinned.
//
//      This started as "nothing outside test/ builds it at all", and
//      `script/RehearseTestnet.s.sol` is what made that too strong — it drives
//      a real buy through the live router on testnet, which is the point of a
//      rehearsal. The premise was never really "no callers"; it was "no caller
//      this guard cannot relate to the deployed layout". A `.sol` file
//      encoding `IV4Router.ExactInputSingleParams` is related to it, by the two
//      checks above.
//
//      Everything else still fails, and the two cases that matter both still
//      do. A hand-rolled `struct ExactInputSingleParams` fails wherever it
//      appears, because nothing in either type system ties a copy to `lib/`.
//      And a TypeScript file fails unconditionally: the frontend swaps nothing
//      today (it buys via `hook.mintBondingCurve` and LPs via the position
//      manager), and the day someone adds a swap panel it would be encoding
//      this tuple by hand in a language with no access to the Solidity type —
//      exactly the silent hazard this guard exists for.
//
// Usage:  node scripts/checkV4RouterTuple.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const FORK_TEST = 'test/ToshV5Fork.t.sol';
const IV4ROUTER = 'lib/v4-periphery/src/interfaces/IV4Router.sol';
const DECODER = 'lib/v4-periphery/src/libraries/CalldataDecoder.sol';

/**
 * The tuple the router deployed on Robinhood Chain decodes, in order. Pinned as
 * a literal because there is no parseable source for it in this tree — the
 * authority is the verified source on Blockscout, corroborated by
 * `test_fork_deployedRouterReadsTheSixthField` against the live contract.
 *
 * Per-chain fact. If this repository ever targets a second chain, this becomes
 * a map and every check below has to run once per entry.
 */
const DEPLOYED_LAYOUT = [
  ['PoolKey', 'poolKey'],
  ['bool', 'zeroForOne'],
  ['uint128', 'amountIn'],
  ['uint128', 'amountOutMinimum'],
  ['uint256', 'minHopPriceX36'],
  ['bytes', 'hookData'],
];

/**
 * Head slots each type occupies in an abi-encoded tuple. `PoolKey` is five
 * static members so it inlines; `bytes` contributes one head slot holding an
 * offset. Anything not listed is a hard error rather than a guess, because
 * guessing a width here would defeat the whole check.
 */
const HEAD_SLOTS = { PoolKey: 5, bool: 1, uint128: 1, uint256: 1, bytes: 1 };

const failures = [];
const ok = [];

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    console.error(`FAIL  cannot read ${path}`);
    process.exit(1);
  }
}

/**
 * Both files document their own byte layouts inline, in prose carrying the same
 * field names and type keywords the parser looks for, so comments have to go
 * before anything is located.
 *
 * The `(?<!:)` keeps `https://` in a doc link from swallowing the rest of its
 * line — which in a scanner would be a false NEGATIVE, the direction that
 * actually costs something here.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');
}

/** Fields of the first `struct <name> { ... }` in `src`, as [type, name] pairs. */
function structFields(src, name, path) {
  const at = src.search(new RegExp(`struct\\s+${name}\\s*\\{`));
  if (at < 0) {
    failures.push(`${path}: no \`struct ${name}\` found — was it renamed or removed?`);
    return null;
  }
  const open = src.indexOf('{', at);
  const close = src.indexOf('}', open);
  if (close < 0) {
    failures.push(`${path}: unterminated \`struct ${name}\``);
    return null;
  }

  const fields = [];
  for (const line of src.slice(open + 1, close).split(';')) {
    const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)$/);
    if (m) fields.push([m[1], m[2]]);
  }
  if (fields.length === 0) {
    failures.push(`${path}: \`struct ${name}\` parsed to zero fields — the parser needs updating`);
    return null;
  }
  return fields;
}

const render = (fields) => fields.map(([t, n]) => `${t} ${n}`).join(', ');

/** Total head slots, or null if the layout contains a type this guard cannot size. */
function headSlots(fields, path) {
  let n = 0;
  for (const [type, name] of fields) {
    const slots = HEAD_SLOTS[type];
    if (slots === undefined) {
      failures.push(
        `${path}: field \`${type} ${name}\` uses a type this guard cannot size.\n` +
          `        Add it to HEAD_SLOTS with its head-slot count — do not let it default.`
      );
      return null;
    }
    n += slots;
  }
  return n;
}

// ── 1 · The fork test imports the struct rather than restating it ───────────

const forkSrc = stripComments(read(FORK_TEST));

if (/struct\s+ExactInputSingleParams\s*\{/.test(forkSrc)) {
  failures.push(
    `${FORK_TEST} declares its own \`ExactInputSingleParams\`.\n` +
      '        It must import IV4Router.ExactInputSingleParams instead. A local copy\n' +
      '        only made sense while the deployed router and lib/ disagreed, which was\n' +
      '        true on Ethereum and is not true on Robinhood. A copy kept past that\n' +
      '        point drifts silently: nothing in either type system relates the two.\n' +
      '        If the router really did diverge again, invert check 2 rather than\n' +
      '        reintroducing an unchecked duplicate.'
  );
} else if (!/\bIV4Router\.ExactInputSingleParams\b/.test(forkSrc)) {
  failures.push(
    `${FORK_TEST} no longer encodes IV4Router.ExactInputSingleParams.\n` +
      '        The fork suite is the only place production router calldata is built,\n' +
      '        so if it stopped building any, checks 2-3 are guarding nothing and this\n' +
      '        guard has silently become decorative.'
  );
} else {
  ok.push(`${FORK_TEST} encodes the vendored IV4Router.ExactInputSingleParams`);
}

// ── 2 · The vendored tuple still matches the deployed one ───────────────────

const libFields = structFields(stripComments(read(IV4ROUTER)), 'ExactInputSingleParams', IV4ROUTER);

let libHead = null;

if (libFields) {
  libHead = headSlots(libFields, IV4ROUTER);

  if (render(libFields) === render(DEPLOYED_LAYOUT)) {
    ok.push(
      `lib/v4-periphery matches the deployed ${DEPLOYED_LAYOUT.length}-field tuple\n` +
        `        ${render(DEPLOYED_LAYOUT)}`
    );
  } else {
    // The load-bearing number: the first head slot at which the deployed
    // decoder and the tuple we would now encode stop describing the same thing.
    let cursor = 0;
    let divergesAt = null;
    for (let i = 0; i < Math.max(libFields.length, DEPLOYED_LAYOUT.length); i++) {
      const mine = libFields[i] ? render([libFields[i]]) : '(absent)';
      const theirs = DEPLOYED_LAYOUT[i] ? render([DEPLOYED_LAYOUT[i]]) : '(absent)';
      if (mine !== theirs) {
        divergesAt = { slot: cursor, mine, theirs };
        break;
      }
      cursor += HEAD_SLOTS[libFields[i][0]] ?? 0;
    }

    failures.push(
      'lib/v4-periphery and the deployed router disagree on ExactInputSingleParams.\n' +
        `        deployed (${DEPLOYED_LAYOUT.length} fields): ${render(DEPLOYED_LAYOUT)}\n` +
        `        lib/     (${libFields.length} fields): ${render(libFields)}\n` +
        (divergesAt
          ? `        first divergence at head slot ${divergesAt.slot} (byte 0x${(divergesAt.slot * 32).toString(16)}):\n` +
            `        deployed reads \`${divergesAt.theirs}\`, we would encode \`${divergesAt.mine}\`\n`
          : '') +
        '\n' +
        `        ${FORK_TEST} encodes with lib/, so it is now sending the live router\n` +
        '        a tuple it will misread — and misreading is not the same as reverting.\n' +
        '        See this file\'s header for what that looked like the last time.\n\n' +
        '        Either pin the submodule back, or hand-roll the DEPLOYED layout in the\n' +
        '        fork test and invert this check to assert they differ.'
    );
  }
}

// ── 3 · The vendored decoder's length floor matches its own field count ─────
//
// `decodeSwapExactInSingleParams` guards on a hard-coded minimum. It has to
// equal (head slots + 1) * 32 — every head slot plus the one length word an
// empty `hookData` still occupies. A `lib/` bump that adds a field but leaves
// the floor alone would accept short calldata and read past it.

const floorMatch = stripComments(read(DECODER))
  .match(/function decodeSwapExactInSingleParams[\s\S]*?lt\(params\.length,\s*(0x[0-9a-fA-F]+)\)/);

if (!floorMatch) {
  failures.push(
    `${DECODER}: could not find the \`lt(params.length, ...)\` floor in\n` +
      '        decodeSwapExactInSingleParams — the decoder was restructured and this\n' +
      '        guard no longer knows what it is checking.'
  );
} else if (libHead !== null) {
  const floor = Number(floorMatch[1]);
  const expected = (libHead + 1) * 32;
  if (floor !== expected) {
    failures.push(
      `${DECODER}: minimum-length floor disagrees with its own struct.\n` +
        `        floor in source: 0x${floor.toString(16)} (${floor} bytes)\n` +
        `        ${libHead} head slots + 1 length word: 0x${expected.toString(16)} (${expected} bytes)\n` +
        '        One of the two was updated without the other.'
    );
  } else {
    ok.push(`vendored decoder floor 0x${floor.toString(16)} matches its ${libHead} head slots`);
  }
}

// ── 4 · Router calldata outside test/ goes through the vendored struct ─────

const SCAN_ROOTS = ['src', 'script', 'scripts', 'soat-frontend/src', 'soat-frontend/scripts'];
const SCAN_EXTS = ['.sol', '.ts', '.tsx', '.mjs', '.js', '.cjs'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'out', 'cache', 'broadcast', '.git']);
const SELF = 'scripts/checkV4RouterTuple.mjs';

/**
 * Ordered longest-first so `SWAP_EXACT_IN_SINGLE` is not reported as a bare
 * `SWAP_EXACT_IN`.
 */
const ROUTER_MARKERS = new RegExp(
  [
    '0x8876789976dEcBfCbBbe364623C63652db8C0904',
    '\\bUniversalRouter\\b',
    '\\bIV4Router\\b',
    '\\bExactInputSingleParams\\b',
    '\\bExactOutputSingleParams\\b',
    '\\bSWAP_EXACT_IN_SINGLE\\b',
    '\\bSWAP_EXACT_OUT_SINGLE\\b',
    '\\bSWAP_EXACT_IN\\b',
    '\\bSWAP_EXACT_OUT\\b',
  ].join('|'),
  'gi'
);

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // an optional root that does not exist is not a failure
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCAN_EXTS.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

const hits = [];
const onPinnedPath = [];

for (const root of SCAN_ROOTS) {
  for (const file of walk(root, [])) {
    const rel = relative('.', file).split(sep).join('/');
    if (rel === SELF) continue;

    const src = stripComments(read(file));

    const markers = [];
    const seen = new Set();
    for (const m of src.matchAll(ROUTER_MARKERS)) {
      const line = src.slice(0, m.index).split('\n').length;
      const key = `${m[0]}@${line}`;
      if (!seen.has(key)) {
        seen.add(key);
        markers.push(`  ${rel}:${line}  ${m[0]}`);
      }
    }
    if (markers.length === 0) continue;

    // A local copy is drift wherever it appears — same argument as check 1,
    // and it outranks the exemption below rather than being excused by it.
    if (/struct\s+ExactInputSingleParams\s*\{/.test(src)) {
      failures.push(
        `${rel} declares its own \`ExactInputSingleParams\`.\n` +
          '        Import IV4Router.ExactInputSingleParams instead. Nothing in either\n' +
          '        type system relates a copy to the vendored struct, so checks 2-3\n' +
          '        cannot see it drift away from the deployed layout.'
      );
      continue;
    }

    // Solidity encoding the vendored struct is already pinned by checks 2-3.
    // The `.sol` condition is load-bearing: a TypeScript file cannot import a
    // Solidity type, so a marker there is always a hand-built tuple.
    if (rel.endsWith('.sol') && /\bIV4Router\.ExactInputSingleParams\b/.test(src)) {
      onPinnedPath.push(rel);
      continue;
    }

    hits.push(...markers);
  }
}

if (hits.length) {
  failures.push(
    `${hits.length} unpinned reference(s) to V4 router calldata:\n${hits.join('\n')}\n\n` +
      '        This code builds UniversalRouter calldata without going through the\n' +
      '        vendored IV4Router.ExactInputSingleParams, so nothing here relates it\n' +
      '        to the layout checks 2-3 pin. Confirm it matches the DEPLOYED tuple:\n\n' +
      `          ${render(DEPLOYED_LAYOUT)}\n\n` +
      '        and that it is checked against the chain rather than against lib/,\n' +
      '        which is a submodule and can move. A tuple of the wrong length does\n' +
      '        not revert on a native-ETH pool — see this file\'s header.'
  );
} else if (onPinnedPath.length) {
  ok.push(
    `router calldata outside test/ is all on the vendored struct\n` +
      onPinnedPath.map((f) => `        ${f}`).join('\n')
  );
} else {
  ok.push(`no V4 router calldata outside test/ (scanned ${SCAN_ROOTS.join(', ')})`);
}

// ── Report ─────────────────────────────────────────────────────────────────

for (const line of ok) console.log(`PASS  ${line}`);

if (failures.length) {
  console.error('');
  for (const f of failures) console.error(`FAIL  ${f}`);
  process.exit(1);
}

console.log('\nV4 router calldata layout is pinned to the deployed router.');
