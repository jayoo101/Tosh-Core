import { NextResponse } from 'next/server';
import { createRateLimiter } from '@/lib/rateLimit';

export const runtime = 'nodejs';

const PINATA_JWT = process.env.PINATA_JWT;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2 MB
const PINATA_TIMEOUT_MS = 10_000;

const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });

function getClientIP(request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
}

export async function POST(request) {
  if (!PINATA_JWT) {
    return NextResponse.json(
      { success: false, error: 'IPFS service not configured on server' },
      { status: 500 }
    );
  }

  const ip = getClientIP(request);
  const rl = limiter(ip);
  if (!rl.allowed) {
    return NextResponse.json(
      { success: false, error: 'Too many uploads. Please wait before retrying.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.retryAfterMs || 60_000) / 1000)) } }
    );
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_PAYLOAD_BYTES) {
    return NextResponse.json(
      { success: false, error: `Payload too large. Maximum ${MAX_PAYLOAD_BYTES / 1024 / 1024}MB allowed.` },
      { status: 413 }
    );
  }

  try {
    const contentType = request.headers.get('content-type') || '';

    // ── JSON metadata upload ──
    if (contentType.includes('application/json')) {
      const raw = await request.text();
      if (raw.length > MAX_PAYLOAD_BYTES) {
        return NextResponse.json(
          { success: false, error: 'JSON payload too large.' },
          { status: 413 }
        );
      }
      const json = JSON.parse(raw);

      if (!json.data || typeof json.data !== 'object') {
        return NextResponse.json(
          { success: false, error: 'Missing or invalid "data" field in JSON body.' },
          { status: 400 }
        );
      }

      const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${PINATA_JWT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pinataContent: json.data,
          pinataOptions: { cidVersion: 1 },
        }),
        signal: AbortSignal.timeout(PINATA_TIMEOUT_MS),
      });
      if (!res.ok) {
        return NextResponse.json(
          { success: false, error: `Pinata upload failed (${res.status})` },
          { status: 502 }
        );
      }
      const result = await res.json();
      return NextResponse.json({ success: true, IpfsHash: result.IpfsHash });
    }

    // ── File (avatar image) upload ──
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file) {
      return NextResponse.json(
        { success: false, error: 'No file provided' },
        { status: 400 }
      );
    }

    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      return NextResponse.json(
        { success: false, error: `Unsupported file type "${file.type}". Allowed: JPEG, PNG, GIF, WebP.` },
        { status: 415 }
      );
    }

    if (file.size > MAX_PAYLOAD_BYTES) {
      return NextResponse.json(
        { success: false, error: `File too large. Maximum ${MAX_PAYLOAD_BYTES / 1024 / 1024}MB allowed.` },
        { status: 413 }
      );
    }

    const pinataForm = new FormData();
    pinataForm.append('file', file);
    pinataForm.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

    const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: { Authorization: `Bearer ${PINATA_JWT}` },
      body: pinataForm,
      signal: AbortSignal.timeout(PINATA_TIMEOUT_MS),
    });
    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: `Pinata upload failed (${res.status})` },
        { status: 502 }
      );
    }
    const result = await res.json();
    return NextResponse.json({ success: true, IpfsHash: result.IpfsHash });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      console.error('[upload] Pinata request timed out');
      return NextResponse.json(
        { success: false, error: 'IPFS upload timed out. Please try again.' },
        { status: 504 }
      );
    }
    console.error('[upload] error:', err?.message);
    return NextResponse.json(
      { success: false, error: 'Upload failed' },
      { status: 500 }
    );
  }
}
