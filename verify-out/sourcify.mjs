/*
 * sourcify.mjs — verify the 2026-09-12 deployment through Sourcify.
 *
 * Blockscout's own verification API sits behind a Cloudflare managed challenge
 * that answers 403 to every automated client: forge's HTTP client, curl with a
 * browser user-agent, and .NET HttpClient. GETs pass, POSTs do not. Sourcify
 * has no such gate and lists chain 4663 as supported, so the sources can be
 * published there instead and Blockscout can pick them up from it.
 *
 * Usage:  node verify-out/sourcify.mjs [name ...]      (default: all five)
 */

import { readFileSync } from 'node:fs'

const SERVER = 'https://sourcify.dev/server'
const CHAIN = 4663
const COMPILER = '0.8.26+commit.8a97fa7a'

// Both implementations are created inside the factory's constructor, so they
// share its creation transaction. HookDeployLib went through the CREATE2 proxy
// as a separate transaction, which is why it is the one every previous count of
// a Tosh deploy has missed.
const FACTORY_TX = '0xadbd589d6bb51816591dc8ef65deed661ae625a510e89deb2137941e55a5d2a8'

const TARGETS = [
  { name: 'ToshFactory',        address: '0x2920ca7E9fcD85491D699e1f9Ae2CAa65Cfb2892', id: 'src/ToshFactory.sol:ToshFactory',                 tx: FACTORY_TX },
  { name: 'ToshLadderTreasury', address: '0x255722226720914eF5B2CD54647f21f584BD4Ea2', id: 'src/ToshLadderTreasury.sol:ToshLadderTreasury',   tx: '0x88804e4b550bdc7787cdad79eb461d118329618bdecd3707dbce031b72cb25e1' },
  { name: 'ToshLaunchpadHook',  address: '0xa90CF8118D0bB8228503da84397125dc1F7F03E9', id: 'src/ToshLaunchpadHook.sol:ToshLaunchpadHook',     tx: FACTORY_TX },
  { name: 'ToshToken',          address: '0xc4184708CeC5137E969bD5d9351DC4626Bbd094E', id: 'src/ToshToken.sol:ToshToken',                     tx: FACTORY_TX },
  { name: 'HookDeployLib',      address: '0x6a02d9801ed36150275e5ac7b228a5f6bf6f28a1', id: 'src/libraries/HookDeployLib.sol:HookDeployLib',   tx: '0xf3228c6c3f7352a369ff3d6a8017fe22598d96f8a80868d477acfb21a05016d8' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function already(address) {
  const res = await fetch(`${SERVER}/v2/contract/${CHAIN}/${address}`)
  if (!res.ok) return null
  const j = await res.json()
  return j.match ?? j.creationMatch ?? j.runtimeMatch ?? null
}

async function submit(t) {
  const stdJsonInput = JSON.parse(readFileSync(`verify-out/${t.name}.std.json`, 'utf8'))

  // The identifier has to name a source key that actually exists in the bundle,
  // and forge's key set is not guaranteed to be the repo-relative path. Resolve
  // it rather than assume, so a mismatch fails here with a readable message
  // instead of as a Sourcify error about a contract it cannot find.
  const [wantPath, wantName] = t.id.split(':')
  const key = Object.keys(stdJsonInput.sources).find((k) => k === wantPath || k.endsWith(`/${wantPath}`))
  if (!key) throw new Error(`${t.name}: no source key matching ${wantPath}`)
  const identifier = `${key}:${wantName}`

  const res = await fetch(`${SERVER}/v2/verify/${CHAIN}/${t.address}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      stdJsonInput,
      compilerVersion: COMPILER,
      contractIdentifier: identifier,
      creationTransactionHash: t.tx,
    }),
  })

  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = text.slice(0, 300) }
  return { status: res.status, body, identifier }
}

async function poll(verificationId, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${SERVER}/v2/verify/${verificationId}`)
    const j = await res.json().catch(() => ({}))
    if (j.isJobCompleted) return j
    await sleep(3000)
  }
  return { timedOut: true }
}

const wanted = process.argv.slice(2)
const list = wanted.length ? TARGETS.filter((t) => wanted.includes(t.name)) : TARGETS

for (const t of list) {
  const pre = await already(t.address)
  if (pre) {
    console.log(`${t.name.padEnd(19)} already verified on Sourcify (${pre})`)
    continue
  }

  let sub
  try {
    sub = await submit(t)
  } catch (err) {
    console.log(`${t.name.padEnd(19)} SUBMIT THREW  ${err.message}`)
    continue
  }

  if (sub.status !== 202) {
    console.log(`${t.name.padEnd(19)} HTTP ${sub.status}  ${JSON.stringify(sub.body).slice(0, 400)}`)
    continue
  }

  const id = sub.body.verificationId
  console.log(`${t.name.padEnd(19)} submitted as ${sub.identifier}, job ${id}`)
  const done = await poll(id)
  if (done.timedOut) {
    console.log(`${''.padEnd(19)} still running after 2 min — re-run to read the result`)
  } else if (done.error) {
    console.log(`${''.padEnd(19)} FAILED  ${done.error.customCode ?? ''} ${done.error.message ?? JSON.stringify(done.error).slice(0, 300)}`)
  } else {
    console.log(`${''.padEnd(19)} ${done.contract?.match ?? 'done'}  creation=${done.contract?.creationMatch} runtime=${done.contract?.runtimeMatch}`)
  }
}
