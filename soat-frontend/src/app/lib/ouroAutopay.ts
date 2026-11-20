/**
 * Automatic partner rebate payouts, run every minute by `/api/ouroboros/ref/autopay`.
 *
 * The payer is a hot wallet (`OURO_REF_PAYER_KEY`, address
 * `NEXT_PUBLIC_OURO_REF_PAYER`) topped up from the treasury; what it can lose
 * is what it holds. A run pays every partner owed at least 5 USDT, one
 * transfer at a time, within the caps of `AUTOPAY_LIMITS`; above them it
 * waits for a Safe signer's approval. Each transfer is written to
 * `ouro_ref_pending` the moment it is sent and becomes a payout once its
 * receipt is stored, so no later run pays it twice, even after the wallet is
 * swapped. `OURO_REF_AUTOPAY=1` turns runs on; anything else stops them.
 *
 * Swapping the wallet: set both payer variables to the new one and redeploy,
 * then sweep the old one back to the treasury. A key that does not match the
 * address stops runs rather than paying from the wrong wallet.
 */
import {
  createWalletClient, encodeFunctionData, erc20Abi, getAddress, http, isHex, keccak256, parseEventLogs,
  TransactionNotFoundError, TransactionReceiptNotFoundError, type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { refReport, storePartnerPayouts } from '@/app/lib/ouroRef'
import { serverPublicClient, serverRpcUrl } from '@/app/lib/serverRpc'
import { getSupabaseAdmin } from '@/app/lib/supabaseAdmin'
import { targetChain } from '@/lib/chain'
import { planPayouts } from '@/lib/ouroboros/autopayPlan'
import { OURO_REF_PAYER, OURO_USDT } from '@/lib/ouroboros/config'
import { ouroIndexStaleness } from '@/app/lib/ouroIndexer'

/** Twice the route's `maxDuration`, so a run never outlives its lock. */
const LOCK_SECONDS = 600
const RECEIPT_TIMEOUT_MS = 30_000
/**
 * A transfer with no receipt after this long was dropped or replaced if its
 * nonce is used, and never broadcast if the node does not know it.
 */
const DROPPED_AFTER_MS = 10 * 60_000

export type AutopayStatus = 'disabled' | 'busy' | 'idle' | 'waiting' | 'held' | 'short' | 'paid' | 'failed'
export interface AutopayResult { status: AutopayStatus; detail: string; paid?: number }

const lower = (a: string) => a.toLowerCase()
const usdt = (wei: bigint) => `${(Number(wei / 10n ** 14n) / 10_000).toLocaleString('en-US')} USDT`

/** RPC errors quote the endpoint, and an endpoint URL can carry its API key. */
const redact = (s: string) => s.replace(/\b(?:https?|wss?):\/\/\S+/gi, '<rpc>')

function db() {
  return getSupabaseAdmin()
}

function payer() {
  const key = process.env.OURO_REF_PAYER_KEY?.trim()
  if (!key || !isHex(key) || key.length !== 66) throw new Error('OURO_REF_PAYER_KEY is unset or malformed')
  if (!OURO_REF_PAYER || !OURO_USDT) throw new Error('NEXT_PUBLIC_OURO_REF_PAYER or the USDT address is unset')
  const account = privateKeyToAccount(key as Hex)
  if (lower(account.address) !== lower(OURO_REF_PAYER)) {
    throw new Error('OURO_REF_PAYER_KEY does not belong to NEXT_PUBLIC_OURO_REF_PAYER')
  }
  return { account, wallet: createWalletClient({ account, chain: targetChain, transport: http(serverRpcUrl()) }) }
}

/** Stores the partner transfers `from` made in a mined receipt. */
async function storeReceipt(hash: Hex, from: string): Promise<'success' | 'reverted' | null> {
  // Only the node answering "not found" means not mined; any other error
  // aborts the run rather than make a mined transfer look dropped.
  const receipt = await serverPublicClient().getTransactionReceipt({ hash }).catch((err: unknown) => {
    if (err instanceof TransactionReceiptNotFoundError) return null
    throw err
  })
  if (!receipt) return null
  if (receipt.status === 'success') {
    const transfers = parseEventLogs({
      abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs.filter(l => lower(l.address) === lower(OURO_USDT!)),
    }).filter(l => lower(l.args.from) === lower(from))
    await storePartnerPayouts(transfers.map(l => ({
      txHash: l.transactionHash, logIndex: l.logIndex, to: l.args.to, value: l.args.value, blockNumber: l.blockNumber,
    })), 'autopay')
  }
  const { error } = await db().from('ouro_ref_pending').delete().eq('tx_hash', lower(hash))
  if (error) throw new Error(`pending delete: ${error.message}`)
  return receipt.status
}

/** Settles transfers earlier runs sent; false while any is still unresolved. */
async function resolvePending(): Promise<boolean> {
  const { data, error } = await db().from('ouro_ref_pending').select('tx_hash, payer, nonce, created_at')
  if (error) throw new Error(`pending read: ${error.message}`)
  const rows = (data ?? []) as { tx_hash: string; payer: string; nonce: number; created_at: string }[]
  let clear = true
  for (const r of rows) {
    if ((await storeReceipt(r.tx_hash as Hex, r.payer)) !== null) continue
    const used = await serverPublicClient().getTransactionCount({ address: r.payer as Hex, blockTag: 'latest' })
    const old = Date.now() - Date.parse(r.created_at) > DROPPED_AFTER_MS
    const known = await serverPublicClient().getTransaction({ hash: r.tx_hash as Hex }).then(() => true, (err: unknown) => {
      if (err instanceof TransactionNotFoundError) return false
      throw err
    })
    if (old && (r.nonce < used || !known)) {
      await db().from('ouro_ref_pending').delete().eq('tx_hash', r.tx_hash)
      continue
    }
    clear = false
  }
  return clear
}

async function approval(): Promise<{ id: number; maxTotal: bigint } | null> {
  const { data, error } = await db().from('ouro_ref_approvals')
    .select('id, max_total::text')
    .is('used_at', null).gt('expires_at', new Date().toISOString())
    .order('approved_at', { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error(`approval read: ${error.message}`)
  const row = data as { id: number; max_total: string } | null
  return row ? { id: row.id, maxTotal: BigInt(row.max_total) } : null
}

async function pay(): Promise<AutopayResult> {
  const { account, wallet } = payer()
  if (!(await resolvePending())) return { status: 'waiting', detail: 'an earlier transfer is not yet mined' }
  // A transfer given up as dropped that mines after all is recorded by the
  // index from the payer's transfers; until the index is current, it would be paid again.
  const stale = await ouroIndexStaleness()
  if (stale) return { status: 'waiting', detail: `the index is not current (${stale})` }

  const report = await refReport()
  const approved = await approval()
  const plan = planPayouts(
    report.partners.map(p => ({ partner: p.partner, owed: BigInt(p.owed) })), new Map(), approved?.maxTotal ?? null,
  )
  if (plan.kind === 'idle') return { status: 'idle', detail: 'nothing owed above the minimum' }
  if (plan.kind === 'held') {
    return { status: 'held', detail: `${usdt(plan.total)} to ${plan.items.length} partners exceeds the caps; awaiting approval` }
  }

  const client = serverPublicClient()
  const balance = await client.readContract({ address: OURO_USDT!, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })
  if (balance < plan.total) {
    return { status: 'short', detail: `payer holds ${usdt(balance)}, owes ${usdt(plan.total)}; top it up from the treasury` }
  }
  let paid = 0
  for (const item of plan.items) {
    // Recorded under its hash before it is broadcast, so a crash in between
    // leaves a row the next run resolves rather than a transfer it repays.
    const nonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' })
    const request = await wallet.prepareTransactionRequest({
      to: OURO_USDT!, nonce,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(item.partner), item.amount] }),
    })
    const signed = await wallet.signTransaction(request)
    const hash = keccak256(signed)
    const { error } = await db().from('ouro_ref_pending')
      .insert({ tx_hash: lower(hash), payer: lower(account.address), partner: item.partner, amount: item.amount.toString(), nonce })
    if (error) throw new Error(`pending insert for ${hash}: ${error.message}`)
    // A send error can still mean it went out, so the row stays until resolved.
    await wallet.sendRawTransaction({ serializedTransaction: signed })
    // Spent by the first transfer it lets out, not before: a run that fails
    // ahead of that leaves it for the next.
    if (item === plan.items[0] && plan.usesApproval && approved) {
      const { error } = await db().from('ouro_ref_approvals').update({ used_at: new Date().toISOString() }).eq('id', approved.id)
      if (error) throw new Error(`approval update: ${error.message}`)
    }
    await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS }).catch(() => null)
    const status = await storeReceipt(hash, account.address)
    if (status === null) return { status: 'waiting', detail: `${hash} not yet mined`, paid }
    if (status === 'reverted') return { status: 'failed', detail: `${hash} reverted`, paid }
    paid++
  }
  return { status: 'paid', detail: `${usdt(plan.total)} to ${paid} partners`, paid }
}

export async function runAutopay(): Promise<AutopayResult> {
  if (process.env.OURO_REF_AUTOPAY !== '1') return { status: 'disabled', detail: 'OURO_REF_AUTOPAY is not 1' }
  const { data: token, error } = await db().rpc('ouro_ref_try_lock', { seconds: LOCK_SECONDS })
  if (error) throw new Error(`lock: ${error.message}`)
  if (!token) return { status: 'busy', detail: 'another run holds the lock' }

  let result: AutopayResult
  try {
    result = await pay()
  } catch (err) {
    result = { status: 'failed', detail: redact(err instanceof Error ? err.message : String(err)) }
  }
  // Released only while still ours: a run that overstayed must not free a later run's lock.
  await db().from('ouro_ref_autopay').update({
    locked_until: new Date().toISOString(), last_run_at: new Date().toISOString(),
    last_status: result.status, last_detail: result.detail.slice(0, 500),
  }).eq('id', 1).eq('locked_until', token as string)
  return result
}

export async function autopayState() {
  const { data, error } = await db().from('ouro_ref_autopay').select('last_run_at, last_status, last_detail').eq('id', 1).maybeSingle()
  if (error) throw new Error(`autopay read: ${error.message}`)
  const row = data as { last_run_at: string | null; last_status: string | null; last_detail: string | null } | null
  return {
    enabled: process.env.OURO_REF_AUTOPAY === '1',
    lastRunAt: row?.last_run_at ?? null, lastStatus: row?.last_status ?? null, lastDetail: row?.last_detail ?? null,
  }
}
