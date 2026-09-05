#!/usr/bin/env node
// Measure the real margin the two PoG signers have against ToshFactory's upper
// deadline bound, instead of reasoning about it.
//
//   src/ToshFactory.sol:506
//     if (deadline > block.timestamp + MAX_SIG_VALIDITY) revert SignatureTooLong();
//
// MAX_SIG_VALIDITY is 24 h. Substituting `deadline = signerNow + 24h` cancels
// both terms and leaves `signerNow > block.timestamp` ??zero margin. That is
// what `pogQuota.computeDeadline()` returns, and `scripts/pogSigner.ts` is its
// only caller. `sign-allocation/route.ts` deliberately uses 23 h instead.
//
// This is measurable without funds or a valid signature, because the bound is
// checked BEFORE the nonce and before `recover`: blacklist, then this, then
// expiry, then nonce, then the cap, then the signature. So an eth_call with a
// junk signature reveals exactly which gate a given deadline lands on, and
// walking the deadline finds the threshold ??which is the effective
// `block.timestamp` the node uses for a call, not a guess at it.
import { ethers } from 'ethers';

const RPC = process.env.ROBINHOOD_TESTNET_RPC || 'https://rpc.testnet.chain.robinhood.com';
const FACTORY = '0x2E690A91b383eDB21f6b5B4180Cc4a2C905C6BeA';

const ABI = [
  // Argument order is (maxAlloc, deadline, nonce, signature) ??deadline SECOND.
  // Getting this backwards puts the deadline in the nonce slot and leaves
  // deadline at 0, so every probe answers SignatureExpired and the measurement
  // looks like a broken gate rather than a broken caller.
  'function registerPoG(uint256 maxAlloc, uint256 deadline, uint256 nonce, bytes signature)',
  'function maxPogAllocationLimit() view returns (uint256)',
  'function pogNonces(address) view returns (uint256)',
  'error SignatureTooLong()',
  'error SignatureExpired()',
  'error NonceConflict()',
  'error ExceedsGlobalPogLimit()',
  'error InvalidSignature()',
  'error IsBlacklisted()',
  'error ECDSAInvalidSignature()',
  'error ECDSAInvalidSignatureS(bytes32)',
  'error ECDSAInvalidSignatureLength(uint256)',
];

const MAX_SIG_VALIDITY = 86400n;      // ToshFactory.MAX_SIG_VALIDITY
const SHARED_TTL = 86400n;            // pogQuota.SIG_VALIDITY_SECONDS, via computeDeadline()
const ROUTE_TTL = 86400n - 3600n;     // sign-allocation.ATTESTATION_TTL_SEC

const provider = new ethers.JsonRpcProvider(RPC);
const factory = new ethers.Contract(FACTORY, ABI, provider);
// A wallet nobody has attested for, so nothing here depends on live quota state.
const probe = ethers.Wallet.createRandom();

/** Which gate a deadline lands on, by name. */
async function gateFor(deadline) {
  try {
    await factory.registerPoG.staticCall(1n, deadline, 0n, '0x' + '11'.repeat(65), { from: probe.address });
    return 'PASSED_ALL';
  } catch (e) {
    const name = e?.revert?.name ?? null;
    if (name) return name;
    return `unknown: ${(e.shortMessage ?? e.message ?? '').slice(0, 90)}`;
  }
}

const latest = await provider.getBlock('latest');
console.log(`chain      : ${(await provider.getNetwork()).chainId}`);
console.log(`head block : ${latest.number}  timestamp ${latest.timestamp}`);
console.log(`local clock: ${Math.floor(Date.now() / 1000)}`);
console.log(`local minus head timestamp: ${Math.floor(Date.now() / 1000) - latest.timestamp} s\n`);

// Find the largest deadline that does NOT trip SignatureTooLong. Bracket first,
// then bisect. The threshold equals `effectiveTimestamp + MAX_SIG_VALIDITY`.
const base = BigInt(latest.timestamp);
let lo = base;                       // certainly fine (well under the bound)
let hi = base + MAX_SIG_VALIDITY * 2n; // certainly too long

const loGate = await gateFor(lo);
const hiGate = await gateFor(hi);
console.log(`sanity: deadline=head+0      -> ${loGate}`);
console.log(`sanity: deadline=head+48h    -> ${hiGate}\n`);
if (loGate === 'SignatureTooLong' || hiGate !== 'SignatureTooLong') {
  console.log('Bracket is wrong; the gate does not behave as assumed. Stopping.');
  process.exit(1);
}

let calls = 2;
while (hi - lo > 1n) {
  const mid = (lo + hi) / 2n;
  const gate = await gateFor(mid);
  calls++;
  if (gate === 'SignatureTooLong') hi = mid; else lo = mid;
}

const threshold = lo;                       // largest accepted deadline
const effectiveNow = threshold - MAX_SIG_VALIDITY;
console.log(`largest accepted deadline : ${threshold}  (${calls} eth_calls)`);
console.log(`=> effective block.timestamp for a call: ${effectiveNow}`);
console.log(`   (head timestamp was ${latest.timestamp}; difference ${effectiveNow - base})\n`);

// The load-bearing quantity, stated directly. Substituting a TTL of T into the
// bound gives: fails iff `signerNow + T > effectiveNow + MAX_SIG_VALIDITY`, i.e.
// iff `signerNow - effectiveNow > MAX_SIG_VALIDITY - T`. So the tolerated skew is
// exactly the headroom a signer leaves under the ceiling, and the current skew is
// what has to stay below it.
const localNow = BigInt(Math.floor(Date.now() / 1000));
const skew = localNow - effectiveNow;
console.log(`clock skew right now: local - effective = ${skew} s`);
console.log('(the threshold above was measured a few seconds earlier, so treat it');
console.log(' as approximate; the gate results below are direct observations.)\n');

const rows = [
  ['pogQuota.computeDeadline()   <- scripts/pogSigner.ts', SHARED_TTL],
  ['sign-allocation ATTESTATION_TTL_SEC', ROUTE_TTL],
];

console.log('Tolerated skew = MAX_SIG_VALIDITY - ttl, and the gate each one hits now:');
let anyZero = false;
for (const [label, ttl] of rows) {
  const tolerated = MAX_SIG_VALIDITY - ttl;
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + ttl;
  const gate = await gateFor(deadline);
  if (tolerated === 0n) anyZero = true;
  console.log(`  ${label}`);
  console.log(`    ttl=${ttl}s  tolerated skew=${tolerated}s  gate=${gate}`);
}

console.log('\nA tolerated skew of 0 means the signer fails the moment its clock is');
console.log('one second ahead of the timestamp of the block that mines the');
console.log('registration ? and fails totally, with SignatureTooLong, for as long');
console.log('as the skew lasts. Clearing the gate shows up as a LATER revert');
console.log('(nonce, cap or signature), which is what a cleared gate looks like here.');
process.exit(anyZero ? 1 : 0);
