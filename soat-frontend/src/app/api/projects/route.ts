import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '../../lib/supabase'
import {
  applyCors,
  applyRateLimit,
  corsPreflight,
  readJsonBody,
} from '../../lib/apiGuard'

// ─────────────────────────────────────────────────────────────────────────────
// HARDENING POLICIES
// ─────────────────────────────────────────────────────────────────────────────

const CORS_OPTS = { methods: ['GET', 'POST', 'OPTIONS'] as const } as const

/** Generous bucket: 20 burst, refilling at 2/sec.  Honest UIs hit this once on
 *  successful launch tx; bots that try to spam the projects table get blocked. */
const POST_RATE_LIMIT = {
  name: 'projects-post',
  capacity: 20,
  refillPerSec: 2,
} as const

/** GET is cheap and read-only — much higher cap. */
const GET_RATE_LIMIT = {
  name: 'projects-get',
  capacity: 60,
  refillPerSec: 10,
} as const

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req, CORS_OPTS)
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared payload type — imported by page.tsx for the POST body
// ─────────────────────────────────────────────────────────────────────────────
export interface ProjectPayload {
  txHash:        string
  tokenAddress?: string   // parsed from LaunchCreated event log
  hookAddress?:  string   // parsed from LaunchCreated event log
  name:          string
  symbol:        string
  logoUrl:       string
  website:       string
  twitter:       string
  telegram:      string
  description?:  string
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/projects — insert a new project row after on-chain confirmation
// ─────────────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const limited = applyRateLimit(req, POST_RATE_LIMIT)
  if (limited) return applyCors(limited, req, CORS_OPTS)

  const parsed = await readJsonBody<ProjectPayload>(req)
  if (parsed.error) return applyCors(parsed.error, req, CORS_OPTS)
  const body = parsed.data

  const {
    txHash, tokenAddress, hookAddress,
    name, symbol, logoUrl, website, twitter, telegram, description,
  } = body

  if (!txHash || !name || !symbol) {
    return applyCors(
      NextResponse.json(
        { error: 'txHash, name, and symbol are required' },
        { status: 422 }
      ),
      req,
      CORS_OPTS
    )
  }

  const { data, error } = await supabase
    .from('projects')
    .insert({
      tx_hash:       txHash,
      token_address: tokenAddress ?? null,
      hook_address:  hookAddress  ?? null,
      name,
      symbol,
      logo_url:  logoUrl  || null,
      website:   website  || null,
      twitter:   twitter  || null,
      telegram:  telegram || null,
      description: description?.trim() || null,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return applyCors(
        NextResponse.json({ ok: true, duplicate: true }, { status: 200 }),
        req,
        CORS_OPTS
      )
    }
    console.error('[Tosh API] Supabase insert error:', error)
    return applyCors(
      NextResponse.json({ error: error.message }, { status: 500 }),
      req,
      CORS_OPTS
    )
  }

  console.log('[Tosh API] Project inserted:', data)
  return applyCors(
    NextResponse.json({ ok: true, data }, { status: 200 }),
    req,
    CORS_OPTS
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/projects — return all projects ordered by newest first
// ─────────────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const limited = applyRateLimit(req, GET_RATE_LIMIT)
  if (limited) return applyCors(limited, req, CORS_OPTS)

  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[Tosh API] Supabase select error:', error)
    return applyCors(
      NextResponse.json({ error: error.message }, { status: 500 }),
      req,
      CORS_OPTS
    )
  }

  return applyCors(
    NextResponse.json({ ok: true, data }, { status: 200 }),
    req,
    CORS_OPTS
  )
}
