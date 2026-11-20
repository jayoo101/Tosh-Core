/**
 * Server side of Ouroboros partner referrals (`src/lib/ouroboros/ref.ts`,
 * `supabase/migrations/0009_ouroboros_referrals.sql`).
 *
 * Every request is a message signed by the caller's wallet. Writes and the
 * full listing need a signer of the treasury Safe; a partner's view is
 * filtered to links paying the signing address.
 */
import {
  getAddress, isAddress, isHex, keccak256, parseAbi, parseEventLogs, stringToHex, type Address, type Hex,
} from 'viem'

import { assertServerChain, serverPublicClient } from '@/app/lib/serverRpc'
import { getSupabaseAdmin } from '@/app/lib/supabaseAdmin'
import { OURO_REF_PAYER, OURO_TREASURY, OURO_USDT } from '@/lib/ouroboros/config'
import {
  isRefCode, MAX_REF_BONUS_WEI, REF_SIG_TTL_MS, refMessage, type RefAction,
} from '@/lib/ouroboros/ref'

const SAFE_ABI = parseAbi(['function isOwner(address owner) view returns (bool)'])
const TRANSFER_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])

export class RefError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const lower = (a: string) => a.toLowerCase()
/** How far ahead of the server's clock a signature may be dated. */
const REF_SIG_MAX_SKEW_MS = 60_000

/** Checks the shape of a request body and returns the action it carries. */
export function parseRefAction(v: unknown): RefAction {
  const r = (v ?? {}) as Record<string, unknown>
  const bonus = (x: unknown) => {
    if (typeof x !== 'string' || !/^[1-9]\d{0,30}$/.test(x) || BigInt(x) > MAX_REF_BONUS_WEI) {
      throw new RefError(422, 'bonus must be a whole number of USDT wei, above 0 and at most 10,000 USDT')
    }
    return x
  }
  const code = (x: unknown) => {
    if (!isRefCode(x)) throw new RefError(422, 'code must be 3 to 16 lowercase letters or digits')
    return x
  }
  const label = (x: unknown) => {
    if (typeof x !== 'string' || x.length > 64) throw new RefError(422, 'label must be at most 64 characters')
    return x
  }
  switch (r.action) {
    case 'list':
    case 'view':
      return { action: r.action }
    case 'apply':
      return { action: 'apply', code: code(r.code), label: label(r.label) }
    case 'approveApplication': {
      if (typeof r.id !== 'number' || !Number.isInteger(r.id) || r.id < 1) {
        throw new RefError(422, 'id must be a positive integer')
      }
      return { action: 'approveApplication', id: r.id, bonus: bonus(r.bonus) }
    }
    case 'rejectApplication': {
      if (typeof r.id !== 'number' || !Number.isInteger(r.id) || r.id < 1) {
        throw new RefError(422, 'id must be a positive integer')
      }
      if (typeof r.reason !== 'string' || r.reason.length > 200) {
        throw new RefError(422, 'reason must be at most 200 characters')
      }
      return { action: 'rejectApplication', id: r.id, reason: r.reason }
    }
    case 'createLink': {
      if (typeof r.partner !== 'string' || !isAddress(r.partner)) throw new RefError(422, 'partner must be an address')
      return { action: 'createLink', code: code(r.code), partner: lower(r.partner), label: label(r.label), bonus: bonus(r.bonus) }
    }
    case 'setBonus':
      return { action: 'setBonus', code: code(r.code), bonus: bonus(r.bonus) }
    case 'recordPayout':
      if (typeof r.txHash !== 'string' || !isHex(r.txHash) || r.txHash.length !== 66) {
        throw new RefError(422, 'txHash must be a transaction hash')
      }
      return { action: 'recordPayout', txHash: lower(r.txHash) }
    case 'approvePayout':
      if (typeof r.maxTotal !== 'string' || !/^[1-9]\d{0,30}$/.test(r.maxTotal)) {
        throw new RefError(422, 'maxTotal must be a positive whole number of USDT wei')
      }
      return { action: 'approvePayout', maxTotal: r.maxTotal }
    default:
      throw new RefError(422, 'unknown action')
  }
}

/** The address that signed `request` at `issuedAt`, or a 401. */
export async function verifyRefSigner(
  request: RefAction, issuedAt: unknown, address: unknown, signature: unknown, now = Date.now(),
): Promise<Address> {
  if (typeof address !== 'string' || !isAddress(address)) throw new RefError(401, 'address missing')
  if (typeof signature !== 'string' || !isHex(signature)) throw new RefError(401, 'signature missing')
  if (
    typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)
    || now - issuedAt > REF_SIG_TTL_MS
  ) {
    throw new RefError(401, 'signature expired; sign again')
  }
  if (issuedAt - now > REF_SIG_MAX_SKEW_MS) {
    throw new RefError(401, 'signature is dated in the future; check this device’s clock')
  }
  const valid = await serverPublicClient().verifyMessage({
    address: getAddress(address), message: refMessage(request, issuedAt), signature: signature as Hex,
  })
  if (!valid) throw new RefError(401, 'signature does not match')
  return getAddress(address)
}

export async function isSafeSigner(account: Address): Promise<boolean> {
  if (!OURO_TREASURY) throw new RefError(503, 'treasury not configured')
  if (!(await assertServerChain())) throw new RefError(503, 'chain endpoint unreachable or on the wrong network; try again')
  return serverPublicClient().readContract({
    address: OURO_TREASURY, abi: SAFE_ABI, functionName: 'isOwner', args: [account],
  })
}

function db() {
  return getSupabaseAdmin()
}

function check(error: { message: string; code?: string } | null, what: string) {
  if (!error) return
  if (error.code === '23505') throw new RefError(409, `${what} already exists`)
  console.error(`[ouroRef] ${what}:`, error.message)
  throw new RefError(503, `${what} unavailable; try again`)
}

export interface RefLink {
  code: string; partner: string; label: string; bonus: string | null; accounts: number; volume: string; accrued: string
}
export interface RefPayout { txHash: string; logIndex: number; partner: string; amount: string; blockNumber: number }
export interface RefPartner { partner: string; accrued: string; paid: string; owed: string }
export interface RefApplication {
  id: number; code: string; partner: string; label: string
  status: 'pending' | 'approved' | 'rejected'
  appliedAt: string; reviewedAt: string | null; rejectReason: string | null
}
export interface RefReport {
  links: RefLink[]; payouts: RefPayout[]; partners: RefPartner[]; applications: RefApplication[]
}

/** PostgREST caps a response at 1,000 rows; reads stay under it a page at a time. */
const PAGE = 500
/** Payouts listed in a report, newest first; balances count all of them. */
export const REPORT_PAYOUTS = 500

type Ranged = PromiseLike<{ data: unknown[] | null; error: { message: string; code?: string } | null }>

/** Every row of a stably ordered query, read a page at a time. */
async function allRows<T>(what: string, page: (from: number, to: number) => Ranged): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    check(error, what)
    const got = (data ?? []) as T[]
    rows.push(...got)
    if (got.length < PAGE) return rows
  }
}

type AppRow = {
  id: number; code: string; partner: string; label: string; status: string
  applied_at: string; reviewed_at: string | null; reject_reason: string | null
}

function mapApplication(r: AppRow): RefApplication {
  return {
    id: r.id, code: r.code, partner: r.partner, label: r.label,
    status: r.status as RefApplication['status'],
    appliedAt: r.applied_at, reviewedAt: r.reviewed_at, rejectReason: r.reject_reason,
  }
}

/** Pending applications (admin), or one wallet's applications (partner). */
export async function listApplications(partner?: string): Promise<RefApplication[]> {
  const who = partner ? lower(partner) : undefined
  let q = db().from('ouro_ref_applications')
    .select('id, code, partner, label, status, applied_at, reviewed_at, reject_reason')
    .order('applied_at', { ascending: false })
  if (who) q = q.eq('partner', who)
  else q = q.eq('status', 'pending')
  const { data, error } = await q.limit(PAGE)
  check(error, 'applications')
  return ((data ?? []) as AppRow[]).map(mapApplication)
}

/** Links, payouts and per-partner balances; every partner when `partner` is undefined. */
export async function refReport(partner?: string): Promise<RefReport> {
  const who = partner ? lower(partner) : undefined
  type LinkRow = { code: string; partner: string; label: string; bonus: string | null; accounts: number; volume: string; accrued: string }
  type PayRow = { tx_hash: string; log_index: number; partner: string; amount: string; block_number: number }
  const links = (from: number, to: number) => {
    const q = db().from('ouro_ref_link_stats')
      .select('code, partner, label, bonus::text, accounts, volume::text, accrued::text')
      .order('created_at', { ascending: true }).order('code', { ascending: true })
    return (who ? q.eq('partner', who) : q).range(from, to)
  }
  // Keyed on the partner rather than an offset, so a row that appears between
  // pages cannot shift a partner onto the next page and list them twice.
  const balances = async () => {
    const rows: RefPartner[] = []
    for (let last = ''; ;) {
      let q = db().from('ouro_ref_partner_balances')
        .select('partner, accrued::text, paid::text, owed::text').order('partner', { ascending: true })
      if (who) q = q.eq('partner', who)
      if (last) q = q.gt('partner', last)
      const { data, error } = await q.limit(PAGE)
      check(error, 'balances')
      const got = (data ?? []) as unknown as RefPartner[]
      rows.push(...got)
      if (got.length < PAGE) return rows
      last = got[got.length - 1].partner
    }
  }
  let payouts = db().from('ouro_ref_payouts')
    .select('tx_hash, log_index, partner, amount::text, block_number')
    .order('block_number', { ascending: false }).order('log_index', { ascending: false })
  if (who) payouts = payouts.eq('partner', who)

  const [linkRows, partners, p, applications] = await Promise.all([
    allRows<LinkRow>('links', links), balances(), payouts.range(0, REPORT_PAYOUTS - 1), listApplications(who),
  ])
  check(p.error, 'payouts')
  const payRows = (p.data ?? []) as unknown as PayRow[]

  return {
    links: linkRows.map(r => ({
      code: r.code, partner: r.partner, label: r.label, bonus: r.bonus,
      accounts: r.accounts, volume: r.volume, accrued: r.accrued,
    })),
    payouts: payRows.map(r => ({
      txHash: r.tx_hash, logIndex: r.log_index, partner: r.partner, amount: r.amount, blockNumber: r.block_number,
    })),
    partners,
    applications,
  }
}

async function headBlock(): Promise<number> {
  return Number(await serverPublicClient().getBlockNumber())
}

export async function createLink(r: Extract<RefAction, { action: 'createLink' }>, by: Address) {
  const { error } = await db().from('ouro_ref_links')
    .insert({ code: r.code, partner: r.partner, label: r.label, created_by: lower(by) })
  check(error, 'link')
  await setBonus({ action: 'setBonus', code: r.code, bonus: r.bonus }, by)
}

/** Wallet applies for a partner invite code; the signer is the payout address. */
export async function applyForLink(r: Extract<RefAction, { action: 'apply' }>, by: Address) {
  const partner = lower(by)
  const { data: link, error: linkErr } = await db().from('ouro_ref_links').select('code').eq('code', r.code).maybeSingle()
  check(linkErr, 'link')
  if (link) throw new RefError(409, `code ${r.code} is already taken`)
  const { error } = await db().from('ouro_ref_applications').insert({
    code: r.code, partner, label: r.label, status: 'pending',
  })
  check(error, 'application')
}

/** Approves a pending application and opens the link at the signed bonus. */
export async function approveApplication(r: Extract<RefAction, { action: 'approveApplication' }>, by: Address) {
  const { data, error } = await db().from('ouro_ref_applications')
    .select('id, code, partner, label, status')
    .eq('id', r.id).maybeSingle()
  check(error, 'application')
  if (!data) throw new RefError(404, `no application ${r.id}`)
  const row = data as { id: number; code: string; partner: string; label: string; status: string }
  if (row.status !== 'pending') throw new RefError(409, `application ${r.id} is ${row.status}`)
  await createLink(
    { action: 'createLink', code: row.code, partner: row.partner, label: row.label, bonus: r.bonus },
    by,
  )
  const { error: updErr } = await db().from('ouro_ref_applications').update({
    status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: lower(by), reject_reason: null,
  }).eq('id', r.id).eq('status', 'pending')
  check(updErr, 'application')
}

export async function rejectApplication(r: Extract<RefAction, { action: 'rejectApplication' }>, by: Address) {
  const { data, error } = await db().from('ouro_ref_applications')
    .select('id, status').eq('id', r.id).maybeSingle()
  check(error, 'application')
  if (!data) throw new RefError(404, `no application ${r.id}`)
  if ((data as { status: string }).status !== 'pending') {
    throw new RefError(409, `application ${r.id} is ${(data as { status: string }).status}`)
  }
  const { error: updErr } = await db().from('ouro_ref_applications').update({
    status: 'rejected',
    reviewed_at: new Date().toISOString(),
    reviewed_by: lower(by),
    reject_reason: r.reason.trim() || null,
  }).eq('id', r.id).eq('status', 'pending')
  check(updErr, 'application')
}

/** Sets the amount paid for each Agent ID that fills, from the current block on. */
export async function setBonus(r: Extract<RefAction, { action: 'setBonus' }>, by: Address) {
  const { data, error } = await db().from('ouro_ref_links').select('code').eq('code', r.code).maybeSingle()
  check(error, 'link')
  if (!data) throw new RefError(404, `no link ${r.code}`)
  const { error: insertError } = await db().from('ouro_ref_bonuses')
    .insert({ code: r.code, amount: r.bonus, effective_block: await headBlock(), set_by: lower(by) })
  check(insertError, 'bonus')
}

export interface UsdtTransfer { txHash: string; logIndex: number; to: string; value: bigint; blockNumber: bigint }

/** Stores the transfers that pay a registered partner as payouts; returns how many did. */
export async function storePartnerPayouts(transfers: UsdtTransfer[], by: string): Promise<number> {
  if (transfers.length === 0) return 0
  const recipients = [...new Set(transfers.map(t => lower(t.to)))]
  const { data, error } = await db().from('ouro_ref_links').select('partner').in('partner', recipients)
  check(error, 'links')
  const partners = new Set(((data ?? []) as { partner: string }[]).map(p => p.partner))
  const rows = transfers.filter(t => partners.has(lower(t.to))).map(t => ({
    tx_hash: lower(t.txHash), log_index: t.logIndex, partner: lower(t.to), amount: t.value.toString(),
    block_number: Number(t.blockNumber), recorded_by: lower(by),
  }))
  if (rows.length === 0) return 0
  const { error: upsertError } = await db().from('ouro_ref_payouts')
    .upsert(rows, { onConflict: 'tx_hash,log_index', ignoreDuplicates: true })
  check(upsertError, 'payout')
  return rows.length
}

/**
 * Records the USDT transfers to partners in `txHash` from the payout Safe or
 * the treasury, with amounts read from the receipt. The indexer records the
 * payout Safe's on its own; this is for anything it has not seen.
 */
export async function recordPayout(r: Extract<RefAction, { action: 'recordPayout' }>, by: Address): Promise<number> {
  const sources = [OURO_REF_PAYER, OURO_TREASURY].filter((a): a is Address => a !== undefined).map(lower)
  if (sources.length === 0 || !OURO_USDT) throw new RefError(503, 'payout Safe not configured')
  const receipt = await serverPublicClient()
    .getTransactionReceipt({ hash: r.txHash as Hex })
    .catch(() => { throw new RefError(404, 'transaction not found or not yet mined') })
  if (receipt.status !== 'success') throw new RefError(422, 'transaction reverted')

  const transfers = parseEventLogs({
    abi: TRANSFER_ABI, eventName: 'Transfer',
    logs: receipt.logs.filter(l => lower(l.address) === lower(OURO_USDT!)),
  }).filter(l => sources.includes(lower(l.args.from)))
  if (transfers.length === 0) throw new RefError(422, 'no USDT transfer from the payout Safe or treasury in this transaction')
  const stored = await storePartnerPayouts(transfers.map(l => ({
    txHash: l.transactionHash, logIndex: l.logIndex, to: l.args.to, value: l.args.value, blockNumber: l.blockNumber,
  })), by)
  if (stored === 0) throw new RefError(422, 'no registered partner was paid in this transaction')
  return stored
}

const APPROVAL_TTL_MS = 24 * 3_600_000

/** Keyed on the signed message, so replaying a request inserts nothing. */
export async function approvePayout(r: Extract<RefAction, { action: 'approvePayout' }>, by: Address, issuedAt: number) {
  const { error } = await db().from('ouro_ref_approvals').insert({
    max_total: r.maxTotal, approved_by: lower(by), expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    sig_hash: keccak256(stringToHex(`${lower(by)}\n${refMessage(r, issuedAt)}`)),
  })
  check(error, 'approval')
}

/** Whether `code` is a registered link, for the page to decide whether to tag mints with it. */
export async function linkExists(code: string): Promise<boolean> {
  const { data, error } = await db().from('ouro_ref_links').select('code').eq('code', code).maybeSingle()
  check(error, 'link')
  return data !== null
}
