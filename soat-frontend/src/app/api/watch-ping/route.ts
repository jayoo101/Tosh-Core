/**
 * /api/watch-ping — the second scheduler for the on-chain watcher.
 *
 * GitHub Actions cron on this repository delivered 0.269 passes an hour
 * against a schedule asking for four. Changing the interval bought nothing,
 * so the interval is not a detection knob. This route is: anything that can
 * hit a URL (Vercel cron, cron-job.org, a laptop) starts the same `watch.yml`
 * job via `repository_dispatch`, which is not the pool the 7% measurement
 * was taken against.
 *
 * Auth is a shared secret, not a signature. The route starts a workflow; it
 * does not read chain or write findings. A leak lets someone spend Actions
 * minutes, which the concurrency group on watch.yml already serialises.
 *
 *   Authorization: Bearer <CRON_SECRET>
 *   or header x-cron-secret: <CRON_SECRET>
 *
 * Vercel cron sends the first of those when `CRON_SECRET` is set on the
 * project. Unset, this route refuses rather than firing an unauthenticated
 * dispatch.
 */
import { timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'

import { applyRateLimit } from '@/app/lib/apiGuard'
import { reportError } from '@/lib/observability'

const PING_LIMIT = { name: 'watch-ping', capacity: 8, refillPerSec: 1 / 15 } as const
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function providedSecret(req: NextRequest): string | null {
  const auth = req.headers.get('authorization')
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)
  if (bearer?.[1]) return bearer[1].trim()
  const header = req.headers.get('x-cron-secret')
  return header?.trim() || null
}

function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export async function GET(req: NextRequest) {
  return ping(req)
}

export async function POST(req: NextRequest) {
  return ping(req)
}

async function ping(req: NextRequest): Promise<NextResponse> {
  const limited = await applyRateLimit(req, PING_LIMIT)
  if (limited) return limited

  const expected = process.env.CRON_SECRET?.trim()
  const token = process.env.WATCH_DISPATCH_TOKEN?.trim()
  const repo = process.env.WATCH_DISPATCH_REPO?.trim() || 'jayoo101/Tosh-Core'

  if (!expected) {
    return NextResponse.json(
      { error: 'CRON_SECRET is unset, so this route will not fire an unauthenticated dispatch.' },
      { status: 503 },
    )
  }

  const got = providedSecret(req)
  if (!got || !secretsEqual(got, expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  if (!REPO_RE.test(repo)) {
    return NextResponse.json({ error: 'WATCH_DISPATCH_REPO is not owner/name' }, { status: 503 })
  }

  if (!token) {
    return NextResponse.json(
      { error: 'WATCH_DISPATCH_TOKEN is unset. The ping arrived; nothing was started.' },
      { status: 503 },
    )
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ event_type: 'watch' }),
    })

    if (res.status !== 204) {
      // The body is GitHub's, not a caller's, and it is what distinguishes an
      // expired PAT from a missing `repository_dispatch` trigger. Reported
      // rather than returned: a 401 upstream must not read as a 401 here.
      const body = await res.text()
      reportError(new Error(`dispatch refused: ${body.slice(0, 200)}`), {
        surface: 'api-route',
        extra: { route: '/api/watch-ping', repo, status: res.status },
      })
      return NextResponse.json(
        { error: 'dispatch failed', status: res.status },
        { status: 502 },
      )
    }

    return NextResponse.json({ ok: true, repo })
  } catch (err) {
    reportError(err, {
      surface: 'api-route',
      extra: { route: '/api/watch-ping', repo },
    })
    return NextResponse.json({ error: 'dispatch failed' }, { status: 502 })
  }
}
