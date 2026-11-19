/** GET /api/ouroboros/leaderboard?board=l1|l15|l2 — top 20 by shares (L1, L2) or USDT turnover (L1.5). */
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

export async function GET(req: NextRequest) {
  const board = req.nextUrl.searchParams.get('board') ?? ''
  if (!(board in BOARDS)) return NextResponse.json({ error: 'board must be l1, l15 or l2' }, { status: 400 })
  const gated = await ouroReadGate(req)
  if (gated) return gated

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
