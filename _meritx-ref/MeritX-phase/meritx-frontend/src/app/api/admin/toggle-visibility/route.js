import { NextResponse } from 'next/server';
import { createRateLimiter } from '@/lib/rateLimit';

const limiter = createRateLimiter({ windowMs: 60_000, max: 20 });

function getClientIP(request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
}

function authenticate(request) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;

  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return token.length > 0 && token === secret;
}

export async function POST(request) {
  if (!authenticate(request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const ip = getClientIP(request);
  const rl = limiter(ip);
  if (!rl.allowed) {
    return NextResponse.json(
      { success: false, error: 'Rate limit exceeded.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.retryAfterMs || 60_000) / 1000)) } }
    );
  }

  try {
    const { address, hidden } = await request.json();

    if (!address || typeof hidden !== 'boolean') {
      return NextResponse.json(
        { success: false, error: 'Missing address or hidden flag' },
        { status: 400 }
      );
    }

    // NOTE: Replace with persistent storage (e.g. Postgres, Supabase) before mainnet.
    // await db.projects.update({ address }, { hidden });

    return NextResponse.json({ success: true, address, hidden });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function GET(request) {
  if (!authenticate(request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  // NOTE: Replace with persistent storage query before mainnet.
  // const hidden = await db.projects.findMany({ where: { hidden: true } });
  // return NextResponse.json({ success: true, hiddenAddresses: hidden.map(p => p.address) });

  return NextResponse.json({ success: true, hiddenAddresses: [] });
}
