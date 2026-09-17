// Pins the frontend's posm action payloads to the infinity-periphery Solidity
// that decodes them.
//
// ── The failure this exists to catch ────────────────────────────────────────
//
// `soat-frontend/src/lib/lpActions.ts` hand-encodes the `(bytes actions,
// bytes[] params)` blob `CLPositionManager.modifyLiquidities` takes. posm does
// not abi-decode it: `CLCalldataDecoder.decodeCLMintParams` reads its fields by
// HARD-CODED calldata offsets, and `decodeActionsRouterParams` recomputes every
// offset and reverts on the slightest deviation. So the frontend's param list
// has to produce one exact byte layout, and the action bytes have to be the
// exact numbers `Actions` assigns.
//
// A submodule bump is all it takes to break that. Insert a field into
// `PoolKey`, move `decodeCLMintParams`'s 0xc0, or renumber an `Actions` opcode,
// and every line of TypeScript still compiles, every Solidity test still
// passes, and every deposit from the UI reverts with `SliceOutOfBounds` — or
// worse, succeeds while performing a different action than the button said.
//
// ── Why this exists next to checkLpActions.ts ──────────────────────────────
//
// `soat-frontend/scripts/checkLpActions.ts` runs the real viem encoder and
// checks the bytes it emits, which this file cannot do — that needs `viem`, and
// npm lives in frontend.yml, which checks out without submodules. But it
// checks those bytes against offsets written in that file, and it used to
// assert the opcodes against `CL_ACTIONS`, the same constant it built the
// payload from, which passes for any value.
//
// So that guard pins the encoder to a set of literals; this one pins those
// literals to the vendored Solidity. Neither is sufficient alone, and this
// half must live in test.yml because that is the job with `lib/`.
//
// Nothing here restates the layout: every number compared below is read out of
// one of the six files named next, because a guard holding its own copy of the
// thing it guards is just another copy to forget.
//
// Usage:  node scripts/checkLpActionsAbi.mjs

import { readFileSync } from 'node:fs';

// Ground truth: the Solidity that will run.
const DECODER = 'lib/infinity-periphery/src/pool-cl/libraries/CLCalldataDecoder.sol';
const ROUTER_DECODER = 'lib/infinity-periphery/src/libraries/CalldataDecoder.sol';
const ACTIONS = 'lib/infinity-periphery/src/libraries/Actions.sol';
const POOL_KEY = 'lib/infinity-core/src/types/PoolKey.sol';

// Files consulted only to resolve user-defined types down to abi types.
const TYPE_SOURCES = [
  'lib/infinity-core/src/types/Currency.sol',
  'lib/infinity-core/src/interfaces/IHooks.sol',
  'lib/infinity-core/src/interfaces/IPoolManager.sol',
];

// The frontend side.
const FE_CONTRACTS = 'soat-frontend/src/lib/contracts.ts';
const FE_LP_ACTIONS = 'soat-frontend/src/lib/lpActions.ts';
const FE_CLMATH = 'soat-frontend/src/lib/clMath.ts';
const FE_GUARD = 'soat-frontend/scripts/checkLpActions.ts';

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
 * Every file here documents the byte layout inline, in prose containing the
 * same offsets, type lists and field names the parsers below look for, so
 * comments have to go before anything is located.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Contents of the `open`/`close` pair opened at the first `anchor` after `from`. */
function balanced(src, from, open, close, label) {
  const at = src.indexOf(open, from);
  if (at < 0) {
    failures.push(`${label}: no \`${open}\` found — was it rewritten?`);
    return null;
  }
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(at + 1, i);
  }
  failures.push(`${label}: unbalanced \`${open}\``);
  return null;
}

/** Single capture group, or null with a recorded failure. */
function capture(src, re, label) {
  const m = re.exec(src);
  if (!m) {
    failures.push(`${label}: pattern ${re} did not match — was it rewritten?`);
    return null;
  }
  return m[1];
}

// ── Solidity type resolution ────────────────────────────────────────────────
//
// `PoolKey` is declared with user-defined types (`Currency`, `IHooks`), while
// the frontend spells the abi types out. Resolution is read from the sources
// rather than tabulated here, so a `Currency` that stops being an address is a
// failure and not a wrong pass.

const ELEMENTARY = /^(address|bool|string|bytes|u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?|bytes([1-9]|[12]\d|3[0-2]))$/;

const typeSources = TYPE_SOURCES.map((p) => ({ path: p, src: stripComments(read(p)) }));

function resolveSolidityType(name, depth = 0) {
  if (depth > 4) return null;
  if (ELEMENTARY.test(name)) {
    if (name === 'uint') return 'uint256';
    if (name === 'int') return 'int256';
    return name;
  }
  for (const { src } of typeSources) {
    // `type Currency is address;`
    const alias = new RegExp(`\\btype\\s+${name}\\s+is\\s+([A-Za-z0-9_]+)\\s*;`).exec(src);
    if (alias) return resolveSolidityType(alias[1], depth + 1);
    // An interface or contract reference is an address in the abi.
    if (new RegExp(`\\b(interface|contract)\\s+${name}\\b`).test(src)) return 'address';
  }
  return null;
}

// ── abi head geometry ───────────────────────────────────────────────────────
//
// The one rule everything below rests on: a STATIC tuple is inlined, so it
// occupies one head slot per field, while a dynamic type occupies exactly one
// head slot holding an offset. That is the whole reason `hookData` lands on
// slot 12 rather than slot 7 — Infinity's PoolKey is six static members, V4's
// was five, and a payload built for the other is well-formed and wrong.

const isDynamic = (abiType) => abiType === 'bytes' || abiType === 'string' || abiType.endsWith('[]');

/** Head slots consumed by one param. `components` is set only for tuples. */
function headSlots(param) {
  if (!param.components) return 1;
  return param.components.some((c) => isDynamic(c)) ? 1 : param.components.length;
}

// ── Read ground truth ───────────────────────────────────────────────────────

const decoderSrc = stripComments(read(DECODER));

/** `uint256 internal constant NAME = 0xNN;` */
function solidityActions() {
  const src = stripComments(read(ACTIONS));
  const out = new Map();
  const re = /uint256\s+internal\s+constant\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(0x[0-9a-fA-F]+|\d+)\s*;/g;
  let m;
  while ((m = re.exec(src)) !== null) out.set(m[1], Number(m[2]));
  return out;
}

/** Fields of `struct PoolKey`, resolved to abi types. */
function solidityPoolKey() {
  const src = stripComments(read(POOL_KEY));
  const body = capture(src, /struct\s+PoolKey\s*\{([^}]*)\}/, POOL_KEY);
  if (body === null) return null;

  return body
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((decl) => {
      const parts = decl.split(/\s+/);
      const solType = parts[0];
      const abi = resolveSolidityType(solType);
      if (abi === null) {
        failures.push(
          `${POOL_KEY}: cannot resolve \`${solType}\` to an abi type. ` +
            'Add its declaring file to TYPE_SOURCES rather than assuming address.'
        );
      }
      return { name: parts[parts.length - 1], solType, abi };
    });
}

/**
 * A decoder entry point, as the layout it actually reads: the declared return
 * types, the calldata offset each one is loaded from, and the `toBytes` index
 * used for the trailing dynamic param.
 */
function solidityDecoder(fnName) {
  const at = decoderSrc.indexOf(`function ${fnName}(`);
  if (at < 0) {
    failures.push(`${DECODER}: no \`function ${fnName}(\` — was it renamed?`);
    return null;
  }
  const bodyStart = decoderSrc.indexOf('{', at);
  const header = decoderSrc.slice(at, bodyStart);
  const body = balanced(decoderSrc, at, '{', '}', `${DECODER} ${fnName}`);
  if (body === null) return null;

  const returnList = capture(header, /returns\s*\(([\s\S]*)\)/, `${DECODER} ${fnName} returns`);
  if (returnList === null) return null;

  const returns = returnList
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((decl) => {
      const parts = decl.split(/\s+/);
      return { solType: parts[0], name: parts[parts.length - 1] };
    });

  // `x := params.offset` / `x := calldataload(params.offset)` are offset 0;
  // `x := calldataload(add(params.offset, 0xNN))` is 0xNN.
  const offsets = new Map();
  const re =
    /([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*(?:calldataload\(\s*add\(\s*params\.offset\s*,\s*(0x[0-9a-fA-F]+)\s*\)\s*\)|calldataload\(\s*params\.offset\s*\)|params\.offset)/g;
  let m;
  while ((m = re.exec(body)) !== null) offsets.set(m[1], m[2] === undefined ? 0 : Number(m[2]));

  const toBytes = /params\.toBytes\(\s*(\d+)\s*\)/.exec(body);

  return { returns, offsets, toBytes: toBytes ? Number(toBytes[1]) : null };
}

// ── Read the frontend side ──────────────────────────────────────────────────

const lpActionsSrc = stripComments(read(FE_LP_ACTIONS));

/** Components of `POOL_KEY_PARAM`, in declaration order. */
function frontendPoolKeyParam() {
  const src = stripComments(read(FE_CLMATH));
  const at = src.indexOf('POOL_KEY_PARAM');
  if (at < 0) {
    failures.push(`${FE_CLMATH}: no POOL_KEY_PARAM — was it renamed?`);
    return null;
  }
  const list = balanced(src, at, '[', ']', `${FE_CLMATH} POOL_KEY_PARAM`);
  if (list === null) return null;

  const out = [];
  const re = /\{\s*name:\s*'([^']+)'\s*,\s*type:\s*'([^']+)'\s*\}/g;
  let m;
  while ((m = re.exec(list)) !== null) out.push({ name: m[1], abi: m[2] });
  return out;
}

const POOL_KEY_COMPONENTS = frontendPoolKeyParam();

/**
 * A `*_PARAM_SPEC` array as a list of abi params. `POOL_KEY_PARAM` is the one
 * identifier allowed in these lists; anything else is a new indirection this
 * parser would silently mis-measure, so it fails instead.
 */
function frontendSpec(name) {
  const at = lpActionsSrc.indexOf(`const ${name} =`);
  if (at < 0) {
    failures.push(`${FE_LP_ACTIONS}: no \`const ${name}\` — was it renamed?`);
    return null;
  }
  const list = balanced(lpActionsSrc, at, '[', ']', `${FE_LP_ACTIONS} ${name}`);
  if (list === null) return null;

  const out = [];
  const re = /\{\s*type:\s*'([^']+)'\s*\}|([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(list)) !== null) {
    const [, inlineType, identifier] = m;
    if (inlineType !== undefined) {
      out.push({ abi: inlineType });
    } else if (identifier === 'POOL_KEY_PARAM') {
      out.push({ abi: 'tuple', components: (POOL_KEY_COMPONENTS ?? []).map((c) => c.abi) });
    } else {
      failures.push(
        `${FE_LP_ACTIONS} ${name}: unrecognised entry \`${identifier}\`. ` +
          'This guard measures head slots and cannot do that through an unknown alias.'
      );
      out.push({ abi: `?${identifier}` });
    }
  }
  return out;
}

/** `CL_ACTIONS` as the frontend declares it. */
function frontendActions() {
  const src = read(FE_CONTRACTS);
  const at = src.indexOf('CL_ACTIONS');
  if (at < 0) {
    failures.push(`${FE_CONTRACTS}: no CL_ACTIONS — was it renamed?`);
    return null;
  }
  const body = balanced(src, at, '{', '}', `${FE_CONTRACTS} CL_ACTIONS`);
  if (body === null) return null;

  const out = new Map();
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(0x[0-9a-fA-F]+|\d+)/g;
  let m;
  while ((m = re.exec(body)) !== null) out.set(m[1], Number(m[2]));
  return out;
}

/** The bare `const NAME = 0xNN` opcode literals in the payload guard. */
function guardOpcodeLiterals(src) {
  const out = new Map();
  const re = /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*(0x[0-9a-fA-F]+)\s*$/gm;
  let m;
  while ((m = re.exec(src)) !== null) out.set(m[1], Number(m[2]));
  return out;
}

// ── Check: action opcodes ───────────────────────────────────────────────────

const solActions = solidityActions();
const feActions = frontendActions();
const guardSrc = stripComments(read(FE_GUARD));
const guardLiterals = guardOpcodeLiterals(guardSrc);

if (solActions.size === 0) {
  failures.push(`${ACTIONS}: parsed zero constants — was the declaration style changed?`);
}

if (feActions) {
  const diffs = [];
  for (const [name, feValue] of feActions) {
    if (!solActions.has(name)) {
      diffs.push(`  ${name} is not defined in ${ACTIONS} at all`);
      continue;
    }
    const solValue = solActions.get(name);
    if (solValue !== feValue) {
      diffs.push(`  ${name}: Solidity 0x${solValue.toString(16).padStart(2, '0')}, frontend 0x${feValue.toString(16).padStart(2, '0')}`);
    }
    // The payload guard asserts against its own literals so it is not
    // comparing CL_ACTIONS with itself; those literals need pinning too.
    if (guardLiterals.has(name) && guardLiterals.get(name) !== solValue) {
      diffs.push(
        `  ${name}: Solidity 0x${solValue.toString(16).padStart(2, '0')}, ` +
          `${FE_GUARD} literal 0x${guardLiterals.get(name).toString(16).padStart(2, '0')}`
      );
    }
  }

  const unpinned = [...feActions.keys()].filter((n) => !guardLiterals.has(n));
  if (unpinned.length) {
    diffs.push(`  ${FE_GUARD} has no literal for ${unpinned.join(', ')} — the payload guard cannot check them without one`);
  }

  if (diffs.length) {
    failures.push(`action opcodes disagree with ${ACTIONS}:\n${diffs.join('\n')}`);
  } else {
    ok.push(`action opcodes: ${feActions.size} names agree across Actions.sol, CL_ACTIONS and the payload guard`);
  }
}

// ── Check: PoolKey is the static 6-field tuple the offsets assume ───────────

const solPoolKey = solidityPoolKey();

if (solPoolKey && solPoolKey.length !== 6) {
  failures.push(
    `${POOL_KEY}: Infinity's PoolKey is 6 fields (currency0, currency1, hooks, poolManager, fee, parameters); ` +
      `parsed ${solPoolKey.length}. This path must point at lib/infinity-core, not v4-core.`
  );
}
if (solPoolKey && solPoolKey.some((f) => f.name === 'tickSpacing')) {
  failures.push(
    `${POOL_KEY}: still declares tickSpacing — that is Uniswap V4's key. Infinity packed it into parameters.`
  );
}

if (solPoolKey && POOL_KEY_COMPONENTS) {
  const diffs = [];
  if (solPoolKey.length !== POOL_KEY_COMPONENTS.length) {
    diffs.push(
      `  field count: Solidity has ${solPoolKey.length}, POOL_KEY_PARAM has ${POOL_KEY_COMPONENTS.length}`
    );
  }
  const n = Math.max(solPoolKey.length, POOL_KEY_COMPONENTS.length);
  for (let i = 0; i < n; i++) {
    const s = solPoolKey[i];
    const f = POOL_KEY_COMPONENTS[i];
    if (!s || !f) {
      diffs.push(`  [${i}] ${s ? `Solidity ${s.solType} ${s.name}, frontend missing` : `Solidity missing, frontend ${f.abi} ${f.name}`}`);
      continue;
    }
    if (s.abi !== f.abi || s.name !== f.name) {
      diffs.push(`  [${i}] Solidity ${s.solType} (${s.abi}) ${s.name}  frontend ${f.abi} ${f.name}`);
    }
  }
  // Static-ness is what makes PoolKey occupy 6 head slots instead of 1.
  // A five-member V4 key would still be static and still encode — it would
  // just hash to a pool that was never initialised. The field list above is
  // the check that refuses that shape; this one only refuses a dynamic member.
  const dynamic = POOL_KEY_COMPONENTS.filter((c) => isDynamic(c.abi));
  if (dynamic.length) {
    diffs.push(
      `  ${dynamic.map((c) => c.name).join(', ')} is dynamic, so the tuple stops being inlined ` +
        'and every offset after it shifts'
    );
  }

  if (diffs.length) {
    failures.push(`PoolKey layout differs from ${POOL_KEY}:\n${diffs.join('\n')}`);
  } else {
    ok.push(`PoolKey: ${solPoolKey.length} fields match by name and abi type, all static`);
  }
}

// ── Check: decoder offsets are the ones the frontend's spec produces ────────

/**
 * Walks a `*_PARAM_SPEC` and the matching decoder entry point side by side,
 * requiring the types to agree AND the head offset each field lands on to be
 * the offset the Solidity loads it from.
 */
function checkDecoder(fnName, specName) {
  const sol = solidityDecoder(fnName);
  const spec = frontendSpec(specName);
  if (!sol || !spec) return;

  const diffs = [];

  if (sol.returns.length !== spec.length) {
    failures.push(
      `${fnName} arity: Solidity returns ${sol.returns.length} params, ${specName} declares ${spec.length}\n` +
        `        solidity: ${sol.returns.map((r) => `${r.solType} ${r.name}`).join(', ')}\n` +
        `        frontend: ${spec.map((s) => s.abi).join(', ')}`
    );
    return;
  }

  let slot = 0;
  let dynamicSeen = null;

  for (let i = 0; i < spec.length; i++) {
    const s = sol.returns[i];
    const f = spec[i];

    // Type agreement. A Solidity struct arrives as a tuple on the frontend;
    // PoolKey's fields are compared against POOL_KEY_PARAM separately above.
    const solAbi = f.components ? 'tuple' : resolveSolidityType(s.solType);
    if (solAbi !== f.abi) {
      diffs.push(`  [${i}] ${s.name}: Solidity ${s.solType} (${solAbi ?? 'unresolved'}), frontend ${f.abi}`);
    }

    const expectedOffset = slot * 32;

    if (isDynamic(f.abi)) {
      // Dynamic params are not calldataload-ed; they are read via toBytes(slot).
      if (dynamicSeen !== null) {
        diffs.push(`  [${i}] ${s.name}: a second dynamic param, which this guard's slot arithmetic does not model`);
      }
      dynamicSeen = { index: i, name: s.name, slot };
      if (sol.toBytes === null) {
        diffs.push(`  [${i}] ${s.name} is dynamic but no \`toBytes(n)\` call was found in ${fnName}`);
      } else if (sol.toBytes !== slot) {
        diffs.push(
          `  [${i}] ${s.name}: Solidity reads toBytes(${sol.toBytes}), but ${specName} puts its head on slot ${slot}`
        );
      }
    } else if (!sol.offsets.has(s.name)) {
      diffs.push(`  [${i}] ${s.name}: no \`${s.name} := calldataload(...)\` found in ${fnName}`);
    } else {
      const got = sol.offsets.get(s.name);
      if (got !== expectedOffset) {
        diffs.push(
          `  [${i}] ${s.name}: Solidity loads 0x${got.toString(16)}, ` +
            `but ${specName} puts it at 0x${expectedOffset.toString(16)} (slot ${slot})`
        );
      }
    }

    slot += headSlots(f);
  }

  if (diffs.length) {
    failures.push(`${fnName} vs ${specName}: ${diffs.length} mismatch(es)\n${diffs.join('\n')}`);
  } else {
    ok.push(
      `${fnName}: ${spec.length} params match ${specName}, head is ${slot} slots, ` +
        `${dynamicSeen ? `${dynamicSeen.name} at toBytes(${dynamicSeen.slot})` : 'no dynamic param'}`
    );
  }
}

checkDecoder('decodeCLMintParams', 'MINT_PARAM_SPEC');
checkDecoder('decodeCLBurnParams', 'BURN_PARAM_SPEC');

// ── Check: the strict-encoding constants the payload guard re-implements ────
//
// `decodeStrict` in checkLpActions.ts reproduces `decodeActionsRouterParams`
// in TypeScript. That is the honest way to check a real encoder's output, but
// it means two magic numbers live in TS. Read both sides and require them to
// agree, so the re-implementation cannot quietly describe a decoder that is no
// longer there.

const routerSrc = stripComments(read(ROUTER_DECODER));
const routerFn = routerSrc.slice(routerSrc.indexOf('function decodeActionsRouterParams('));

const solWord0 = capture(
  routerFn,
  /xor\(\s*calldataload\(\s*_bytes\.offset\s*\)\s*,\s*(0x[0-9a-fA-F]+)\s*\)/,
  `${ROUTER_DECODER} decodeActionsRouterParams word0`
);
const solParamsBase = capture(
  routerFn,
  /paramsLengthOffset\s*:=\s*add\([\s\S]*?,\s*(0x[0-9a-fA-F]+)\s*\)\s*\n/,
  `${ROUTER_DECODER} decodeActionsRouterParams params base`
);
const tsWord0 = capture(guardSrc, /w\[0\]\s*!==\s*(0x[0-9a-fA-F]+)n/, `${FE_GUARD} decodeStrict word0`);
const tsParamsBase = capture(
  guardSrc,
  /ceil32\(actionsLen\)\s*\+\s*(0x[0-9a-fA-F]+)/,
  `${FE_GUARD} decodeStrict params base`
);

if (solWord0 && solParamsBase && tsWord0 && tsParamsBase) {
  const diffs = [];
  if (Number(solWord0) !== Number(tsWord0)) {
    diffs.push(`  actions offset: Solidity requires ${solWord0}, decodeStrict requires ${tsWord0}`);
  }
  if (Number(solParamsBase) !== Number(tsParamsBase)) {
    diffs.push(`  params base: Solidity uses ${solParamsBase}, decodeStrict uses ${tsParamsBase}`);
  }
  if (diffs.length) {
    failures.push(`strict-encoding constants drifted:\n${diffs.join('\n')}`);
  } else {
    ok.push(`strict encoding: actions offset ${solWord0} and params base ${solParamsBase} agree with decodeStrict`);
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

for (const line of ok) console.log(`PASS  ${line}`);

if (failures.length) {
  console.error('');
  for (const f of failures) console.error(`FAIL  ${f}`);
  console.error(
    '\nThe frontend posm payload layout no longer matches the vendored infinity-periphery.\n' +
      'If a submodule was bumped, update soat-frontend/src/lib/lpActions.ts,\n' +
      'src/lib/contracts.ts and scripts/checkLpActions.ts to match the new decoder —\n' +
      'do NOT relax this guard, or every deposit and withdrawal from the LP panel\n' +
      'reverts with SliceOutOfBounds, or silently performs the wrong action.'
  );
  process.exit(1);
}

console.log('\nposm action payload layout is in sync with lib/infinity-periphery.');
