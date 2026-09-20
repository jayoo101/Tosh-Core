#!/usr/bin/env node
/*
 * checkAderynFindings.mjs
 * ───────────────────────
 * Pins the exact set of Cyfrin Aderyn findings against `aderyn-baseline.json`,
 * so a detector cannot start or stop firing without somebody deciding about it.
 *
 * This is `checkSlitherFindings.mjs` applied to a second tool, and the pairing
 * is the point rather than redundancy. The two disagree usefully: Slither
 * reasons over a CFG and finds dataflow problems, Aderyn walks the AST and is
 * better at "this is declared and nothing uses it". On the first run against
 * this tree Aderyn's 19 detectors overlapped Slither's on almost nothing, and
 * the two genuine findings it produced — a dead `error` declaration and three
 * unreferenced imports — are in a category Slither does not report at all.
 *
 * ── Why the key is a derived scope and not a line number ────────────────────
 *
 * Same reasoning as the Slither gate: a guard that fails when a comment is
 * inserted above a function gets deleted within a week, and this repository
 * adds comments constantly.
 *
 * Slither hands over an `elements` array naming the enclosing function, so its
 * gate can key on it directly. Aderyn gives `contract_path` and `line_no` and
 * nothing else structural, so the scope is RECOVERED here by walking back from
 * the reported line to the nearest declaration. That recovery is the fragile
 * part of this file and is written to degrade safely: when it cannot find a
 * function it falls back to the enclosing contract, and when it cannot find
 * that either it falls back to the file. A finding that lands on an import or
 * a pragma legitimately has no function around it, so those fallbacks are the
 * normal path for roughly a third of the entries rather than an error case.
 *
 * The cost of the fallback is real and worth stating: two findings from the
 * same detector in the same contract but different functions collapse into one
 * keyed entry if neither resolves to a function. They are still counted, so
 * one appearing or vanishing still fails the gate — the resolution lost is
 * WHICH of them moved, not THAT something moved.
 *
 * ── What is checked ─────────────────────────────────────────────────────────
 *
 * 1. The finding set matches `aderyn-baseline.json`, entry for entry and count
 *    for count — new findings, changed counts, and vanished findings all fail.
 * 2. Aderyn is the pinned version, since detector sets move between releases
 *    and a baseline is meaningless against an unstated one.
 * 3. The scan covered the expected number of source units. Aderyn infers scope
 *    from `foundry.toml` and silently analyses nothing if that inference
 *    breaks, and a zero-finding run would otherwise read as a pass.
 *
 * ── Running it on Windows ───────────────────────────────────────────────────
 *
 * Aderyn ships no Windows binary — the npm package supports only darwin and
 * linux, and installing it here leaves a shim that fails with MODULE_NOT_FOUND
 * rather than an honest "unsupported platform". So on win32 this shells into
 * WSL. CI is Linux and runs it directly.
 *
 * Usage:
 *   node scripts/checkAderynFindings.mjs             verify
 *   node scripts/checkAderynFindings.mjs --update    rewrite the baseline
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
const BASELINE = path.join(ROOT, 'aderyn-baseline.json');
const PINNED_VERSION = '0.6.8';

// Aderyn infers this from foundry.toml's `src`. Asserted rather than trusted:
// a run that analyses nothing reports no findings, which is indistinguishable
// from a clean tree unless the denominator is checked too.
const EXPECTED_SOURCE_UNITS = 7;

const UPDATE = process.argv.includes('--update');
const fail = [];

const die = (msg, extra = []) => {
  console.error(`FAIL  ${msg}`);
  for (const e of extra) console.error(`      ${e}`);
  process.exit(2);
};

// ── 1. Run Aderyn ───────────────────────────────────────────────────────────

const WIN = process.platform === 'win32';

/** Translate a Windows path to the WSL mount form. */
const toWsl = (p) => {
  const r = spawnSync('wsl', ['wslpath', '-a', p.replace(/\\/g, '/')], { encoding: 'utf8' });
  if (r.status !== 0) die('wslpath failed; cannot address this path from WSL.', [r.stderr?.trim() ?? '']);
  return r.stdout.trim();
};

const aderyn = (args) => {
  const opts = { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 };
  if (!WIN) return spawnSync('aderyn', args, opts);
  // `bash -c` with an explicit PATH rather than `-lc`: a login shell here
  // inherits the Windows PATH, and the `npm` it finds that way is the Windows
  // one, which is how the broken install this replaced happened in the first
  // place.
  const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  return spawnSync('wsl', ['bash', '-c', `export PATH="$HOME/.local/bin:$PATH"; aderyn ${quoted}`], opts);
};

const ver = aderyn(['--version']);
if (ver.error || ver.status !== 0) {
  die('Aderyn is not installed or not runnable.', [
    WIN
      ? 'On Windows it runs through WSL. See docs/AUDIT.md for the install.'
      : `Install the pinned version:  npm install -g @cyfrin/aderyn@${PINNED_VERSION}`,
    'This is a CI gate. A skipped run is an untriaged finding.',
  ]);
}
const version = `${ver.stdout || ''}`.trim().split(/\r?\n/).pop().replace(/^aderyn\s+/, '').trim();
if (version !== PINNED_VERSION) {
  die(`Aderyn ${version} found; the baseline's triage is against ${PINNED_VERSION}.`, [
    'Detector sets move between releases, so the baseline does not carry over.',
    'To upgrade: re-run, re-triage whatever moved, then change PINNED_VERSION here',
    'and the pin in .github/workflows/test.yml in the same commit.',
  ]);
}

const reportHost = path.join(os.tmpdir(), `aderyn-${process.pid}.json`);
const reportArg = WIN ? toWsl(reportHost) : reportHost;
const run = aderyn(['.', '-o', reportArg]);
const chatter = `${run.stdout || ''}${run.stderr || ''}`;

if (!fs.existsSync(reportHost)) {
  die('Aderyn produced no JSON report.', chatter.split(/\r?\n/).filter(Boolean).slice(-8));
}

let raw;
try {
  raw = JSON.parse(fs.readFileSync(reportHost, 'utf8'));
} finally {
  fs.rmSync(reportHost, { force: true });
}

const sourceUnits = raw.files_summary?.total_source_units ?? 0;
if (sourceUnits !== EXPECTED_SOURCE_UNITS) {
  die(`Aderyn analysed ${sourceUnits} source units; expected ${EXPECTED_SOURCE_UNITS}.`, [
    'Scope is inferred from foundry.toml. A file added to or removed from src/',
    'means updating EXPECTED_SOURCE_UNITS here in the same commit; anything else',
    'means the inference broke and the run covered the wrong tree.',
  ]);
}

// ── 2. Recover a scope for each instance ────────────────────────────────────

const srcCache = new Map();
const linesOf = (rel) => {
  if (!srcCache.has(rel)) {
    const abs = path.join(ROOT, rel);
    srcCache.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split('\n') : null);
  }
  return srcCache.get(rel);
};

const DECL = /^\s{4}(?:function|constructor|modifier|receive|fallback)\s*([A-Za-z0-9_]*)/;
const TYPE = /^\s*(?:abstract\s+)?(?:contract|library|interface)\s+([A-Za-z0-9_]+)/;

/**
 * Walk back from `line` to the nearest enclosing declaration.
 *
 * Returns `Contract.member`, or `Contract` for anything at contract level, or
 * `<file>` for imports and pragmas. See the header for why the coarse
 * fallbacks are acceptable.
 */
function scopeOf(rel, line) {
  const lines = linesOf(rel);
  if (!lines) return '<unreadable>';
  const i0 = Math.max(0, Math.min(line - 1, lines.length - 1));

  let member = null;
  for (let i = i0; i >= 0; i--) {
    const d = DECL.exec(lines[i]);
    if (d) {
      member = d[1] || lines[i].trim().split(/[\s(]/)[0];
      break;
    }
    // A closing brace in column 4 means the previous member already ended, so
    // anything above it encloses the contract rather than this finding.
    if (/^\s{4}\}/.test(lines[i]) && i !== i0) break;
  }

  let type = null;
  for (let i = i0; i >= 0; i--) {
    const t = TYPE.exec(lines[i]);
    if (t) {
      type = t[1];
      break;
    }
  }

  if (type && member) return `${type}.${member}`;
  if (type) return type;
  return '<file>';
}

// ── 3. Fold into a counted, sorted set ──────────────────────────────────────

const m = new Map();
let total = 0;
for (const [sev, key] of [
  ['High', 'high_issues'],
  ['Low', 'low_issues'],
]) {
  for (const issue of raw[key]?.issues ?? []) {
    for (const inst of issue.instances ?? []) {
      total += 1;
      const file = (inst.contract_path ?? '<unknown>').replace(/\\/g, '/');
      const entry = {
        check: issue.detector_name,
        impact: sev,
        file,
        scope: scopeOf(file, inst.line_no ?? 0),
      };
      const k = `${entry.check}\u0000${entry.file}\u0000${entry.scope}`;
      const prev = m.get(k);
      if (prev) prev.count += 1;
      else m.set(k, { ...entry, count: 1 });
    }
  }
}

if (total === 0) {
  die('Aderyn reported zero findings, which is not plausible for this tree.', [
    'Expected 100. The scan covered nothing, or the report shape changed.',
  ]);
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

if (UPDATE) {
  fs.writeFileSync(
    BASELINE,
    `${JSON.stringify(
      {
        _readme:
          'Generated by scripts/checkAderynFindings.mjs --update. Every entry has been ' +
          'triaged — this is the disposition record, not a list of findings to ignore. ' +
          'Regenerating it to make CI green, without looking at what changed and why, is ' +
          'the drift the guard exists to prevent. docs/AUDIT.md carries the reasoning ' +
          'per detector; this file carries only the shape.',
        _aderyn: PINNED_VERSION,
        _scope: 'src/ — inferred from foundry.toml, which excludes lib/, test/ and script/',
        _generated: new Date().toISOString().slice(0, 10),
        sourceUnits,
        sloc: raw.files_summary?.total_sloc ?? null,
        detectorsRun: raw.detectors_used?.length ?? null,
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
  console.log(`wrote aderyn-baseline.json — ${total} findings, ${actual.length} distinct sites`);
  for (const [k, n] of Object.entries(byCheck).sort()) console.log(`  ${String(n).padStart(3)}  ${k}`);
  process.exit(0);
}

// ── 4. Compare against the baseline ─────────────────────────────────────────

if (!fs.existsSync(BASELINE)) {
  die('aderyn-baseline.json is missing.', ['Create it with: node scripts/checkAderynFindings.mjs --update']);
}
let baseline;
try {
  baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8').replace(/^\uFEFF/, ''));
} catch (e) {
  die(`aderyn-baseline.json is not valid JSON: ${e.message}`);
}

const keyOf = (f) => `${f.check}\u0000${f.file}\u0000${f.scope}`;
const want = new Map((baseline.findings ?? []).map((f) => [keyOf(f), f]));
const have = new Map(actual.map((f) => [keyOf(f), f]));
const show = (f) => `[${f.impact}] ${f.check}  ${f.scope}  (${f.file})`;

for (const [k, f] of have) {
  if (!want.has(k)) {
    fail.push(
      `NEW finding, not in the baseline:\n        ${show(f)}\n` +
        '        Triage it and record the disposition in docs/AUDIT.md, then rerun with --update.',
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

// ── 5. Report ───────────────────────────────────────────────────────────────

if (fail.length > 0) {
  console.error(`\nFAIL  Aderyn findings drifted from aderyn-baseline.json (${fail.length}):\n`);
  for (const f of fail) console.error(`  - ${f}\n`);
  process.exit(1);
}

console.log(
  `OK    Aderyn ${version}: ${total} findings across ${actual.length} sites ` +
    `(${byImpact.High ?? 0}H/${byImpact.Low ?? 0}L) over ${sourceUnits} source units.`,
);
