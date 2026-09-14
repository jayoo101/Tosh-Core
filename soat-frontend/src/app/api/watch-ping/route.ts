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
 *
 * Every refusal is a different repair, so each has its own status:
 *
 *   401  nothing this route reads was sent — the pinger has no header
 *   403  a credential was read and does not match — the value is stale
 *   502  the ping was accepted; GitHub refused the dispatch (token scope,
 *        or `repository_dispatch` absent from the default branch)
 *   503  a credential this route needs is unset on the deployment
 */
import { timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'

import { applyRateLimit } from '@/app/lib/apiGuard'
import { reportError } from '@/lib/observability'

const PING_LIMIT = { name: 'watch-ping', capacity: 8, refillPerSec: 1 / 15 } as const
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/**
 * A pinger that sends nothing and a pinger that sends the wrong value both
 * used to get a bare 401, which is one observation for two different repairs
 * — and the observation is all the operator has, because the pinger is a
 * third-party form and Vercel's request log keeps status codes, not headers.
 * cron-job.org's own hint on a 401 ("add an authorization header") argues for
 * the case that is already handled, so it points away from the other one.
 *
 * `scheme` carries the case that costs the most time: cron-job.org's
 * Authentication fields send `Authorization: Basic <base64>`, which is a
 * credential the operator can see themselves entering and that this route
 * does not read. Naming it discloses nothing a reader of this file does not
 * already have — the header names are three lines up, and the value is never
 * echoed.
 */
type Credential =
  | { kind: 'sent'; value: string }
  | { kind: 'absent'; scheme: string | null }

function providedSecret(req: NextRequest): Credential {
  const auth = req.headers.get('authorization')
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)
  if (bearer?.[1]) return { kind: 'sent', value: bearer[1].trim() }
  const header = req.headers.get('x-cron-secret')?.trim()
  if (header) return { kind: 'sent', value: header }
  const scheme = auth?.trim().split(/\s+/)[0]
  return { kind: 'absent', scheme: scheme || null }
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
  if (got.kind === 'absent') {
    return NextResponse.json(
      {
        error: 'no credential',
        detail: got.scheme
          ? `The authorization header used the ${got.scheme} scheme. This route reads `
            + `Bearer, or the x-cron-secret header. HTTP Basic auth fields on a pinger `
            + `send Basic and will never match.`
          : 'Send Authorization: Bearer <CRON_SECRET>, or x-cron-secret: <CRON_SECRET>.',
      },
      { status: 401, headers: { 'www-authenticate': 'Bearer' } },
    )
  }

  // 403, not 401: the credential arrived and was read. A pinger that repeats a
  // 401 is configured wrong; one that gets 403 is configured and holds a stale
  // value, and only the second is fixed by rotating CRON_SECRET. Nothing about
  // the expected value is disclosed — length included, which is why the
  // comparison below is reached with no length hint returned here.
  if (!secretsEqual(got.value, expected)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
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
      // The hint names a permission, not a value, and only for the statuses
      // that mean "GitHub read the token and said no". Without it this 502 is
      // the end of the trail for whoever is holding the pinger: the ping was
      // accepted, so every field they control looks right.
      const hint =
        res.status === 403 || res.status === 404
          ? 'WATCH_DISPATCH_TOKEN was refused. repository_dispatch needs Contents: write; '
            + 'Actions: write is the workflow_dispatch endpoint and grants nothing here.'
          : res.status === 422
            ? 'The token is fine. watch.yml on the default branch has no repository_dispatch trigger.'
            : undefined

      return NextResponse.json(
        { error: 'dispatch failed', status: res.status, ...(hint ? { hint } : {}) },
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
