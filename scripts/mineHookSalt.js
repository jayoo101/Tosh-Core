#!/usr/bin/env node
/*
 * mineHookSalt.js
 * ───────────────
 * Mine a CREATE2 salt whose factory-derived hook address carries the v5.0 flag
 * mask 0x20CC, mirroring soat-frontend/src/app/lib/hookMiner.ts.
 *
 * PREFERRED — read the initcode hash off the chain, exactly as the frontend
 * does.  This cannot drift: the factory answers with the same hash it will
 * check inside `createLaunch`, so the bytecode artifact, the constructor tuple,
 * and the live factory globals are all guaranteed to agree.
 *
 *   node scripts/mineHookSalt.js \
 *     --rpc https://sepolia.base.org \
 *     --factory 0x... --treasury 0x... --creator 0x... [--admin 0x...] \
 *     [--duration 86400]
 *
 * FALLBACK — compute the hash locally.  Every constructor field must then be
 * supplied correctly, including the ladder treasury and the two factory caps;
 * a single stale value yields a salt that reverts with `InvalidHookSalt`.
 *
 *   node scripts/mineHookSalt.js \
 *     --factory 0x... --treasury 0x... --creator 0x... --ladder 0x... \
 *     --softcap 10000000000000000000 --wallet-cap 100000000000000000
 *
 * Flags:
 *   --treasury    projectTreasury (project multisig), NOT the ladder treasury
 *   --ladder      ladderTreasury (platform buyback reservoir); local mode only
 *   --admin       projectAdmin; defaults to --creator
 *   --duration    genesis window in seconds: 10800 | 86400 | 259200
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const {
    keccak256, encodeAbiParameters, parseAbiParameters, concat, pad,
    createPublicClient, http, parseAbi,
} = require('viem');

const REPO_ROOT = path.resolve(__dirname, '..');
const BYTECODE_PATH = path.join(REPO_ROOT, 'soat-frontend', 'src', 'app', 'lib', 'hookBytecode.ts');

const REQUIRED_FLAGS = BigInt(0x20CC);
const BEFORE_SWAP_FLAG = BigInt(1 << 7);
const AFTER_SWAP_FLAG  = BigInt(1 << 6);
const AFTER_ADD_FLAG   = BigInt(1 << 10);
const AFTER_REM_FLAG   = BigInt(1 << 8);
const BEFORE_SWAP_DELTA_FLAG = BigInt(1 << 3);
const AFTER_SWAP_DELTA_FLAG  = BigInt(1 << 2);
const AFTER_ADD_DELTA_FLAG   = BigInt(1 << 1);
const AFTER_REM_DELTA_FLAG   = BigInt(1 << 0);

const POOL_MANAGER = '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408';

/// Must mirror ToshLaunchpadHook.DURATION_{FAST,STANDARD,SLOW}; the constructor
/// rejects anything else, so an unlisted value mines a salt that cannot deploy.
const ALLOWED_DURATIONS = [10800n, 86400n, 259200n];
const DEFAULT_DURATION = 86400n;

const FACTORY_ABI = parseAbi([
    'function hookInitcodeHash(address projectTreasury, address creator, address projectAdmin, uint256 softCap, uint256 perWalletCap, uint256 genesisDuration) view returns (bytes32)',
    'function defaultSoftCap() view returns (uint256)',
    'function maxPogAllocationLimit() view returns (uint256)',
]);

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
    return fallback;
}

function loadBytecode() {
    const src = fs.readFileSync(BYTECODE_PATH, 'utf8');
    const m = src.match(/export const HOOK_BYTECODE =\s+"((?:0x)?[0-9a-fA-F]+)"/);
    if (!m) throw new Error('HOOK_BYTECODE not found in ' + BYTECODE_PATH);
    return (m[1].startsWith('0x') ? m[1] : '0x' + m[1]);
}

function computeCreate2Address(deployer, salt, initcodeHash) {
    const hash = keccak256(concat(['0xff', deployer, salt, initcodeHash]));
    return ('0x' + hash.slice(26));
}

function isValidHookAddress(addr) {
    const bits = BigInt(addr);
    if ((bits & REQUIRED_FLAGS) !== REQUIRED_FLAGS) return false;
    if ((bits & BEFORE_SWAP_DELTA_FLAG) !== 0n && (bits & BEFORE_SWAP_FLAG) === 0n) return false;
    if ((bits & AFTER_SWAP_DELTA_FLAG)  !== 0n && (bits & AFTER_SWAP_FLAG)  === 0n) return false;
    if ((bits & AFTER_ADD_DELTA_FLAG)   !== 0n && (bits & AFTER_ADD_FLAG)   === 0n) return false;
    if ((bits & AFTER_REM_DELTA_FLAG)   !== 0n && (bits & AFTER_REM_FLAG)   === 0n) return false;
    return true;
}

function deriveFinalSalt(creator, rawSalt) {
    return keccak256(encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes32' }],
        [creator, rawSalt]
    ));
}

/// Mirrors HookDeployLib.computeInitcodeHash — nine fields, this exact order.
function computeHookInitcodeHash(
    bytecode, poolManager, factory, projectTreasury, creator, projectAdmin,
    ladderTreasury, softCap, perWalletCap, genesisDuration,
) {
    const encodedArgs = encodeAbiParameters(
        parseAbiParameters('address, address, address, address, address, address, uint256, uint256, uint256'),
        [poolManager, factory, projectTreasury, creator, projectAdmin, ladderTreasury,
         softCap, perWalletCap, genesisDuration]
    );
    return keccak256(concat([bytecode, encodedArgs]));
}

function mine(factory, creator, initcodeHash, maxAttempts) {
    for (let i = 0n; i < BigInt(maxAttempts); i++) {
        const rawSalt = pad(('0x' + i.toString(16)), { size: 32 });
        const finalSalt = deriveFinalSalt(creator, rawSalt);
        const addr = computeCreate2Address(factory, finalSalt, initcodeHash);
        if (isValidHookAddress(addr)) {
            return { rawSalt, finalSalt, hookAddress: addr, attempts: Number(i) + 1 };
        }
    }
    throw new Error('no valid 0x20CC salt within ' + maxAttempts + ' attempts');
}

async function main() {
    const factory   = arg('factory');
    const treasury  = arg('treasury');
    const creator   = arg('creator');
    const admin     = arg('admin', creator);
    const ladder    = arg('ladder');
    const pool      = arg('pool', POOL_MANAGER);
    const rpc       = arg('rpc');
    const maxAttempts = Number(arg('max', '500000'));
    const duration  = BigInt(arg('duration', DEFAULT_DURATION.toString()));

    if (!factory || !treasury || !creator) {
        console.error('usage: node scripts/mineHookSalt.js --factory 0x --treasury 0x --creator 0x [--admin 0x]');
        console.error('       add --rpc <url> to read the initcode hash on-chain (recommended),');
        console.error('       or --ladder 0x --softcap <wei> --wallet-cap <wei> to compute it locally.');
        process.exit(1);
    }

    if (!ALLOWED_DURATIONS.includes(duration)) {
        console.error('--duration must be one of ' + ALLOWED_DURATIONS.join(' | ') + ' (got ' + duration + ')');
        process.exit(1);
    }

    let initcodeHash;
    let softCap;
    let perWalletCap;
    let source;

    if (rpc) {
        const client = createPublicClient({ transport: http(rpc) });
        const read = (functionName, args) =>
            client.readContract({ address: factory, abi: FACTORY_ABI, functionName, args });

        // The factory snapshots its live globals into the initcode at
        // `createLaunch` time, so they must be read now rather than assumed.
        [softCap, perWalletCap] = await Promise.all([
            read('defaultSoftCap', []),
            read('maxPogAllocationLimit', []),
        ]);
        initcodeHash = await read('hookInitcodeHash', [treasury, creator, admin, softCap, perWalletCap, duration]);
        source = 'on-chain (factory.hookInitcodeHash)';
    } else {
        if (!ladder) {
            console.error('local mode needs --ladder <ladderTreasury>; pass --rpc <url> to avoid this entirely.');
            process.exit(1);
        }
        softCap = BigInt(arg('softcap', '0'));
        perWalletCap = BigInt(arg('wallet-cap', '0'));
        if (softCap === 0n || perWalletCap === 0n) {
            console.error('local mode needs --softcap <wei> and --wallet-cap <wei> matching the LIVE factory values.');
            process.exit(1);
        }
        initcodeHash = computeHookInitcodeHash(
            loadBytecode(), pool, factory, treasury, creator, admin, ladder,
            softCap, perWalletCap, duration,
        );
        source = 'local (bytecode artifact + supplied args)';
    }

    const hit = mine(factory, creator, initcodeHash, maxAttempts);
    const flags = BigInt(hit.hookAddress) & BigInt(0x3fff);

    console.log('hash source         :', source);
    console.log('softCap             :', softCap.toString());
    console.log('perWalletCap        :', perWalletCap.toString());
    console.log('genesisDuration     :', duration.toString());
    console.log('initcodeHash        :', initcodeHash);
    console.log('rawSalt             :', hit.rawSalt);
    console.log('finalSalt           :', hit.finalSalt);
    console.log('hookAddress         :', hit.hookAddress);
    console.log('attempts            :', hit.attempts);
    console.log('addr & 0x3fff       :', '0x' + flags.toString(16).toUpperCase().padStart(4, '0'));
    console.log('REQUIRED_FLAGS      : 0x20CC');
    console.log('mask subset OK      :', (flags & REQUIRED_FLAGS) === REQUIRED_FLAGS ? 'YES' : 'NO');
}

main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
});
