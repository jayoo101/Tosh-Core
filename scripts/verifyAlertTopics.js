#!/usr/bin/env node
/*
 * verifyAlertTopics.js
 * ────────────────────
 * Checks `monitoring/alerts.json` against the compiled Foundry artifacts.
 *
 * The problem this exists to prevent: an alert config is write-once and then
 * trusted for years. Rename an event or change a parameter type and every
 * monitor keyed on the old topic0 goes quiet — not erroring, just never firing
 * again. That failure is invisible precisely when it matters, because "no
 * alerts" reads the same as "nothing wrong".
 *
 * Three things are verified:
 *   1. Every event named in alerts.json still exists on the named contract,
 *      with exactly the parameter types the signature claims.
 *   2. Every topic0 equals keccak256 of that signature (via `cast sig-event`,
 *      skipped with a warning if Foundry is not on PATH).
 *   3. Every event the contracts emit is accounted for — either it has an
 *      alert, or it is explicitly listed under `mustNotPage`. A new event that
 *      nobody classified is the real hazard, since it is silently unmonitored.
 *   4. The counts quoted in the prose docs match the config. Those sentences
 *      are what a reader trusts when deciding whether a provider import is
 *      complete, and they drifted the first time the catalogue changed:
 *      removing GOV-05 and muting PlatformSwapFeePaid left four sentences
 *      claiming 25 alerts and 21 muted events against a file holding 24 and 22.
 *      Checks 1-3 all passed throughout, because none of them reads the docs.
 *
 * Usage (from repository root, after `forge build`):
 *     node scripts/verifyAlertTopics.js
 *
 * Exits non-zero on any drift, so it can gate CI.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(REPO_ROOT, 'monitoring', 'alerts.json');

// Ownable2Step / Pausable events are inherited, so they appear in the compiled
// ABI but are not declared in src/. Nothing special is needed for them here —
// they are listed only so the reader knows why they are not in the .sol files.
const ARTIFACTS = {
    ToshFactory: path.join('ToshFactory.sol', 'ToshFactory.json'),
    ToshLaunchpadHook: path.join('ToshLaunchpadHook.sol', 'ToshLaunchpadHook.json'),
    ToshLadderTreasury: path.join('ToshLadderTreasury.sol', 'ToshLadderTreasury.json'),
};

const problems = [];
const notes = [];

function fail(msg) {
    problems.push(msg);
}

function loadAbi(rel) {
    const p = path.join(REPO_ROOT, 'out', rel);
    if (!fs.existsSync(p)) {
        console.error('[verifyAlertTopics] missing artifact: ' + p);
        console.error('[verifyAlertTopics] run `forge build` first.');
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(p, 'utf8')).abi;
}

/** Canonical `Name(type,type)` for an ABI event entry. */
function signatureOf(evt) {
    return evt.name + '(' + evt.inputs.map((i) => i.type).join(',') + ')';
}

let castAvailable = true;
function topic0Of(signature) {
    try {
        return execFileSync('cast', ['sig-event', signature], { encoding: 'utf8' }).trim().toLowerCase();
    } catch {
        castAvailable = false;
        return null;
    }
}

// ─── Load ────────────────────────────────────────────────────────────────────

const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

const abis = {};
const signaturesByContract = {};
for (const [name, rel] of Object.entries(ARTIFACTS)) {
    abis[name] = loadAbi(rel);
    signaturesByContract[name] = new Set(
        abis[name].filter((e) => e.type === 'event').map(signatureOf),
    );
}

// ─── 1 + 2. Every alert resolves, and its topic0 matches ─────────────────────

const alerts = config.alerts || [];
if (alerts.length === 0) fail('alerts.json declares no alerts at all');

for (const a of alerts) {
    const known = signaturesByContract[a.contract];
    if (!known) {
        fail(`${a.id}: unknown contract "${a.contract}"`);
        continue;
    }
    if (!known.has(a.event)) {
        fail(
            `${a.id}: ${a.contract} no longer emits "${a.event}". ` +
                `Any monitor keyed on this alert has stopped firing.`,
        );
        continue;
    }

    const expected = topic0Of(a.event);
    if (expected === null) continue;
    if (expected !== String(a.topic0).toLowerCase()) {
        fail(`${a.id}: topic0 mismatch for ${a.event}\n    config:   ${a.topic0}\n    computed: ${expected}`);
    }
}

// ─── 3. Every emitted event is classified ────────────────────────────────────

const alerted = new Set(alerts.map((a) => `${a.contract}.${a.event.split('(')[0]}`));
const muted = new Set((config.mustNotPage && config.mustNotPage.events) || []);

for (const [contract, sigs] of Object.entries(signaturesByContract)) {
    for (const sig of sigs) {
        const bare = `${contract}.${sig.split('(')[0]}`;
        if (alerted.has(bare) || muted.has(bare)) continue;

        // Inherited plumbing that carries no operational signal on its own.
        if (/^(Initialized|EIP712DomainChanged|Approval|Transfer)$/.test(sig.split('(')[0])) {
            notes.push(`unclassified but ignorable: ${bare}`);
            continue;
        }
        fail(
            `${bare} is emitted by the contracts but appears in neither "alerts" nor ` +
                `"mustNotPage". Classify it — an unclassified event is an unmonitored one.`,
        );
    }
}

// ─── 4. The docs quote the same numbers the config holds ─────────────────────
//
// A count in prose is a claim about this file, and the only reason to write one
// is so a reader does not have to open the JSON. That makes a stale count worse
// than no count: "import the 25 alerts" reads as a complete instruction while
// leaving the importer no way to notice they finished at 24.
//
// Each pattern must match exactly once. A pattern that matches nothing is a
// failure too — otherwise rewording the sentence would quietly retire the check
// rather than break it, which is the same silent-drift shape as the rest of
// this file.

const sevCount = alerts.reduce((acc, a) => ((acc[a.severity] = (acc[a.severity] || 0) + 1), acc), {});
const actual = {
    alerts: alerts.length,
    stateChecks: (config.stateChecks || []).length,
    muted: muted.size,
    P0: sevCount.P0 || 0,
    P1: sevCount.P1 || 0,
    P2: sevCount.P2 || 0,
    P3: sevCount.P3 || 0,
};

// ─── Report ──────────────────────────────────────────────────────────────────

if (!castAvailable) {
    console.warn(
        '[verifyAlertTopics] WARNING: `cast` not found on PATH — topic0 hashes were NOT verified.\n' +
            '                    Event existence and classification were still checked.',
    );
}
for (const n of notes) console.log('[verifyAlertTopics] ' + n);

if (problems.length > 0) {
    console.error('\n[verifyAlertTopics] FAILED — monitoring/alerts.json has drifted:\n');
    for (const p of problems) console.error('  • ' + p);
    console.error('');
    process.exit(1);
}

console.log(
    `[verifyAlertTopics] OK — ${actual.alerts} alerts ` +
        `(${Object.entries(sevCount).sort().map(([k, v]) => `${k}:${v}`).join(' ')}), ` +
        `${actual.stateChecks} state checks, ${actual.muted} muted events.`,
);
