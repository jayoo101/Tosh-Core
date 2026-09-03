import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `clientIp` is not exported, and is not tested directly on purpose. What
 * matters is not which string it returns but whether a caller can obtain a
 * private rate-limit bucket by choosing a header — so these go through
 * `applyRateLimit` and count 429s, which is the behaviour the endpoint
 * actually has.
 *
 * `TRUSTED_PROXY_HOPS` is resolved at module load, so the cases that vary it
 * reset the registry and re-import.
 */
async function loadGuard(hops?: string) {
  vi.resetModules()
  vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY_HOPS', hops as unknown as string)
  // Keep the limiter in-process; a shared backend would make counts depend on
  // whatever else has run against it.
  vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined as unknown as string)
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', undefined as unknown as string)
  return import('./apiGuard')
}

function reqWith(headers: Record<string, string>): Request {
  return new Request('https://tosh.test/api/thing', { headers })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

/** Distinct per test so buckets never bleed between cases. */
let bucketSeq = 0
const bucket = (capacity: number) => ({
  name: `test-${process.pid}-${bucketSeq++}`,
  capacity,
  refillPerSec: 0.001, // effectively no refill for the duration of a test
})

describe('applyRateLimit — a caller cannot choose its own bucket', () => {
  it('throttles a single client that varies the leftmost X-Forwarded-For entry', async () => {
    // The bug: the bucket was keyed on the leftmost entry, which the client
    // supplies. Behind a proxy that appends, a fresh random value per request
    // meant a fresh full bucket per request — the limiter came off with one
    // header, including on the signing endpoint.
    const { applyRateLimit } = await loadGuard('1')
    const opts = bucket(20)

    let limited = 0
    for (let i = 0; i < 60; i++) {
      const res = await applyRateLimit(
        reqWith({ 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` }),
        opts,
      )
      if (res) limited++
    }
    expect(limited).toBe(40)
  })

  it('gives genuinely different clients their own buckets', async () => {
    // The mirror of the case above: if the fix were "ignore XFF entirely" the
    // test above would also pass, while every visitor behind one CDN shared a
    // bucket. Both properties have to hold at once.
    const { applyRateLimit } = await loadGuard('1')
    const opts = bucket(20)

    let limited = 0
    for (let i = 0; i < 60; i++) {
      const res = await applyRateLimit(
        reqWith({ 'x-forwarded-for': `10.0.0.5, 203.0.113.${i}` }),
        opts,
      )
      if (res) limited++
    }
    expect(limited).toBe(0)
  })

  it('prefers a platform header over anything in X-Forwarded-For', async () => {
    const { applyRateLimit } = await loadGuard('1')
    const opts = bucket(10)

    let limited = 0
    for (let i = 0; i < 30; i++) {
      const res = await applyRateLimit(
        reqWith({
          'cf-connecting-ip': '198.51.100.1',
          'x-forwarded-for': `10.0.0.${i}, 203.0.113.${i}`,
        }),
        opts,
      )
      if (res) limited++
    }
    expect(limited).toBe(20)
  })

  it('counts from the right when two proxies are declared', async () => {
    const { applyRateLimit } = await loadGuard('2')
    const opts = bucket(10)

    // Second from the right is constant; the two the client controls are not.
    let limited = 0
    for (let i = 0; i < 30; i++) {
      const res = await applyRateLimit(
        reqWith({ 'x-forwarded-for': `10.0.0.${i}, 198.51.100.9, 203.0.113.${i}` }),
        opts,
      )
      if (res) limited++
    }
    expect(limited).toBe(20)
  })

  it('ignores X-Forwarded-For entirely when no proxy is trusted', async () => {
    // Direct-to-Node: nothing in front normalises the header, so honouring it
    // would hand out a private bucket to anyone who sets it.
    const { applyRateLimit } = await loadGuard('0')
    const opts = bucket(10)

    let limited = 0
    for (let i = 0; i < 30; i++) {
      const res = await applyRateLimit(
        reqWith({ 'x-forwarded-for': `10.0.0.${i}` }),
        opts,
      )
      if (res) limited++
    }
    expect(limited).toBe(20)
  })

  it('clamps rather than wraps when there are fewer hops than configured', async () => {
    const { applyRateLimit } = await loadGuard('3')
    const opts = bucket(10)

    let limited = 0
    for (let i = 0; i < 30; i++) {
      const res = await applyRateLimit(reqWith({ 'x-forwarded-for': '203.0.113.7' }), opts)
      if (res) limited++
    }
    // One entry, three declared hops: index clamps to 0 and stays a stable key
    // rather than becoming undefined and collapsing to a shared bucket.
    expect(limited).toBe(20)
  })

  it('reports a Retry-After the caller can act on', async () => {
    const { applyRateLimit } = await loadGuard('1')
    const opts = { name: `retry-${process.pid}`, capacity: 1, refillPerSec: 1 }
    const req = reqWith({ 'x-forwarded-for': '203.0.113.7' })

    expect(await applyRateLimit(req, opts)).toBeNull()
    const res = await applyRateLimit(req, opts)
    expect(res?.status).toBe(429)
    expect(Number(res?.headers.get('Retry-After'))).toBeGreaterThanOrEqual(0)
  })
})

describe('readJsonBody — the cap is in bytes, and it is enforced while reading', () => {
  function jsonReq(body: string, headers: Record<string, string> = {}): Request {
    return new Request('https://tosh.test/api/thing', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    })
  }

  /**
   * A body with no `Content-Length`, so only the metering in `readBodyCapped`
   * can reject it.
   *
   * A plain string body would make undici set the header, and the fast path
   * would then return 413 before the meter ran — the test would pass against
   * the very bug it is meant to pin.
   */
  function streamReq(text: string): Request {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    })
    const req = new Request('https://tosh.test/api/thing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      // @ts-expect-error — Node requires this for a stream body; not in the DOM lib types.
      duplex: 'half',
    })
    if (req.headers.get('content-length') !== null) {
      throw new Error('fixture is not exercising the meter: Content-Length was set')
    }
    return req
  }

  it('rejects a body that fits the cap in UTF-16 units but exceeds it in bytes', async () => {
    // The bug: the cap was compared against `raw.length`, which counts UTF-16
    // code units. Astral-plane characters are 2 units and 4 bytes, so a body
    // could be twice the advertised limit and still pass.
    const { readJsonBody } = await loadGuard('1')
    const payload = JSON.stringify('😀'.repeat(6)) // 14 UTF-16 units, 26 bytes

    expect(payload.length).toBeLessThan(20)
    expect(new TextEncoder().encode(payload).length).toBeGreaterThan(20)

    const { data, error } = await readJsonBody(streamReq(payload), 20)
    expect(data).toBeNull()
    expect(error?.status).toBe(413)
  })

  it('enforces the cap even when Content-Length is absent', async () => {
    // The declared length is a hint from the caller. A streamed body with no
    // length at all has to be metered as it arrives, or the check is advisory.
    const { readJsonBody } = await loadGuard('1')
    const { data, error } = await readJsonBody(
      streamReq(JSON.stringify({ pad: 'x'.repeat(5_000) })),
      1_000,
    )
    expect(data).toBeNull()
    expect(error?.status).toBe(413)
  })

  it('still rejects on a declared length that exceeds the cap, before reading', async () => {
    const { readJsonBody } = await loadGuard('1')
    const { error } = await readJsonBody(jsonReq(JSON.stringify({ pad: 'x'.repeat(5_000) })), 1_000)
    expect(error?.status).toBe(413)
  })

  it('accepts a body under the cap and returns the parsed value', async () => {
    const { readJsonBody } = await loadGuard('1')
    const { data, error } = await readJsonBody<{ hello: string }>(
      jsonReq(JSON.stringify({ hello: 'world' })),
      1_000,
    )
    expect(error).toBeNull()
    expect(data).toEqual({ hello: 'world' })
  })

  it('preserves multi-byte content that fits, rather than truncating at a chunk edge', async () => {
    const { readJsonBody } = await loadGuard('1')
    const value = '日本語テキスト😀'
    const { data, error } = await readJsonBody<{ v: string }>(
      jsonReq(JSON.stringify({ v: value })),
      1_000,
    )
    expect(error).toBeNull()
    expect(data?.v).toBe(value)
  })

  it('distinguishes an empty body from invalid JSON', async () => {
    const { readJsonBody } = await loadGuard('1')

    const empty = await readJsonBody(jsonReq(''), 1_000)
    expect(empty.error?.status).toBe(400)

    const bad = await readJsonBody(jsonReq('{ not json'), 1_000)
    expect(bad.error?.status).toBe(400)
  })
})
