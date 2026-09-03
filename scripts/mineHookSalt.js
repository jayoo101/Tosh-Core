#!/usr/bin/env node
/*
 * mineHookSalt.js
 * ───────────────
 * Mine a CREATE2 salt whose factory-derived hook address carries the v5.0 flag
 * mask 0x20CC, mirroring soat-frontend/src/app/lib/hookMiner.ts.
 *
 * PREFERRED — read the initcode hash off the chain, exactly as the frontend
 * does.  This cannot drift: the factory answers with the same hash it will
 * check inside `createLaunch`, so the clone layout and the live factory globals
 * are all guaranteed to agree.
 *
 *   node scripts/mineHookSalt.js \
 *     --rpc https://rpc.testnet.chain.robinhood.com \
 *     --factory 0x... --treasury 0x... --creator 0x... \
 *     [--duration 86400]
 *
 * FALLBACK — build the clone initcode locally.  Every field must then be
 * supplied correctly; a single stale value yields a salt that reverts with
 * `InvalidHookSalt`.
 *
 *   node scripts/mineHookSalt.js \
 *     --factory 0x... --treasury 0x... --creator 0x... --impl 0x... \
 *     --softcap 10000000000000000 --wallet-cap 6000000000000000
 *
 * Flags:
 *   --treasury    projectTreasury (project multisig), NOT the ladder treasury
 *   --impl        factory.hookImplementation(); local mode only
 *   --duration    genesis window in seconds: 10800 | 86400 | 259200
 *
 * ── This file drifted once; here is what it drifted past ────────────────────
 *
 * Until the Robinhood cutover it mined against `keccak256(hookBytecode ‖
 * abi.encode(nine constructor args))`, which is what a hook *used* to be. Since
 * the EIP-1167 change a hook is a 131-byte clone initcode and the hash is over
 * that, with only five fields in it — see `computeCloneInitcode`. The on-chain
 * ABI here was also a field ahead of the factory's, so `--rpc` mode simply
 * reverted.
 *
 * Worth naming why only this copy rotted. `soat-frontend/src/app/lib/
 * hookMiner.ts` does the same arithmetic and stayed correct throughout, because
 * `test_hookInitcodeHash_matchesHandBuiltCloneInitcode` compares it against
 * `ToshCloneLib` on every run. This file has no such test, so nothing objected.
 * Prefer `--rpc` for exactly that reason: it asks the contract instead of
 * restating it.
 */

'use strict';

const {
    keccak256, encodeAbiParameters, concat, pad, numberToHex,
    createPublicClient, http, parseAbi,
} = require('viem');

const REQUIRED_FLAGS = BigInt(0x20CC);
const BEFORE_SWAP_FLAG = BigInt(1 << 7);
const AFTER_SWAP_FLAG  = BigInt(1 << 6);
const AFTER_ADD_FLAG   = BigInt(1 << 10);
const AFTER_REM_FLAG   = BigInt(1 << 8);
const BEFORE_SWAP_DELTA_FLAG = BigInt(1 << 3);
const AFTER_SWAP_DELTA_FLAG  = BigInt(1 << 2);
const AFTER_ADD_DELTA_FLAG   = BigInt(1 << 1);
const AFTER_REM_DELTA_FLAG   = BigInt(1 << 0);

/// Must mirror ToshLaunchpadHook.DURATION_{FAST,STANDARD,SLOW}; `initializeToken`
/// rejects anything else, so an unlisted value mines a salt that cannot deploy.
const ALLOWED_DURATIONS = [10800n, 86400n, 259200n];
const DEFAULT_DURATION = 86400n;

const FACTORY_ABI = parseAbi([
    'function hookInitcodeHash(address projectTreasury, address creator, uint256 softCap, uint256 perWalletCap, uint256 genesisDuration) view returns (bytes32)',
    'function hookImplementation() view returns (address)',
    'function defaultSoftCap() view returns (uint256)',
    'function maxPogAllocationLimit() view returns (uint256)',
]);

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
    return fallback;
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

/// Mirrors ToshCloneLib.cloneInitcode byte for byte — 131 bytes, three parts:
///
///   [0  .. 9  ]  10 B  creation stub returning the 121 (0x79) bytes below
///   [10 .. 54 ]  45 B  EIP-1167 runtime, implementation address at offset 10
///   [55 .. 130]  76 B  immutable args, copied verbatim into the runtime
///
/// The args are packed, NOT abi-encoded: two addresses, two uint128s and a
/// uint32, 76 bytes with no padding and no offsets. Encoding them as a tuple
/// would produce 160 bytes and a hash nothing on chain agrees with.
///
/// Note what is NOT in here. `poolManager`, `factory` and `ladderTreasury` are
/// the same for every launch and live as ordinary immutables on the shared
/// implementation. `projectAdmin` is mutable by design and applied later by
/// `initializeToken`, so it does not move the mined address.
function computeCloneInitcode(
    implementation, creator, projectTreasury, softCap, perWalletCap, genesisDuration,
) {
    if (softCap >= 1n << 128n || perWalletCap >= 1n << 128n) {
        throw new Error('softCap / perWalletCap must fit in uint128');
    }
    if (genesisDuration >= 1n << 32n) {
        throw new Error('genesisDuration must fit in uint32');
    }
    return concat([
        '0x3d607980600a3d3981f3',
        '0x363d3d373d3d3d363d73',
        implementation,
        '0x5af43d82803e903d91602b57fd5bf3',
        creator,
        projectTreasury,
        numberToHex(softCap, { size: 16 }),
        numberToHex(perWalletCap, { size: 16 }),
        numberToHex(genesisDuration, { size: 4 }),
    ]);
}

function computeHookInitcodeHash(...args) {
    return keccak256(computeCloneInitcode(...args));
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
    const impl      = arg('impl');
    const rpc       = arg('rpc');
    const maxAttempts = Number(arg('max', '500000'));
    const duration  = BigInt(arg('duration', DEFAULT_DURATION.toString()));

    if (!factory || !treasury || !creator) {
        console.error('usage: node scripts/mineHookSalt.js --factory 0x --treasury 0x --creator 0x');
        console.error('       add --rpc <url> to read the initcode hash on-chain (recommended),');
        console.error('       or --impl 0x --softcap <wei> --wallet-cap <wei> to compute it locally.');
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
        initcodeHash = await read('hookInitcodeHash', [treasury, creator, softCap, perWalletCap, duration]);

        // Cross-check the chain's answer against the local reconstruction. Free,
        // and it is the only thing standing between this file and the drift
        // described in the header — `--rpc` mode would otherwise keep working
        // while the local path rotted unnoticed.
        const impl = await read('hookImplementation', []);
        const local = computeHookInitcodeHash(impl, creator, treasury, softCap, perWalletCap, duration);
        if (local !== initcodeHash) {
            console.error('initcode hash mismatch — this script no longer models ToshCloneLib.');
            console.error('  factory.hookInitcodeHash : ' + initcodeHash);
            console.error('  computeCloneInitcode     : ' + local);
            console.error('  Mining would produce salts that revert with InvalidHookSalt.');
            console.error('  Fix computeCloneInitcode against src/libraries/ToshCloneLib.sol.');
            process.exit(1);
        }
        source = 'on-chain (factory.hookInitcodeHash), local reconstruction agrees';
    } else {
        if (!impl) {
            console.error('local mode needs --impl <factory.hookImplementation()>; pass --rpc <url> to avoid this entirely.');
            process.exit(1);
        }
        softCap = BigInt(arg('softcap', '0'));
        perWalletCap = BigInt(arg('wallet-cap', '0'));
        if (softCap === 0n || perWalletCap === 0n) {
            console.error('local mode needs --softcap <wei> and --wallet-cap <wei> matching the LIVE factory values.');
            process.exit(1);
        }
        initcodeHash = computeHookInitcodeHash(impl, creator, treasury, softCap, perWalletCap, duration);
        source = 'local (clone initcode, unverified against any chain)';
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
