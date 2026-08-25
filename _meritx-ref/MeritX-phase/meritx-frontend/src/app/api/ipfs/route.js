import { NextResponse } from 'next/server';
import { createRateLimiter } from '@/lib/rateLimit';

export const runtime = 'nodejs';

const PINATA_JWT = process.env.PINATA_JWT;
const PINATA_GATEWAY = process.env.PINATA_DEDICATED_GATEWAY || 'https://gateway.pinata.cloud';

const FALLBACK_GATEWAYS = [
  'https://cloudflare-ipfs.com',
  'https://ipfs.io',
];

const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_CACHE_ENTRIES = 2000;

const limiter = createRateLimiter({ windowMs: 60_000, max: 30 });

function getClientIP(request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
}

const ALLOWED_ORIGINS = new Set([
  'http://localhost:3000',
  'http://localhost:3001',
]);
const appUrl = process.env.NEXT_PUBLIC_APP_URL;
if (appUrl) ALLOWED_ORIGINS.add(appUrl.replace(/\/$/, ''));

function getCorsHeaders(request) {
  const origin = request.headers.get('origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return { 'Access-Control-Allow-Origin': origin };
  }
  return {};
}

function isValidCid(cid) {
  if (typeof cid !== 'string' || cid.length < 10 || cid.length > 128) return false;
  if (/[/\\.\s]/.test(cid)) return false;
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) return true;
  if (/^b[a-z2-7]{49,100}$/.test(cid)) return true;
  return false;
}

async function fetchFromGateway(url, headers = {}) {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  return res;
}

/**
 * GET /api/ipfs?cid=<CID>
 *
 * Backend proxy for IPFS content. Tries Pinata (authenticated) first,
 * then falls back to public gateways. Returns the content with correct
 * Content-Type and aggressive caching headers (IPFS content is immutable).
 */
export async function GET(request) {
  const ip = getClientIP(request);
  const rl = limiter(ip);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.retryAfterMs || 60_000) / 1000)) } }
    );
  }

  const { searchParams } = new URL(request.url);
  const rawCid = searchParams.get('cid');

  if (!rawCid) {
    return NextResponse.json({ error: 'Missing ?cid= parameter' }, { status: 400 });
  }

  const cid = rawCid.startsWith('ipfs://') ? rawCid.slice(7) : rawCid;

  if (!isValidCid(cid)) {
    return NextResponse.json({ error: 'Invalid CID format' }, { status: 400 });
  }

  const gateways = [];
  if (PINATA_JWT) {
    gateways.push({ url: `${PINATA_GATEWAY}/ipfs/${cid}`, headers: { Authorization: `Bearer ${PINATA_JWT}` } });
  }
  for (const gw of FALLBACK_GATEWAYS) {
    gateways.push({ url: `${gw}/ipfs/${cid}`, headers: {} });
  }

  let upstreamRes;
  for (const gw of gateways) {
    try {
      upstreamRes = await fetchFromGateway(gw.url, gw.headers);
      break;
    } catch (e) {
      console.warn(`[IPFS Proxy] ${gw.url} failed: ${e?.message}`);
    }
  }

  if (!upstreamRes) {
    console.error(`[IPFS Proxy] All gateways failed for CID: ${cid}`);
    return NextResponse.json(
      { error: 'All IPFS gateways failed' },
      { status: 502 }
    );
  }

  const declaredLength = parseInt(upstreamRes.headers.get('content-length') || '0', 10);
  if (declaredLength > MAX_RESPONSE_BYTES) {
    return NextResponse.json(
      { error: `IPFS object too large (${Math.round(declaredLength / 1024 / 1024)}MB exceeds 5MB limit)` },
      { status: 413, headers: getCorsHeaders(request) }
    );
  }

  const body = await upstreamRes.arrayBuffer();

  if (body.byteLength > MAX_RESPONSE_BYTES) {
    return NextResponse.json(
      { error: 'IPFS object too large (exceeds 5MB limit)' },
      { status: 413, headers: getCorsHeaders(request) }
    );
  }

  const contentType = upstreamRes.headers.get('content-type') || 'application/octet-stream';
  const cors = getCorsHeaders(request);

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      ...cors,
    },
  });
}
