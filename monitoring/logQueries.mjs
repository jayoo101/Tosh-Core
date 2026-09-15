/**
 * Builds the smallest set of `eth_getLogs` filters that still covers every
 * alert. The public 4663 endpoint 429s on the seventh identical call; a pass
 * that issued one request per topic0 walked into that ceiling on every run,
 * which is how a rate-limit became a missed P0.
 *
 * Ethereum treats `topics[0] = [a, b, c]` as OR. Grouping by address (or
 * "any") therefore collapses the catalogue to one query per scope: factory,
 * treasury, and the address-less hook events. Three requests sit under the
 * measured ceiling of six; twenty-odd do not.
 *
 * Necessary, and measured 2026-09-15 to be insufficient on its own: from a CI
 * runner all three are refused outright, because that endpoint meters by source
 * IP and a shared runner range is spent before the pass starts. What grouping
 * buys is a pass cheap enough that a keyed endpoint's free tier carries it
 * comfortably. `rpc.mjs` has the measurement and the reasoning.
 */
export function buildLogQueries(alerts, addressFor) {
  const groups = new Map()

  for (const a of alerts) {
    if (!a.topic0) continue
    const key = a.scope === 'any-address' ? '*' : addressFor[a.contract]
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(a)
  }

  return [...groups.entries()].map(([key, group]) => {
    const topic0s = [...new Set(group.map((a) => String(a.topic0).toLowerCase()))]
    return {
      address: key === '*' ? null : key,
      // Nested array = OR on topic0. A flat array would mean topic0 AND topic1.
      topics: [topic0s],
      alerts: group,
    }
  })
}

export function matchLog(query, log, addressFor) {
  const topic0 = String(log.topics?.[0] || '').toLowerCase()
  const addr = String(log.address || '').toLowerCase()
  return query.alerts.find((a) => {
    if (String(a.topic0).toLowerCase() !== topic0) return false
    if (a.scope === 'any-address') return true
    return addressFor[a.contract] === addr
  })
}
