#!/usr/bin/env node
//
// INCIDENT_RESPONSE §Q4 — red-team drill against forged PoG attestations.
//
// ── What Q4 asks for ────────────────────────────────────────────────────────
//
//   "External attacker tries a forged PoG attestation against the Robinhood
//    testnet deployment. Every attempt reverts out of ToshFactory.registerPoG
//    with InvalidSignature() (or NonceConflict / SignatureExpired /
//    SignatureTooLong for a replay or a stale deadline), and pogQuota is
//    unchanged for every address tried."
//
//   That criterion is new. Until 2026-09-05 the pass condition read "all
//   attempts fail at `_verifyPoGSignature`", naming a function that has never
//   existed — see SECURITY_AUDIT.md §5.12. You cannot watch calls fail at a
//   function that is not there, so the drill was unrunnable as specified. This
//   harness is the criterion made executable.
//
// ── Attacker model ──────────────────────────────────────────────────────────
//
//   A genuine external attacker: no pogSigner key, no owner key, nothing but
//   public chain data. That is why this runs entirely through `eth_call` — the
//   attacker's own transactions would revert and change nothing, and eth_call
//   walks the identical code path while returning the exact revert selector.
//   A reverting top-level call cannot mutate state, so "reverts" already
//   implies "pogQuota unchanged"; the quota is still read before and after, as
//   the cross-check that catches an attempt which did NOT revert.
//
// ── Why the gate-order vectors matter ───────────────────────────────────────
//
//   Without the signer key there is no way to demonstrate the ACCEPT path, so a
//   factory that refuses everything for an unrelated reason — paused, signer
//   set to a dead address — would pass a naive drill trivially. The defence is
//   distinctness: `registerPoG` checks blacklist, then SignatureTooLong, then
//   SignatureExpired, then NonceConflict, then ExceedsGlobalPogLimit, and only
//   then the signature. Driving each gate to return its OWN selector is what
//   proves the harness reaches line 513 rather than bouncing off something
//   earlier. `paused` is asserted false for the same reason.
//
// ── What this drill CANNOT reach, and where those properties live instead ───
//
//   Sender-binding and cross-chain / cross-contract domain separation are NOT
//   exercised here, and the reason is structural rather than an omission. The
//   only genuine attestation ever registered on this deployment is expired, and
//   the deadline gate precedes the signature check — so replaying it always
//   stops at SignatureExpired, and getting past that gate requires mutating the
//   deadline, which changes the digest and makes every failure attributable to
//   two fields at once. No single-field isolation is possible from public data.
//   Those properties are proven by code review (§5.12) and by the unit tests in
//   test/ToshV5Factory.t.sol, which hold the signer key.
//
// Usage: node scripts/drillQ4.mjs [--json out.json]
// Exit:  0 every vector behaved as specified · 1 a vector misbehaved · 2 cannot run

import { ethers } from 'ethers';
import fs from 'node:fs';

const RPC = process.env.ROBINHOOD_TESTNET_RPC || 'https://rpc.testnet.chain.robinhood.com';
const FACTORY = '0x2E690A91b383eDB21f6b5B4180Cc4a2C905C6BeA';
const TESTNET_ID = 46630n;

// The one genuine PoG registration on this deployment, from its calldata.
// tx 0xf1c6257e5f4ba00e6102676cc99e38199e9c1d312b2259043719205f18a80942
const REAL = {
  tx: '0xf1c6257e5f4ba00e6102676cc99e38199e9c1d312b2259043719205f18a80942',
  sender: '0x73db078fa94607893270079AC8F5c7492aB480cd',
  maxAlloc: 10_000_000_000_000_000n, // 0.01 ETH
  nonce: 0n,
  deadline: 1_788_440_372n, // 2026-09-03T12:59:32Z — expired
  signature:
    '0x98f5332f152b1f421862eebd4ebdfeb75174b6c150bd24af65d3e3cf78c1a5c8' +
    '6485e2bed60cf4bb9e57c17d171e1e8705d082476af9d6b9a0032fbb4bd85777' +
    '1c',
};

const FACTORY_ABI = [
  'function registerPoG(uint256 maxAlloc,uint256 deadline,uint256 nonce,bytes signature)',
  'function pogSigner() view returns (address)',
  'function pogQuota(address) view returns (uint256)',
  'function pogNonces(address) view returns (uint256)',
  'function maxPogAllocationLimit() view returns (uint256)',
  'function MAX_SIG_VALIDITY() view returns (uint256)',
  'function paused() view returns (bool)',
  'error IsBlacklisted()',
  'error InvalidSignature()',
  'error NonceConflict()',
  'error SignatureExpired()',
  'error SignatureTooLong()',
  'error ExceedsGlobalPogLimit()',
  'error EnforcedPause()',
  // OpenZeppelin ECDSA reverts from INSIDE `recover`, before the factory ever
  // compares an address. A malformed signature therefore never yields
  // `InvalidSignature` — it cannot produce a recovered address at all. Running
  // the drill is what surfaced this; the first pass flagged three correct
  // refusals as failures because these three were missing from the ABI.
  'error ECDSAInvalidSignature()',
  'error ECDSAInvalidSignatureS(bytes32)',
  'error ECDSAInvalidSignatureLength(uint256)',
];

const iface = new ethers.Interface(FACTORY_ABI);
const provider = new ethers.JsonRpcProvider(RPC);
const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);

const die = (msg) => {
  console.error(`\n  CANNOT RUN — ${msg}`);
  process.exit(2);
};

// ── Digest the contract builds, so vectors can be signed over a chosen tuple ──
function digest({ sender, maxAlloc, nonce, deadline, contract, chainId }) {
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'uint256', 'uint256', 'uint256', 'address', 'uint256'],
      [sender, maxAlloc, nonce, deadline, contract, chainId]
    )
  );
  return ethers.hashMessage(ethers.getBytes(inner)); // EIP-191
}

// ── Run one vector as the attacker would see it ───────────────────────────────
async function attempt({ from, maxAlloc, deadline, nonce, signature }) {
  const data = iface.encodeFunctionData('registerPoG', [maxAlloc, deadline, nonce, signature]);
  try {
    await provider.call({ to: FACTORY, from, data });
    return { reverted: false, error: null };
  } catch (e) {
    const raw = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
    if (typeof raw === 'string' && raw.length >= 10) {
      try {
        const parsed = iface.parseError(raw);
        if (parsed) return { reverted: true, error: parsed.name };
      } catch {}
      return { reverted: true, error: `unknown selector ${raw.slice(0, 10)}` };
    }
    const m = (e.shortMessage || e.message || '').slice(0, 90);
    return { reverted: true, error: `no revert data (${m})` };
  }
}

async function main() {
  console.log('═'.repeat(78));
  console.log('  Q4 — forged PoG attestation red team');
  console.log('═'.repeat(78));

  const net = await provider.getNetwork().catch((e) => die(`RPC unreachable: ${e.shortMessage || e.message}`));
  if (net.chainId !== TESTNET_ID) die(`wrong chain ${net.chainId}, this drill only runs on ${TESTNET_ID}`);
  if (((await provider.getCode(FACTORY)).length - 2) / 2 === 0) die(`no contract at ${FACTORY}`);

  const [signer, limit, ttl, paused, head] = await Promise.all([
    factory.pogSigner(),
    factory.maxPogAllocationLimit(),
    factory.MAX_SIG_VALIDITY(),
    factory.paused(),
    provider.getBlockNumber(),
  ]);

  // A paused factory refuses registerPoG at the modifier, which would make
  // every vector below pass for a reason that has nothing to do with signatures.
  if (paused) die('factory is PAUSED — every vector would refuse at the modifier and prove nothing');

  console.log(`\n  chain ${net.chainId}  head ${head}`);
  console.log(`  factory     ${FACTORY}`);
  console.log(`  pogSigner   ${signer}`);
  console.log(`  wallet cap  ${ethers.formatEther(limit)} ETH   sig TTL ${ttl}s   paused ${paused}`);

  // ── Step 0: the historical artefact really is a pogSigner signature ────────
  const realDigest = digest({
    sender: REAL.sender,
    maxAlloc: REAL.maxAlloc,
    nonce: REAL.nonce,
    deadline: REAL.deadline,
    contract: FACTORY,
    chainId: TESTNET_ID,
  });
  const recovered = ethers.recoverAddress(realDigest, REAL.signature);
  const genuine = recovered.toLowerCase() === signer.toLowerCase();
  console.log(`\n  step 0 — historical attestation ${REAL.tx.slice(0, 14)}…`);
  console.log(`    recovers to ${recovered}`);
  console.log(`    ${genuine ? 'MATCHES the live pogSigner — the artefact is genuine' : 'DOES NOT match pogSigner'}`);
  if (!genuine) die('the historical signature does not recover to the live pogSigner; rebuild REAL from chain');

  // ── Attacker keys. Deterministic so a rerun is comparable. ─────────────────
  const attacker = new ethers.Wallet(ethers.id('tosh-q4-attacker'));
  const victim = new ethers.Wallet(ethers.id('tosh-q4-victim'));
  const now = (await provider.getBlock('latest')).timestamp;
  const soon = BigInt(now + 3600);
  const tooFar = BigInt(now) + ttl + 3600n;

  const signAs = async (wallet, tuple) =>
    wallet.signingKey.sign(digest(tuple)).serialized;

  const good = { maxAlloc: limit, nonce: 0n, deadline: soon };

  const vectors = [
    // ── Gate-order vectors: each must return its OWN selector, which is what
    //    proves the harness drives real code and reaches the signature check.
    {
      name: 'deadline further out than MAX_SIG_VALIDITY',
      want: 'SignatureTooLong',
      why: 'the TTL ceiling is live',
      build: async () => ({
        from: attacker.address,
        maxAlloc: good.maxAlloc,
        deadline: tooFar,
        nonce: 0n,
        signature: await signAs(attacker, {
          sender: attacker.address, maxAlloc: good.maxAlloc, nonce: 0n, deadline: tooFar,
          contract: FACTORY, chainId: TESTNET_ID,
        }),
      }),
    },
    {
      name: 'deadline already passed',
      want: 'SignatureExpired',
      why: 'the expiry gate is live',
      build: async () => ({
        from: attacker.address,
        maxAlloc: good.maxAlloc,
        deadline: BigInt(now - 1),
        nonce: 0n,
        signature: await signAs(attacker, {
          sender: attacker.address, maxAlloc: good.maxAlloc, nonce: 0n, deadline: BigInt(now - 1),
          contract: FACTORY, chainId: TESTNET_ID,
        }),
      }),
    },
    {
      name: 'nonce skipped ahead',
      want: 'NonceConflict',
      why: 'the nonce gate is live and sequential',
      build: async () => ({
        from: attacker.address, maxAlloc: good.maxAlloc, deadline: soon, nonce: 7n,
        signature: await signAs(attacker, {
          sender: attacker.address, maxAlloc: good.maxAlloc, nonce: 7n, deadline: soon,
          contract: FACTORY, chainId: TESTNET_ID,
        }),
      }),
    },
    {
      name: 'maxAlloc one wei over the per-wallet ceiling',
      want: 'ExceedsGlobalPogLimit',
      why: 'the ceiling is live and is not silently clamped',
      build: async () => ({
        from: attacker.address, maxAlloc: limit + 1n, deadline: soon, nonce: 0n,
        signature: await signAs(attacker, {
          sender: attacker.address, maxAlloc: limit + 1n, nonce: 0n, deadline: soon,
          contract: FACTORY, chainId: TESTNET_ID,
        }),
      }),
    },

    // ── The Q4 property: a perfect envelope with an attacker-signed digest.
    {
      name: 'PERFECT envelope, signed by an attacker key',
      want: 'InvalidSignature',
      why: 'THE Q4 PROPERTY — every gate satisfied, refused on the signature alone',
      build: async () => ({
        from: attacker.address, maxAlloc: good.maxAlloc, deadline: soon, nonce: 0n,
        signature: await signAs(attacker, {
          sender: attacker.address, maxAlloc: good.maxAlloc, nonce: 0n, deadline: soon,
          contract: FACTORY, chainId: TESTNET_ID,
        }),
      }),
    },
    {
      name: 'attacker signs a digest naming the VICTIM as sender, submits it himself',
      want: 'InvalidSignature',
      why: 'no key, no quota — the digest is not the weak point, the key is',
      build: async () => ({
        from: attacker.address, maxAlloc: good.maxAlloc, deadline: soon, nonce: 0n,
        signature: await signAs(victim, {
          sender: attacker.address, maxAlloc: good.maxAlloc, nonce: 0n, deadline: soon,
          contract: FACTORY, chainId: TESTNET_ID,
        }),
      }),
    },

    // ── The genuine artefact, reused every way public data allows.
    {
      name: 'GENUINE attestation replayed verbatim by its original sender',
      want: 'SignatureExpired',
      why: 'a real signature is already dead on TTL alone, before any other check',
      build: async () => ({
        from: REAL.sender, maxAlloc: REAL.maxAlloc, deadline: REAL.deadline, nonce: REAL.nonce,
        signature: REAL.signature,
      }),
    },
    {
      name: 'GENUINE attestation lifted to the attacker wallet, verbatim',
      want: 'SignatureExpired',
      why: 'stopped by the cheapest gate; sender-binding is never even consulted',
      build: async () => ({
        from: attacker.address, maxAlloc: REAL.maxAlloc, deadline: REAL.deadline, nonce: REAL.nonce,
        signature: REAL.signature,
      }),
    },
    {
      name: 'GENUINE signature, deadline refreshed AND nonce advanced to the sender\'s current one',
      want: 'InvalidSignature',
      why: 'both had to move to reach the signature check at all — this IS the two-field '
        + 'coupling that makes single-field isolation unreachable from public data',
      build: async () => ({
        from: REAL.sender, maxAlloc: REAL.maxAlloc, deadline: soon,
        nonce: await factory.pogNonces(REAL.sender),
        signature: REAL.signature,
      }),
    },
    {
      name: 'GENUINE signature, deadline refreshed but the spent nonce reused',
      want: 'NonceConflict',
      why: 'the spent nonce is refused before the signature is even looked at, '
        + 'so a consumed attestation has two independent reasons to die',
      build: async () => ({
        from: REAL.sender, maxAlloc: REAL.maxAlloc, deadline: soon, nonce: REAL.nonce,
        signature: REAL.signature,
      }),
    },
    {
      name: 'GENUINE signature, refreshed deadline, lifted to the attacker wallet',
      want: 'InvalidSignature',
      why: 'the only artefact on chain cannot be reused at all',
      build: async () => ({
        from: attacker.address, maxAlloc: REAL.maxAlloc, deadline: soon, nonce: 0n,
        signature: REAL.signature,
      }),
    },

    // ── Signature-shape attacks against the ECDSA layer.
    {
      name: 'malleable signature — s flipped to the upper half of the curve',
      want: 'ECDSAInvalidSignatureS',
      why: 'high-s is named and refused inside recover(), not quietly accepted as a '
        + 'second valid encoding of a signature the signer really did issue',
      build: async () => {
        const sig = ethers.Signature.from(REAL.signature);
        const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
        // Assembled by hand: ethers v6 refuses to SERIALIZE a high-s signature
        // ("non-canonical s"), which is the library declining to build the very
        // artefact this vector needs. The 65 bytes go r ‖ s ‖ v.
        const flipped = ethers.concat([
          sig.r,
          ethers.toBeHex(N - BigInt(sig.s), 32),
          new Uint8Array([sig.v === 27 ? 28 : 27]),
        ]);
        return {
          from: REAL.sender, maxAlloc: REAL.maxAlloc, deadline: soon,
          nonce: await factory.pogNonces(REAL.sender), signature: ethers.hexlify(flipped),
        };
      },
    },
    {
      name: 'all-zero 65-byte signature',
      want: 'ECDSAInvalidSignature',
      why: 'recovery fails outright — a null signature does not resolve to address(0), '
        + 'which is the version of this bug that would matter',
      build: async () => ({
        from: attacker.address, maxAlloc: good.maxAlloc, deadline: soon, nonce: 0n,
        signature: '0x' + '00'.repeat(65),
      }),
    },
    {
      // Deliberately a SET rather than one selector, and deliberately repeated.
      // Random bytes are refused by whichever gate they happen to hit first: a
      // high s lands on ECDSAInvalidSignatureS, a low s recovers to a junk
      // address and lands on the factory's own InvalidSignature, and an r/s the
      // curve rejects lands on ECDSAInvalidSignature. Pinning a seed to force
      // one answer would have hidden that spread behind a green tick; asserting
      // the set is what actually says "however the bytes fall, it is refused".
      name: 'random 65 bytes, 8 independent draws',
      want: ['ECDSAInvalidSignature', 'ECDSAInvalidSignatureS', 'InvalidSignature'],
      repeat: 8,
      why: 'brute force has no cheaper entry than the key itself, by any of three paths',
      build: async () => ({
        from: attacker.address, maxAlloc: good.maxAlloc, deadline: soon, nonce: 0n,
        signature: ethers.hexlify(ethers.randomBytes(65)),
      }),
    },
    {
      name: 'truncated 64-byte signature',
      want: 'ECDSAInvalidSignatureLength',
      why: 'a wrong-length blob is refused on length, so no short-read path exists',
      build: async () => ({
        from: attacker.address, maxAlloc: good.maxAlloc, deadline: soon, nonce: 0n,
        signature: ethers.dataSlice(REAL.signature, 0, 64),
      }),
    },
  ];

  // ── Quota snapshot for every address the drill touches ─────────────────────
  const touched = [...new Set([attacker.address, victim.address, REAL.sender])];
  const before = {};
  for (const a of touched) before[a] = await factory.pogQuota(a);

  console.log(`\n  ${vectors.length} vectors, all through eth_call — an attacker's transactions would`);
  console.log('  revert and change nothing, and eth_call returns the exact selector.\n');
  console.log('  ' + '─'.repeat(74));

  const results = [];
  let bad = 0;

  for (const [i, v] of vectors.entries()) {
    const accept = Array.isArray(v.want) ? v.want : [v.want];
    const draws = v.repeat ?? 1;
    const got = [];
    let ok = true;

    for (let d = 0; d < draws; d++) {
      const { reverted, error } = await attempt(await v.build());
      got.push(reverted ? error : 'ACCEPTED');
      if (!reverted || !accept.includes(error)) ok = false;
    }
    if (!ok) bad++;

    const tally = [...new Set(got)].map((e) => `${e}×${got.filter((g) => g === e).length}`).join(', ');
    results.push({ vector: v.name, want: accept, draws, got: tally, pass: ok, why: v.why });

    console.log(`  ${ok ? 'REFUSED ' : '*** !! *'} ${String(i + 1).padStart(2)}. ${v.name}`);
    console.log(`             ${ok ? tally : `expected ${accept.join(' | ')}, got ${tally}`}`);
    console.log(`             ${v.why}`);
  }

  console.log('  ' + '─'.repeat(74));

  // ── The cross-check: nothing moved ────────────────────────────────────────
  let moved = 0;
  console.log('\n  pogQuota, before and after:');
  for (const a of touched) {
    const after = await factory.pogQuota(a);
    const same = after === before[a];
    if (!same) moved++;
    console.log(
      `    ${same ? 'unchanged' : '*** MOVED'}  ${a}  ${ethers.formatEther(before[a])} -> ${ethers.formatEther(after)} ETH`
    );
  }

  const pass = bad === 0 && moved === 0;
  console.log('\n' + '═'.repeat(78));
  console.log(`  ${pass ? 'Q4 PASS' : 'Q4 FAIL'} — ${vectors.length - bad}/${vectors.length} vectors refused as specified, ` +
    `${touched.length - moved}/${touched.length} quotas unchanged`);
  if (pass) {
    console.log('  Not covered here, by construction: sender-binding and cross-chain /');
    console.log('  cross-contract domain separation. The only genuine attestation on this');
    console.log('  deployment is expired and the TTL gate precedes the signature check, so');
    console.log('  no single-field isolation is reachable from public data. Those live in');
    console.log('  test/ToshV5Factory.t.sol.');
  }
  console.log('═'.repeat(78));

  const jsonIdx = process.argv.indexOf('--json');
  if (jsonIdx > -1 && process.argv[jsonIdx + 1]) {
    const out = {
      drill: 'Q4', chainId: Number(net.chainId), factory: FACTORY, pogSigner: signer,
      head, ranAt: new Date().toISOString(), artefact: REAL.tx, artefactGenuine: genuine,
      vectors: results,
      quotas: Object.fromEntries(touched.map((a) => [a, before[a].toString()])),
      pass,
    };
    fs.writeFileSync(process.argv[jsonIdx + 1], JSON.stringify(out, null, 2));
    console.log(`\n  report -> ${process.argv[jsonIdx + 1]}`);
  }

  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error(`\n  drill crashed: ${e.stack || e.message}`);
  process.exitCode = 2;
});
