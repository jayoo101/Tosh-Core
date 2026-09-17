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
// ── What the BSC cutover did NOT change ────────────────────────────────────
//
// The header above warned that a second target chain would turn the pinned
// layout into a map. It did not, and the reason is worth recording so the next
// reader does not go looking for the map.
//
// BSC's UniversalRouter 2.1.1 (0x8B844f885672f333Bc0042cB669255f93a4C1E6b) is
// the same compiled build as Robinhood's: both are 24,546 bytes, and the two
// runtimes differ only where a constructor immutable is baked in. Measured, not
// assumed — `test_forkBsc_deployedRouterReadsTheSixthField` drives a real buy
// through it on a mainnet fork and the sixth field arrives. One layout, now
// corroborated on two chains.
//
// BSC also carries an OLDER router at 0x1906c1d672b88cD1B9aC7593301cA990F94Eae07,
// 19,499 bytes, a different build entirely. That one is the Ethereum-era hazard
// wearing a BSC address: point this protocol at it and `hookData` goes to the
// quiet case below — the swap succeeds, the tax is right, and the hook never
// sees its payload. Check 5 exists solely to keep that address out of anything
// that is not documenting it as a trap.
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
//   1. Every fork suite imports the vendored struct and does NOT carry a
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
//   5. BSC's older, five-field-era router appears nowhere except the one test
//      that names it as the wrong one. Checks 2-4 pin the LAYOUT; this pins the
//      ADDRESS, which is the other half of the same mistake — a correct tuple
//      sent to the wrong decoder fails exactly as quietly.
//
// Usage:  node scripts/checkV4RouterTuple.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Every suite that builds router calldata against a live chain. Both encode the
 * same vendored struct against the same build, so check 1 runs once per entry
 * rather than picking one and hoping the other followed.
 */
const FORK_TESTS = ['test/ToshV5Fork.t.sol', 'test/ToshV5ForkBsc.t.sol'];
const IV4ROUTER = 'lib/v4-periphery/src/interfaces/IV4Router.sol';

/**
 * BSC's older UniversalRouter, and the one file allowed to name it. That file
 * asserts it is a different build from 2.1.1, which is the whole reason the
 * address is written down anywhere — see check 5.
 */
const OLD_BSC_ROUTER = '0x1906c1d672b88cD1B9aC7593301cA990F94Eae07';
const OLD_BSC_ROUTER_HOME = 'test/ToshV5ForkBsc.t.sol';
const DECODER = 'lib/v4-periphery/src/libraries/CalldataDecoder.sol';

/**
 * The tuple the deployed router decodes, in order. Pinned as a literal because
 * there is no parseable source for it in this tree — the authority is the
 * verified source on the explorer, corroborated by
 * `test_fork_deployedRouterReadsTheSixthField` on Robinhood and
 * `test_forkBsc_deployedRouterReadsTheSixthField` on BSC, both against the live
 * contract.
 *
 * Nominally a per-chain fact, and it stayed a single literal across the BSC
 * cutover only because both routers are the same compiled build. A third chain
 * earns no such assumption: measure it before adding it, and if it disagrees,
 * this becomes a map and every check below runs once per entry.
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

/**
 * Infinity's `PoolKey` carries SIX members, not five — it names its pool
 * manager, which Uniswap's does not need. So the same-looking swap tuple has a
 * different shape, and the two cannot share a HEAD_SLOTS map.
 *
 * Both `PoolKey` widths are derived from their vendored sources below rather
 * than written here, because that single number is what makes the two layouts
 * collide at the same total size — see check 6.
 */
const INFINITY_HEAD_SLOTS = { bool: 1, uint128: 1, uint256: 1, bytes: 1 };

/**
 * Types allowed as `PoolKey` members when deriving its width. A member outside
 * this set is a hard error: `bytes`/`string`/arrays would make `PoolKey`
 * dynamic, which would stop it inlining into the head at all and quietly
 * invalidate every slot number in this file.
 */
const STATIC_POOLKEY_MEMBERS = new Set([
  'Currency',
  'IHooks',
  'ICLHooks',
  'IPoolManager',
  'uint24',
  'int24',
  'bytes32',
  'address',
]);

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

/**
 * Width of a `PoolKey` in head slots, derived from its vendored source. Every
 * member must be a known static type, so a dynamic member is reported rather
 * than counted as one slot.
 */
function poolKeyWidth(path) {
  const fields = structFields(stripComments(read(path)), 'PoolKey', path);
  if (!fields) return null;

  for (const [type, name] of fields) {
    if (!STATIC_POOLKEY_MEMBERS.has(type)) {
      failures.push(
        `${path}: \`PoolKey\` member \`${type} ${name}\` is not a known static type.\n` +
          '        If it is dynamic, PoolKey no longer inlines into the tuple head and\n' +
          '        every head-slot number in this guard is wrong. If it is static, add\n' +
          '        it to STATIC_POOLKEY_MEMBERS.'
      );
      return null;
    }
  }
  return fields.length;
}

/** Total head slots, or null if the layout contains a type this guard cannot size. */
function headSlots(fields, path, slots_ = HEAD_SLOTS) {
  let n = 0;
  for (const [type, name] of fields) {
    const slots = slots_[type];
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

// ── 0 · Both PoolKey widths, derived rather than assumed ───────────────────
//
// The literal `5` this file used to carry was the one number holding up every
// slot offset below, and it is also the number that differs between the two
// AMMs. Derive it.

const V4_POOLKEY = 'lib/v4-core/src/types/PoolKey.sol';
const INFINITY_POOLKEY = 'lib/infinity-core/src/types/PoolKey.sol';

const v4PoolKeyWidth = poolKeyWidth(V4_POOLKEY);
const infinityPoolKeyWidth = poolKeyWidth(INFINITY_POOLKEY);

if (v4PoolKeyWidth !== null) {
  if (v4PoolKeyWidth !== HEAD_SLOTS.PoolKey) {
    failures.push(
      `${V4_POOLKEY}: PoolKey now has ${v4PoolKeyWidth} members, not ${HEAD_SLOTS.PoolKey}.\n` +
        '        Every head-slot offset this guard reports shifts with it, and the\n' +
        '        deployed router still decodes the old width. Re-measure against the\n' +
        '        chain before updating HEAD_SLOTS.'
    );
  } else {
    ok.push(`v4-core PoolKey is ${v4PoolKeyWidth} static members, as the deployed router decodes`);
  }
}

if (infinityPoolKeyWidth !== null) {
  INFINITY_HEAD_SLOTS.PoolKey = infinityPoolKeyWidth;
}

// ── 1 · The fork test imports the struct rather than restating it ───────────

for (const forkTest of FORK_TESTS) {
  const forkSrc = stripComments(read(forkTest));

  if (/struct\s+ExactInputSingleParams\s*\{/.test(forkSrc)) {
    failures.push(
      `${forkTest} declares its own \`ExactInputSingleParams\`.\n` +
        '        It must import IV4Router.ExactInputSingleParams instead. A local copy\n' +
        '        only made sense while the deployed router and lib/ disagreed, which was\n' +
        '        true on Ethereum and is true on neither chain we target now. A copy\n' +
        '        kept past that point drifts silently: nothing in either type system\n' +
        '        relates the two. If the router really did diverge again, invert check 2\n' +
        '        rather than reintroducing an unchecked duplicate.'
    );
  } else if (!/\bIV4Router\.ExactInputSingleParams\b/.test(forkSrc)) {
    failures.push(
      `${forkTest} no longer encodes IV4Router.ExactInputSingleParams.\n` +
        '        The fork suites are the only place production router calldata is built,\n' +
        '        so if one stopped building any, checks 2-3 are guarding less than they\n' +
        '        appear to and this guard is drifting towards decorative.'
    );
  } else {
    ok.push(`${forkTest} encodes the vendored IV4Router.ExactInputSingleParams`);
  }
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
        `        ${FORK_TESTS.join(' and ')} encode with lib/, so they are now\n` +
        '        sending the live router a tuple it will misread — and misreading is not\n' +
        '        the same as reverting.\n' +
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
    '0x8876789976dEcBfCbBbe364623C63652db8C0904', // Robinhood 4663/46630
    '0x8B844f885672f333Bc0042cB669255f93a4C1E6b', // BSC 56, UniversalRouter 2.1.1
    OLD_BSC_ROUTER, // BSC 56, the older build — see check 5
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

// ── 5 · BSC's older router is named only where it is named as wrong ─────────
//
// Checks 2-4 pin the tuple. This pins the destination, because the two failure
// modes are indistinguishable from the outside: a six-field tuple sent to the
// five-field-era decoder loses `hookData` in exactly the quiet way the header
// describes. `test/` is in scope here and not in check 4 — the trap lives in a
// test, so a test is precisely where it could spread.

const oldRouterHits = [];

for (const root of [...SCAN_ROOTS, 'test']) {
  for (const file of walk(root, [])) {
    const rel = relative('.', file).split(sep).join('/');
    if (rel === SELF || rel === OLD_BSC_ROUTER_HOME) continue;

    const src = stripComments(read(file));
    const at = src.toLowerCase().indexOf(OLD_BSC_ROUTER.toLowerCase());
    if (at >= 0) {
      oldRouterHits.push(`  ${rel}:${src.slice(0, at).split('\n').length}`);
    }
  }
}

if (oldRouterHits.length) {
  failures.push(
    `BSC's older UniversalRouter (${OLD_BSC_ROUTER}) is referenced\n` +
      `        outside ${OLD_BSC_ROUTER_HOME}:\n${oldRouterHits.join('\n')}\n\n` +
      '        That address is a 19,499-byte build, not the 24,546-byte 2.1.1 this\n' +
      '        protocol encodes for. Sending it a correct tuple is as quiet as sending\n' +
      '        the correct router a wrong one: the swap settles, the tax is right, and\n' +
      '        hookData is silently dropped. Use 2.1.1\n' +
      '        (0x8B844f885672f333Bc0042cB669255f93a4C1E6b).'
  );
} else {
  ok.push(`BSC's older router is named only in ${OLD_BSC_ROUTER_HOME}, as the wrong one`);
}

// ── 6 · The restated Infinity tuple, and the size collision ────────────────
//
// The Infinity spike restates `CLSwapExactInputSingleParams` instead of
// importing it, and the reason is not laziness: infinity-periphery reaches
// infinity-core through an `infinity-core/` prefix, and adding that remapping
// moves every production contract's metadata hash. Measured — the hook's
// creation code changed keccak on a remapping no production file even imports,
// because solc records the whole remappings list in metadata.
//
// So the hand-roll is forced, and a forced hand-roll is exactly what checks 1-3
// refuse to allow unguarded. This is its guard.
//
// It also pins the nastiest fact the router spike turned up. The two AMMs'
// decoders are the SAME hazard — both `swapParams := add(params.offset,
// calldataload(params.offset))`, no length check past a floor — and both floors
// are the same number:
//
//   Uniswap:  PoolKey(5) + bool + uint128 + uint128 + uint256 + bytes = 10 head
//   Infinity: PoolKey(6) + bool + uint128 + uint128 +           bytes = 10 head
//
// Identical encoded size, different meanings. The floor cannot tell them apart.
// Sending one to the other is caught only because Uniswap's `fee` lands on the
// slot Infinity reads as `poolManager`, and that field is validated — luck, one
// field in one position, measured by
// `test_forkInfinity_theUniswapShapedTupleIsNotInterchangeable`.

const ICLROUTERBASE = 'lib/infinity-periphery/src/pool-cl/interfaces/ICLRouterBase.sol';
const CL_DECODER = 'lib/infinity-periphery/src/pool-cl/libraries/CLCalldataDecoder.sol';
const INFINITY_SPIKE = 'test/ToshV5ForkInfinity.t.sol';
const INTERCHANGE_TEST = 'test_forkInfinity_theUniswapShapedTupleIsNotInterchangeable';

const STRUCT = 'CLSwapExactInputSingleParams';

const vendoredInfinity = structFields(stripComments(read(ICLROUTERBASE)), STRUCT, ICLROUTERBASE);
const spikeSrc = stripComments(read(INFINITY_SPIKE));
const restatedInfinity = structFields(spikeSrc, STRUCT, INFINITY_SPIKE);

let infinityHead = null;

if (vendoredInfinity && restatedInfinity) {
  infinityHead = headSlots(vendoredInfinity, ICLROUTERBASE, INFINITY_HEAD_SLOTS);

  if (render(vendoredInfinity) === render(restatedInfinity)) {
    ok.push(
      `${INFINITY_SPIKE} restates infinity-periphery's ${STRUCT} exactly\n` +
        `        ${render(vendoredInfinity)}`
    );
  } else {
    failures.push(
      `${INFINITY_SPIKE} has drifted from infinity-periphery's ${STRUCT}.\n` +
        `        vendored (${vendoredInfinity.length} fields): ${render(vendoredInfinity)}\n` +
        `        restated (${restatedInfinity.length} fields): ${render(restatedInfinity)}\n\n` +
        '        The restatement exists because importing infinity-periphery needs an\n' +
        '        `infinity-core/` remapping, which moves every production metadata hash.\n' +
        '        That makes this guard the ONLY thing relating the two, so a mismatch\n' +
        '        here is the silent-calldata hazard with nothing else watching it.'
    );
  }
}

const clFloorMatch = stripComments(read(CL_DECODER))
  .match(/function decodeCLSwapExactInSingleParams[\s\S]*?lt\(params\.length,\s*(0x[0-9a-fA-F]+)\)/);

if (!clFloorMatch) {
  failures.push(
    `${CL_DECODER}: could not find the \`lt(params.length, ...)\` floor in\n` +
      '        decodeCLSwapExactInSingleParams — the decoder was restructured and this\n' +
      '        guard no longer knows what it is checking.'
  );
} else if (infinityHead !== null) {
  const clFloor = Number(clFloorMatch[1]);
  const expected = (infinityHead + 1) * 32;

  if (clFloor !== expected) {
    failures.push(
      `${CL_DECODER}: minimum-length floor disagrees with its own struct.\n` +
        `        floor in source: 0x${clFloor.toString(16)} (${clFloor} bytes)\n` +
        `        ${infinityHead} head slots + 1 length word: 0x${expected.toString(16)}\n` +
        '        One of the two was updated without the other.'
    );
  } else {
    ok.push(`Infinity decoder floor 0x${clFloor.toString(16)} matches its ${infinityHead} head slots`);
  }

  // The collision. Not a failure — if the two sizes ever diverge the hazard
  // gets SAFER, because then the length floor alone separates them. But while
  // they match, the test that measures the near-miss has to exist.
  if (libHead !== null && libHead === infinityHead) {
    if (!spikeSrc.includes(INTERCHANGE_TEST)) {
      failures.push(
        `Uniswap and Infinity swap tuples are both ${libHead} head slots, so neither\n` +
          `        decoder's length floor can reject the other's calldata — but\n` +
          `        ${INTERCHANGE_TEST}\n` +
          `        is gone from ${INFINITY_SPIKE}.\n\n` +
          '        That test is what establishes the mismatch is loud rather than quiet,\n' +
          '        and it is loud for one incidental reason: Uniswap\'s `fee` occupies the\n' +
          '        slot Infinity reads as `poolManager`, which is validated. Nothing\n' +
          '        guarantees that survives a version bump. Keep it measured.'
      );
    } else {
      ok.push(
        `both swap tuples are ${libHead} head slots — the collision is measured by\n` +
          `        ${INTERCHANGE_TEST}`
      );
    }
  }
}

// ── Report ─────────────────────────────────────────────────────────────────

for (const line of ok) console.log(`PASS  ${line}`);

if (failures.length) {
  console.error('');
  for (const f of failures) console.error(`FAIL  ${f}`);
  process.exit(1);
}

console.log('\nV4 router calldata layout is pinned to the deployed router.');
