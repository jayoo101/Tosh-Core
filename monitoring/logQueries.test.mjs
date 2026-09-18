import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildLogQueries, matchLog } from './logQueries.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(join(ROOT, 'alerts.json'), 'utf8'))

/* Deliberately not real addresses.
 *
 * What this file tests is the GROUPING — that two contracts sharing a topic0 end
 * up in separate queries, that an any-address alert does not collide with an
 * address-scoped one, and that no two alerts in one group share a topic0. None
 * of that depends on which addresses are used, only on their being distinct.
 *
 * They used to be the real 4663 factory and treasury, which made the test look
 * chain-specific when it is not, and left two addresses for a retired chain in a
 * file that never talks to a chain at all. Obvious placeholders say "fixture"
 * without a comment having to.
 */
const FACTORY = '0x000000000000000000000000000000000000fac7'
const TREASURY = '0x0000000000000000000000000000000000007265'
const addressFor = { ToshFactory: FACTORY, ToshLadderTreasury: TREASURY }

const queries = buildLogQueries(config.alerts, addressFor)
const covered = new Set(queries.flatMap((q) => q.alerts.map((a) => a.id)))

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL', msg)
    process.exit(1)
  }
}

assert(queries.length === 3, `expected 3 queries, got ${queries.length}`)
assert(
  queries.every((q) => q.topics[0].length >= 1),
  'each query must OR at least one topic0',
)

const byAddr = Object.fromEntries(queries.map((q) => [q.address || '*', q]))
assert(byAddr[FACTORY], 'factory group missing')
assert(byAddr[TREASURY], 'treasury group missing')
assert(byAddr['*'], 'any-address group missing')

for (const a of config.alerts) {
  if (!a.topic0) continue
  const expectKey = a.scope === 'any-address' ? '*' : addressFor[a.contract]
  if (!expectKey) continue
  assert(covered.has(a.id), `${a.id} is not in any query`)
}

// Shared topic0, two contracts: OwnershipTransferred lives on both. A single
// address-less query would mix them; grouping by address keeps them apart.
const transferred = '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0'
assert(
  byAddr[FACTORY].topics[0].includes(transferred) &&
    byAddr[TREASURY].topics[0].includes(transferred),
  'OwnershipTransferred must be queried at both addresses, not OR-mixed',
)

const gov02 = matchLog(
  byAddr[FACTORY],
  { topics: [transferred], address: FACTORY },
  addressFor,
)
const gov03 = matchLog(
  byAddr[TREASURY],
  { topics: [transferred], address: TREASURY },
  addressFor,
)
assert(gov02?.id === 'GOV-02', `factory OwnershipTransferred matched ${gov02?.id}`)
assert(gov03?.id === 'GOV-03', `treasury OwnershipTransferred matched ${gov03?.id}`)

// A factory log must not match against the treasury query.
assert(
  !matchLog(byAddr[TREASURY], { topics: [transferred], address: FACTORY }, addressFor),
  'factory log leaked into the treasury query',
)

/* Two collisions that grouping turns into silence, neither of which
 * `verifyAlertTopics.js` can see — it checks a topic0 against the compiled
 * ABIs, not against the other alerts sharing a query.
 *
 * 1. Same group, same topic0. `matchLog` resolves a log with `find`, so the
 *    second alert is unreachable: it stays in the config, passes topic
 *    verification, and never fires again. GOV-02/GOV-03 are the near miss —
 *    one topic0, two contracts, two groups. Add a second factory alert on a
 *    topic0 the factory already has and one of them goes quiet.
 * 2. One topic0 on both an `any-address` alert and an address-scoped one. The
 *    two land in different groups, and a log from that address matches BOTH
 *    queries, so the finding is recorded twice — a P0 duplicated in the issue
 *    tracker on every pass, which is how a pager gets muted.
 */
for (const q of queries) {
  const seen = new Map()
  for (const a of q.alerts) {
    const t = String(a.topic0).toLowerCase()
    const prior = seen.get(t)
    assert(
      !prior,
      `${prior?.id} and ${a.id} share topic0 ${t} in the ${q.address || 'any-address'} ` +
      `query, so matchLog can only ever return the first — the other is unreachable. ` +
      `Split them by address, or give one a distinct event.`,
    )
    seen.set(t, a)
  }
}

const anyTopics = new Set(
  config.alerts
    .filter((a) => a.topic0 && a.scope === 'any-address')
    .map((a) => String(a.topic0).toLowerCase()),
)
for (const a of config.alerts) {
  if (!a.topic0 || a.scope === 'any-address') continue
  assert(
    !anyTopics.has(String(a.topic0).toLowerCase()),
    `${a.id} is address-scoped on a topic0 that an any-address alert also claims, so ` +
    `every matching log is recorded twice — once per query. Pick one scope.`,
  )
}

const before = config.alerts.filter((a) => a.topic0).length
console.log(`ok — ${queries.length} queries cover ${covered.size}/${before} alerts`)
console.log(
  queries
    .map((q) => `  ${q.address || 'any-address'}  ${q.topics[0].length} topic0(s)`)
    .join('\n'),
)
