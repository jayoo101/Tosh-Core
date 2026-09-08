/**
 * Guard: every credential is in the store it belongs in, at the tier it needs.
 *
 * PM-D3. This is the pre-mainnet key-custody check, and the one to re-run after
 * the wholesale key rotation, because that rotation touches every row below and
 * "I re-added them all" is not the same claim as "they are all there, and none
 * of them landed one tier too readable".
 *
 * ── The distinction this exists to enforce ──────────────────────────────────
 *
 * Vercel has two tiers and the difference is not cosmetic:
 *
 *   type: "sensitive"  write-only. Nobody, including the project owner, can
 *                      read it back through the dashboard or `vercel env pull`.
 *   type: "encrypted"  encrypted at rest, but any account with project access
 *                      can pull the plaintext.
 *
 * Both render as a locked-looking row in the dashboard, and `vercel env add`
 * picks the tier from a prompt that is easy to click past. A signer key that
 * lands on "encrypted" is therefore a credential that looks stored correctly
 * and is readable by every collaborator, forever, with no signal that anything
 * is wrong. That is the failure this file is pointed at.
 *
 * ── Why an inventory rather than a presence check ───────────────────────────
 *
 * A check that only asks "is POG_SIGNER_PRIVATE_KEY set" cannot notice the
 * things that actually go wrong: a new credential added without anyone deciding
 * which tier it belongs in, or ADMIN_SECRET being helpfully filled in by
 * someone who read the variable name and assumed blank was a gap. So the
 * inventory is exhaustive and closed: anything live that is not classified here
 * is a finding, and anything classified `absent` must stay absent.
 *
 * ── Not a CI gate ───────────────────────────────────────────────────────────
 *
 * It needs an authenticated `vercel` and `gh`, which CI deliberately does not
 * have. It is an operator command:  node scripts/checkSecretStore.mjs
 */

import { spawnSync } from 'node:child_process'

/**
 * `secret`     must exist in Vercel production as type "sensitive".
 * `config`     must exist in Vercel production; readable is fine and intended.
 * `ci`         must exist as a GitHub Actions secret, and must NOT also exist as
 *              a variable of the same name.
 * `ci-config`  must exist as a GitHub Actions variable; readable is intended.
 * `absent`     must exist in NO store. Setting it changes behaviour, and the
 *              `why` says what it turns on.
 *
 * GitHub keeps secrets and variables in separate namespaces, and a workflow that
 * reads `secrets.X` cannot tell that a plaintext `vars.X` exists beside it. Both
 * namespaces are therefore read here: an unclassified variable is checked for
 * the same reason an unclassified Vercel row is, and a name in both is a
 * credential that has been quietly copied somewhere world-readable.
 */
const INVENTORY = {
  // ── Credentials. A leak of any of these is an incident. ──────────────────
  POG_SIGNER_PRIVATE_KEY: {
    tier: 'secret',
    why: 'Signs PoG allocation attestations. Whoever holds it can mint deposit quota out of nothing.',
  },
  SUPABASE_SERVICE_ROLE_KEY: {
    tier: 'secret',
    why: 'Bypasses row-level security on the project registry. Full read/write on every row.',
  },
  UPSTASH_REDIS_REST_TOKEN: {
    tier: 'secret',
    why: 'Read/write on the rate-limit store. Holding it means being able to erase the limits.',
  },
  SENTRY_AUTH_TOKEN: {
    tier: 'secret',
    why: 'org:ci scope — uploads source maps and cuts releases against the Sentry org.',
  },
  BLOCKSCOUT_API_KEY: {
    tier: 'secret',
    why: 'Reads the five-chain gas history every genesis allocation is sized from. It is a '
       + 'credential twice over: the daily credit allowance is drainable, and the gas scan '
       + 'fails closed, so whoever spends the budget blocks every claim — and on a paid tier '
       + 'the overage is billed to us.',
  },

  // ── Configuration. Readable on purpose; none of it is a credential. ──────
  NEXT_PUBLIC_FACTORY_ADDRESS:       { tier: 'config', why: 'Public contract address; shipped in the client bundle.' },
  NEXT_PUBLIC_TREASURY_ADDRESS:      { tier: 'config', why: 'Public contract address; shipped in the client bundle.' },
  NEXT_PUBLIC_CHAIN_ID:              { tier: 'config', why: 'Public chain selector.' },
  NEXT_PUBLIC_RPC_URL: {
    tier: 'config',
    why: 'Universal RPC override, shipped in the client bundle because of the NEXT_PUBLIC_ prefix. '
       + 'Today it is the bare public endpoint https://rpc.mainnet.chain.robinhood.com and holds '
       + 'no credential. providers.tsx names this the premium leg ("Alchemy / Infura / drpc") and '
       + '.env.production.example tells production to point it at a dedicated provider; those '
       + 'providers embed the API key in the URL path. Swapping this for a keyed URL therefore '
       + 'ships a credential to every browser while this row stays config and the guard stays '
       + 'green. There is no conditional tier — the prefix makes a secret impossible, and this '
       + 'check never reads the value. A paid endpoint belongs off NEXT_PUBLIC_*, the way '
       + 'MONITOR_RPC is a GitHub secret for the same reason.',
  },
  NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC: { tier: 'config', why: 'Public RPC endpoint, no credential in the URL.' },
  NEXT_PUBLIC_SUPABASE_URL:          { tier: 'config', why: 'Public project URL.' },
  NEXT_PUBLIC_SUPABASE_ANON_KEY:     { tier: 'config', why: 'Anon key is public by design; RLS is what protects the rows.' },
  NEXT_PUBLIC_SENTRY_DSN:            { tier: 'config', why: 'DSN is a public ingest endpoint, not a token.' },
  NEXT_PUBLIC_SENTRY_ENVIRONMENT:    { tier: 'config', why: 'Environment label.' },
  SENTRY_ORG:                        { tier: 'config', why: 'Org slug; the token beside it is what carries the authority.' },
  SENTRY_PROJECT:                    { tier: 'config', why: 'Project slug.' },
  UPSTASH_REDIS_REST_URL:            { tier: 'config', why: 'Endpoint only; the token beside it is the credential.' },
  ALLOWED_ORIGINS:                   { tier: 'config', why: 'CORS allow-list. Not secret, but changing it is a security change.' },
  RATE_LIMIT_TRUSTED_PROXY_HOPS:     { tier: 'config', why: 'How many proxy hops to trust in X-Forwarded-For.' },

  // ── CI. ──────────────────────────────────────────────────────────────────
  ROBINHOOD_RPC: {
    tier: 'ci',
    why: 'Fork suite reads it. Unset, those tests skip rather than fail, so its absence is silent.',
  },
  MONITOR_RPC: {
    tier: 'ci',
    why: 'The endpoint the on-chain watcher reads. A secret rather than a variable only because '
       + 'RPC URLs routinely carry the key in the path. Its absence is worse than silent before '
       + 'C1 and loud after: watch.mjs falls back to the hardcoded testnet URL, which is the '
       + 'right chain today and the wrong one the moment mainnet is what needs watching. The '
       + 'WATCHER-03 chain-id check is what catches that, and only once the state file already '
       + 'holds 4663 — so this row, not that check, is what says the secret must exist.',
  },

  // ── CI configuration. Plaintext to anyone with repo access, and meant to be.
  //    Listed because "holds no credential" is a claim worth having reviewed,
  //    and because these four are what decide WHICH chain is being watched. ──
  MONITOR_FACTORY:             { tier: 'ci-config', why: 'Public factory address the watcher scans.' },
  MONITOR_TREASURY:            { tier: 'ci-config', why: 'Public treasury address the watcher scans.' },
  MONITOR_EXPECTED_OWNER:      { tier: 'ci-config', why: 'Public address the watcher expects to own both; a change is the alert.' },
  MONITOR_EXPECTED_POG_SIGNER: { tier: 'ci-config', why: 'Public address of the PoG signer; the private half is POG_SIGNER_PRIVATE_KEY.' },

  // ── Deliberately unset. ──────────────────────────────────────────────────
  MONITOR_KEEPER_ADDRESS: {
    tier: 'absent',
    why: 'Turns on the STATE-05 keeper gas-balance check. Unset is correct while no automated '
       + 'keeper exists — the check would otherwise page about an empty address that is empty '
       + 'because it does not exist. Set it only when something starts calling pokeBuyback() '
       + 'on a schedule, which is the first wallet the protocol has that can fail by running dry.',
  },
  ADMIN_SECRET: {
    tier: 'absent',
    why: 'Bearer-token fallback on POST /api/admin/config. Unset disables that path entirely and '
       + 'leaves the owner-signature check as the only way in, which is the posture we want. '
       + 'Setting it re-opens a shared-secret route to a privileged endpoint.',
  },
}

const ICON = { ok: '  ok  ', bad: ' FAIL ', warn: ' warn ' }

function run(command) {
  const r = spawnSync(command, { shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/**
 * Both CLIs print progress to stderr and data to stdout, so stdout is parsed
 * on its own. A CLI that is missing or logged out fails here rather than
 * further down as an empty list, which would otherwise read as "every
 * credential is missing" and bury the real cause.
 */
function readJson(command, what) {
  const { code, stdout, stderr } = run(command)
  if (code !== 0) {
    console.error(`\nCannot read ${what}.`)
    console.error(`  $ ${command}`)
    console.error(`  ${(stderr || stdout).trim().split('\n').slice(-3).join('\n  ')}`)
    console.error(`\nThis check needs an authenticated CLI. It is an operator command, not a CI gate.`)
    process.exit(2)
  }
  try {
    return JSON.parse(stdout.slice(stdout.indexOf(stdout.trimStart()[0] === '[' ? '[' : '{')))
  } catch (err) {
    console.error(`\n${what} did not come back as JSON: ${err.message}`)
    process.exit(2)
  }
}

const vercel = readJson('vercel env ls production --json', 'the Vercel production environment')
const github = readJson('gh secret list --json name', 'the GitHub Actions secrets')
const ghVars = readJson('gh variable list --json name', 'the GitHub Actions variables')

const live = new Map(vercel.envs.map(e => [e.key, e]))
const ciLive = new Set(github.map(s => s.name))
const ciVarLive = new Set(ghVars.map(v => v.name))

const findings = []
const lines = []

for (const [name, spec] of Object.entries(INVENTORY)) {
  const inVercel = live.get(name)
  const inCi = ciLive.has(name)
  const inCiVar = ciVarLive.has(name)

  if (spec.tier === 'absent') {
    if (inVercel || inCi || inCiVar) {
      const where = [inVercel && 'Vercel', inCi && 'a GitHub secret', inCiVar && 'a GitHub variable']
        .filter(Boolean).join(' and ')
      lines.push(`${ICON.bad} ${name} — must be unset, but it is set as ${where}`)
      findings.push(`${name} is set. ${spec.why}`)
    } else {
      lines.push(`${ICON.ok} ${name} — unset, as intended`)
    }
    continue
  }

  if (spec.tier === 'ci') {
    if (!inCi) {
      lines.push(`${ICON.bad} ${name} — missing from GitHub Actions`)
      findings.push(`${name} is not a GitHub secret. ${spec.why}`)
    } else if (inCiVar) {
      // Both namespaces hold this name. The workflow reads `secrets.` and so
      // behaves identically, which is exactly why this needs saying out loud:
      // the variable copy is plaintext to anyone with read access and nothing
      // about the running system looks wrong.
      lines.push(`${ICON.bad} ${name} — a GitHub secret, but also a plaintext variable of the same name`)
      findings.push(
        `${name} exists as both a secret and a variable. ${spec.why} `
        + `The variable copy is readable by anyone with repository access. Delete it with `
        + `gh variable delete ${name}, and treat the value as exposed and rotate it.`
      )
    } else {
      lines.push(`${ICON.ok} ${name} — GitHub Actions secret`)
    }
    continue
  }

  if (spec.tier === 'ci-config') {
    if (!inCiVar) {
      lines.push(`${ICON.bad} ${name} — missing from GitHub Actions variables`)
      findings.push(`${name} is not a GitHub variable. ${spec.why}`)
    } else {
      lines.push(`${ICON.ok} ${name} — GitHub Actions variable`)
    }
    continue
  }

  if (!inVercel) {
    lines.push(`${ICON.bad} ${name} — missing from Vercel production`)
    findings.push(`${name} is not set in Vercel production. ${spec.why}`)
    continue
  }

  if (spec.tier === 'secret') {
    if (inVercel.type === 'sensitive') {
      lines.push(`${ICON.ok} ${name} — sensitive (write-only)`)
    } else {
      lines.push(`${ICON.bad} ${name} — stored as "${inVercel.type}", which any collaborator can read back`)
      findings.push(
        `${name} is readable. ${spec.why} `
        + `Re-add it as a Sensitive variable: vercel env rm ${name} production, then `
        + `vercel env add ${name} production and choose Sensitive. Treat the old value as exposed and rotate it.`
      )
    }
    continue
  }

  lines.push(`${ICON.ok} ${name} — config`)
}

// Anything live but unclassified. A new credential must be a deliberate row
// above, not something that appeared in the dashboard and was never reviewed.
const unclassified = [...live.keys()].filter(k => !(k in INVENTORY))
for (const name of unclassified) {
  const e = live.get(name)
  lines.push(`${ICON.bad} ${name} — live in Vercel but not classified in this inventory (type "${e.type}")`)
  findings.push(
    `${name} is set in Vercel production and no one has recorded what it is. `
    + `Add it to INVENTORY in this file as secret, config, or absent.`
  )
}
const unclassifiedCi = [...ciLive].filter(k => !(k in INVENTORY))
for (const name of unclassifiedCi) {
  lines.push(`${ICON.bad} ${name} — live in GitHub Actions but not classified in this inventory`)
  findings.push(`${name} is a GitHub secret and no one has recorded what it is. Add it to INVENTORY.`)
}
const unclassifiedCiVar = [...ciVarLive].filter(k => !(k in INVENTORY))
for (const name of unclassifiedCiVar) {
  lines.push(`${ICON.bad} ${name} — a GitHub Actions variable, not classified in this inventory`)
  findings.push(
    `${name} is a GitHub variable and no one has recorded what it is. A variable is plaintext `
    + `to anyone with repository access, so the thing to establish is that it holds no `
    + `credential. Add it to INVENTORY as ci-config, or as ci if it turns out to be one.`
  )
}

console.log('\nCredential custody — Vercel production and GitHub Actions\n')
for (const l of lines.sort()) console.log(l)

// Preview and Development carry nothing. That is a posture, not an oversight:
// a preview build with no variables fails at boot, where one holding the
// production service-role key would come up looking healthy and writing to the
// real registry. Stated here so a green run is not read as "all environments
// are configured".
const previewCount = readJson('vercel env ls preview --json', 'the Vercel preview environment').envs.length
if (previewCount > 0) {
  console.log(
    `\nnote  Preview now has ${previewCount} variable(s). It had none, deliberately — a preview `
    + `\n      that boots is a preview that can reach whatever those variables point at. Confirm `
    + `\n      none of them is a production credential.`
  )
} else {
  console.log('\nnote  Preview and Development hold nothing, so preview builds fail closed rather than\n      booting against production data.')
}

if (findings.length === 0) {
  console.log(`\n${Object.keys(INVENTORY).length} credentials checked · every one in the right store at the right tier\n`)
  process.exit(0)
}

console.error(`\n${findings.length} finding(s):\n`)
for (const f of findings) console.error(`  - ${f}`)
console.error('')
process.exit(1)
