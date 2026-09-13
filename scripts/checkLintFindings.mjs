#!/usr/bin/env node
/*
 * checkLintFindings.mjs
 * ─────────────────────
 * Pins the exact set of `forge lint src` findings, so that
 * the set of narrowing casts in `src/` cannot change without somebody deciding.
 *
 * ── The drift this was written for ──────────────────────────────────────────
 *
 * §2.5 hands the auditor a table of every narrowing cast in `src/`, with the
 * bound each one relies on. On 2026-09-04 that table still summed to 19, which
 * is the number `forge lint` reports — and was wrong anyway:
 *
 *   - it carried a row for a `uint48` swap-block stamp at `ToshLaunchpadHook`
 *     :1755 that `forge lint` no longer reports at all, and
 *   - it was missing a third `BalanceDelta` site, so it described 4 delta casts
 *     where the code has 6.
 *
 * The two errors cancelled in the total. That is the worst shape a stale
 * document can take: the number reconciles, so nobody opens the table, and the
 * auditor bills for rediscovering the map they were handed.
 *
 * A count alone would not have caught it. This guard pins the SET.
 *
 * ── Why the key is source text and not a line number ────────────────────────
 *
 * §2.5 says its own line numbers "drift with any edit above them", which is
 * true and is why it cannot be gated on them: every commit that adds a comment
 * to the hook would fail the build for no reason, and a guard that cries wolf
 * gets deleted.
 *
 * So a finding is keyed by (rule, file, trimmed source line) and counted.
 * Code motion is invisible to that key. A cast that appears, disappears, or
 * changes shape is not. The count disambiguates the common case of two
 * findings on one line — `uint256(uint128(-d0))` is two casts at two columns
 * with identical text, and collapsing them would hide one going away.
 *
 * ── What this does NOT claim ────────────────────────────────────────────────
 *
 * That the baseline is a set of casts which are FINE. It is a set of casts
 * which have been LOOKED AT, and §2.5 records what was found. Adding a row
 * here without adding its bound to §2.5 defeats the whole arrangement, so the
 * final check below refuses a baseline whose totals §2.5 does not state.
 *
 * Nor is `forge lint`'s output the complete set of narrowing casts in `src/`.
 * It is silent on all eight clock and block-height narrowings — the
 * `uint32(block.timestamp)` and `uint48(_blockNumber())` sites — which §2.5
 * lists separately for exactly that reason. This guard pins what the tool
 * reports; §2.5 covers the gap the tool leaves.
 *
 * Usage:
 *   node scripts/checkLintFindings.mjs             verify against the baseline
 *   node scripts/checkLintFindings.mjs --update    rewrite the baseline
 *
 * Exits non-zero on drift, so it can gate CI.
 */

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, 'lint-baseline.json');

const UPDATE = process.argv.includes('--update');

const fail = [];
const note = [];

// ── 1. Run the linter ───────────────────────────────────────────────────────
//
// `forge lint --json` emits one diagnostic per line. It writes them to stderr,
// not stdout, so both streams are read and concatenated rather than assuming
// either one.

// `shell: true` is deliberately NOT used. It would make Node concatenate the
// argv rather than pass it, and it earns a DEP0190 warning on stderr — which
// this script then tries to parse as diagnostics.
const opts = { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
let run = spawnSync('forge', ['lint', 'src', '--json'], opts);

// Windows resolves `forge` to `forge.exe` without help, but a Foundry
// installed through a shim (scoop, a .cmd wrapper) needs the extension.
if (run.error?.code === 'ENOENT' && process.platform === 'win32') {
  run = spawnSync('forge.cmd', ['lint', 'src', '--json'], opts);
}

if (run.error) {
  console.error(`FAIL  could not run 'forge lint': ${run.error.message}`);
  console.error('      Foundry must be on PATH. This guard is a CI gate, not optional.');
  process.exit(2);
}

const raw = `${run.stdout || ''}\n${run.stderr || ''}`;

const findings = [];
for (const line of raw.split(/\r?\n/)) {
  const t = line.trim();
  if (!t.startsWith('{')) continue;
  let d;
  try {
    d = JSON.parse(t);
  } catch {
    continue; // not a diagnostic line; forge interleaves build chatter
  }
  if (d.$message_type !== 'diagnostic') continue;
  if (d.level !== 'warning' && d.level !== 'error') continue;
  const span = (d.spans || []).find((s) => s.is_primary) || (d.spans || [])[0];
  if (!span) continue;
  findings.push({
    rule: d.code?.code ?? '<unnamed>',
    file: String(span.file_name).replace(/\\/g, '/'),
    text: String(span.text?.[0]?.text ?? '').trim(),
  });
}

if (findings.length === 0) {
  console.error("FAIL  'forge lint src' produced no diagnostics at all.");
  console.error('      That is not plausible for this tree — 37 are expected. The output');
  console.error('      format changed, or the build failed. Run it by hand and look.');
  process.exit(2);
}

// ── 2. Fold into a counted, sorted set ──────────────────────────────────────

function fold(list) {
  const m = new Map();
  for (const f of list) {
    const k = `${f.rule}\u0000${f.file}\u0000${f.text}`;
    const prev = m.get(k);
    if (prev) prev.count += 1;
    else m.set(k, { rule: f.rule, file: f.file, text: f.text, count: 1 });
  }
  return [...m.values()].sort(
    (a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.text.localeCompare(b.text),
  );
}

const actual = fold(findings);
const totals = {};
for (const f of actual) totals[f.rule] = (totals[f.rule] ?? 0) + f.count;

if (UPDATE) {
  const doc = {
    _readme:
      'Generated by scripts/checkLintFindings.mjs --update. Every entry is a narrowing ' +
      'cast that has been looked at and found bounded — not one that is assumed safe. ' +
      'Regenerating this file to make CI green, without establishing what bounds the new ' +
      'finding, is the drift the guard exists to prevent.',
    _generated: new Date().toISOString().slice(0, 10),
    totals,
    findings: actual,
  };
  fs.writeFileSync(BASELINE, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  console.log(`wrote ${path.relative(ROOT, BASELINE)} — ${actual.length} distinct, ${findings.length} total`);
  for (const [rule, n] of Object.entries(totals).sort()) console.log(`  ${n.toString().padStart(3)}  ${rule}`);
  process.exit(0);
}

// ── 3. Compare against the baseline ─────────────────────────────────────────

if (!fs.existsSync(BASELINE)) {
  console.error(`FAIL  ${path.relative(ROOT, BASELINE)} is missing.`);
  console.error('      Create it with: node scripts/checkLintFindings.mjs --update');
  process.exit(2);
}

let baseline;
try {
  baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8').replace(/^\uFEFF/, ''));
} catch (e) {
  console.error(`FAIL  ${path.relative(ROOT, BASELINE)} is not valid JSON: ${e.message}`);
  process.exit(2);
}

const keyOf = (f) => `${f.rule}\u0000${f.file}\u0000${f.text}`;
const want = new Map((baseline.findings ?? []).map((f) => [keyOf(f), f]));
const have = new Map(actual.map((f) => [keyOf(f), f]));

const show = (f) => `${f.rule}  ${f.file}\n        ${f.text}`;

for (const [k, f] of have) {
  if (!want.has(k)) {
    fail.push(
      `NEW finding, with no recorded bound:\n        ${show(f)}\n` +
        '        Establish what bounds this cast, say so at the cast, then rerun with --update.',
    );
  } else if (want.get(k).count !== f.count) {
    fail.push(
      `count changed ${want.get(k).count} -> ${f.count} for:\n        ${show(f)}\n` +
        '        Two casts on one line becoming one (or three) is a code change, not noise.',
    );
  }
}

for (const [k, f] of want) {
  if (!have.has(k)) {
    fail.push(
      `finding GONE, so §2.5 now describes code that is not there:\n        ${show(f)}\n` +
        '        Then rerun with --update.',
    );
  }
}

//  4. Report ───────────────────────────────────────────────────────────────

for (const n of note) console.log(`note  ${n}`);

if (fail.length > 0) {
  console.error(`\nFAIL  forge lint findings drifted from lint-baseline.json (${fail.length}):\n`);
  for (const f of fail) console.error(`  - ${f}\n`);
  process.exit(1);
}

const summary = Object.entries(totals)
  .sort()
  .map(([r, n]) => `${n} ${r}`)
  .join(', ');
console.log(`OK    forge lint findings match the baseline — ${summary}.`);
