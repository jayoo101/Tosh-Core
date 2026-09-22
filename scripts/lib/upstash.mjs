/**
 * The few Upstash Redis reads the dashboard needs, over the REST API.
 *
 * Deliberately not `@upstash/redis`: `scripts/` has no build step and three
 * commands do not justify a dependency. Read-only by construction — there is no
 * `set` here, because a dashboard that can write to the store the production
 * app reads from is a dashboard that can cause an outage.
 */

export class StoreUnavailable extends Error {}

function credentials() {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    throw new StoreUnavailable('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are not both set')
  }
  return { url: url.replace(/\/$/, ''), token }
}

export function configured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
}

/**
 * One command, as a path-style REST call.
 *
 * Arguments are URL-encoded individually rather than joined, because PoG keys
 * embed addresses and rate-limit keys embed `::`-delimited IPs — both of which
 * contain characters that would otherwise change the command's shape.
 */
async function command(parts) {
  const { url, token } = credentials()
  const path = parts.map((p) => encodeURIComponent(String(p))).join('/')
  let res
  try {
    res = await fetch(`${url}/${path}`, { headers: { Authorization: `Bearer ${token}` } })
  } catch (e) {
    throw new StoreUnavailable(`Upstash unreachable: ${e.message}`)
  }
  if (!res.ok) throw new StoreUnavailable(`Upstash HTTP ${res.status}`)
  const body = await res.json()
  if (body.error) throw new StoreUnavailable(`Upstash: ${body.error}`)
  return body.result
}

export async function get(key) {
  return command(['get', key])
}

export async function mget(keys) {
  if (keys.length === 0) return []
  return command(['mget', ...keys])
}

/**
 * Keys matching a glob, gathered across the SCAN cursor.
 *
 * `SCAN` rather than `KEYS` because this runs against the store production
 * depends on: `KEYS` is a single blocking pass over the whole keyspace, and the
 * one thing a read-only dashboard must never do is stall the app it is
 * reporting on. The page cap is a safety valve for a keyspace that has grown
 * past what a dashboard should be enumerating.
 */
export async function scanKeys(pattern, { pageLimit = 40, count = 500 } = {}) {
  const keys = []
  let cursor = '0'
  let pages = 0
  do {
    const [next, batch] = await command(['scan', cursor, 'match', pattern, 'count', count])
    cursor = String(next)
    keys.push(...batch)
    pages += 1
  } while (cursor !== '0' && pages < pageLimit)
  return { keys, truncated: cursor !== '0' }
}
