#!/usr/bin/env node
/*
 * checkSlitherFindings.mjs
 * ────────────────────────
 * Pins the exact set of Slither findings, and holds `docs/SECURITY_AUDIT.md`
 * §5.7 — the disposition table for every one of them — to what the tool
 * actually reports.
 *
 * ── The drift this was written for ──────────────────────────────────────────
 *
 * §5.7 is the same kind of artefact as §2.5, three times the size, and it had
 * rotted in two independent ways at once. Found on 2026-09-04 by running the
 * tool and adding up the table:
 *
 *   - The table never summed to its own stated total. Its rows came to 68
 *     against a prose figure of 70, because `low-level-calls` (Informational,
 *     x2, the two `_sendEth` helpers) had no row at all. The IMPACT line
 *     "1 high / 24 medium / 26 low / 19 informational" counted them, so the
 *     two summaries of the same run disagreed with each other and neither was
 *     checked against the third.
 *   - The run itself had moved. §5.7 says "Re-run 2026-08-27 ... Identical:
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
 * 1. The finding set matches `slither-baseline.json`.
 * 2. §5.7's prose totals — contract count, finding count, and the
 *    high/medium/low/informational split — match the run.
 * 3. Every row of §5.7's disposition table sums to the detectors it names.
 * 4. EVERY detector the run reports is named by some row. This is the one that
 *    would have caught `low-level-calls`: a finding with no row is a finding
 *    nobody dispositioned, and it is invisible to any check that only verifies
 *    the rows that exist.
 *
 * ── Version pinning ─────────────────────────────────────────────────────────
 *
 * Detector counts move between Slither releases, so a baseline is only
 * meaningful against a stated version. This asserts 0.11.6, the version §5.7
 * records. Upgrading is a deliberate act: re-run, re-triage what moved, then
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
const DOSSIER = path.join(ROOT, 'docs', 'SECURITY_AUDIT.md');
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
  die(`Slither ${version} found; §5.7's triage is against ${PINNED_VERSION}.`, [
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
          'Generated by scripts/checkSlitherFindings.mjs --update. Every entry must be ' +
          'dispositioned by a row of docs/SECURITY_AUDIT.md §5.7. Regenerating this without ' +
          'updating that table is the drift the guard exists to prevent.',
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
      `NEW finding, not dispositioned in §5.7:\n        ${show(f)}\n` +
        '        Triage it in docs/SECURITY_AUDIT.md §5.7, then rerun with --update.',
    );
  } else if (want.get(k).count !== f.count) {
    fail.push(`count changed ${want.get(k).count} -> ${f.count} for:\n        ${show(f)}`);
  }
}
for (const [k, f] of want) {
  if (!have.has(k)) {
    fail.push(
      `finding GONE, so §5.7 disposes of something that is not there:\n        ${show(f)}\n` +
        '        Update the table, then rerun with --update.',
    );
  }
}

// ── 4. §5.7 must describe this run ──────────────────────────────────────────

const md = fs.existsSync(DOSSIER) ? fs.readFileSync(DOSSIER, 'utf8') : null;
if (!md) {
  die('docs/SECURITY_AUDIT.md not found.');
}

const secStart = md.indexOf('### 5.7 ');
const secEnd = md.indexOf('\n### 5.8 ', secStart);
if (secStart < 0 || secEnd < 0) die('Could not locate §5.7 in docs/SECURITY_AUDIT.md.');
const section = md.slice(secStart, secEnd);

const headline = /(\d+)\s+contracts,\s+(\d+)\s+detectors,\s+\*\*(\d+)\s+findings\*\*/.exec(section);
if (!headline) {
  fail.push(
    '§5.7 no longer states "<n> contracts, <n> detectors, **<n> findings**.\n' +
      '        That line is the section\'s scale and this guard reads it.',
  );
} else {
  const [, c, dets, t] = headline.map(Number);
  if (contractCount !== null && c !== contractCount) {
    fail.push(`§5.7 says ${c} contracts; Slither analysed ${contractCount}.`);
  }
  if (detectorCount !== null && dets !== detectorCount) {
    fail.push(`§5.7 says ${dets} detectors; Slither ran ${detectorCount}.`);
  }
  if (t !== total) fail.push(`§5.7 says ${t} findings; Slither reports ${total}.`);
}

const split = /(\d+)\s+high\s*\/\s*(\d+)\s+medium\s*\/\s*(\d+)\s+low\s*\/\s*(\d+)\s+informational/i.exec(section);
if (!split) {
  fail.push('§5.7 no longer states a "<n> high / <n> medium / <n> low / <n> informational" split.');
} else {
  const stated = { High: Number(split[1]), Medium: Number(split[2]), Low: Number(split[3]), Informational: Number(split[4]) };
  for (const level of ['High', 'Medium', 'Low', 'Informational']) {
    const got = byImpact[level] ?? 0;
    if (stated[level] !== got) fail.push(`§5.7's split says ${stated[level]} ${level.toLowerCase()}; the run has ${got}.`);
  }
}

// ── 5. Every row must sum, and every detector must have a row ───────────────
//
// The second half is the one that matters. A table can be internally perfect
// and still omit a whole detector, which is precisely how `low-level-calls`
// stayed undispositioned while three separate summaries of the same run were
// maintained by hand.

const claimed = new Map(); // detector -> row label
for (const line of section.split('\n')) {
  if (!/^\|\s*`/.test(line)) continue;
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  if (cells.length < 3) continue;
  const names = [...cells[0].matchAll(/`([a-z0-9-]+)`/g)].map((x) => x[1]);
  if (names.length === 0) continue;
  const n = Number(cells[2]);
  if (!Number.isFinite(n)) continue;

  const sum = names.reduce((acc, d) => acc + (byCheck[d] ?? 0), 0);
  if (sum !== n) {
    fail.push(
      `§5.7 row "${names.join(', ')}" claims ${n}; the run has ${sum}` +
        ` (${names.map((d) => `${d}=${byCheck[d] ?? 0}`).join(', ')}).`,
    );
  }
  for (const d of names) {
    if (claimed.has(d)) fail.push(`§5.7 names detector '${d}' in two rows; its findings would be counted twice.`);
    claimed.set(d, names.join(', '));
  }
}

for (const d of Object.keys(byCheck)) {
  if (!claimed.has(d)) {
    fail.push(
      `detector '${d}' fired ${byCheck[d]} time(s) and NO row of §5.7 mentions it.\n` +
        '        An undispositioned finding is invisible to any check that only verifies\n' +
        '        the rows that exist. Add a row.',
    );
  }
}
for (const d of claimed.keys()) {
  if (!(d in byCheck)) fail.push(`§5.7 has a row for '${d}', which this run does not report at all.`);
}

// ── 6. Report ───────────────────────────────────────────────────────────────

if (fail.length > 0) {
  console.error(`\nFAIL  Slither findings drifted from §5.7 / slither-baseline.json (${fail.length}):\n`);
  for (const f of fail) console.error(`  - ${f}\n`);
  process.exit(1);
}

console.log(
  `OK    Slither ${version}: ${total} findings across ${actual.length} sites ` +
    `(${byImpact.High ?? 0}H/${byImpact.Medium ?? 0}M/${byImpact.Low ?? 0}L/${byImpact.Informational ?? 0}I).`,
);
console.log(`      Every detector has a row in §5.7 and every row sums to the run.`);
