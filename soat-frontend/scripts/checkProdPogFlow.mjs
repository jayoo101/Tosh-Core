/**
 * Drives the automatable half of the production PoG flow against the live site,
 * with a throwaway key generated in memory. The key is never written to disk,
 * never passed as an argument and never printed — only its address is.
 *
 * What this can and cannot reach:
 *
 *   reached   GATE 1 wallet auth, the oracle key loading in production, the
 *             five-chain Blockscout scan, the live factory reads, and — since
 *             2026-09-13 — the identity of the production signing key. Every one
 *             of those runs BEFORE the eligibility floor, so a wallet the floor
 *             must refuse still proves all of them.
 *   not       GATE 2, the attestation itself. A fresh key has no gas history, so
 *             the floor refuses it and nothing is signed. That needs a wallet
 *             with history, and it is the only part that does.
 *
 * On step 3, the status IS the result, and this is the whole reason the probe is
 * worth running against production:
 *
 *   403 / 409   pass. The floor refused the wallet, which it can only do after
 *               wallet auth, the key loading, the factory reads and the signer
 *               comparison have all succeeded — each of those refuses earlier
 *               and with a different status.
 *   500         the key in Vercel Production does not derive to
 *               `factory.pogSigner()`. Nothing signed with it would ever be
 *               accepted by `registerPoG`, and before that comparison existed
 *               this probe returned 403 in exactly this case. The production
 *               key is write-only, so this is the only
 *               check that can see the value actually in use.
 *
 * Budgets, deliberately respected: POST /api/pog-scan is a 3-token bucket
 * refilling once a minute, so this spends exactly one. sign-allocation's is 5
 * tokens at 1 per 6 s, so the negative cases go there instead.
 *
 * Run it by hand — `npm run check:pog`. It is deliberately NOT in `verify`: it
 * talks to the live deployment and spends real rate-limit tokens, which is the
 * point of it and also the reason it must not run on every build.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const SITE = 'https://toshx.xyz'
const FACTORY = '0x2920ca7E9fcD85491D699e1f9Ae2CAa65Cfb2892'
const CHAIN_ID = 56
const AUTH_DOMAIN = 'Tosh PoG Scan Request'

const account = privateKeyToAccount(generatePrivateKey())
console.log(`throwaway address : ${account.address}`)
console.log(`factory           : ${FACTORY}`)
console.log('')

const authMessage = (address, ts) => `${AUTH_DOMAIN}\nAddress: ${address}\nTimestamp: ${ts}`

async function post(path, body) {
  const res = await fetch(`${SITE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch { /* non-JSON body is itself the finding */ }
  return { status: res.status, json }
}

function show(label, r, keys) {
  const picked = keys
    .filter(k => r.json && r.json[k] !== undefined)
    .map(k => `${k}=${JSON.stringify(r.json[k])}`)
    .join('  ')
  console.log(`${label.padEnd(46)} ${String(r.status).padEnd(4)} ${picked}`)
}

// ── 1. Start the scan ────────────────────────────────────────────────────────
const ts = Date.now()
const sig = await account.signMessage({ message: authMessage(account.address, ts) })

const started = await post('/api/pog-scan', {
  userAddress: account.address, chainId: CHAIN_ID, timestamp: ts, signature: sig,
})
show('1  POST /api/pog-scan', started, ['status', 'error', 'floorWei'])

// ── 2. Poll until it settles ─────────────────────────────────────────────────
let job = null
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 2000))
  const res = await fetch(`${SITE}/api/pog-scan?address=${account.address}`)
  job = await res.json().catch(() => null)
  if (job?.status === 'done' || job?.status === 'failed') break
}
console.log(`2  GET  /api/pog-scan (polled)               `
  + `${job?.status ?? 'no answer'}  totalGasWei=${job?.totalGasWei ?? '-'} `
  + `eligible=${job?.eligible ?? '-'} truncated=${job?.truncated ?? '-'}`)
if (job?.chains) {
  for (const c of job.chains) {
    console.log(`     ${String(c.chain).padEnd(12)} id=${String(c.chainId).padEnd(7)} `
      + `wei=${c.gasWei} txs=${c.sentTxs} unavailable=${c.unavailable} skipped=${c.skipped}`)
  }
}
if (job?.unavailableChains?.length) {
  console.log(`     UNAVAILABLE: ${job.unavailableChains.join(', ')}`)
}
console.log('')

// ── 3. The signing route, on a wallet the floor must refuse ──────────────────
const signed = await post('/api/sign-allocation', {
  userAddress: account.address, contractAddress: FACTORY,
  chainId: CHAIN_ID, timestamp: ts, signature: sig,
})
show('3  POST /api/sign-allocation (ineligible)', signed,
  ['error', 'eligible', 'totalGasWei', 'floorWei'])
console.log(signed.status === 403 || signed.status === 409
  ? `   => PASS. The production key derives to factory.pogSigner(); the floor is `
    + `what refused this wallet, and it is reached only after that comparison.`
  : signed.status === 500
    ? `   => FAIL. Read the message: a signer mismatch means every registration `
      + `would revert. Anything else here is a server fault worth the same look.`
    : `   => UNEXPECTED status ${signed.status}. Neither the floor nor the signer `
      + `check produces this, so read the body before drawing a conclusion.`)

// ── 4. Negative cases, to check the refusals are the refusals we think ───────
const stale = Date.now() - 40 * 60 * 1000
const staleSig = await account.signMessage({ message: authMessage(account.address, stale) })
show('4a POST sign-allocation, stale timestamp', await post('/api/sign-allocation', {
  userAddress: account.address, contractAddress: FACTORY,
  chainId: CHAIN_ID, timestamp: stale, signature: staleSig,
}), ['error'])

const other = privateKeyToAccount(generatePrivateKey())
const forged = await other.signMessage({ message: authMessage(account.address, ts) })
show('4b POST sign-allocation, wrong signer', await post('/api/sign-allocation', {
  userAddress: account.address, contractAddress: FACTORY,
  chainId: CHAIN_ID, timestamp: ts, signature: forged,
}), ['error'])

show('4c POST sign-allocation, retired factory', await post('/api/sign-allocation', {
  userAddress: account.address,
  contractAddress: '0xBa9d2E86281b988225Eca383C375215912fb20B9',
  chainId: CHAIN_ID, timestamp: ts, signature: sig,
}), ['error'])
