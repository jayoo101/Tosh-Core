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

import { readFileSync, existsSync } from 'node:fs';
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
//   `PRD-v5.0.md` is now gated too, which it was not when this guard was
//   written. The reasoning then was that a stale name in a product spec is a
//   spec nit rather than an unverifiable control, so the drift this guard found
//   in it — `feeMode`, `handleDeposit`, `handleMineSalt`, cited with precise
//   line ranges against a launch page that had replaced all three — was left
//   OPEN and the names were allowlisted so §5.12 could quote them.
//
//   That deferral did not survive contact with the numbers. Gating the PRD
//   turned out to cost nine stale references in total, not three: the other six
//   were `ConnectGate`, `GenesisWindowSelect`, `RecentEventsTicker` and three
//   test names carrying a `test_hook_ctor_` prefix that the EIP-1167 clone
//   refactor had renamed. Nine is a morning's work, and leaving the document
//   ungated is what let three become nine in the first place. Chapter 6 is
//   rewritten against the code as it stands and the gate is now closed behind
//   it — see SECURITY_AUDIT.md §5.18.
//
//   `ROBINHOOD_MIGRATION.md` stays ungated: it describes a migration that has
//   already happened, so its names are meant to read as history.
//   `C1_RUNBOOK.md` is gated because it is the one document that gets executed
//   rather than read, once, against real money — a script name that has drifted
//   is discovered at the broadcast. It was added the day it was written, before
//   it had a chance to rot.
//
//   `PRE_MAINNET_CHECKLIST.md` and `SIGNER_BRIEF.md` were added 2026-09-06, and
//   the reason they were not here already does not survive inspection: the
//   checklist is the launch gate and names ~40 scripts and contracts in its
//   evidence column, and the brief is what a Safe signer reads before signing.
//   Both were ungated while four less operational documents were not. Adding
//   them cost three ALLOW entries and found no drift — which is the good
//   outcome, not a reason it was not worth doing.
const DOCS = [
  'SECURITY_AUDIT.md',
  'INCIDENT_RESPONSE.md',
  'ONCHAIN_MONITORING.md',
  'PRD-v5.0.md',
  'C1_RUNBOOK.md',
  'PRE_MAINNET_CHECKLIST.md',
  'SIGNER_BRIEF.md',
];

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
  // A git commit sha, same category as `master`: an object name, not a symbol.
  //
  // Worth recording WHY it only started dangling on 2026-09-12, because the
  // answer is not "the docs rotted". It resolved for four days by accident:
  // `broadcast/DeployMainnet.s.sol/4663/run-latest.json` carried
  // `"commit": "d0220e2"`, and that file is tracked, so the haystack contained
  // the literal. Redeploying overwrote the artefact with `9b9d9ce` and the
  // string left the tree — which means this guard was, without anyone intending
  // it, checking that the deploy artefact still described the deployment the
  // docs describe. It stopped being true and the guard said so.
  //
  // The claim resting on the name survives: `d0220e279218243754c0c85363b8ec786c7caffb`
  // is still in history, and the superseded artefact is recoverable from
  // `b938da7`. Cost is nil in the usual direction — `src/` gaining a `d0220e2`
  // string would not falsify a statement about which commit was deployed.
  ['d0220e2', 'the 2026-09-08 deploy commit — a git object, not a code symbol; artefact recoverable from b938da7'],
  // Three JSON-RPC method names, same category as `master`: they are names on
  // someone else's node, not symbols in this tree, so "found nowhere" is the
  // expected result rather than drift. PRE_MAINNET_CHECKLIST.md §7 names them
  // precisely to record that the Robinhood node does NOT serve them, which is
  // why counting one wallet's sends there would mean walking 54.8 M blocks.
  //
  // The ALLOW cost documented below is unusually low for these three. It bites
  // when a skipped name comes back into `src/` unnoticed — but the claim here is
  // about what the node serves, not about what this repo calls, so our tree
  // gaining a `trace_filter` string would not falsify the prose. Contrast
  // `eth_getLogs` in the same paragraph, which is deliberately NOT allowlisted:
  // it resolves in the tree on its own and is checked normally.
  ['eth_getTransactionsByAddress', 'a JSON-RPC method the node does not serve — §7 names it to record its absence'],
  ['trace_filter', 'a JSON-RPC method absent from the Robinhood node — §7 names it to record that'],
  ['arbtrace_filter', 'the Nitro-flavoured spelling, absent from the same node — §7'],
  // A function on the Gnosis Safe, which this repository consumes and does not
  // contain: same category as `master` and the three method names above. It is
  // named because every Safe batch this project has sent was dry-run through it
  // first, and a dossier that reports "the simulation returned success" has to
  // be able to say what performed the simulation. The ALLOW cost is nil in the
  // usual direction — a name arriving in `src/` would matter, and nothing here
  // would notice — but `src/` gaining a `simulateAndRevert` would not falsify a
  // claim about what the Safe does, which is the same reasoning as `trace_filter`.
  ['simulateAndRevert', 'a Gnosis Safe function used to dry-run batches — consumed, not contained'],
  // The other two halves of the same story, admitted for the same reason. A
  // dossier that says a batch executed has to name the evidence: `ExecutionSuccess`
  // is the Safe's own log, and its indexed `safeTxHash` is what lets an execution
  // be tied to a hash computed days earlier. `multiSend` is named because §5.31
  // records a route that does NOT work — raw calldata in Transaction Builder's Raw
  // Data field, which runs as CALL and reverts — and that finding is unstatable
  // without naming the function whose dispatch context is the whole point.
  ['ExecutionSuccess', 'the Gnosis Safe execution log — emitted by the Safe, not by anything here'],
  ['multiSend', 'the MultiSendCallOnly entrypoint this project delegatecalls into — consumed, not contained'],
  // Three fields on a Blockscout API response, same category as the Safe names
  // above: they are keys in someone else's JSON, not symbols in this tree.
  //
  // They are named because PM-C4 closed on a distinction that is invisible
  // without them. "Verified" on an explorer covers two different outcomes — a
  // full match and a metadata-stripped partial one — and only the full match is
  // evidence that this tree reproduces the deployed bytecode. Recording that
  // `HookDeployLib` came back `is_fully_verified` true and
  // `is_partially_verified` false says which one happened; writing "verified"
  // would not. `is_changed_bytecode` is the third leg: it would be true if the
  // address had been redeployed under the verified source.
  //
  // The ALLOW cost here is the usual one and it is nil in the direction that
  // matters: the name is skipped before the search runs, so this guard would not
  // notice one arriving in `src/`, but our tree gaining an `is_fully_verified`
  // would not falsify a claim about what Blockscout returned.
  ['is_fully_verified', 'a Blockscout API field — PM-C4 names it to distinguish a full match from a partial one'],
  ['is_partially_verified', 'the other half of that distinction, same response, same reason'],
  ['is_changed_bytecode', 'a Blockscout API field — true would mean the address was redeployed under the verified source'],
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
  // These six are the PRD chapter-6 drift, and the reason strings changed shape
  // when it was fixed (§5.16). They are no longer "quoted by a dossier while the
  // spec stays wrong" — the spec now names each one to say, in place, that the
  // thing does not exist and what replaced it. That is the same disposition as
  // `_headers` above: asserted ABSENT, and the assertion is the content.
  //
  // The cost noted at the top of this block applies to all six: an ALLOW entry
  // is skipped BEFORE the search runs, so if `feeMode` or `ConnectGate` came
  // back into `soat-frontend/` this guard would not say so, and the PRD would
  // then be asserting the absence of something present. Nothing here watches
  // for that.
  ['feeMode', 'asserted ABSENT — §6.4 names it to record that useActionGate replaced it'],
  ['handleDeposit', 'asserted ABSENT — the §5.12 finding; §6.6.3 now documents submitDeposit'],
  ['handleMineSalt', 'asserted ABSENT — §6.5 names it to record that mineSalt replaced it'],
  // A seventh of exactly the same kind, and the last one to be found, which is
  // the interesting part: the §5.12 sweep counted nine stale references and this
  // was not among them, because it was the one that still resolved. The previous
  // project's entire frontend was committed at `_meritx-ref/` and happened to
  // contain an unrelated `handleMint`, so this guard had been checking a PRD
  // citation against a foreign codebase and reporting green. Deleting that
  // directory on 2026-09-12 is what surfaced it.
  //
  // The stale section was worse than the others, too. It documented a
  // seven-rung mint cascade in an order the code had deliberately reversed —
  // `exceedsMax` ahead of the same-block lock, which told a buyer to shrink an
  // order that would have reverted regardless — so the PRD was teaching the bug
  // as current behaviour. §6 now documents `submitMint` behind `useActionGate`.
  //
  // Two things to take from it. A guard that passes because the haystack is too
  // large is worth less than no guard; and the six `[bracket_labels]` in the
  // same table were never checked at all, because only identifiers in backticks
  // are read. That second gap is still open.
  ['handleMint', 'asserted ABSENT — §6 names it as the pre-rewrite handler, now `submitMint`'],
  ['ConnectGate', 'asserted ABSENT — §6.6.2 names it to record that no such gate exists'],
  ['GenesisWindowSelect', 'asserted ABSENT — §6.4 names it to record the control is inline, not a component'],
  ['RecentEventsTicker', 'asserted ABSENT — §6.6.4 names it to record the per-project ticker never existed'],
  // These five are the v0 redesign's removal of the directory-home event
  // ticker (2026-09-12), and they are the entries in this file most likely to
  // become wrong, so read the last paragraph before trusting them.
  //
  // Unlike everything above, these names are not absent on principle. They
  // name components that really shipped — `TxFeedMarquee`, its
  // `EventTickerStrip` wrapper (called `A2AFeed` until 50bc9a7) and the
  // `useWatchContractEvent` subscription that drove them — and the redesign
  // deleted both files and the mount in `AgentDirectoryHome` as one change.
  // What these entries record is that removal, not a claim that the
  // components were never written. §6.6.4 describes what was removed, and
  // 50bc9a7 is where it is recoverable from.
  //
  // HOW THIS GUARD CAUGHT IT, which is the part worth keeping. The haystack is
  // what `git ls-files` reports, and a file it cannot open is skipped rather
  // than failed. So while the deletion was still uncommitted, three
  // tracked-but-absent files read here as symbols existing nowhere — and the
  // guard went red on a working tree whose docs were still correct. That is it
  // working: an uncommitted deletion of a live feature is exactly the drift
  // this is for. It was briefly misread as documentation drift, and the docs
  // were rewritten to say the components had never existed, on the reasoning
  // that `git log --diff-filter=D` found no delete commit. That inference is
  // invalid — an uncommitted deletion produces no delete commit either — and
  // the rewrite was reverted. §6.6.4 keeps the record so it is not repeated.
  //
  // THE COST HERE IS REAL, unlike `trace_filter` or the Safe names. An ALLOW
  // entry is skipped BEFORE the search runs, so these five now sit between
  // this guard and the very condition it just detected: rebuild a ticker under
  // any of these names, or restore the files, and the guard stays green while
  // §6.6.4 asserts an absence that has stopped being true. Whoever does either
  // has to delete these entries in the same change.
  ['TxFeedMarquee', 'removed by the v0 redesign — §6.6.4 records what it was; recoverable from 50bc9a7'],
  ['EventTickerStrip', 'the ssr:false wrapper that mounted it, removed in the same change'],
  ['A2AFeed', 'that wrapper\'s pre-50bc9a7 name — §6.6.4 cites it for the rename; neither name is in the tree now'],
  ['watchContractEvent', 'asserted ABSENT — §6.6.4 names it to record that the app subscribes to no contract event'],
  ['useWatchContractEvent', 'the wagmi hook form: it drove the removed marquee, and §6.6.4 names it for both facts'],
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

// ── One pass over the tree, excluding the docs themselves ───────────────────
//
// This used to shell out to `rg`, and it was never once green in CI. Ripgrep is
// not on the GitHub runner image, so the guard failed closed with
// `spawnSync rg ENOENT` on every push from the commit that introduced it — five
// consecutive red runs, unnoticed because the step sits late in a seven-minute
// job. Failing closed was right; depending on a binary nobody had declared was
// not. A guard that only runs on the author's laptop is not a CI guard.
//
// The haystack is now assembled with `git`, which the checkout already depends
// on. `--cached --others --exclude-standard` is the precise equivalent of what
// ripgrep scanned: tracked files, plus untracked ones that are not ignored. That
// equivalence is load-bearing rather than incidental — ripgrep honoured
// `.gitignore` for free, and the exclusions below are the record of what happens
// when generated output reaches the haystack.
const EXCLUDED = [
  /^docs\//,
  /(^|\/)node_modules\//,
  /^out\//,
  /^cache\//,
  // This file names stale symbols in its own header in order to explain itself.
  // Without this exclusion the guard reports every such symbol as present, on
  // the strength of its own prose, and silently stops working — which is how the
  // mutation harness first found it broken.
  /^scripts\/checkDocSymbols\.mjs$/,
  // Generated artifacts are not evidence that a symbol exists. `gasreport.txt`
  // is tracked, 130 KB, and lists the name of every test that existed when it
  // was last regenerated; `slither-baseline.json` embeds source snippets the
  // same way. Either one keeps a DELETED symbol resolving indefinitely, which
  // is the precise failure this guard exists to prevent — a doc citing a test
  // that is gone, passing because a stale report still mentions it. Found by
  // mutation: renaming a real test in `test/` stayed green until these were
  // excluded. Regenerating them is not a fix; being outside the haystack is.
  /^gasreport\.txt$/,
  /(^|\/)slither[^/]*\.json$/,
  /(^|\/)[^/]*-report\.json$/,
  /\.tsbuildinfo$/,
  /\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
];

function gitList(args) {
  const ls = spawnSync('git', ['ls-files', '-z', ...args], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (ls.error || ls.status !== 0) {
    const why = ls.error
      ? ls.error.message
      : `git exited ${ls.status}: ${(ls.stderr || '').slice(0, 400)}`;
    fail(2, `check:doc-symbols could not list the tree with git ${args.join(' ')} — ${why}`);
    process.exit();
  }
  return ls.stdout.split('\0').filter(Boolean);
}

// Two calls, because `--recurse-submodules` and `--others` are mutually
// exclusive in git, and both halves are needed.
//
// The submodules are not optional here: `ProtocolFees`, `SignedMath`,
// `feesAccrued` and `hookDelta` are named in the audit and exist only in
// vendored v4-core and OpenZeppelin under `lib/`. Listing the superproject alone
// reported all four as invented, which is the answer a reviewer would have acted
// on — and the reason this replacement was checked against the ripgrep result
// instead of merely being run.
const haystack = [
  ...new Set([
    ...gitList(['--cached', '--recurse-submodules']),
    ...gitList(['--others', '--exclude-standard']),
  ]),
].filter((p) => !EXCLUDED.some((re) => re.test(p)));

if (haystack.length === 0) {
  fail(2, 'check:doc-symbols has an empty haystack, which cannot be right');
  process.exit();
}

// One alternation, longest name first so a name that is a bounded prefix of
// another cannot shadow it. `\b` is zero-width, so each match is the name itself.
//
// The tail-only anchor for `_`-leading names is carried over from the ripgrep
// pattern file: a leading `\b` cannot precede an underscore when the character
// before it in the source is a word character, and the docs abbreviate shared
// test prefixes exactly that way — `test_ladderCuration_rejectsForeignTokens` /
// `_rejectsUnlaunchedProjects`. That still leaves a genuinely invented `_foo`
// unmatched.
const names = [...seenIn.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
const NEEDLES = new RegExp(
  names
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .map((n) => (n.startsWith('_') ? `${n}\\b` : `\\b${n}\\b`))
    .join('|'),
  'g'
);

const found = new Set();
for (const rel of haystack) {
  let text;
  try {
    text = readFileSync(join(REPO, rel), 'utf8');
  } catch {
    // Unreadable or gone between the listing and the read. Not evidence either
    // way, and not worth failing the build over.
    continue;
  }
  for (const m of text.matchAll(NEEDLES)) found.add(m[0]);
  if (found.size === names.length) break;
}

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
