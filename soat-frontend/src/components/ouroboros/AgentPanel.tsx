'use client'

import { useState } from 'react'
import { erc20Abi } from 'viem'
import { useReadContract } from 'wagmi'

import { Panel, Row } from '@/components/x/Panel'
import { useNowSec } from '@/components/ui'
import { fill } from '@/i18n'
import { AgentAddressField, AgentModeSheet, useAgentAddress, type AgentStep } from '@/components/v2/AgentModeSheet'
import { NATIVE_SYMBOL } from '@/lib/chain'
import { TARGET_CHAIN_ID } from '@/lib/contracts'
import { OURO_MINT_ABI } from '@/lib/ouroboros/abis'
import { L1_PRICE, L2_TOTAL_SHARES, MAX_SHARES, OURO_MINT, OURO_USDT } from '@/lib/ouroboros/config'

import { useOuroCopy } from './copy'
import { fmt, fmtCompact } from './fmt'
import { l2PoolCap, useOuroUser, type OuroState } from './useOuro'
import { L2_MAX_PAY_BPS } from './MintPanel'
import { useOuroRef } from './useOuroRef'
import { PayToggle, SharesInput } from './SharesInput'

const BNB_BUFFER_BPS = 50n
/** Prepared before the open, the quote has hours to move; the contract refunds what it does not spend. */
const BNB_EARLY_BUFFER_BPS = 500n
const L2_SLIPPAGE_BPS = 100n

/**
 * Agent mode: most Agent IDs sit in a Binance Agentic Wallet, which cannot
 * connect to a site. This builds the exact calls that wallet must send —
 * approve and mint, or claim — for the address entered here.
 */
export function AgentPanel({ state, onDone }: { state: OuroState; onDone: () => void }) {
  const c = useOuroCopy()
  const agent = useAgentAddress()
  const { user, refetch } = useOuroUser(agent)
  const now = useNowSec()
  const [shares, setShares] = useState(1)
  const [payBnb, setPayBnb] = useState(false)
  const ref = useOuroRef()
  const done = () => { void refetch(); onDone() }

  const isL2 = state.phase === 'L2'
  // Before L1 the L1 mint can be prepared, not sent.
  const early = state.phase === 'Pending'
  const minting = state.phase === 'L1' || isL2 || early
  const pay = payBnb
  const opensAt = `${new Date(state.l1Start * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16)} (UTC+8)`
  const soldLeft = Number(L2_TOTAL_SHARES - state.l2Minted)
  const poolCap = isL2 ? l2PoolCap(state) : MAX_SHARES
  // Without an address the quota is unknown; the instruction has the wallet check it before sending.
  const quota = agent ? user.remaining : MAX_SHARES
  const max = Math.max(0, Math.min(MAX_SHARES, quota, isL2 ? soldLeft : MAX_SHARES, poolCap))
  const n = Math.min(Math.max(shares, 1), Math.max(max, 1))

  const { data: l2Quote } = useReadContract({
    address: OURO_MINT, abi: OURO_MINT_ABI, functionName: 'quoteL2', args: [BigInt(n)], chainId: TARGET_CHAIN_ID,
    query: { enabled: isL2, refetchInterval: 6_000 },
  })
  const cost = isL2 ? (l2Quote?.[0] ?? 0n) : L1_PRICE * BigInt(n)
  const tokens = l2Quote?.[1] ?? 0n
  const maxPay = isL2 ? cost + (cost * L2_MAX_PAY_BPS) / 10_000n : cost
  // Quoted on the most the mint may cost; the contract refunds the BNB it does not spend.
  const { data: bnbQuote } = useReadContract({
    address: OURO_MINT, abi: OURO_MINT_ABI, functionName: 'quoteBnb', args: [maxPay], chainId: TARGET_CHAIN_ID,
    query: { enabled: pay && cost > 0n, refetchInterval: 6_000 },
  })
  const buffer = early ? BNB_EARLY_BUFFER_BPS : BNB_BUFFER_BPS
  const bnbValue = bnbQuote === undefined ? undefined : bnbQuote + (bnbQuote * buffer) / 10_000n

  const mintSteps = ((): AgentStep[] | null => {
    if (!OURO_MINT || !OURO_USDT || max === 0 || cost === 0n) return null
    if (isL2 && tokens === 0n) return null
    if (pay && bnbValue === undefined) return null
    const minTokens = (tokens * (10_000n - L2_SLIPPAGE_BPS)) / 10_000n
    const call: AgentStep = isL2
      ? { note: `${c.mint} ${n} · L2`, to: OURO_MINT, abi: OURO_MINT_ABI, functionName: 'mintL2',
          args: [BigInt(n), maxPay, minTokens, ref.ref], value: pay ? bnbValue : undefined }
      : { note: `${c.mint} ${n} · L1`, to: OURO_MINT, abi: OURO_MINT_ABI, functionName: 'mintL1',
          args: [BigInt(n), cost, ref.ref], value: pay ? bnbValue : undefined }
    if (pay) return [call]
    return [
      { note: `${c.approve} ${fmt(maxPay)}`, to: OURO_USDT, abi: erc20Abi, functionName: 'approve', args: [OURO_MINT, maxPay] },
      call,
    ]
  })()

  const unlocked = now >= user.unlockAt
  const vestClaimable = user.vestClaimable + (unlocked ? user.vestLocked : 0n)
  const claimSteps: AgentStep[] = []
  if (OURO_MINT && state.launched && !user.l1Claimed && user.l1Tokens > 0n) {
    claimSteps.push({ note: c.claimL1, to: OURO_MINT, abi: OURO_MINT_ABI, functionName: 'claimL1' })
  }
  if (OURO_MINT && vestClaimable > 0n) {
    claimSteps.push({ note: c.claim, to: OURO_MINT, abi: OURO_MINT_ABI, functionName: 'claim' })
  }

  return (
    <Panel title={c.agentTitle}>
      <p className="text-note text-text-tertiary">{c.agentIntro}</p>
      <AgentAddressField label={c.agentAddress} hint={c.agentAddressHint} invalidHint={c.agentAddressBad} />
      {agent && (
        <dl className="flex flex-col gap-2 text-note">
          <Row k={c.remaining} v={`${user.remaining} / ${MAX_SHARES}`} />
          {user.l1Shares > 0n && <Row k={c.l1Claim} v={user.l1Claimed ? c.l1Claimed : fmtCompact(user.l1Tokens)} />}
          <Row k={c.vestClaimable} v={vestClaimable > 0n ? fmtCompact(vestClaimable) : c.nothing} />
        </dl>
      )}

      {early && <p className="text-note text-warning">{fill(c.agentEarly, { time: opensAt })}</p>}

      {minting && (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <SharesInput label={c.shares} value={n} max={max} onChange={setShares} />
            <PayToggle label={c.payWith} bnb={payBnb} onChange={setPayBnb} />
          </div>
          <dl className="text-note">
            <Row k={c.cost} v={pay ? (bnbValue === undefined ? '…' : `${fmt(bnbValue, 6)} ${NATIVE_SYMBOL}`) : `${fmt(cost)} USDT`} strong />
          </dl>
          <AgentModeSheet
            title={`${c.mint} ${n}`}
            summary={c.agentMintSummary}
            steps={mintSteps}
            pending={state.paused ? c.paused : isL2 && !state.poolSeeded ? c.awaitSeed : poolCap === 0 ? c.poolTooThin : max === 0 ? c.noAgent : undefined}
            addressField={false}
            notes={[
              ...(agent ? [] : [fill(c.agentQuotaInstr, { mint: OURO_MINT ?? '', n: String(n) })]),
              ...(early ? [fill(c.agentEarlyInstr, { time: opensAt, ts: state.l1Start }) + (pay ? '' : c.agentEarlyApprove)] : []),
              ...(ref.code ? [c.agentRefNote] : []),
            ]}
            onDone={done}
          />
        </div>
      )}

      {agent && claimSteps.length > 0 && (
        <AgentModeSheet title={c.claimTitle} openLabel={c.claimTitle} steps={claimSteps} addressField={false} onDone={done} />
      )}
    </Panel>
  )
}
