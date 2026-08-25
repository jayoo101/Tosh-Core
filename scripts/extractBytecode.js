#!/usr/bin/env node
/*
 * extractBytecode.js
 * ──────────────────
 * Regenerates `soat-frontend/src/app/lib/hookBytecode.ts` from the current
 * Foundry artifact at `out/ToshLaunchpadHook.sol/ToshLaunchpadHook.json`.
 *
 * The frontend's CREATE2 hook-address miner (hookMiner.ts) hashes this
 * bytecode together with the constructor args to predict the deployment
 * address.  A stale bytecode here → wrong predicted address → every call
 * to `factory.createLaunch()` reverts with `InvalidHookSalt`.
 *
 * Usage (from repository root):
 *     forge build
 *     node scripts/extractBytecode.js
 *
 * Or via npm:
 *     (cd scripts && npm run sync-bytecode)
 *
 * Zero runtime dependencies — runs on any Node ≥ 14 out of the box.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const REPO_ROOT     = path.resolve(__dirname, '..');
const ARTIFACT_PATH = path.join(REPO_ROOT, 'out', 'ToshLaunchpadHook.sol', 'ToshLaunchpadHook.json');
const OUTPUT_PATHS  = [
    path.join(REPO_ROOT, 'soat-frontend', 'src', 'app', 'lib', 'hookBytecode.ts'),
];

function fail(msg) {
    console.error('\x1b[31m[extractBytecode]\x1b[0m ' + msg);
    process.exit(1);
}

function info(msg) {
    console.log('\x1b[36m[extractBytecode]\x1b[0m ' + msg);
}

// ── 1. Load the artifact ────────────────────────────────────────────────────
if (!fs.existsSync(ARTIFACT_PATH)) {
    fail(
        'Artifact not found at\n    ' + ARTIFACT_PATH +
        '\nRun `forge build` first.'
    );
}

let artifact;
try {
    artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
} catch (e) {
    fail('Failed to parse artifact JSON: ' + e.message);
}

const bytecode =
    artifact.bytecode && typeof artifact.bytecode === 'object'
        ? artifact.bytecode.object
        : artifact.bytecode;

if (typeof bytecode !== 'string' || !bytecode.startsWith('0x')) {
    fail('Artifact has no valid `.bytecode.object` field.');
}

const len = bytecode.length;
if (len < 100) {
    fail('Extracted bytecode is suspiciously short (' + len + ' chars).');
}

// ── 2. Compose the .ts file ────────────────────────────────────────────────
const header =
    '// AUTO-GENERATED from Foundry artifact — do not edit by hand.\n' +
    '// Source: out/ToshLaunchpadHook.sol/ToshLaunchpadHook.json -> bytecode.object\n' +
    '//\n' +
    '// Regenerate after any change to ToshLaunchpadHook.sol (or its libraries):\n' +
    '//   1. forge build\n' +
    '//   2. node scripts/extractBytecode.js\n' +
    '//\n' +
    '// The CREATE2 hook-address miner (hookMiner.ts) feeds this bytecode into\n' +
    '// the salt search; a stale string here will produce wrong predicted\n' +
    '// addresses and every createLaunch() call will revert with InvalidHookSalt.\n' +
    '//\n' +
    '// The Foundry test `test_hookBytecode_inSyncWithArtifact` guards CI against\n' +
    '// forgetting this regeneration step.\n' +
    'export const HOOK_BYTECODE =\n' +
    '  "';

const footer = '" as const\n';

const content = header + bytecode + footer;

function writeAtomic(outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const tmpPath = outputPath + '.tmp';
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, outputPath);
}

let wrote = 0;
for (const outputPath of OUTPUT_PATHS) {
    const prev = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
    if (prev === content) {
        info('already in sync: ' + path.relative(REPO_ROOT, outputPath) + ' (' + len + ' chars)');
        continue;
    }
    writeAtomic(outputPath);
    wrote++;
    info('Wrote ' + len + ' chars to ' + path.relative(REPO_ROOT, outputPath));
}
if (wrote === 0) {
    info('hookBytecode.ts already in sync at every target. No changes written.');
}
