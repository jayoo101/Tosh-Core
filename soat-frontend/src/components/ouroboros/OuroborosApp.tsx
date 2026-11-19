'use client'

import { Panel, Stat, StatGrid } from '@/components/x/Panel'
import { AddressLink, Badge, Button, cn, formatCountdown, useNowSec, useTxAction } from '@/components/ui'
import { useState } from 'react'
import type { Address } from 'viem'
import { useReadContract, useReadContracts } from 'wagmi'

import { TARGET_CHAIN_ID } from '@/lib/contracts'
import { OURO_BIDBOOK_ABI, OURO_MINT_ABI } from '@/lib/ouroboros/abis'
import {
  OURO_BIDBOOK, OURO_ENABLED, OURO_MINT, OURO_PAIR, OURO_TOKEN, OURO_TREASURY, type Phase,
} from '@/lib/ouroboros/config'

import { AgentPanel } from './AgentPanel'
import { BidBookPanel, Field } from './BidBookPanel'
import { ClaimPanel } from './ClaimPanel'
import { useOuroCopy } from './copy'
import { fmtCompact, fmtPrice, openingPrice, parseAmount, poolPrice } from './fmt'
import { LadderTable } from './LadderTable'
import { Leaderboards } from './Leaderboards'
import { MintPanel } from './MintPanel'
import { useOuroState, useOuroUser, type OuroState } from './useOuro'
import { useOuroRef } from './useOuroRef'

const ORDER: Phase[] = ['L1', 'AwaitLaunch', 'L1_5', 'L2']

export function OuroborosApp() {
  const c = useOuroCopy()
  // Up here so a partner link is kept on any visit, before the contracts are
  // configured and in phases that show no mint panel.
  useOuroRef()
  if (!OURO_ENABLED) {
    return (
      <Panel title={c.title}>
        <p className="text-body text-text-secondary">{c.notDeployed}</p>
      </Panel>
    )
  }
  return <Live />
}

function Live() {
  const c = useOuroCopy()
  const { state, refetch } = useOuroState()
  const { address, user, refetch: refetchUser } = useOuroUser()
  const refresh = () => { void refetch(); void refetchUser() }

  const phase = state.phase
  const minting = phase === 'L1' || phase === 'L2'
  const price = poolPrice(state.reserveUsdt, state.reserveToken)

  return (
    <div className="flex flex-col gap-6">
      <Hero state={state} />

      <StatGrid>
        <Stat label={c.statL1Shares} value={state.totalL1Shares.toLocaleString()} />
        <Stat label={c.statL2Minted} value={state.l2Minted.toLocaleString()} sub="/ 21,000,000" />
        <Stat label={c.statPrice} value={state.launched ? fmtPrice(price) : '—'} highlight />
        <Stat label={c.statBurned} value={fmtCompact(state.totalBurned)} />
        <Stat label={c.statSupply} value={fmtCompact(state.supply)} sub="/ 21B" />
      </StatGrid>

      <Timeline phase={phase} />

      <div className="grid gap-6 lg:grid-cols-2">
        {minting && <MintPanel state={state} user={user} address={address} onDone={refresh} />}
        {phase === 'AwaitLaunch' && <LaunchPanel onDone={refresh} />}
        {phase === 'L2' && !state.poolSeeded && <SeedPanel state={state} address={address} onDone={refresh} />}
        {address && <ClaimPanel state={state} user={user} onDone={refresh} />}
        {phase !== 'Pending' && phase !== 'Failed' && <AgentPanel state={state} onDone={refresh} />}
      </div>

      {state.launched && (
        <BidBookPanel open={phase === 'L1_5'} user={user} address={address} onDone={refresh} />
      )}

      <LadderTable minted={Number(state.l2Minted)} />
      <Leaderboards address={address} />
      <Risk />
      <Contracts />
    </div>
  )
}

function Hero({ state }: { state: OuroState }) {
  const c = useOuroCopy()
  const now = useNowSec()
  const p = state.phase
  const countdown =
    p === 'Pending' ? [c.startsIn, state.l1Start - now]
    : p === 'L1' ? [c.endsIn, state.l1End - now]
    : p === 'L1_5' ? [c.l2In, state.l2Start - now]
    : null

  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-hero text-text-primary">{c.title}</h1>
        {p && <Badge tone={p === 'Failed' ? 'danger' : 'info'} pip live={p === 'L1' || p === 'L2'}>{c.phase[p]}</Badge>}
        {state.paused && <Badge tone="warn">{c.paused}</Badge>}
      </div>
      <p className="text-body text-text-secondary">{c.tagline}</p>
      {countdown && now > 0 && (
        <p className="font-mono text-readout text-brand">
          {countdown[0]} {formatCountdown(Number(countdown[1]))}
        </p>
      )}
    </header>
  )
}

function Timeline({ phase }: { phase: Phase | undefined }) {
  const c = useOuroCopy()
  const steps: [Phase, string][] = [['L1', c.tlL1], ['AwaitLaunch', c.tlLaunch], ['L1_5', c.tlL15], ['L2', c.tlL2]]
  const at = phase === 'SoldOut' ? ORDER.length : phase ? ORDER.indexOf(phase) : -1
  return (
    <Panel title={c.timeline}>
      <ol className="grid gap-3 md:grid-cols-4">
        {steps.map(([id, text], i) => (
          <li
            key={id}
            className={cn(
              'rounded-card border px-4 py-3 text-note',
              i === at ? 'border-brand bg-brand/5 text-text-primary'
                : i < at ? 'border-border-subtle text-text-tertiary'
                  : 'border-border-subtle text-text-secondary',
            )}
          >
            {text}
          </li>
        ))}
      </ol>
    </Panel>
  )
}

function LaunchPanel({ onDone }: { onDone: () => void }) {
  const c = useOuroCopy()
  const tx = useTxAction({ action: 'launch', onConfirmed: onDone })
  return (
    <Panel title={c.phase.AwaitLaunch}>
      <p className="text-note text-text-tertiary">{c.tlLaunch}</p>
      <Button
        label={c.launchNow}
        onClick={() => OURO_MINT && tx.send({ address: OURO_MINT, abi: OURO_MINT_ABI, functionName: 'launch' })}
        disabled={tx.isBusy}
      />
    </Panel>
  )
}

/** Matches `OuroborosMint.OPEN_SEED_DELAY`. */
const OPEN_SEED_DELAY_SEC = 3 * 86_400

/**
 * Shown to everyone; the Safe and its signers get the form, and three days
 * into L2 anyone may seed at the L1 price.
 */
function SeedPanel({ state, address, onDone }: { state: OuroState; address: Address | undefined; onDone: () => void }) {
  const c = useOuroCopy()
  const now = useNowSec()
  const tx = useTxAction({ action: 'seedPool', onConfirmed: onDone })
  const seeder = useReadContract({
    address: OURO_MINT, abi: OURO_MINT_ABI, functionName: 'isSeeder', args: address ? [address] : undefined,
    chainId: TARGET_CHAIN_ID, query: { enabled: OURO_MINT !== undefined && address !== undefined },
  })
  const seed = (price: bigint) => OURO_MINT && tx.send({
    address: OURO_MINT, abi: OURO_MINT_ABI, functionName: 'seedPool', args: [price],
  })
  const open = state.l2Start > 0 && now >= state.l2Start + OPEN_SEED_DELAY_SEC
  return (
    <Panel title={c.seedTitle}>
      <p className="text-note text-text-tertiary">{seeder.data ? c.seedNote : open ? c.seedOpenNote : c.awaitSeed}</p>
      {seeder.data === true && <SeedForm busy={tx.isBusy} onSeed={seed} />}
      {seeder.data !== true && open && address && (
        <Button label={c.seedOpenNow} onClick={() => seed(0n)} disabled={tx.isBusy} />
      )}
    </Panel>
  )
}

function SeedForm({ busy, onSeed }: { busy: boolean; onSeed: (price: bigint) => void }) {
  const c = useOuroCopy()
  const terms = useReadContract({
    address: OURO_MINT, abi: OURO_MINT_ABI, functionName: 'seedTerms',
    chainId: TARGET_CHAIN_ID, query: { enabled: OURO_MINT !== undefined },
  })
  const volume = useReadContracts({
    contracts: [
      { address: OURO_BIDBOOK, abi: OURO_BIDBOOK_ABI, functionName: 'filledUsdt', chainId: TARGET_CHAIN_ID },
      { address: OURO_BIDBOOK, abi: OURO_BIDBOOK_ABI, functionName: 'filledTokens', chainId: TARGET_CHAIN_ID },
    ],
    query: { enabled: OURO_BIDBOOK !== undefined },
  })
  const [priceIn, setPriceIn] = useState('')
  if (!terms.data) return null
  const [l1Price, volumeMet] = terms.data
  const filledUsdt = volume.data?.[0].result ?? 0n
  const filledTokens = volume.data?.[1].result ?? 0n
  const vwap = filledTokens === 0n ? 0n : (filledUsdt * 10n ** 18n) / filledTokens
  const requested = priceIn === '' ? (vwap > l1Price ? vwap : l1Price) : parseAmount(priceIn)
  const opening = requested === undefined ? undefined : openingPrice(requested, l1Price, volumeMet)
  return (
    <div className="flex flex-col gap-3">
      <StatGrid>
        <Stat label={c.seedL1Price} value={fmtPrice(l1Price)} />
        <Stat label={c.seedVwap} value={vwap === 0n ? c.nothing : fmtPrice(vwap)} />
        <Stat label={c.seedVolume} value={`${fmtCompact(filledUsdt)} USDT`} />
      </StatGrid>
      <p className="text-note text-text-tertiary">{volumeMet ? c.seedVolumeMet : c.seedVolumeShort}</p>
      <div className="flex flex-wrap items-end gap-3">
        {volumeMet && <Field label={c.seedPriceLabel} value={priceIn} onChange={setPriceIn} />}
        <Button
          label={opening === undefined ? c.seedNow : `${c.seedNow} @ ${fmtPrice(opening)}`}
          onClick={() => requested !== undefined && onSeed(requested)}
          disabled={busy || requested === undefined}
        />
      </div>
    </div>
  )
}

function Risk() {
  const c = useOuroCopy()
  return (
    <Panel title={c.riskTitle}>
      <ul className="list-disc space-y-1 pl-6 text-note text-text-secondary">
        {c.risks.map(r => <li key={r}>{r}</li>)}
      </ul>
    </Panel>
  )
}

function Contracts() {
  const c = useOuroCopy()
  const rows: [string, string | undefined][] = [
    ['OuroborosToken', OURO_TOKEN], ['OuroborosMint', OURO_MINT], ['OuroborosBidBook', OURO_BIDBOOK],
    ['Pancake V2 Pair', OURO_PAIR], ['Treasury (Safe)', OURO_TREASURY],
  ]
  return (
    <Panel title={c.contracts}>
      <dl className="flex flex-col gap-2 text-note">
        {rows.filter(([, a]) => a).map(([k, a]) => (
          <div key={k} className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-text-tertiary">{k}</dt>
            <dd className="font-mono"><AddressLink value={a} display="full" /></dd>
          </div>
        ))}
      </dl>
    </Panel>
  )
}
