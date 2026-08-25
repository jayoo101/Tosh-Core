/**
 * Shared Moralis multi-chain gas scanner — used by the allocation signing API.
 * Single source of truth for chain list and gas calculation logic.
 */

const MORALIS_BASE = 'https://deep-index.moralis.io/api/v2.2';
const MORALIS_TIMEOUT_MS = 8_000;
const MAX_PAGES_PER_CHAIN = 30;
const MAX_429_RETRIES = 3;

export const TARGET_CHAINS = [
  { name: 'Ethereum', hex: '0x1',    label: 'Ethereum Mainnet' },
  { name: 'Base',     hex: '0x2105', label: 'Base L2' },
  { name: 'Optimism', hex: '0xa',    label: 'Optimism' },
  { name: 'Arbitrum', hex: '0xa4b1', label: 'Arbitrum One' },
];

/**
 * Fetch all outgoing transactions for `address` on one chain via Moralis,
 * summing gasUsed * gasPrice. Returns { gas: number (ETH), txCount: number }.
 * Returns { gas: 0, txCount: 0 } on any failure so one chain never blocks the others.
 */
export async function fetchChainGas(address, chainHex, apiKey, logPrefix = '[Gas]') {
  const lower = address.toLowerCase();
  let totalWei = BigInt(0);
  let txCount = 0;
  let cursor = null;
  let pages = 0;
  let rateLimitHits = 0;

  try {
    do {
      const url = new URL(`${MORALIS_BASE}/${address}`);
      url.searchParams.set('chain', chainHex);
      url.searchParams.set('limit', '100');
      if (cursor) url.searchParams.set('cursor', cursor);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MORALIS_TIMEOUT_MS);

      const res = await fetch(url.toString(), {
        headers: { 'X-API-Key': apiKey, accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 429) {
        rateLimitHits++;
        if (rateLimitHits > MAX_429_RETRIES) {
          console.warn(`${logPrefix} Moralis ${chainHex} rate-limited ${rateLimitHits}x, aborting chain`);
          break;
        }
        const backoff = 1000 * rateLimitHits;
        console.warn(`${logPrefix} Moralis ${chainHex} rate-limited (429), retry ${rateLimitHits}/${MAX_429_RETRIES} in ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`${logPrefix} Moralis ${chainHex} HTTP ${res.status}: ${body.slice(0, 200)}`);
        return { gas: 0, txCount: 0 };
      }

      const json = await res.json();
      const txs = json.result || [];
      pages++;

      if (pages === 1 && txs.length > 0) {
        const sample = txs[0];
        console.log(`${logPrefix} ${chainHex} sample tx fields:`, JSON.stringify({
          from: sample.from_address,
          gas_price: sample.gas_price,
          receipt_effective_gas_price: sample.receipt_effective_gas_price,
          receipt_gas_used: sample.receipt_gas_used,
          gas_used: sample.gas_used,
          gas: sample.gas,
        }));
      }

      for (const tx of txs) {
        if ((tx.from_address || '').toLowerCase() !== lower) continue;
        txCount++;
        const gasUsed  = BigInt(tx.receipt_gas_used || tx.gas_used || '0');
        const gasPrice = BigInt(tx.receipt_effective_gas_price || tx.gas_price || '0');
        totalWei += gasUsed * gasPrice;
      }

      cursor = json.cursor || null;
    } while (cursor && pages < MAX_PAGES_PER_CHAIN);

    if (cursor) {
      console.warn(`${logPrefix} ${chainHex}: pagination capped at ${MAX_PAGES_PER_CHAIN} pages (more data exists)`);
    }
  } catch (err) {
    console.error(`${logPrefix} ${chainHex} failed:`, err?.name === 'AbortError' ? 'timeout' : err?.message);
    return { gas: 0, txCount: 0 };
  }

  const gasEth = Number(totalWei / BigInt(1e9)) / 1e9;
  console.log(`${logPrefix} ${chainHex}: ${txCount} txns, ${pages} pages, ${gasEth.toFixed(6)} ETH`);
  return { gas: gasEth, txCount };
}

/**
 * Scan gas across all TARGET_CHAINS in parallel.
 * Moralis free-tier allows burst concurrency across different chain endpoints,
 * so parallel execution is safe and critical for staying within Vercel's 10s timeout.
 * Returns array of { label, gas, txCount } and a totalGas number.
 */
export async function scanAllChainGas(address, apiKey, logPrefix = '[Gas]') {
  const settled = await Promise.allSettled(
    TARGET_CHAINS.map(async (c) => {
      const data = await fetchChainGas(address, c.hex, apiKey, logPrefix);
      return { label: c.label, chain: c.hex, name: c.name, gas: data.gas, txCount: data.txCount };
    })
  );
  const results = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    console.error(`${logPrefix} ${TARGET_CHAINS[i].hex} rejected:`, r.reason?.message);
    return { label: TARGET_CHAINS[i].label, chain: TARGET_CHAINS[i].hex, name: TARGET_CHAINS[i].name, gas: 0, txCount: 0 };
  });
  const totalGas = results.reduce((sum, c) => sum + c.gas, 0);
  return { chains: results, totalGas };
}
