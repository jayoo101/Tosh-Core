#!/usr/bin/env node
//
// CI guard: every code identifier the docs name in backticks must exist
// somewhere in the repo.
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
//   The §5.12 sweep found `docs/SECURITY_AUDIT.md` §1.2 scoping in a function
//   called `_verifyPoGSignature` that has never existed in `src/` — the PoG
//   signature check is inline in `registerPoG`. On its own that is a stale name
//   in a scope paragraph. What made it a finding is that `INCIDENT_RESPONSE.md`
//   §Q4 stated the red-team drill's PASS CRITERION as "all attempts fail at
//   `_verifyPoGSignature`", which cannot be observed: you cannot watch calls
//   fail at a function that does not exist, so the drill could have been
//   recorded as passed by anyone who did not go looking.
//
//   The same probe found `mintFromShelf` in the invariant-coverage notes; the
//   real function is `mintBondingCurve`. Two in one pass, in prose nobody
//   compiles, is a class of drift rather than an accident — hence a guard.
//
// ── What it does NOT claim ──────────────────────────────────────────────────
//
//   "Exists somewhere in the repo" is a deliberately weak test. It will not
//   catch a name that is real but attributed to the wrong contract, nor one
//   whose behaviour the prose describes incorrectly. It catches invented and
//   renamed symbols, which is what both findings were, and it does so with no
//   baseline to maintain.
//
// Usage: node scripts/checkDocSymbols.mjs
// Exit:  0 clean · 1 unknown identifier(s) · 2 guard could not run

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchored to this file, not to the caller's cwd: the npm alias lives in
// soat-frontend/package.json and runs with that directory as cwd.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOC_DIR = join(REPO, 'docs');

// ── Scope ───────────────────────────────────────────────────────────────────
//
//   The three documents where a stale symbol has a SECURITY consequence: the
//   audit dossier tells a reviewer what to review, the runbook tells an
//   operator what to check under pressure, and the monitoring doc says what
//   the alerts mean. In all three, a name that resolves to nothing turns a
//   claim into something no one can verify — which is what both findings were.
//
//   `PRD-v5.0.md` and `ROBINHOOD_MIGRATION.md` are deliberately NOT gated.
//   They describe product behaviour and a migration that has already happened,
//   and a stale name there is a spec nit, not an unverifiable control. They are
//   not clean: this guard was run across them once and found three UI symbols
//   that no longer exist anywhere in `soat-frontend/` —
//
//     `feeMode`, `handleDeposit`, `handleMineSalt`
//
//   — cited in `PRD-v5.0.md` with precise line ranges (`:516-520`, `:484-505`)
//   against a launch page that now exposes a single `handleLaunch`. Fixing those
//   sections means rewriting product spec, which is a separate job from this
//   sweep, so the drift is OPEN.
//
//   They do appear in ALLOW below, because §5.12 quotes them by name and this
//   guard reads §5.12. That is a quoting concession, not a disposition: their
//   reason strings say OPEN, and the day one of them starts resolving is the day
//   to reread §5.12 rather than to delete the entry.
const DOCS = ['SECURITY_AUDIT.md', 'INCIDENT_RESPONSE.md', 'ONCHAIN_MONITORING.md'];

// Backticked identifiers, >= 6 chars, optional trailing (). Both cases are
// wanted: `registerPoG` for functions and members, and `InvalidSignature` for
// the custom errors — which matter MORE than the functions here, because Q4's
// pass criterion in INCIDENT_RESPONSE.md is built almost entirely out of error
// names, and a dangling error name is exactly as uncheckable as a dangling
// function. The first version of this guard only matched lower-case starts and
// so read straight past every one of them.
//
// `isCandidate` drops SCREAMING_SNAKE_CASE, which is env vars and Solidity
// constants whose names legitimately appear in prose without being greppable
// symbols. A single lower-case letter anywhere is enough to distinguish them.
//
// It deliberately does NOT drop interior underscores, though an earlier version
// did, folding them in with the env vars. That was the guard's largest blind
// spot and it survived two rounds of hardening: every Foundry test is named
// `test_thing_doesWhat`, so the rule skipped the entire class — and a cited test
// name is the most common form of EVIDENCE in these documents. "Fixed, see
// `test_x`" is a claim that rests completely on `test_x` existing, so a dangling
// one is worse than a dangling function name, which is usually just narration.
// Caught by mutation: renaming a real test in `test/` left the guard silent
// while §5.11 and the PRD went on citing the old name.
const IDENT = /`(_?[A-Za-z][A-Za-z0-9_]{5,})\(?\)?`/g;

const isCandidate = (n) => {
  const body = n.startsWith('_') ? n.slice(1) : n;
  return /[a-z]/.test(body); // must have a lower-case letter: excludes ALLCAPS
};

// Solidity/JS keywords and ordinary words that show up in backticks as prose.
const PROSE = new Set([
  'address', 'require', 'revert', 'return', 'returns', 'external', 'internal',
  'public', 'private', 'immutable', 'constant', 'mapping', 'struct', 'contract',
  'library', 'function', 'modifier', 'payable', 'receive', 'fallback',
  'assembly', 'unchecked', 'keccak', 'bytes32', 'uint256', 'uint128', 'uint160',
  'uint112', 'uint224', 'int128', 'string', 'memory', 'calldata', 'storage',
  'emit', 'indexed', 'override', 'virtual', 'selector', 'testnet', 'mainnet',
  'chainid', 'timestamp', 'origin', 'sender', 'value', 'balance', 'transfer',
]);

// Names the docs mention precisely BECAUSE they are absent, or that belong to
// something outside the tree. Each needs a reason; an entry without one is a
// place to hide the next `_verifyPoGSignature`.
const ALLOW = new Map([
  ['_headers', 'asserted ABSENT — §5.1 proves no Cloudflare/Netlify edge config exists'],
  ['webSocket', 'asserted ABSENT — §5.1 proves no viem webSocket() transport is used'],
  ['master', 'a git branch name in the submodule pin table, not a code symbol'],
  // A dossier that records a stale-name finding has to be able to print the
  // stale name. Both appear in §5.12 for exactly that reason. Note what an ALLOW
  // entry costs: the name is skipped BEFORE the search runs, so this guard would
  // not notice if either symbol came back into `src/`. Nothing here watches for
  // that, and pretending otherwise would be the same kind of unverifiable claim
  // §5.12 is about.
  ['_verifyPoGSignature', 'the §5.12 finding itself — named to record that it never existed'],
  ['mintFromShelf', 'the §5.12 finding itself — the real name is mintBondingCurve'],
  // The third finding, and the one that shows the cost above is real: the whole
  // point of `EthNotTokens` is that it is the dangling TAIL of a line-wrapped
  // `test_buyTax_exactOutputSkimsEthNotTokens`. The full name resolves and is
  // checked normally wherever §5.11 and the PRD cite it; only the orphaned half
  // is skipped. So this entry does not blind the guard to the test going away.
  ['EthNotTokens', 'the §5.12 finding itself — the wrapped tail of test_buyTax_exactOutputSkimsEthNotTokens'],
  // Named in §5.12 as UNFIXED drift in PRD-v5.0.md, which is outside this
  // guard's gate. Allowlisted only because the dossier quotes them; the drift
  // itself is open. If one of these starts resolving, the PRD may have been
  // repaired — reread §5.12 before deleting the entry.
  ['feeMode', 'OPEN PRD drift quoted in §5.12 — absent from soat-frontend/'],
  ['handleDeposit', 'OPEN PRD drift quoted in §5.12 — absent from soat-frontend/'],
  ['handleMineSalt', 'OPEN PRD drift quoted in §5.12 — absent from soat-frontend/'],
]);

function fail(code, msg) {
  console.error(msg);
  process.exitCode = code;
}

const docs = DOCS.filter((f) => existsSync(join(DOC_DIR, f)));
if (docs.length !== DOCS.length) {
  const gone = DOCS.filter((f) => !docs.includes(f));
  fail(2, `check:doc-symbols cannot find gated doc(s): ${gone.join(', ')}`);
  process.exit();
}

// ── Collect candidates, remembering where each was seen ─────────────────────
const seenIn = new Map();
for (const f of docs) {
  const text = readFileSync(join(DOC_DIR, f), 'utf8');
  for (const m of text.matchAll(IDENT)) {
    const name = m[1];
    if (!isCandidate(name) || PROSE.has(name) || ALLOW.has(name)) continue;
    if (!seenIn.has(name)) seenIn.set(name, new Set());
    seenIn.get(name).add(f);
  }
}

if (seenIn.size === 0) {
  console.log('check:doc-symbols — no identifiers to check (suspicious; is the regex still right?)');
  process.exitCode = 2;
  process.exit();
}

// ── One ripgrep over the tree, excluding the docs themselves ────────────────
const PATTERN_NAME = '.doc-symbols.pattern';
const patternFile = join(REPO, PATTERN_NAME);
// A leading `\b` cannot precede an underscore when the character before it in
// the source is a word character, and the docs abbreviate shared test prefixes
// exactly that way — `test_ladderCuration_rejectsForeignTokens` /
// `_rejectsUnlaunchedProjects`. So anchor the tail only for `_`-leading names,
// which still leaves a genuinely invented `_foo` unmatched.
writeFileSync(
  patternFile,
  [...seenIn.keys()].map((n) => (n.startsWith('_') ? `${n}\\b` : `\\b${n}\\b`)).join('\n'),
  'utf8'
);

let found = new Set();
try {
  const rg = spawnSync(
    'rg',
    [
      '-o', '-N', '--no-heading', '--no-filename',
      '-f', patternFile,
      '--glob', '!docs/**',
      '--glob', '!node_modules/**',
      '--glob', '!out/**',
      '--glob', '!cache/**',
      '--glob', `!${PATTERN_NAME}`,
      // This file names stale symbols in its own header in order to explain
      // itself. Without this exclusion the guard reports every such symbol as
      // present, on the strength of its own prose, and silently stops working —
      // which is how the mutation harness first found it broken.
      '--glob', '!scripts/checkDocSymbols.mjs',
      // Generated artifacts are not evidence that a symbol exists. `gasreport.txt`
      // is tracked, 130 KB, and lists the name of every test that existed when it
      // was last regenerated; `slither-baseline.json` embeds source snippets the
      // same way. Either one keeps a DELETED symbol resolving indefinitely, which
      // is the precise failure this guard exists to prevent — a doc citing a test
      // that is gone, passing because a stale report still mentions it. Found by
      // mutation: renaming a real test in `test/` stayed green until these were
      // excluded. Regenerating them is not a fix; being outside the haystack is.
      '--glob', '!gasreport.txt',
      '--glob', '!slither*.json',
      '--glob', '!*-report.json',
      '--glob', '!*.tsbuildinfo',
      '--glob', '!**/*.lock',
      '--glob', '!**/pnpm-lock.yaml',
      REPO,
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
  // rg exits 1 on "no matches", which is a legitimate (if alarming) result.
  if (rg.error) throw rg.error;
  if (rg.status !== 0 && rg.status !== 1) {
    throw new Error(`rg exited ${rg.status}: ${(rg.stderr || '').slice(0, 400)}`);
  }
  found = new Set((rg.stdout || '').split(/\r?\n/).filter(Boolean));
} catch (e) {
  unlinkSync(patternFile);
  fail(2, `check:doc-symbols could not run ripgrep — ${e.message}`);
  process.exit();
}
unlinkSync(patternFile);

const missing = [...seenIn.keys()].filter((n) => !found.has(n)).sort();

if (missing.length === 0) {
  console.log(
    `check:doc-symbols OK — ${seenIn.size} identifiers named in ${docs.length} docs, all present in the tree ` +
      `(${ALLOW.size} allowlisted as deliberately absent)`
  );
  process.exit();
}

console.error(`check:doc-symbols FAILED — ${missing.length} identifier(s) named in docs but found nowhere:\n`);
// Width is measured, not guessed at 38: test names run past 40 characters and a
// fixed column silently glued the name to the label.
const col = Math.max(...missing.map((n) => n.length)) + 5;
for (const n of missing) {
  console.error(`  \`${n}\``.padEnd(col) + `named in: ${[...seenIn.get(n)].join(', ')}`);
}
console.error(
  '\nEither the symbol was renamed (fix the doc to match the code), or it never\n' +
    'existed (fix the doc and check whether any claim resting on it still holds),\n' +
    'or the doc names it precisely because it is absent (add it to ALLOW with a reason).'
);
process.exitCode = 1;
