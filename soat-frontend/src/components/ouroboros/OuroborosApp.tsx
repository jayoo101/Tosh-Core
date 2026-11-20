'use client'

import { useState, useSyncExternalStore, type ComponentType } from 'react'
import {
  BarChart3,
  BookOpen,
  Check,
  Cpu,
  Flame,
  ShieldAlert,
  Trophy,
  Wallet,
  Zap,
} from 'lucide-react'
import type { Address } from 'viem'
import { useReadContract, useReadContracts } from 'wagmi'

import { Bar, Panel, Stat, StatGrid } from '@/components/x/Panel'
import { AddressLink, Badge, Button, cn, useNowSec, useTxAction } from '@/components/ui'
import { TARGET_CHAIN_ID } from '@/lib/contracts'
import { OURO_BIDBOOK_ABI, OURO_MINT_ABI } from '@/lib/ouroboros/abis'
import {
  L2_TOTAL_SHARES,
  OURO_BIDBOOK,
  OURO_ENABLED,
  OURO_MINT,
  OURO_PAIR,
  OURO_TOKEN,
  OURO_TREASURY,
  type Phase,
} from '@/lib/ouroboros/config'

import { AgentPanel } from './AgentPanel'
import { BidBookPanel, Field } from './BidBookPanel'
import { ClaimPanel } from './ClaimPanel'
import { useOuroCopy } from './copy'
import { Countdown, CountdownClock } from './Countdown'
import { fmtCompact, fmtPrice, openingPrice, parseAmount, poolPrice } from './fmt'
import { LadderTable } from './LadderTable'
import { Leaderboards } from './Leaderboards'
import { MintAnatomy } from './MintAnatomy'
import { MintPanel } from './MintPanel'
import { OuroborosMark } from './OuroborosMark'
import { FlywheelMini } from './PriceFlywheel'
import { useOuroState, useOuroUser, type OuroState } from './useOuro'
import { useOuroRef } from './useOuroRef'

const ORDER: Phase[] = ['L1', 'AwaitLaunch', 'L1_5', 'L2']
type MintMode = 'wallet' | 'agent'
type ExplorerTab = 'anatomy' | 'ladder' | 'book' | 'boards' | 'contracts'

const noopSubscribe = () => () => {}
const readUrlMode = (): MintMode =>
  new URLSearchParams(window.location.search).get('mode') === 'agent' ? 'agent' : 'wallet'

const L2_SCHEDULE_SEC = Math.floor(Date.UTC(2026, 10, 20, 12, 0, 0) / 1000)

export function OuroborosApp() {
  useOuroRef()
  if (!OURO_ENABLED) return <Preview />
  return <Live />
}

function Preview() {
  const c = useOuroCopy()
  const { address, user, refetch: refetchUser } = useOuroUser()
  const [tab, setTab] = useState<'anatomy' | 'ladder' | 'boards' | 'contracts'>('anatomy')

  return (
    <div className="flex flex-col gap-8">
      <header className="glow-frame glow-flow relative isolate overflow-hidden rounded-panel bg-surface-card/85">
        <div aria-hidden="true" className="hero-grid pointer-events-none absolute inset-0 -z-10" />
        <div className="flex flex-col gap-8 p-6 md:p-10 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2.5">
              <Badge tone="info" pip live>{c.phase.L1_5}</Badge>
            </div>
            <div className="flex items-center gap-4">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-card border border-brand/35 bg-brand/10 text-brand shadow-[0_0_18px_-4px_var(--tosh-brand)]">
                <OuroborosMark className="size-8" />
              </span>
              <h1 className="font-mono text-hero text-text-primary">{c.title}</h1>
            </div>
            <p className="max-w-xl text-pretty text-lede text-text-secondary">{c.tagline}</p>
          </div>
          <CountdownClock label={c.l2In} targetSec={L2_SCHEDULE_SEC} className="shrink-0" />
        </div>

        <ol className="grid grid-cols-2 border-t border-border-subtle bg-bg-subtle/50 lg:grid-cols-4">
          {c.pipelineSteps.map((step, i) => {
            const done = i < 2
            const current = i === 2
            return (
              <li
                key={step.id}
                className={cn(
                  'flex items-center gap-3 border-border-subtle px-5 py-4 md:px-6',
                  i % 2 === 1 && 'border-l',
                  i >= 2 && 'border-t lg:border-t-0',
                  i === 2 && 'lg:border-l',
                  current && 'bg-brand/10',
                )}
              >
                <span
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-pill border font-mono text-micro font-bold',
                    current
                      ? 'border-brand bg-brand text-bg-base'
                      : done
                        ? 'border-brand/60 text-brand'
                        : 'border-border-subtle text-text-tertiary',
                  )}
                >
                  {done ? <Check className="size-3.5" aria-hidden /> : step.tag}
                </span>
                <div className="flex min-w-0 flex-col">
                  <span className={cn('font-mono text-note font-bold', current ? 'text-brand' : 'text-text-primary')}>
                    {step.name}
                  </span>
                  <span className="text-micro text-text-tertiary">{step.brief}</span>
                </div>
              </li>
            )
          })}
        </ol>
      </header>

      <StatGrid>
        <Stat label={c.statL1Shares} value="—" />
        <Stat label={c.statL2Minted} value="0" sub="/ 21M">
          <Bar pct={0} label={c.statL2Minted} />
        </Stat>
        <Stat label={c.statL1Price} value="—" highlight />
        <Stat
          label={(
            <span className="inline-flex items-center gap-1.5 text-warning">
              <Flame className="size-3.5" aria-hidden />
              {c.statBurned}
            </span>
          )}
          value="0"
        />
        <Stat label={c.statSupply} value="21B" sub="/ 21B" />
      </StatGrid>

      <BidBookPanel open user={user} address={address} onDone={() => { void refetchUser() }} />

      <section className="glow-frame flex flex-col gap-7 rounded-panel bg-surface-card/85 p-6 md:p-8">
        <div role="tablist" aria-label={c.title} className="flex gap-2 overflow-x-auto border-b border-border-subtle pb-5 [scrollbar-width:none]">
          {([
            ['anatomy', c.explorerTabs.anatomy, Zap],
            ['ladder', c.explorerTabs.ladder, BarChart3],
            ['boards', c.explorerTabs.boards, Trophy],
            ['contracts', c.explorerTabs.contracts, ShieldAlert],
          ] as const).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                'inline-flex shrink-0 items-center gap-2 rounded-pill border px-4 py-2 font-mono text-note font-bold transition-colors',
                tab === id
                  ? 'border-brand bg-brand/15 text-brand'
                  : 'border-border-subtle text-text-secondary hover:border-border-strong hover:text-text-primary',
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              {label}
            </button>
          ))}
        </div>

        {tab === 'anatomy' && <MintAnatomy />}
        {tab === 'ladder' && <LadderTable minted={0} embedded />}
        {tab === 'boards' && <Leaderboards address={address} embedded />}
        {tab === 'contracts' && (
          <div className="grid gap-8 lg:grid-cols-2">
            <Contracts embedded />
            <Risk embedded />
          </div>
        )}
      </section>
    </div>
  )
}

function Live() {
  const c = useOuroCopy()
  const { state, refetch } = useOuroState()
  const { address, user, refetch: refetchUser } = useOuroUser()
  const refresh = () => { void refetch(); void refetchUser() }

  const urlMode = useSyncExternalStore(noopSubscribe, readUrlMode, (): MintMode => 'wallet')
  const [pickedMode, setPickedMode] = useState<MintMode | null>(null)
  const mintMode = pickedMode ?? urlMode
  const setMintMode = (m: MintMode) => setPickedMode(m)
  const [explorerTab, setExplorerTab] = useState<ExplorerTab>('anatomy')

  const phase = state.phase
  const minting = phase === 'L1' || phase === 'L2'
  const inL15 = phase === 'L1_5'
  const pool = poolPrice(state.reserveUsdt, state.reserveToken)
  const { data: terms } = useReadContract({
    address: OURO_MINT,
    abi: OURO_MINT_ABI,
    functionName: 'seedTerms',
    chainId: TARGET_CHAIN_ID,
    query: { enabled: state.launched && !state.poolSeeded, refetchInterval: 30_000 },
  })
  const l1Price = terms?.[0]
  const priceLabel = state.poolSeeded ? c.statPrice : c.statL1Price
  const priceValue = state.poolSeeded
    ? pool
    : l1Price !== undefined
      ? l1Price
      : 0n

  const l2Pct = Number((state.l2Minted * 10_000n) / L2_TOTAL_SHARES) / 100
  const phaseTip = c.phaseGuide[phase ?? 'Pending'][0]

  const openExplorer = (tab: ExplorerTab) => {
    setExplorerTab(tab)
    const el = document.getElementById('ouro-explorer')
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const tabs: { id: ExplorerTab; label: string; icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }> }[] = [
    { id: 'anatomy', label: c.explorerTabs.anatomy, icon: Zap },
    { id: 'ladder', label: c.explorerTabs.ladder, icon: BarChart3 },
    ...(!inL15 ? [{ id: 'book' as const, label: c.explorerTabs.book, icon: BookOpen }] : []),
    { id: 'boards', label: c.explorerTabs.boards, icon: Trophy },
    { id: 'contracts', label: c.explorerTabs.contracts, icon: ShieldAlert },
  ]

  const activeTab: ExplorerTab = inL15 && explorerTab === 'book' ? 'anatomy' : explorerTab

  return (
    <div className="flex flex-col gap-8">
      <Hero state={state} />

      <StatGrid>
        <Stat label={c.statL1Shares} value={state.totalL1Shares.toLocaleString()} />
        <Stat label={c.statL2Minted} value={state.l2Minted.toLocaleString()} sub="/ 21M">
          <Bar pct={l2Pct} label={c.statL2Minted} />
        </Stat>
        <Stat label={priceLabel} value={state.launched ? fmtPrice(priceValue) : '—'} highlight />
        <Stat
          label={(
            <span className="inline-flex items-center gap-1.5 text-warning">
              <Flame className="size-3.5" aria-hidden />
              {c.statBurned}
            </span>
          )}
          value={fmtCompact(state.totalBurned)}
        />
        <Stat label={c.statSupply} value={fmtCompact(state.supply)} sub="/ 21B" />
      </StatGrid>

      {inL15 && (
        <BidBookPanel open user={user} address={address} onDone={refresh} />
      )}

      {state.launched && !inL15 && (
        <BidBookPanel open={false} user={user} address={address} onDone={refresh} />
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          {phase === 'AwaitLaunch' && <LaunchPanel onDone={refresh} />}
          {phase === 'L2' && !state.poolSeeded && <SeedPanel state={state} address={address} onDone={refresh} />}

          {phase !== 'Failed' && (
            <section className="glow-frame flex flex-col gap-6 rounded-panel bg-surface-card/85 p-6 md:p-8">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle pb-5">
                <div role="tablist" aria-label={c.mintTitle} className="grid w-full grid-cols-2 gap-1.5 rounded-input bg-bg-subtle p-1 sm:w-auto">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mintMode === 'wallet'}
                    onClick={() => setMintMode('wallet')}
                    className={cn(
                      'inline-flex items-center justify-center gap-2 rounded-input px-4 py-2 font-mono text-note font-bold transition-colors',
                      mintMode === 'wallet'
                        ? 'bg-brand text-bg-base'
                        : 'text-text-tertiary hover:text-text-primary',
                    )}
                  >
                    <Wallet className="size-3.5" aria-hidden />
                    {c.modeWalletTab}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mintMode === 'agent'}
                    onClick={() => setMintMode('agent')}
                    className={cn(
                      'inline-flex items-center justify-center gap-2 rounded-input px-4 py-2 font-mono text-note font-bold transition-colors',
                      mintMode === 'agent'
                        ? 'bg-brand text-bg-base'
                        : 'text-text-tertiary hover:text-text-primary',
                    )}
                  >
                    <Cpu className="size-3.5" aria-hidden />
                    {c.modeAgentTab}
                  </button>
                </div>

                {phase && (
                  <Badge tone={phase === 'L1' || phase === 'L2' ? 'ok' : 'info'} pip live={phase === 'L1' || phase === 'L2'} size="sm">
                    {c.phase[phase]}
                  </Badge>
                )}
              </div>

              {mintMode === 'wallet' ? (
                minting ? (
                  <MintPanel state={state} user={user} address={address} onDone={refresh} embedded />
                ) : (
                  <NonMintWalletNotice phase={phase} onSwitchAgent={() => setMintMode('agent')} />
                )
              ) : (
                <AgentPanel state={state} onDone={refresh} embedded />
              )}
            </section>
          )}

          {address && <ClaimPanel state={state} user={user} onDone={refresh} />}
        </div>

        <aside className="flex min-w-0 flex-col gap-6">
          <FlywheelMini tip={phaseTip} onOpenSimulator={() => openExplorer('anatomy')} />
        </aside>
      </div>

      <section id="ouro-explorer" className="glow-frame flex flex-col gap-7 rounded-panel bg-surface-card/85 p-6 md:p-8">
        <div
          role="tablist"
          aria-label={c.title}
          className="flex gap-2 overflow-x-auto border-b border-border-subtle pb-5 [scrollbar-width:none]"
        >
          {tabs.map(t => {
            const Icon = t.icon
            const active = activeTab === t.id
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setExplorerTab(t.id)}
                className={cn(
                  'inline-flex shrink-0 items-center gap-2 rounded-pill border px-4 py-2 font-mono text-note font-bold transition-colors',
                  active
                    ? 'border-brand bg-brand/15 text-brand'
                    : 'border-border-subtle text-text-secondary hover:border-border-strong hover:text-text-primary',
                )}
              >
                <Icon className="size-3.5" aria-hidden />
                {t.label}
              </button>
            )
          })}
        </div>

        {activeTab === 'anatomy' && <MintAnatomy />}

        {activeTab === 'ladder' && (
          <LadderTable minted={Number(state.l2Minted)} embedded />
        )}

        {activeTab === 'book' && !inL15 && (
          <div className="flex flex-col gap-3 py-4">
            <h3 className="text-title text-text-primary">{c.bookTitle}</h3>
            <p className="max-w-2xl text-body text-text-secondary">
              {state.launched ? c.bookClosed : c.bookSoon}
            </p>
          </div>
        )}

        {activeTab === 'boards' && (
          <Leaderboards address={address} embedded />
        )}

        {activeTab === 'contracts' && (
          <div className="grid gap-8 lg:grid-cols-2">
            <Contracts embedded />
            <Risk embedded />
          </div>
        )}
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-3 px-1 text-micro text-text-quiet">
        <span>{c.riskFooter}</span>
        <button
          type="button"
          onClick={() => openExplorer('contracts')}
          className="font-mono text-micro text-text-tertiary underline underline-offset-4 transition-colors hover:text-brand"
        >
          {c.riskViewFull}
        </button>
      </footer>
    </div>
  )
}

function Hero({ state }: { state: OuroState }) {
  const c = useOuroCopy()
  const p = state.phase
  const at = p === 'SoldOut' ? ORDER.length : p ? ORDER.indexOf(p) : -1

  return (
    <header className="glow-frame glow-flow relative isolate overflow-hidden rounded-panel bg-surface-card/85">
      <div aria-hidden="true" className="hero-grid pointer-events-none absolute inset-0 -z-10" />
      <div className="flex flex-col gap-8 p-6 md:p-10 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2.5">
            {p && (
              <Badge tone={p === 'Failed' ? 'danger' : p === 'L1' || p === 'L2' ? 'ok' : 'info'} pip live={p === 'L1' || p === 'L2'}>
                {c.phase[p]}
              </Badge>
            )}
            {state.paused && <Badge tone="warn">{c.paused}</Badge>}
          </div>
          <div className="flex items-center gap-4">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-card border border-brand/35 bg-brand/10 text-brand shadow-[0_0_18px_-4px_var(--tosh-brand)]">
              <OuroborosMark className="size-8" />
            </span>
            <h1 className="font-mono text-hero text-text-primary">{c.title}</h1>
          </div>
          <p className="max-w-xl text-pretty text-lede text-text-secondary">{c.tagline}</p>
        </div>
        <Countdown state={state} className="shrink-0" />
      </div>

      <ol className="grid grid-cols-2 border-t border-border-subtle bg-bg-subtle/50 lg:grid-cols-4">
        {c.pipelineSteps.map((step, i) => {
          const done = at > i
          const current = at === i
          return (
            <li
              key={step.id}
              className={cn(
                'flex items-center gap-3 border-border-subtle px-5 py-4 md:px-6',
                i % 2 === 1 && 'border-l',
                i >= 2 && 'border-t lg:border-t-0',
                i === 2 && 'lg:border-l',
                current && 'bg-brand/10',
              )}
            >
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-pill border font-mono text-micro font-bold',
                  current
                    ? 'border-brand bg-brand text-bg-base'
                    : done
                      ? 'border-brand/60 text-brand'
                      : 'border-border-subtle text-text-tertiary',
                )}
              >
                {done ? <Check className="size-3.5" aria-hidden /> : step.tag}
              </span>
              <div className="flex min-w-0 flex-col">
                <span className={cn('font-mono text-note font-bold', current ? 'text-brand' : 'text-text-primary')}>
                  {step.name}
                </span>
                <span className="text-micro text-text-tertiary">{step.brief}</span>
              </div>
            </li>
          )
        })}
      </ol>
    </header>
  )
}

function NonMintWalletNotice({ phase, onSwitchAgent }: { phase: Phase | undefined; onSwitchAgent: () => void }) {
  const c = useOuroCopy()
  if (phase === 'Pending') {
    return (
      <div className="flex flex-col gap-5 py-2">
        <div className="flex flex-col gap-2">
          <h3 className="text-title text-text-primary">{c.pendingMintTitle}</h3>
          <p className="text-body text-text-secondary">{c.pendingMintDesc}</p>
        </div>
        <Button label={c.pendingGoAgent} onClick={onSwitchAgent} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 py-2">
      <span className="font-mono text-label uppercase text-brand">
        {phase ? c.phase[phase] : c.mintTitle}
      </span>
      <p className="text-body text-text-secondary">
        {phase === 'L1_5' ? c.tlL15 : phase === 'AwaitLaunch' ? c.tlLaunch : c.tlL2}
      </p>
    </div>
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

const OPEN_SEED_DELAY_SEC = 3 * 86_400

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

function Risk({ embedded = false }: { embedded?: boolean }) {
  const c = useOuroCopy()
  const list = (
    <ul className="list-disc space-y-2.5 pl-5 text-note leading-relaxed text-text-secondary">
      {c.risks.map(r => <li key={r}>{r}</li>)}
    </ul>
  )
  if (embedded) {
    return (
      <div className="flex flex-col gap-4">
        <h3 className="text-label uppercase text-warning">{c.riskTitle}</h3>
        {list}
      </div>
    )
  }
  return <Panel title={c.riskTitle}>{list}</Panel>
}

function Contracts({ embedded = false }: { embedded?: boolean }) {
  const c = useOuroCopy()
  const rows: [string, string | undefined][] = [
    ['OuroborosToken', OURO_TOKEN], ['OuroborosMint', OURO_MINT], ['OuroborosBidBook', OURO_BIDBOOK],
    ['Pancake V2 Pair', OURO_PAIR], ['Treasury (Safe)', OURO_TREASURY],
  ]
  const dl = (
    <dl className="flex flex-col divide-y divide-border-subtle text-note">
      {rows.filter(([, a]) => a).map(([k, a]) => (
        <div key={k} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
          <dt className="text-text-tertiary">{k}</dt>
          <dd className="font-mono"><AddressLink value={a} /></dd>
        </div>
      ))}
    </dl>
  )
  if (embedded) {
    return (
      <div className="flex flex-col gap-4">
        <h3 className="text-label uppercase text-text-tertiary">{c.contracts}</h3>
        {dl}
      </div>
    )
  }
  return <Panel title={c.contracts}>{dl}</Panel>
}
