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
 * One tier per name was an assumption, not a fact, and it hid a gap until
 * 2026-09-13: the chain-scoped RPC is read by the fork suite in CI AND by
 * serverRpc.ts in production, so classifying it `ci` left its Vercel half
 * unguarded. An optional `alsoVercel` names the second home and the Vercel
 * type it must have. The lesson generalises past that one row: a name with two
 * consumers gets checked in the store the tier is named after and nowhere
 * else, so the store nobody classified is the one that fails silently.
 *
 * ── The port, and the limit of an inventory ─────────────────────────────────
 *
 * 2026-09-18: this file ran green for the whole PancakeSwap Infinity port while
 * checking names the port had abandoned. It asserted ROBINHOOD_RPC and
 * NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC were present and correct, and carried no row
 * at all for BSC_RPC, BSC_TESTNET_RPC or ETHERSCAN_API_KEY — the three the code
 * now actually reads. Every run passed; nothing it reported was false; and the
 * credentials production depends on were entirely outside its view.
 *
 * That is this file's own failure mode, stated at the top of it: a check that
 * does not name a credential cannot report on that credential. What it costs is
 * measurable — BSC_RPC is absent from Vercel, so every server-side read on
 * chain 56 falls through to a public dataseed, and the CI fork step spent the
 * port passing ROBINHOOD_RPC into suites that read BSC_RPC. Neither was visible
 * here.
 *
 * The repair is not a better checker. An inventory keyed on names can only ever
 * be as current as the last person to edit it, so the rule is procedural: a
 * commit that changes which env name the code reads changes this table in the
 * same commit, the way a commit that lowers a test floor says why.
 *
 * ── Local copies, added after the 2026-09-08 exposure ───────────────────────
 *
 * Store-and-tier is necessary and not sufficient. A credential can be in
 * Vercel as Sensitive and also sit in `.env.local`, and this check was green
 * throughout that state because it never asked about the laptop. Secret- and
 * absent-tier names must now be absent or empty in the local dotenv files in
 * both `soat-frontend/` and the repo root -- the root because that is where
 * `forge script` runs and therefore where a deploy key lands, which is the
 * gap a 2026-09 laptop-copy sweep found after this scan had been green for
 * weeks. Presence of a non-empty assignment is the entire signal: values
 * are never read for comparison and never printed. If no such file is
 * present — the CI case, because `.env.local` is gitignored — that absence
 * is reported as not-evaluated, not as a pass.
 *
 * ── Not a CI gate ───────────────────────────────────────────────────────────
 *
 * It needs an authenticated `vercel` and `gh`, which CI deliberately does not
 * have. It is an operator command:  node scripts/checkSecretStore.mjs
 */

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * `secret`     must exist in Vercel production as type "sensitive".
 * `config`     must exist in Vercel production; readable is fine and intended.
 * `ci`         must exist as a GitHub Actions secret, and must NOT also exist as
 *              a variable of the same name.
 * `ci-config`  must exist as a GitHub Actions variable; readable is intended.
 * `absent`     must exist in NO store. Setting it changes behaviour, and the
 *              `why` says what it turns on.
 * `local-only` must exist in NO remote store, but MAY hold a value in a local
 *              dotenv — an operator signing key with no server-side use. The
 *              finding is inverted: presence in Vercel or GitHub is the
 *              incident, and a copy on the operator's machine is the point.
 * `optional-pair`
 *              turns a feature on, and needs its `pairedWith` partner to do it.
 *              Absent is a pass; present-and-Sensitive is a pass; HALF is the
 *              finding. Added 2026-09-14 for the two /api/watch-ping names.
 *              `secret` was wrong for them in a way worth naming: it asserts a
 *              Vercel row exists, so an operator who has not wired the second
 *              scheduler yet reads a red pre-launch check for a feature that is
 *              off by design and degrades safely (the route answers 503). A
 *              check that is red for "not configured" is a check somebody makes
 *              green with a dummy value, which is strictly worse than the gap.
 *              Half-configured is the state that actually misleads: with
 *              CRON_SECRET alone the route authenticates a ping and starts
 *              nothing, so the pinger looks wired and the cadence never moves.
 *
 * That last tier was added on 2026-09-11 because the two keys it now covers
 * fitted no existing one, and so had been classified nowhere at all. `secret`
 * asserts the value IS in Vercel, which for a launch signing key would be the
 * incident; `absent` asserts it is nowhere, which contradicts the dotenv the
 * operator needs it in. The consequence was not theoretical: the unclassified
 * sweep below reads only the two remote stores, so a name in neither of them
 * is invisible to this file however it is stored locally, and
 * `LAUNCH_CREATOR_PRIVATE_KEY` sat in plaintext in the repo root
 * `.env.production` — beside a copy of the live PoG signer key — through a
 * green run of this check.
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
  CRON_SECRET: {
    tier: 'optional-pair',
    pairedWith: 'WATCH_DISPATCH_TOKEN',
    why: 'Shared secret on GET/POST /api/watch-ping. Vercel cron sends it as '
       + 'Authorization: Bearer when this name is set. Unset, the route refuses rather '
       + 'than firing an unauthenticated Actions dispatch. A leak spends Actions minutes; '
       + 'the concurrency group on watch.yml already serialises them.',
  },
  WATCH_DISPATCH_TOKEN: {
    tier: 'optional-pair',
    pairedWith: 'CRON_SECRET',
    why: 'Fine-grained PAT with Contents: write on jayoo101/Tosh-Core. /api/watch-ping '
       + 'uses it to POST repository_dispatch=watch — the scheduler GitHub\'s own cron '
       + 'is not, because that pool delivered 0.269 passes/hour no matter the interval. '
       + 'Contents, not Actions: GitHub files POST /repos/{o}/{r}/dispatches under '
       + 'Contents, and Actions: write buys the workflow_dispatch endpoint instead — a '
       + 'token scoped that way authenticates and is then refused, which reaches the '
       + 'operator as a 502 from a ping that looked accepted. Not ALERT_REPO_TOKEN: that '
       + 'one files into tosh-alerts. Nothing beyond Contents is needed; GITHUB_TOKEN '
       + 'inside the job persists the checkpoint. Expires on the date in '
       + '`monitoring/watch-dispatch-token-expires`; `scripts/checkTokenExpiry.mjs` goes '
       + 'red 21 days out, because the lapse itself is silent — findings keep filing and '
       + 'only the cadence quietly halves back to GitHub\'s cron.',
  },
  BLOCKSCOUT_API_KEY: {
    tier: 'secret',
    why: 'Reads the five-chain gas history every genesis allocation is sized from. It is a '
       + 'credential twice over: the daily credit allowance is drainable, and the gas scan '
       + 'fails closed, so whoever spends the budget blocks every claim — and on a paid tier '
       + 'the overage is billed to us.',
  },

  // ── Operator signing keys. No server-side use; never a remote store. ────
  LAUNCH_CREATOR_PRIVATE_KEY: {
    tier: 'local-only',
    why: 'Broadcasts createLaunch and launch(), and on 4663 it is the creator of the live '
       + 'project — so it holds the only claim on that launch\'s 4,620,000-token genesis '
       + 'tranche, and `creator` is an immutable clone argument that no admin call can '
       + 'reassign. Read by scripts/watchAndLaunch.mjs and scripts/e2eLaunchFlow.mjs, both '
       + 'of which run on an operator machine. Nothing server-side reads it, so a copy in '
       + 'Vercel would be reach without a reason.',
  },
  CREATOR_PRIVATE_KEY: {
    tier: 'absent',
    why: 'A dead alias of LAUNCH_CREATOR_PRIVATE_KEY that no code in this repository reads — '
       + 'every call site resolves LAUNCH_CREATOR_PRIVATE_KEY, else PRIVATE_KEY. It held a '
       + 'second copy of the same key in .env.production until 2026-09-11, which is the '
       + '"second key copy" shape cd148d8 already cleared once: two names for one secret '
       + 'double the places it can leak from and halve the chance a sweep finds both. Absent '
       + 'rather than local-only on purpose, so reintroducing the duplicate is a finding.',
  },

  // ── Configuration. Readable on purpose; none of it is a credential. ──────
  NEXT_PUBLIC_FACTORY_ADDRESS:       { tier: 'config', why: 'Public contract address; shipped in the client bundle.' },
  NEXT_PUBLIC_TREASURY_ADDRESS:      { tier: 'config', why: 'Public contract address; shipped in the client bundle.' },
  NEXT_PUBLIC_CHAIN_ID:              { tier: 'config', why: 'Public chain selector.' },
  NEXT_PUBLIC_RPC_URL: {
    tier: 'absent',
    carriesCredential: false,
    why: 'Universal RPC override, shipped in the client bundle because of the NEXT_PUBLIC_ prefix. '
       + 'It was config until 2026-09-13, holding the bare public endpoint '
       + 'https://rpc.mainnet.chain.robinhood.com, and it is absent now because serverRpcUrl() '
       + 'reads it BEFORE the chain-scoped name — ROBINHOOD_RPC then, BSC_RPC / BSC_TESTNET_RPC '
       + 'now, and the ordering is what matters rather than the chain. Setting it silently disables '
       + 'the keyed server endpoint: the paid node stays configured, stays billed and is never '
       + 'called. It cannot be repurposed to carry the key either, because the NEXT_PUBLIC_ '
       + 'prefix inlines it into every browser bundle. So the only two things it can be here are '
       + 'redundant or harmful. Redundant, precisely: its former value is character-for-character '
       + "viem's robinhood.rpcUrls.default.http[0], which providers.tsx appends unconditionally, "
       + 'so deleting it left the browser candidate list identical. A paid endpoint belongs off '
       + 'NEXT_PUBLIC_*, the way MONITOR_RPC is a GitHub secret for the same reason.',
  },
  // NEXT_PUBLIC_BSC_RPC and NEXT_PUBLIC_BSC_TESTNET_RPC are deliberately NOT
  // rows here, and the omission is the classification rather than an oversight.
  //
  // `serverRpcUrl` reads them only after the keyed BSC_RPC / BSC_TESTNET_RPC, and
  // `providers.tsx` appends viem's own default unconditionally, so they are a
  // fallback behind a fallback: unset is the normal, correct state. A `config`
  // row would assert they must be present and produce two findings that name no
  // problem, which is how a check gets ignored — the failure mode this file's
  // docblock is about.
  //
  // Unclassified is not unguarded. The sweep at the bottom flags any name found
  // in a remote store without a row, so ADDING either one still comes up for
  // review — which is what you want for a NEXT_PUBLIC_ name, because the prefix
  // inlines it into every browser bundle.
  NEXT_PUBLIC_LADDER_TREASURY: {
    tier: 'absent',
    carriesCredential: false,
    why: 'The older alias of NEXT_PUBLIC_TREASURY_ADDRESS. contracts.ts resolves the canonical '
       + 'name first and says plainly to delete this one rather than resolve it, because both set '
       + 'and disagreeing is a case the `??` picks silently: a .env.local once carried the '
       + 'PREVIOUS deployment\'s treasury under the alias while the canonical name held the '
       + 'current one, and both were live contracts of identical size because they are the same '
       + 'contract from two deploys. Vercel production correctly holds only the canonical name. '
       + 'Two names for one address is the same shape as two names for one key.',
  },
  NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC: {
    tier: 'absent',
    carriesCredential: false,
    why: 'The chain-46630 endpoint. Nothing reads it after the port; it is config rather than a '
       + 'credential, so this row is housekeeping and not an incident — but a NEXT_PUBLIC_ name '
       + 'is inlined into every browser bundle, and shipping a dead chain\'s RPC to users is a '
       + 'claim about which chain this app is on. Delete from Vercel production.',
  },
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
  BSC_RPC: {
    tier: 'ci',
    alsoVercel: 'sensitive',
    why: 'Chain 56. The fork suites read it — ToshV5ForkTest and ToshV5ForkInfinityTest — and '
       + 'unset, those tests skip rather than fail, so its absence is silent inside forge. '
       + 'The workflow step is what makes it loud: it refuses a run where nothing passed.',
    alsoVercelWhy:
      'Two consumers, as ROBINHOOD_RPC had: serverRpc.ts resolves this name for chain 56, so it '
      + 'is also the keyed endpoint every server-side read goes through. The two copies are NOT '
      + 'interchangeable — CI wants breadth and the app wants latency — which is why the Vercel '
      + 'side is asserted separately. Losing it is silent: PUBLIC_FALLBACK answers with '
      + 'bsc-dataseed1, production reverts to a public endpoint, and the only symptom is '
      + 'intermittent 429s under concurrency.',
  },
  BSC_TESTNET_RPC: {
    tier: 'ci',
    alsoVercel: 'sensitive',
    why: 'Chain 97. Read by the rehearsal scripts and by anything driving the deployed testnet '
       + 'factory.',
    alsoVercelWhy:
      'serverRpc.ts resolves this name for chain 97, and 97 is what NEXT_PUBLIC_CHAIN_ID points '
      + 'at until 56 is deployed — so today this is the endpoint production actually reads, and '
      + 'BSC_RPC is the one that matters later. Same silent-failure shape as BSC_RPC: the public '
      + 'dataseed answers and nothing reports the downgrade.',
  },
  ETHERSCAN_API_KEY: {
    tier: 'ci',
    why: 'Contract verification on BOTH BSC chains. foundry.toml points `bsc` and `bsc_testnet` '
       + 'at Etherscan v2\'s multichain host on this one key, so a single value covers 56 and 97 '
       + '— which is also why losing it blocks verification on both at once. Blockscout does not '
       + 'cover chain 56 at any tier, so there is no second door: unverified is the state a '
       + 'missing key leaves the mainnet factory in, and an unverified launchpad is one nobody '
       + 'can read the terms of before depositing.',
  },
  ROBINHOOD_RPC: {
    tier: 'absent',
    why: 'The chain-4663 endpoint, and a keyed one. The Infinity port removed BOTH of its '
       + 'consumers: serverRpc.ts has no 4663 case in scopedEnvUrl, and the CI fork step now '
       + 'passes BSC_RPC. It survived in two remote stores after the last thing that read it was '
       + 'deleted, and for a while the CI step still passed THIS name into suites that read '
       + 'BSC_RPC — so the credential was present, billed, and could not be used. Absent rather '
       + 'than ci-tier on purpose: a live credential in two stores that nothing reads is reach '
       + 'without a reason, and reintroducing it should be a finding rather than a shrug. Delete '
       + 'from GitHub Actions and from Vercel production, and rotate at the provider — the '
       + 'operator scripts under scripts/ still carry it as a default, so copies exist.',
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
  // ── The alerting path. Added 2026-09-12: all four were live GitHub secrets
  //    that this file did not carry, which is the one failure mode its own
  //    docblock is about — a check that does not name a credential cannot
  //    report on it, and every run stayed green while four went unclassified. ──
  // All four are `ci`, not `secret`/`ci-config`, and the tiers are not
  // interchangeable: `secret` asserts a row in Vercel production, `ci-config`
  // asserts a GitHub Actions VARIABLE. Nothing in the Next.js app reads any of
  // these — they are read by `monitoring/report.mjs` under `watch.yml` — and
  // watch.yml resolves all four through `secrets.`, including the two that
  // carry no credential. Classifying them by what they ARE rather than by
  // where they LIVE would make this check demand a Vercel row for a pager
  // token the app cannot use, which is reach without a reason.
  ALERT_REPO_TOKEN: {
    tier: 'ci',
    why: 'A fine-grained PAT on jayoo101/tosh-alerts with Issues:write. It exists because this '
       + 'repository went public on 2026-09-11 and the issue tracker went public with it, so the '
       + 'watcher files findings into a private repo instead — meaning this token is what keeps '
       + 'unpublished on-chain findings unpublished. It expires on the date in '
       + '`monitoring/alert-token-expires` (issued for 90 days). The day it lapses, '
       + '`scripts/checkTokenExpiry.mjs` turns CI red and filing 401s; the checkpoint '
       + 'deliberately stops advancing. Unset '
       + 'falls back to the per-run secrets.GITHUB_TOKEN and this repository, which is the old '
       + 'behaviour and now the wrong sink.',
  },
  PAGER_TELEGRAM_TOKEN: {
    tier: 'ci',
    why: 'A Telegram bot token. With PAGER_TELEGRAM_CHAT it turns report.mjs from a notifier into '
       + 'a pager that pushes every P0 into the operators\' Telegram channel. Holding it means '
       + 'being able to post into that channel as the pager — so a leak is not only eavesdropping, '
       + 'it is forging incident traffic to the signers. MUST be set through the stdin prompt, '
       + 'never `gh secret set --body`: a live PoG key leak happened exactly that way, via shell '
       + 'history.',
  },
  ALERT_REPO: {
    tier: 'ci',
    why: 'The owner/name the watcher files into, read as WATCH_ISSUE_REPO. A repository slug and '
       + 'no credential, yet stored as a GitHub secret rather than a variable — which is the '
       + 'right call for a different reason than secrecy: it names a PRIVATE repository, and a '
       + 'variable is readable to anyone who can see the public Actions logs. report.mjs also '
       + 'treats a 404 from it as a likely token problem rather than a missing repo, because a '
       + 'private repository returns 404 to a token without access.',
  },
  PAGER_TELEGRAM_CHAT: {
    tier: 'ci',
    why: 'The chat id the pager pushes into. Not a credential — posting needs the bot token — but '
       + 'stored as a secret for the same reason as ALERT_REPO: it identifies the operators\' '
       + 'incident channel, which is not something to publish in a log. It is half of the '
       + 'PAGER_ON condition, so with only one of the pair set report.mjs writes findings down '
       + 'and wakes nobody, and says so on every pass rather than failing.',
  },

  MONITOR_FACTORY:             { tier: 'ci-config', why: 'Public factory address the watcher scans.' },
  MONITOR_TREASURY:            { tier: 'ci-config', why: 'Public treasury address the watcher scans.' },
  MONITOR_EXPECTED_OWNER:      { tier: 'ci-config', why: 'Public address the watcher expects to own both; a change is the alert.' },
  MONITOR_EXPECTED_POG_SIGNER: { tier: 'ci-config', why: 'Public address of the PoG signer; the private half is POG_SIGNER_PRIVATE_KEY.' },
  MONITOR_MAX_RUN_GAP_MIN: {
    tier: 'ci-config',
    why: 'Minutes the watcher tolerates between passes before WATCHER-05 pages. Carries no '
       + 'credential. Set to 60 on 2026-09-14, down from the 480 default, once /api/watch-ping '
       + 'had been measured delivering every ~15 minutes: three consecutive misses still stay '
       + 'quiet, while an outage surfaces eight times sooner than the default allowed. The '
       + 'number is only defensible against that measurement, so raising it without taking a '
       + 'fresh one lengthens the blind window rather than reducing noise.',
  },

  // ── Deliberately unset. ──────────────────────────────────────────────────
  MONITOR_KEEPER_ADDRESS: {
    tier: 'absent',
    carriesCredential: false,
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
  POG_PRIVATE_KEY: {
    tier: 'absent',
    why: 'The spec-compliant alias for POG_SIGNER_PRIVATE_KEY, and a second place the signing '
       + 'key can live. `loadOracleAccount` reads `POG_SIGNER_PRIVATE_KEY ?? POG_PRIVATE_KEY` '
       + '(sign-allocation/route.ts), so whichever value sits here is inert while the primary '
       + 'is set -- which is exactly what makes it dangerous: rotating the primary leaves a '
       + 'superseded key behind, in a store, readable, and this file would still report every '
       + 'row green because it never asked about a name it did not carry. That is the shape of '
       + 'the 2026-09-10 sweep, where the check was green throughout because it never asked '
       + 'whether a copy existed. One name for the key, and it is the primary.',
  },
  PRIVATE_KEY: {
    tier: 'absent',
    why: 'The bare Foundry name for a deploy key, and the one this repository actually used -- '
       + 'a 2026-09 sweep records destroying it from .env.production. Nothing in the '
       + 'application reads it; it exists only for `forge script --private-key`, which is a '
       + 'terminal operation and not a deployment variable. Carried here because that sweep and the '
       + 'POG_PRIVATE_KEY row above are the same lesson twice and this was the third instance: '
       + 'a laptop-copy check found a plaintext PRIVATE_KEY in a repo-root '
       + '.env.bak-premigration that every green run had missed, because a check that does not '
       + 'carry a name cannot report on it. A deploy key is the strictly worse leak -- it owns '
       + 'contracts rather than signing quota.',
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

  // Inverted against every other tier: here a remote store is the finding.
  // The local half is handled with the dotenv scan further down, where it is
  // reported rather than failed — see the tier's entry in the docblock.
  if (spec.tier === 'local-only') {
    if (inVercel || inCi || inCiVar) {
      const where = [inVercel && 'Vercel', inCi && 'a GitHub secret', inCiVar && 'a GitHub variable']
        .filter(Boolean).join(' and ')
      lines.push(`${ICON.bad} ${name} — an operator key, but it is set in ${where}`)
      findings.push(
        `${name} is set in ${where}, and nothing server-side reads it. ${spec.why} `
        + `Delete it from there and treat the value as exposed.`
      )
    } else {
      lines.push(`${ICON.ok} ${name} — in no remote store, as intended`)
    }
    continue
  }

  // Absent or fully present; never half. The partner is read from the live
  // stores rather than from a running tally, so the two rows report the same
  // verdict whichever order the inventory is iterated in.
  if (spec.tier === 'optional-pair') {
    const partner = spec.pairedWith
    const partnerLive = live.get(partner)

    if (!inVercel && !partnerLive) {
      lines.push(`${ICON.ok} ${name} — unset, and so is ${partner}: the feature is off, which is a valid state`)
    } else if (!inVercel) {
      lines.push(`${ICON.bad} ${name} — missing while ${partner} is set, so the pair is half-configured`)
      findings.push(
        `${name} is not set in Vercel production but ${partner} is. ${spec.why} `
        + `Half of this pair is the one state that misleads: set both, or remove both.`,
      )
    } else if (inVercel.type !== 'sensitive') {
      lines.push(`${ICON.bad} ${name} — stored as "${inVercel.type}", which any collaborator can read back`)
      findings.push(
        `${name} is readable. ${spec.why} `
        + `Re-add it as a Sensitive variable: vercel env rm ${name} production, then `
        + `vercel env add ${name} production and choose Sensitive. Treat the old value as exposed and rotate it.`,
      )
    } else {
      lines.push(`${ICON.ok} ${name} — sensitive (write-only), paired with ${partner}`)
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
    // A name can be required in both stores at once. `tier` says which store
    // the classification is named after; `alsoVercel` adds the second claim.
    // Without it the inventory can only describe one home per name, and the
    // unnamed one is unguarded — which for BSC_RPC means deleting the Vercel
    // row leaves every row green while production quietly falls back to the
    // rate-limited public dataseed.
    if (spec.alsoVercel) {
      const why = spec.alsoVercelWhy ?? spec.why
      if (!inVercel) {
        lines.push(`${ICON.bad} ${name} — also required in Vercel production, and missing there`)
        findings.push(`${name} is not set in Vercel production. ${why}`)
      } else if (inVercel.type !== spec.alsoVercel) {
        lines.push(
          `${ICON.bad} ${name} — in Vercel as "${inVercel.type}", not "${spec.alsoVercel}"`,
        )
        findings.push(
          `${name} is stored in Vercel as "${inVercel.type}" where it must be `
          + `"${spec.alsoVercel}". ${why} An RPC URL carries its key in the path, so a readable `
          + `row hands the endpoint to every collaborator. Re-add it: vercel env rm ${name} `
          + `production, then vercel env add ${name} production, and rotate the old value.`,
        )
      } else {
        lines.push(`${ICON.ok} ${name} — also in Vercel production as ${spec.alsoVercel}`)
      }
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

// Local dotenv copies. Store-and-tier cannot see a laptop file. Secret- and
// absent-tier names must be absent or empty in every `.env*` file in the two
// directories below, except `*.example` templates (committed placeholders,
// empty by design).
// The assigned value is discarded unread: a non-empty right-hand side is
// the whole finding. Vercel Sensitive values cannot be read back anyway,
// so there is nothing to compare against.
// Two directories, not one. This read `FRONTEND_ROOT` alone until 2026-09-10,
// which meant the repo root was never opened -- and the repo root is where
// `forge script` is run from, so it is exactly where a deploy key lands.
// A 2026-09 laptop-copy sweep found a plaintext `PRIVATE_KEY` sitting in
// `.env.bak-premigration` one level above this scan, dormant only because no
// loader looks for that filename. Scoping a laptop-copy check to the
// application package assumes secrets only ever land where the application
// would read them, and a deploy key is the counterexample.
const ENV_SCAN_DIRS = [
  { dir: FRONTEND_ROOT, label: 'soat-frontend' },
  { dir: dirname(FRONTEND_ROOT), label: 'repo root' },
]

const localEnvFiles = ENV_SCAN_DIRS.flatMap(({ dir, label }) => {
  try {
    return readdirSync(dir)
      .filter((n) => n.startsWith('.env') && !n.toLowerCase().includes('example'))
      .sort()
      .map((name) => ({ dir, name, shown: `${label}/${name}` }))
  } catch {
    return []
  }
})

/**
 * True when `name` has a non-empty assignment. The right-hand side is
 * forgotten immediately; it is never returned, logged, or compared to a
 * known secret.
 */
function hasNonEmptyAssignment(text, name) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const body = line.startsWith('export ') ? line.slice(7).trimStart() : line
    const eq = body.indexOf('=')
    if (eq <= 0) continue
    if (body.slice(0, eq).trim() !== name) continue
    let rhs = body.slice(eq + 1).trim()
    const quoted = /^(["'])([\s\S]*)\1$/.exec(rhs)
    if (quoted) rhs = quoted[2]
    else rhs = rhs.replace(/\s+#.*$/, '').trim()
    const nonempty = rhs.length > 0
    rhs = ''
    if (nonempty) return true
  }
  return false
}

// `absent` joins `secret` here, where it used to be checked against the two
// remote stores only. A name whose whole classification is "must exist in no
// store" is not satisfied by being missing from Vercel while sitting in a
// dotenv on the machine that deploys -- that is the more likely of the two
// places for it to be, not the less.
// `optional-pair` is scanned here on the same terms as `secret`, even though the
// remote half of it is allowed to be absent. Being optional is a statement about
// whether the FEATURE is on, not about how the credential is stored: a PAT with
// Actions: write and the shared secret that fires it both belong in Vercel, and
// `scripts/pingWatch.mjs` reads them from the shell environment, which needs no
// file on disk.
const localScanNames = Object.entries(INVENTORY)
  .filter(([, spec]) => ['secret', 'absent', 'optional-pair'].includes(spec.tier))
  .map(([name]) => name)

// `local-only` names are counted here and reported below rather than failed:
// a copy on this machine is what the tier means. They are named anyway, which
// is the whole lesson of the two sweeps this scan already carries -- a key
// nobody lists is a key nobody re-examines, and plaintext at rest is still
// exposure the moment the disk is imaged, backed up or synced.
const localOnlyNames = Object.entries(INVENTORY)
  .filter(([, spec]) => spec.tier === 'local-only')
  .map(([name]) => name)
const localOnlySeen = []

if (localEnvFiles.length > 0) {
  for (const file of localEnvFiles) {
    const text = readFileSync(join(file.dir, file.name), 'utf8')
    for (const name of localScanNames) {
      if (!hasNonEmptyAssignment(text, name)) continue

      // Two different repairs, and telling them apart matters. For a credential,
      // deletion is the lesser half: the copy that leaked stays valid until it is
      // rotated at the provider. For an address or a public endpoint there is
      // nothing to rotate, and saying so anyway sends the reader to look for a
      // rotation procedure that does not exist — which is its own kind of wrong
      // answer, and the reason this branch exists rather than one generic string.
      const rotatable = INVENTORY[name].carriesCredential !== false
      const repair = rotatable
        ? 'delete it and rotate, not delete only'
        : 'delete it — nothing to rotate, it carries no credential'

      lines.push(`${ICON.bad} ${name} — non-empty assignment in ${file.shown}; ${repair}`)
      findings.push(
        rotatable
          ? `${name} has a non-empty assignment in ${file.shown}. Delete it from that file and rotate the live value — deletion alone leaves the leaked copy live.`
          : `${name} has a non-empty assignment in ${file.shown}. Delete the line; it carries no credential, so there is nothing to rotate. ${INVENTORY[name].why}`,
      )
    }
    for (const name of localOnlyNames) {
      if (hasNonEmptyAssignment(text, name)) localOnlySeen.push(`${name} in ${file.shown}`)
    }
  }
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

if (localEnvFiles.length === 0) {
  console.log(
    '\nnote  No local dotenv file was present in soat-frontend/ or the repo root (.env,\n'
    + '      .env.local, and other .env* siblings, excluding *.example), so absence of laptop\n'
    + '      copies was not evaluated. That is expected in CI, where .env.local is gitignored;\n'
    + '      it is not a pass of this check.',
  )
} else {
  console.log(
    `\nnote  Local dotenv scanned: ${localEnvFiles.map((f) => f.shown).join(', ')}. Secret- and`
    + ' absent-tier names must be absent or empty.',
  )
}

if (localOnlySeen.length > 0) {
  console.log(
    `\nnote  Operator signing key(s) held locally, which is the local-only tier's intended`
    + `\n      state and not a finding:`
    + `\n        ${localOnlySeen.join('\n        ')}`
    + `\n      Named rather than passed over in silence: this is plaintext at rest, so a disk`
    + `\n      image, an off-machine backup or a file-sync client each turn it into exposure.`,
  )
}

if (findings.length === 0) {
  const localBit = localEnvFiles.length === 0
    ? ''
    : ', and no secret- or absent-tier assignment in local dotenv'
  console.log(`\n${Object.keys(INVENTORY).length} credentials checked · every one in the right store at the right tier${localBit}\n`)
  process.exit(0)
}

console.error(`\n${findings.length} finding(s):\n`)
for (const f of findings) console.error(`  - ${f}`)
console.error('')
process.exit(1)
