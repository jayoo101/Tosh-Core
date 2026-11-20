import { NextResponse, type NextRequest } from 'next/server'

/**
 * Optional HTTP Basic Auth for an internal deployment (the reward-review site).
 * Off unless `SITE_ACCESS_PASSWORD` is set, so the public site is unaffected.
 */
export function proxy(req: NextRequest) {
  const password = process.env.SITE_ACCESS_PASSWORD
  if (!password) return NextResponse.next()
  const user = process.env.SITE_ACCESS_USER || 'tosh'

  const header = req.headers.get('authorization') ?? ''
  if (header.startsWith('Basic ')) {
    let decoded = ''
    try { decoded = atob(header.slice(6)) } catch { /* malformed */ }
    const sep = decoded.indexOf(':')
    if (sep >= 0 && same(decoded.slice(0, sep), user) && same(decoded.slice(sep + 1), password)) {
      return NextResponse.next()
    }
  }
  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="ToshX internal", charset="UTF-8"', 'cache-control': 'no-store' },
  })
}

/** Length-independent comparison, so a wrong guess does not leak how much of it matched. */
function same(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.png|robots.txt).*)'],
}
