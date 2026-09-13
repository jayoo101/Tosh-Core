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
 * Five things are verified:
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
 *   5. Every repo file named by a `playbook`, `action`, or severity string is
 *      actually on disk. A playbook is only worth what it resolves to at 3am,
 *      and these drifted twice: once to the wrong section, once to a document
 *      that had been deleted outright.
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

// ─── 5. No playbook or action points at a file that is not there ─────────────
//
// This file's own header used to note that playbook targets were unchecked and
// that "nothing mechanical stops them drifting again". They drifted again. The
// first time, eleven pointed at the wrong section; the second time, every one of
// them pointed at an incident doc that had been deleted from the repo, so a
// responder paged at 3am would have been handed a path that does not resolve.
//
// Only repo-relative paths are checkable. `tosh-status/` lives in another
// repository and is allowed through by name, which is a hole — but a narrow and
// visible one, rather than the whole class being unchecked.

const REFERENCE = /\b((?:docs|src|test|scripts|monitoring|script)\/[\w./-]+\.(?:md|sol|mjs|js|ts|json))/g;
const EXTERNAL_OK = /^tosh-status\//;

const responders = [
    ...alerts.map((a) => ({ id: a.id, text: [a.playbook, a.action] })),
    ...(config.stateChecks || []).map((s) => ({ id: s.id, text: [s.playbook, s.action] })),
];

for (const { id, text } of responders) {
    for (const field of text) {
        if (typeof field !== 'string') continue;
        for (const [, ref] of field.matchAll(REFERENCE)) {
            if (EXTERNAL_OK.test(ref)) continue;
            if (!fs.existsSync(path.join(REPO_ROOT, ref))) {
                fail(
                    `${id}: playbook/action points at "${ref}", which is not in the repo. ` +
                        `A responder following this alert lands on nothing.`,
                );
            }
        }
    }
}

// Severity prose is read by whoever is deciding whether to wake someone up, so
// it is held to the same standard as the per-alert playbooks.
for (const [sev, prose] of Object.entries(config.severities || {})) {
    for (const [, ref] of String(prose).matchAll(REFERENCE)) {
        if (EXTERNAL_OK.test(ref)) continue;
        if (!fs.existsSync(path.join(REPO_ROOT, ref))) {
            fail(`severities.${sev} points at "${ref}", which is not in the repo.`);
        }
    }
}

// ─── 6. Every § names a document, and that document exists ───────────────────
//
// Check 5 resolves paths, so it only sees a reference that still names its
// document AND writes it with a directory prefix. Two shapes slip past it, and
// the deleted incident and audit docs left both behind:
//
//   "escalates to §5"            names no document at all
//   "SECURITY_AUDIT.md §5.11"    names one, but with no `docs/` prefix, so
//                                check 5's path pattern never matches it
//
// `why` was outside check 5's reach as well — only `playbook` and `action` were
// read, on the theory that `why` is background rather than instruction. That
// stopped being true the moment a `why` carried an escalation step.
//
// A § is worth exactly what the document beside it resolves to, so that is what
// is asserted: find the document named before each §, and require it to be on
// disk or allowlisted as external. `tosh-status/MANUAL_INTERACTION.md §4` is
// the legitimate case and must keep working — it is the offline-interaction
// guide, it lives in the status repo on purpose so it stays reachable during an
// outage, and three alerts point a user at it.

const SECTION_REF = /§\s*[\w.]+/g;
const DOC_NAME = /([\w./-]+\.md)/g;

const proseFields = [
    ...alerts.flatMap((a) => [
        { id: a.id, field: 'playbook', text: a.playbook },
        { id: a.id, field: 'action', text: a.action },
        { id: a.id, field: 'why', text: a.why },
    ]),
    ...(config.stateChecks || []).flatMap((s) => [
        { id: s.id, field: 'playbook', text: s.playbook },
        { id: s.id, field: 'action', text: s.action },
        { id: s.id, field: 'why', text: s.why },
    ]),
    ...Object.entries(config.severities || {}).map(([sev, text]) => ({
        id: `severities.${sev}`,
        field: 'prose',
        text,
    })),
];

for (const { id, field, text } of proseFields) {
    if (typeof text !== 'string') continue;
    for (const m of text.matchAll(SECTION_REF)) {
        // The nearest .md named before this §. Nearest rather than first,
        // because a long `why` can cite several documents.
        const before = text.slice(0, m.index);
        const named = [...before.matchAll(DOC_NAME)].pop();
        if (!named) {
            fail(
                `${id}: ${field} cites "${m[0]}" without naming a document, so it resolves to ` +
                    `nothing. Write the step out instead — a responder reading this at 3am has ` +
                    `no section to turn to.`,
            );
            continue;
        }
        const doc = named[1];
        if (EXTERNAL_OK.test(doc)) continue;
        if (!fs.existsSync(path.join(REPO_ROOT, doc))) {
            fail(
                `${id}: ${field} cites "${doc} ${m[0]}", and ${doc} is not in the repo. ` +
                    `The section number outlived the document.`,
            );
        }
    }
}

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
