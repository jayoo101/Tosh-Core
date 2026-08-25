// IPFS resolution strategy:
// 1. Primary: our own /api/ipfs backend proxy (authenticated Pinata, no CORS, no 429)
// 2. Fallback: public gateways (for edge cases where the proxy is unreachable)

const PUBLIC_GATEWAYS = [
  'https://cloudflare-ipfs.com',
  'https://ipfs.io',
  'https://dweb.link',
];

const PROXY_TIMEOUT_MS = 6000;
const GATEWAY_TIMEOUT_MS = 3000;
const TOTAL_TIMEOUT_MS = 8000;

/**
 * Extract the raw CID (+ optional path) from any IPFS reference.
 * Returns null for plain http(s) URLs.
 */
function extractCid(uri) {
  if (!uri || typeof uri !== 'string') return null;
  const trimmed = uri.trim();
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) return null;
  return trimmed.startsWith('ipfs://') ? trimmed.slice(7) : trimmed;
}

/**
 * Convert an ipfs:// URI to an HTTP URL via our backend proxy.
 * Falls through to the raw URI for non-IPFS http links.
 */
export function ipfsToHttp(uri) {
  if (!uri || typeof uri !== 'string') return null;
  const cid = extractCid(uri);
  if (!cid) return uri.startsWith('http') ? uri : null;
  return `/api/ipfs?cid=${encodeURIComponent(cid)}`;
}

/**
 * Returns an ordered array of URLs to try for a given IPFS URI.
 * Proxy first, then public gateways as fallback.
 */
export function ipfsGatewayUrls(uri) {
  const cid = extractCid(uri);
  if (!cid) {
    if (uri && typeof uri === 'string' && uri.startsWith('http')) return [uri];
    return [];
  }
  return [
    `/api/ipfs?cid=${encodeURIComponent(cid)}`,
    ...PUBLIC_GATEWAYS.map(gw => `${gw}/ipfs/${cid}`),
  ];
}

function fetchWithTimeout(url, ms) {
  return fetch(url, { signal: AbortSignal.timeout(ms), cache: 'force-cache' });
}

/**
 * Fetch IPFS JSON metadata. Tries the backend proxy first (fast, authenticated,
 * no CORS). If the proxy fails, races public gateways as fallback.
 * Returns parsed JSON or null.
 */
export async function fetchIPFSMetadata(ipfsURI) {
  if (!ipfsURI || typeof ipfsURI !== 'string') return null;
  const cid = extractCid(ipfsURI);
  if (!cid) return null;

  try {
    const result = await Promise.race([
      (async () => {
        // Try proxy first
        try {
          const proxyRes = await fetchWithTimeout(
            `/api/ipfs?cid=${encodeURIComponent(cid)}`,
            PROXY_TIMEOUT_MS
          );
          if (proxyRes.ok) return proxyRes;
        } catch { /* proxy failed, fall through */ }

        // Fallback: race public gateways
        return Promise.any(
          PUBLIC_GATEWAYS.map(gw =>
            fetchWithTimeout(`${gw}/ipfs/${cid}`, GATEWAY_TIMEOUT_MS).then(r => {
              if (!r.ok) throw new Error(`${gw} ${r.status}`);
              return r;
            })
          )
        );
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('IPFS total timeout')), TOTAL_TIMEOUT_MS)
      ),
    ]);
    return await result.json();
  } catch {
    return null;
  }
}
