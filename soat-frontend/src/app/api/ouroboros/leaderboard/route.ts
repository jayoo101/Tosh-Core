/**
 * GET /api/ouroboros/leaderboard?board=l1|l15|l2|ref — top 20 by shares (L1, L2),
 * USDT turnover (L1.5), or Agent IDs filled through an invite link (ref).
 */
import { NextResponse, type NextRequest } from 'next/server'

import { ouroReadGate } from '@/app/lib/ouroRead'
import { getSupabaseAdmin } from '@/app/lib/supabaseAdmin'
import { dbFailure, ok } from '@/app/lib/v2Read'

const BOARDS = {
  l1: { view: 'ouro_lb_l1', cols: 'account, shares, volume::text, first_block', order: 'shares' },
  l2: { view: 'ouro_lb_l2', cols: 'account, shares, volume::text, first_block', order: 'shares' },
  l15: { view: 'ouro_lb_l15', cols: 'account, fills, volume::text, first_block', order: 'volume' },
} as const

const LIMIT = 20
/** PostgREST caps a response at 1,000 rows. */
const PAGE = 1_000

export interface RefBoardRow { code: string; filled: number; rewarded: string }

/** Invite links ranked by Agent IDs filled, then reward, then the older link. Partner addresses are not exposed. */
async function refBoard(): Promise<RefBoardRow[] | { message: string }> {
  const db = getSupabaseAdmin()
  const filled = new Map<string, number>()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from('ouro_ref_fill_rebates')
      .select('code, tx_hash, log_index')
      .order('tx_hash', { ascending: true }).order('log_index', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) return error
    for (const r of (data ?? []) as { code: string }[]) filled.set(r.code, (filled.get(r.code) ?? 0) + 1)
    if ((data ?? []).length < PAGE) break
  }
  const { data, error } = await db.from('ouro_ref_link_stats').select('code, accrued::text, created_at')
  if (error) return error
  return ((data ?? []) as { code: string; accrued: string; created_at: string }[])
    .filter(r => (filled.get(r.code) ?? 0) > 0)
    .sort((a, b) =>
      (filled.get(b.code)! - filled.get(a.code)!)
      || (BigInt(b.accrued) > BigInt(a.accrued) ? 1 : BigInt(b.accrued) < BigInt(a.accrued) ? -1 : 0)
      || a.created_at.localeCompare(b.created_at))
    .slice(0, LIMIT)
    .map(r => ({ code: r.code, filled: filled.get(r.code)!, rewarded: r.accrued }))
}

export async function GET(req: NextRequest) {
  const board = req.nextUrl.searchParams.get('board') ?? ''
  if (board !== 'ref' && !(board in BOARDS)) {
    return NextResponse.json({ error: 'board must be l1, l15, l2 or ref' }, { status: 400 })
  }
  const gated = await ouroReadGate(req)
  if (gated) return gated

  if (board === 'ref') {
    const rows = await refBoard()
    if (!Array.isArray(rows)) return dbFailure('/api/ouroboros/leaderboard', rows)
    return ok({ board, rows })
  }

  const b = BOARDS[board as keyof typeof BOARDS]
  const { data, error } = await getSupabaseAdmin()
    .from(b.view)
    .select(b.cols)
    .order(b.order, { ascending: false })
    .order('first_block', { ascending: true })
    .order('account', { ascending: true })
    .limit(LIMIT)
  if (error) return dbFailure('/api/ouroboros/leaderboard', error)
  return ok({ board, rows: data ?? [] })
}
