#!/usr/bin/env node
/*
 * checkSlitherFindings.mjs
 * ────────────────────────
 * Pins the exact set of Slither findings against `slither-baseline.json`, so a
 * detector cannot start or stop firing without somebody deciding about it.
 *
 * ── The drift this was written for ──────────────────────────────────────────
 *
 * The triage behind this baseline is the same kind of artefact as the lint one,
 * rotted in two independent ways at once. Found on 2026-09-04 by running the
 * tool and adding up the table:
 *
 *   - The table never summed to its own stated total. Its rows came to 68
 *     against a prose figure of 70, because `low-level-calls` (Informational,
 *     x2, the two `_sendNative` helpers) had no row at all. The IMPACT line
 *     "1 high / 24 medium / 26 low / 19 informational" counted them, so the
 *     two summaries of the same run disagreed with each other and neither was
 *     checked against the third.
 *   - The run itself had moved. The table said "Re-run 2026-08-27 ... Identical:
 *     70 findings", and the dark-tax work landed after that date. It added
 *     `_skimInputTax`, which Slither reads as three more `reentrancy-events`.
 *     Nobody re-ran it, so a new function on the money path went into the
 *     audit package undispositioned.
 *
 * The second one is what matters. A triage document's whole value is the claim
 * "every finding has been looked at", and that claim expires silently on the
 * next commit.
 *
 * ── Why the key is a scope name and not a line number ───────────────────────
 *
 * Same reasoning as `checkLintFindings.mjs`: a guard that fails when a comment
 * is inserted above a function gets deleted within a week. A finding is keyed
 * by (detector, file, enclosing scope) and counted, so code motion is
 * invisible and a finding appearing, vanishing or multiplying is not.
 *
 * Slither's element shapes differ per detector — most carry a `function`
 * element, `uninitialized-local` and `naming-convention` carry a `variable`,
 * `missing-inheritance` carries a `contract` — so the scope is derived per
 * shape rather than assumed.
 *
 * ── What is checked ─────────────────────────────────────────────────────────
 *
 * 1. The finding set matches `slither-baseline.json`, entry for entry and count
 *    for count — new findings, changed counts, and vanished findings all fail.
 * 2. Slither is the pinned version, since detector counts move between releases
 *    and a baseline is meaningless against an unstated one.
 *
 * ── What used to be checked, and is not ─────────────────────────────────────
 *
 * Three further checks read a disposition table in a security-audit document:
 * that its prose totals matched the run, that each of its rows summed to the
 * detectors it named, and that every detector the run reported was named by
 * some row. That last one is what caught `low-level-calls` sitting in the run
 * with no row at all.
 *
 * That document was deleted from the repo on 2026-09-13 and those three checks
 * went with it. Check 1 inherits the part that mattered most: a detector
 * appearing for the first time still fails, because it is a NEW finding against
 * the baseline, so nothing can reach `src/` undispositioned. What is genuinely
 * gone is the cross-check between two independent summaries of the same run —
 * there is now only one record, so it cannot disagree with itself.
 *
 * ── Version pinning ─────────────────────────────────────────────────────────
 *
 * Detector counts move between Slither releases, so a baseline is only
 * meaningful against a stated version. This asserts 0.11.6, the version the
 * baseline was triaged against. Upgrading is a deliberate act: re-run, re-triage what moved, then
 * change the constant here and in the workflow together.
 *
 * Usage:
 *   node scripts/checkSlitherFindings.mjs             verify
 *   node scripts/checkSlitherFindings.mjs --update    rewrite the baseline
 *
 * Exits 1 on drift, 2 if the check could not be run at all.
 */

'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, 'slither-baseline.json');
const PINNED_VERSION = '0.11.6';
const FILTER = 'lib/|test/|script/';

const UPDATE = process.argv.includes('--update');
const fail = [];

const die = (msg, extra = []) => {
  console.error(`FAIL  ${msg}`);
  for (const e of extra) console.error(`      ${e}`);
  process.exit(2);
};

// ── 1. Run Slither ──────────────────────────────────────────────────────────

const slither = (args) => {
  const opts = { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 };
  let r = spawnSync('slither', args, opts);
  if (r.error?.code === 'ENOENT') r = spawnSync('slither.exe', args, opts);
  if (r.error?.code === 'ENOENT') r = spawnSync('python', ['-m', 'slither', ...args], opts);
  return r;
};

const ver = slither(['--version']);
if (ver.error) {
  die('Slither is not installed or not on PATH.', [
    `Install the pinned version:  pip install slither-analyzer==${PINNED_VERSION}`,
    'This is a CI gate. A skipped run is an untriaged finding.',
  ]);
}
const version = `${ver.stdout || ''}${ver.stderr || ''}`.trim().split(/\r?\n/).pop().trim();
if (version !== PINNED_VERSION) {
  die(`Slither ${version} found; the baseline's triage is against ${PINNED_VERSION}.`, [
    'Detector counts move between releases, so the baseline does not carry over.',
    'To upgrade: re-run, re-triage whatever moved, then change PINNED_VERSION here',
    'and the pin in .github/workflows/test.yml in the same commit.',
  ]);
}

const report = path.join(os.tmpdir(), `slither-${process.pid}.json`);
const run = slither(['.', '--filter-paths', FILTER, '--json', report]);
const chatter = `${run.stdout || ''}${run.stderr || ''}`;

if (!fs.existsSync(report)) {
  die('Slither produced no JSON report.', chatter.split(/\r?\n/).filter(Boolean).slice(-8));
}

let raw;
try {
  raw = JSON.parse(fs.readFileSync(report, 'utf8'));
} finally {
  fs.rmSync(report, { force: true });
}

const detectors = raw.results?.detectors ?? [];
if (detectors.length === 0) {
  die('Slither reported zero findings, which is not plausible for this tree.', [
    'Expected 71. The build failed, or the filter swallowed src/.',
  ]);
}

// "... analyzed (66 contracts with 102 detectors), 71 result(s) found"
const analyzed = /analyzed \((\d+) contracts with (\d+) detectors\)/.exec(chatter);
const contractCount = analyzed ? Number(analyzed[1]) : null;
const detectorCount = analyzed ? Number(analyzed[2]) : null;

// ── 2. Fold into a counted, sorted set ──────────────────────────────────────

function scopeOf(d) {
  const els = d.elements ?? [];
  const fn = els.find((e) => e.type === 'function');
  if (fn) return `${fn.type_specific_fields?.parent?.name ?? '?'}.${fn.name}`;
  const e0 = els[0];
  if (!e0) return '<no element>';
  const parent = e0.type_specific_fields?.parent?.name;
  return parent ? `${parent}.${e0.name}` : `${e0.type}:${e0.name}`;
}

function fileOf(d) {
  const els = d.elements ?? [];
  const withFile = els.find((e) => e.source_mapping?.filename_relative);
  return (withFile?.source_mapping?.filename_relative ?? '<unknown>').replace(/\\/g, '/');
}

const m = new Map();
for (const d of detectors) {
  const entry = { check: d.check, impact: d.impact, file: fileOf(d), scope: scopeOf(d) };
  const k = `${entry.check}\u0000${entry.file}\u0000${entry.scope}`;
  const prev = m.get(k);
  if (prev) prev.count += 1;
  else m.set(k, { ...entry, count: 1 });
}
const actual = [...m.values()].sort(
  (a, b) => a.check.localeCompare(b.check) || a.file.localeCompare(b.file) || a.scope.localeCompare(b.scope),
);

const byCheck = {};
const byImpact = {};
for (const f of actual) {
  byCheck[f.check] = (byCheck[f.check] ?? 0) + f.count;
  byImpact[f.impact] = (byImpact[f.impact] ?? 0) + f.count;
}
const total = detectors.length;

if (UPDATE) {
  fs.writeFileSync(
    BASELINE,
    `${JSON.stringify(
      {
        _readme:
          'Generated by scripts/checkSlitherFindings.mjs --update. Every entry has been ' +
          'triaged — this is the disposition record, not a list of findings to ignore. ' +
          'Regenerating it to make CI green, without looking at what changed and why, is ' +
          'the drift the guard exists to prevent.',
        _slither: PINNED_VERSION,
        _filterPaths: FILTER,
        _generated: new Date().toISOString().slice(0, 10),
        contracts: contractCount,
        detectorsRun: detectorCount,
        total,
        byImpact,
        byCheck,
        findings: actual,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`wrote slither-baseline.json — ${total} findings, ${actual.length} distinct sites`);
  for (const [k, n] of Object.entries(byCheck).sort()) console.log(`  ${String(n).padStart(3)}  ${k}`);
  process.exit(0);
}

// ── 3. Compare against the baseline ─────────────────────────────────────────

if (!fs.existsSync(BASELINE)) {
  die('slither-baseline.json is missing.', ['Create it with: node scripts/checkSlitherFindings.mjs --update']);
}
let baseline;
try {
  baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8').replace(/^\uFEFF/, ''));
} catch (e) {
  die(`slither-baseline.json is not valid JSON: ${e.message}`);
}

const keyOf = (f) => `${f.check}\u0000${f.file}\u0000${f.scope}`;
const want = new Map((baseline.findings ?? []).map((f) => [keyOf(f), f]));
const have = new Map(actual.map((f) => [keyOf(f), f]));
const show = (f) => `[${f.impact}] ${f.check}  ${f.scope}  (${f.file})`;

for (const [k, f] of have) {
  if (!want.has(k)) {
    fail.push(
      `NEW finding, not in the baseline:\n        ${show(f)}\n` +
        '        Triage it, then rerun with --update.',
    );
  } else if (want.get(k).count !== f.count) {
    fail.push(`count changed ${want.get(k).count} -> ${f.count} for:\n        ${show(f)}`);
  }
}
for (const [k, f] of want) {
  if (!have.has(k)) {
    fail.push(
      `finding GONE, so the baseline disposes of something that is not there:\n        ${show(f)}\n` +
        '        Confirm the code change that removed it was intended, then rerun with --update.',
    );
  }
}

// ── 6. Report ───────────────────────────────────────────────────────────────

if (fail.length > 0) {
  console.error(`\nFAIL  Slither findings drifted from slither-baseline.json (${fail.length}):\n`);
  for (const f of fail) console.error(`  - ${f}\n`);
  process.exit(1);
}

console.log(
  `OK    Slither ${version}: ${total} findings across ${actual.length} sites ` +
    `(${byImpact.High ?? 0}H/${byImpact.Medium ?? 0}M/${byImpact.Low ?? 0}L/${byImpact.Informational ?? 0}I).`,
);
