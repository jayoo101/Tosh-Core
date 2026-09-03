// Pins the frontend CREATE2 miner's initcode layout to ToshCloneLib.
//
// The failure this exists to catch is silent and total: if the clone's byte
// layout changes on one side only, the miner still produces a perfectly
// well-formed salt. It is just a salt for a different initcode, so the
// predicted address never materialises and EVERY createLaunch from the UI
// reverts with `InvalidHookSalt`. Nothing in the type system or the Solidity
// test suite notices, because both sides compile and pass in isolation.
//
// ── What this compares ──────────────────────────────────────────────────────
//
// A hook clone's initcode is fully determined by four things: the three
// EIP-1167 hex runs, the position of the implementation address among them,
// and the order and byte-width of the five immutable args. This reads all of
// those out of BOTH sources and requires them to agree token for token:
//
//   solidity  src/libraries/ToshCloneLib.sol      cloneInitcode()
//   frontend  soat-frontend/.../hookMiner.ts      computeCloneInitcode()
//
// It reads the real literals from the real files rather than comparing either
// side against a copy kept here — a guard holding its own third copy of the
// layout is just a third thing to forget to update.
//
// ── Why source parsing and not a differential test ──────────────────────────
//
// There is no compiled artifact to diff against: ToshCloneLib is an `internal`
// library, so every function is inlined into its callers and none of the
// layout survives into an ABI. The bytes are decided entirely by the source
// literals, which is exactly what is compared here.
//
// This guard pins TS to the Solidity SOURCE. `test_hookInitcodeHash_matches
// HandBuiltCloneInitcode` pins that source to the EVM's actual behaviour.
// Together they pin the miner to what `createLaunch` will check on-chain;
// neither one alone is sufficient, so both must stay wired up.
//
// Usage:  node scripts/checkHookMinerTuple.mjs

import { readFileSync } from 'node:fs';

const SOL = 'src/libraries/ToshCloneLib.sol';
const TS = 'soat-frontend/src/app/lib/hookMiner.ts';

/** Total initcode length asserted by both sides: 10 stub + 45 proxy + 76 args. */
const EXPECTED_TOTAL_BYTES = 131;

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
 * Comments have to go before anything else is located: both files document the
 * byte layout inline, in prose that contains the same hex runs and field names
 * the parser is looking for.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Contents of the delimiter pair opened at the first `anchor` after `from`.
 *
 * Anchored on the packing call itself rather than on the function body: a
 * `return` search catches the `returns` in the signature, and the expression
 * has no terminating `;` on the TS side, so both of the obvious bounds are
 * wrong in a way that silently reads into the next declaration.
 */
function packedList(src, from, anchor, open, close, path) {
  const at = src.indexOf(anchor, from);
  if (at < 0) {
    failures.push(`${path}: no \`${anchor}\` found after the function signature — was it rewritten?`);
    return null;
  }
  let depth = 0;
  const bodyStart = at + anchor.length;
  for (let i = bodyStart - 1; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i);
    }
  }
  failures.push(`${path}: unbalanced \`${open}\` after \`${anchor}\``);
  return null;
}

function functionAt(src, needle, path) {
  const start = src.indexOf(needle);
  if (start < 0) {
    failures.push(`${path}: no \`${needle}\` found — was it renamed?`);
    return -1;
  }
  return start;
}

// ── Token model ─────────────────────────────────────────────────────────────
//
// Both sides reduce to the same sequence of emitted fields. `bytes` carries
// the width so a widened cap or a shortened stub is a mismatch, not just a
// reordering.

function tok(kind, value, bytes) {
  return { kind, value, bytes, toString: () => `${kind}(${value}, ${bytes}B)` };
}

/** Solidity: `hex"..."`, bare identifiers, and `uintN(field)` casts. */
function parseSolidity(list) {
  const tokens = [];
  const re = /hex"([0-9a-fA-F]+)"|uint(\d+)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)|([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(list)) !== null) {
    const [, hexLit, castBits, castName, bareName] = m;
    if (hexLit !== undefined) {
      tokens.push(tok('hex', hexLit.toLowerCase(), hexLit.length / 2));
    } else if (castBits !== undefined) {
      tokens.push(tok('field', castName, Number(castBits) / 8));
    } else if (bareName !== undefined) {
      // Every bare identifier in the packed list is an address arg.
      tokens.push(tok('field', bareName, 20));
    }
  }
  return tokens;
}

/** TS: `"0x..."` literals, bare identifiers, and `numberToHex(f, { size: N })`. */
function parseTypescript(list) {
  const tokens = [];
  const re =
    /"0x([0-9a-fA-F]+)"|numberToHex\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*\{\s*size:\s*(\d+)\s*\}\s*\)|([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(list)) !== null) {
    const [, hexLit, numName, numSize, bareName] = m;
    if (hexLit !== undefined) {
      tokens.push(tok('hex', hexLit.toLowerCase(), hexLit.length / 2));
    } else if (numName !== undefined) {
      tokens.push(tok('field', numName, Number(numSize)));
    } else if (bareName !== undefined) {
      tokens.push(tok('field', bareName, 20));
    }
  }
  return tokens;
}

// ── Read both sides ─────────────────────────────────────────────────────────

const solSrc = stripComments(read(SOL));
const tsSrc = read(TS);
const tsClean = stripComments(tsSrc);

const solAt = functionAt(solSrc, 'function cloneInitcode(', SOL);
const tsAt = functionAt(tsClean, 'export function computeCloneInitcode(', TS);

const solList =
  solAt < 0 ? null : packedList(solSrc, solAt, 'abi.encodePacked(', '(', ')', SOL);
const tsList = tsAt < 0 ? null : packedList(tsClean, tsAt, 'concat([', '[', ']', TS);

if (!solList || !tsList) {
  for (const f of failures) console.error(`FAIL  ${f}`);
  process.exit(1);
}

const solTokens = parseSolidity(solList);
const tsTokens = parseTypescript(tsList);

// ── Compare ─────────────────────────────────────────────────────────────────

if (solTokens.length !== tsTokens.length) {
  failures.push(
    `initcode field count: Solidity emits ${solTokens.length}, hookMiner.ts emits ${tsTokens.length}\n` +
      `        solidity: ${solTokens.join(' | ')}\n` +
      `        frontend: ${tsTokens.join(' | ')}`
  );
} else {
  const diffs = [];
  for (let i = 0; i < solTokens.length; i++) {
    const s = solTokens[i];
    const t = tsTokens[i];
    // Field NAMES are allowed to differ only in that Solidity strips no
    // prefix here; both sides use the same names today and keeping the check
    // strict is what catches two same-width fields being transposed.
    if (s.kind !== t.kind || s.bytes !== t.bytes || s.value !== t.value) {
      diffs.push(`  [${i}] solidity=${s}  frontend=${t}`);
    }
  }
  if (diffs.length) {
    failures.push(`initcode layout: ${diffs.length} position(s) differ\n${diffs.join('\n')}`);
  } else {
    ok.push(`initcode layout: ${solTokens.length} fields match, in order and width`);
  }
}

// Total width is the property the creation stub's hard-coded PUSH1 depends on,
// so check it even when the sequences agree.
const solTotal = solTokens.reduce((n, t) => n + t.bytes, 0);
const tsTotal = tsTokens.reduce((n, t) => n + t.bytes, 0);

if (solTotal !== EXPECTED_TOTAL_BYTES || tsTotal !== EXPECTED_TOTAL_BYTES) {
  failures.push(
    `initcode length: expected ${EXPECTED_TOTAL_BYTES} B, got ${solTotal} B (solidity) / ${tsTotal} B (frontend).\n` +
      '        The creation stub PUSH1es the runtime length, so this constant is\n' +
      '        load-bearing: past 210 B of args the stub needs a PUSH2.'
  );
} else {
  ok.push(`initcode length: ${solTotal} B on both sides`);
}

// `CLONE_INITCODE_BYTES` is exported for callers to sanity-check against, so a
// stale value there misleads even when the layout itself is correct.
const declared = tsSrc.match(/CLONE_INITCODE_BYTES\s*=\s*(\d+)/);
if (!declared) {
  failures.push(`${TS}: CLONE_INITCODE_BYTES not found`);
} else if (Number(declared[1]) !== EXPECTED_TOTAL_BYTES) {
  failures.push(
    `${TS}: CLONE_INITCODE_BYTES is ${declared[1]}, but the layout above is ${EXPECTED_TOTAL_BYTES} B`
  );
} else {
  ok.push(`CLONE_INITCODE_BYTES agrees at ${declared[1]}`);
}

// ── Report ──────────────────────────────────────────────────────────────────

for (const line of ok) console.log(`PASS  ${line}`);

if (failures.length) {
  console.error('');
  for (const f of failures) console.error(`FAIL  ${f}`);
  console.error(
    `\nThe frontend salt miner no longer matches ${SOL}.\n` +
      `Update computeCloneInitcode in ${TS} to mirror cloneInitcode, or every\n` +
      'createLaunch from the UI will revert with InvalidHookSalt.'
  );
  process.exit(1);
}

console.log('\nhookMiner.ts clone initcode layout is in sync with ToshCloneLib.');
