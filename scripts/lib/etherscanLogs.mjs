/**
 * Event log history, via Etherscan's v2 API.
 *
 * WHY NOT JSON-RPC
 *
 * Because no free BSC endpoint will serve it. That is measured rather than
 * assumed: eight public endpoints were probed against a real `eth_getLogs`
 * filter at both 1,000 and 200 block spans and every one refused. `publicnode`
 * is the only one that says why — `-32602 Archive requests require a personal
 * token`. Log history more than a few thousand blocks old is a paid feature
 * essentially everywhere on this chain, and a dashboard that counts wallets
 * needs all of it.
 *
 * The API key is read from the environment by the caller and never logged,
 * echoed, or sent anywhere but Etherscan.
 */

const ENDPOINT = 'https://api.etherscan.io/v2/api'

/** Etherscan's per-page ceiling for the `logs` module. */
const PAGE_SIZE = 1000

export class LogSourceUnavailable extends Error {}

/**
 * Every log matching one topic on one address.
 *
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} p.address
 * @param {string} p.topic0
 * @param {number} p.fromBlock
 * @param {number} p.toBlock
 * @param {number} [p.chainId]
 * @param {(n: number) => void} [p.onProgress] Called with the running count.
 */
export async function fetchLogs({
  apiKey, address, topic0, fromBlock, toBlock, chainId = 56, onProgress,
}) {
  if (!apiKey) {
    throw new LogSourceUnavailable(
      'ETHERSCAN_API_KEY is not set, and no free BSC endpoint serves log history this far back',
    )
  }

  const out = []
  let page = 1
  while (true) {
    const url = `${ENDPOINT}?chainid=${chainId}&module=logs&action=getLogs`
      + `&address=${address}&topic0=${topic0}`
      + `&fromBlock=${fromBlock}&toBlock=${toBlock}`
      + `&page=${page}&offset=${PAGE_SIZE}&apikey=${apiKey}`

    let res
    try {
      res = await fetch(url)
    } catch (e) {
      throw new LogSourceUnavailable(`Etherscan unreachable: ${e.message}`)
    }
    if (!res.ok) throw new LogSourceUnavailable(`Etherscan HTTP ${res.status}`)

    const body = await res.json()

    // `status: '0'` means both "nothing matched" and "your request was bad",
    // separable only by the message. Conflating them is expensive in both
    // directions: read as an error, a legitimately empty range looks broken;
    // read as empty, a rejected key looks like "nobody qualified".
    if (body.status === '0') {
      const msg = String(body.message || '')
      const detail = typeof body.result === 'string' ? body.result : ''
      if (/no records found/i.test(msg) || /no records found/i.test(detail)) break
      throw new LogSourceUnavailable(`Etherscan: ${msg} ${detail}`.trim())
    }

    const batch = Array.isArray(body.result) ? body.result : []
    out.push(...batch)
    onProgress?.(out.length)
    if (batch.length < PAGE_SIZE) break
    page += 1
  }

  // Etherscan hands back hex strings where JSON-RPC hands back numbers.
  // Normalising here means no call site has to remember which source it got.
  return out.map((l) => ({
    topics: l.topics,
    data: l.data,
    blockNumber: Number(BigInt(l.blockNumber)),
    timeStamp: l.timeStamp ? Number(BigInt(l.timeStamp)) : undefined,
    transactionHash: l.transactionHash,
  }))
}

/**
 * The block a deployment landed in, from Foundry's own broadcast record.
 *
 * ⚠ DO NOT SUBSTITUTE A BISECTION ON `getCode`. That was tried and it produces
 *   a confidently wrong answer against a non-archive node: historical `getCode`
 *   returns empty, a bisection reads empty as "too early", and every probe walks
 *   toward the chain head. It converged 94 blocks below head — 247,000 blocks
 *   after the real deployment — and the scan that followed reported zero events
 *   for a contract that had plenty.
 */
export function deploymentBlock(broadcastJson, address) {
  const creation = broadcastJson.transactions?.find(
    (t) => t.contractAddress?.toLowerCase() === address.toLowerCase()
      && t.transactionType === 'CREATE',
  )
  const receipt = creation?.hash
    && broadcastJson.receipts?.find((r) => r.transactionHash === creation.hash)
  if (receipt?.blockNumber) return Number(BigInt(receipt.blockNumber))

  // Not in this record. The earliest block it knows about is still a sound
  // lower bound for anything it deployed, but the caller should be told.
  const earliest = broadcastJson.receipts
    ?.map((r) => Number(BigInt(r.blockNumber)))
    .sort((a, b) => a - b)[0]
  if (!earliest) throw new Error('broadcast record has no receipts to date a deployment from')
  return earliest
}
