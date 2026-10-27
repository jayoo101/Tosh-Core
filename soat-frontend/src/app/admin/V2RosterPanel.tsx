'use client'

/**
 * The v2 buyback roster: which launched projects each stack's
 * `ToshLadderTreasury` buys back and burns.
 *
 * Nothing lists a project on its own. Until the treasury owner (the Safe) calls
 * `addLadderToken`, the reservoir only fills. The owner is rarely a browser
 * wallet, so every write here can also be exported as a Safe Transaction
 * Builder batch, and the gate is this treasury's owner rather than the page's
 * ambient v1 factory owner.
 */

import { useCallback, useMemo, useState } from 'react'
import { encodeFunctionData, type Address } from 'viem'
import { useAccount, useReadContract, useReadContracts } from 'wagmi'

import {
  ActionButton, ActionGateProvider, revertOrder, useActionGate, useTxAction, type TxAction,
} from '@/components/ui'
import { useDirectoryProjects, type DirectoryProject } from '@/components/directory/useDirectoryProjects'
import { fmtSig } from '@/components/v2/fmt'
import { fill, useT } from '@/i18n'
import { NATIVE_SYMBOL, TARGET_CHAIN_ID } from '@/lib/chain'
import { V2_FACTORY_ABI, V2_HOOK_ABI, V2_TREASURY_ABI } from '@/lib/v2/abis'
import { V2_FACTORY_BNB, V2_FACTORY_USDT } from '@/lib/v2/config'
import { AddressLink, ConfirmDialog, Readout, ScopeNote, Section, StatusBadge, labelCls } from './shared'
import { downloadJson, rosterCandidates, safeBatch, twapReady } from './v2Roster'

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

const linkBtn =
  'font-mono text-note text-brand hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-40'

export function V2RosterPanel() {
  const t = useT().admin
  const { projects } = useDirectoryProjects({ includeHidden: true })
  const stacks = [
    V2_FACTORY_BNB && { factory: V2_FACTORY_BNB, quote: NATIVE_SYMBOL },
    V2_FACTORY_USDT && { factory: V2_FACTORY_USDT, quote: 'USDT' },
  ].filter((s): s is { factory: Address; quote: string } => !!s)

  if (stacks.length === 0) {
    return (
      <Section title={t.rosterNoneTitle}>
        <ScopeNote tone="warn">{t.rosterNotConfigured}</ScopeNote>
      </Section>
    )
  }
  return <>{stacks.map(s => <StackRoster key={s.factory} {...s} projects={projects} />)}</>
}

function StackRoster({ factory, quote, projects }: { factory: Address; quote: string; projects: readonly DirectoryProject[] }) {
  const t = useT().admin
  const { address } = useAccount()
  const [pendingRemoval, setPendingRemoval] = useState<Address | null>(null)

  const { data: treasury } = useReadContract({
    address: factory, abi: V2_FACTORY_ABI, functionName: 'ladderTreasury', chainId: TARGET_CHAIN_ID,
  })
  const at = { address: treasury, abi: V2_TREASURY_ABI, chainId: TARGET_CHAIN_ID } as const
  const { data: core, refetch: refetchCore } = useReadContracts({
    contracts: [
      { ...at, functionName: 'owner' },
      { ...at, functionName: 'factory' },
      { ...at, functionName: 'reservoir' },
      { ...at, functionName: 'untilNextTrigger' },
      { ...at, functionName: 'nextSpendAmount' },
      { ...at, functionName: 'ladderTokenCount' },
      { ...at, functionName: 'currentCursor' },
    ],
    query: { enabled: !!treasury, refetchInterval: 12_000 },
  })
  const [owner, boundFactory, balance, untilNext, nextSpend, count, cursor] = (core ?? []).map(r => r.result) as [
    Address?, Address?, bigint?, bigint?, bigint?, bigint?, bigint?,
  ]

  const { data: listedRaw, refetch: refetchListed } = useReadContracts({
    contracts: Array.from({ length: Number(count ?? 0n) }, (_, i) => ({ ...at, functionName: 'ladderTokens' as const, args: [BigInt(i)] as const })),
    query: { enabled: !!treasury && (count ?? 0n) > 0n },
  })
  const listed = useMemo(
    () => (listedRaw ?? []).map(r => r.result as Address | undefined).filter((a): a is Address => !!a),
    [listedRaw],
  )
  const rosterPending = core === undefined || ((count ?? 0n) > 0n && listedRaw === undefined)

  const candidates = useMemo(() => rosterCandidates(projects, factory, listed), [projects, factory, listed])
  const { data: twaps } = useReadContracts({
    contracts: candidates.map(p => ({ address: p.hook, abi: V2_HOOK_ABI, functionName: 'twapSqrtPriceX96' as const, chainId: TARGET_CHAIN_ID })),
    query: { enabled: candidates.length > 0, refetchInterval: 30_000 },
  })
  const ready = candidates.filter((_, i) => twapReady(twaps?.[i]))

  const symbolOf = useCallback((token: Address) => projects.find(p => same(p.token, token))?.symbol, [projects])

  const isOwner = same(address, owner)
  const access = { allowed: isOwner, reason: isOwner ? null : t.rosterNotOwner, label: t.rosterSafeOnly }

  const tx = useTxAction({
    action: t.rosterTxAction,
    onConfirmed: () => { void refetchCore(); void refetchListed() },
  })

  const exportCalls = useCallback((fn: 'addLadderToken' | 'removeLadderToken', tokens: readonly Address[], label: string) => {
    if (!treasury || tokens.length === 0) return
    const calls = tokens.map(token => ({ to: treasury, data: encodeFunctionData({ abi: V2_TREASURY_ABI, functionName: fn, args: [token] }) }))
    downloadJson(
      `toshx-v2-${fn}-${quote.toLowerCase()}-${label}.json`,
      safeBatch(TARGET_CHAIN_ID, `ToshX v2 ${fn} (${quote})`, tokens.map(tk => symbolOf(tk) ?? tk).join(', '), calls),
    )
  }, [treasury, quote, symbolOf])

  const removal = pendingRemoval
  const confirmRemoval = useCallback(() => {
    if (!removal || !treasury) return
    setPendingRemoval(null)
    tx.send({ address: treasury, abi: V2_TREASURY_ABI, functionName: 'removeLadderToken', args: [removal] })
  }, [removal, treasury, tx])

  return (
    <ActionGateProvider value={access}>
      <Section
        title={fill(t.rosterStackTitle, { quote })}
        subtitle="addLadderToken / removeLadderToken"
        action={<StatusBadge ok={listed.length > 0} okLabel={fill(t.rosterListedBadge, { n: String(listed.length) })} badLabel={t.rosterEmptyBadge} />}
      >
        <Readout label={t.rosterTreasury} value={<AddressLink addr={treasury} />} />
        <Readout
          label={t.rosterBoundFactory}
          value={<AddressLink addr={boundFactory} />}
          hint={boundFactory && !same(boundFactory, factory) ? t.rosterFactoryMismatch : null}
        />
        <Readout label={t.rosterOwner} value={<AddressLink addr={owner} />} hint={isOwner ? t.rosterYouOwn : null} />
        <Readout label={t.rosterBalance} value={`${fmtSig(balance)} ${quote}`} tone="fluo" />
        <Readout
          label={t.rosterUntilNext}
          value={untilNext === 0n ? t.rosterArmed : `${fmtSig(untilNext)} ${quote}`}
        />
        <Readout label={t.rosterNextSpend} value={`${fmtSig(nextSpend)} ${quote}`} />
        <Readout label={t.rosterCursor} value={`${(cursor ?? 0n).toString()} / ${(count ?? 0n).toString()}`} />

        <ScopeNote>{t.rosterValve}</ScopeNote>
        {!isOwner && <ScopeNote tone="warn">{t.rosterNotOwner}</ScopeNote>}

        <div className="flex flex-col gap-1.5">
          <span className={labelCls}>{t.rosterListedTitle}</span>
          {rosterPending ? (
            <p className="py-3 font-mono text-note text-text-tertiary">{t.rosterReading}</p>
          ) : listed.length === 0 ? (
            <p className="py-3 font-mono text-note text-text-tertiary">{t.rosterListedEmpty}</p>
          ) : (
            <div className="divide-y divide-border-subtle/60 rounded-lg border border-border-subtle">
              {listed.map((token, i) => (
                <div key={token} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="font-mono text-label tabular-nums text-text-quiet">{String(i).padStart(2, '0')}</span>
                    {BigInt(i) === cursor && <span className="font-mono text-micro tracking-widest text-brand">{t.rosterNext}</span>}
                    <span className="font-mono text-note text-text-primary">{symbolOf(token) ? `$${symbolOf(token)}` : '—'}</span>
                    <span className="break-all font-mono text-note text-text-secondary"><AddressLink addr={token} /></span>
                  </div>
                  <div className="flex items-center gap-3">
                    <button type="button" className={linkBtn} onClick={() => exportCalls('removeLadderToken', [token], symbolOf(token) ?? 'token')}>
                      {t.rosterExportSafe}
                    </button>
                    <RemoveButton tx={tx} onRemove={() => setPendingRemoval(token)} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className={labelCls}>{t.rosterPendingTitle}</span>
          {candidates.length === 0 ? (
            <p className="py-3 font-mono text-note text-text-tertiary">{t.rosterPendingEmpty}</p>
          ) : (
            <div className="divide-y divide-border-subtle/60 rounded-lg border border-border-subtle">
              {candidates.map((p, i) => (
                <CandidateRow
                  key={p.token}
                  project={p}
                  ready={twapReady(twaps?.[i])}
                  reading={twaps === undefined}
                  treasury={treasury}
                  tx={tx}
                  onExport={() => exportCalls('addLadderToken', [p.token], p.symbol)}
                />
              ))}
            </div>
          )}
          {ready.length > 1 && (
            <button type="button" className={`${linkBtn} w-fit`} onClick={() => exportCalls('addLadderToken', ready.map(p => p.token), 'batch')}>
              {fill(t.rosterExportAll, { n: String(ready.length) })}
            </button>
          )}
          <span className="text-label tracking-wider text-text-tertiary">{t.rosterSafeHint}</span>
        </div>

        <ConfirmDialog
          open={!!removal}
          title={t.rosterRemoveTitle}
          body={
            <>
              <p className="break-all text-text-secondary">{removal}</p>
              <p className="mt-3 text-text-tertiary">{t.rosterRemoveBody}</p>
            </>
          }
          confirmLabel={t.rosterRemove}
          onConfirm={confirmRemoval}
          onCancel={() => setPendingRemoval(null)}
          danger
        />
      </Section>
    </ActionGateProvider>
  )
}

function RemoveButton({ tx, onRemove }: { tx: TxAction; onRemove: () => void }) {
  const t = useT().admin
  const gate = useActionGate({ action: t.rosterRemove, tx, onAct: onRemove })
  return <ActionButton gate={gate} size="sm" full={false} intent="danger" showReason={false} />
}

function CandidateRow({ project, ready, reading, treasury, tx, onExport }: {
  project: DirectoryProject
  ready: boolean
  reading: boolean
  treasury: Address | undefined
  tx: TxAction
  onExport: () => void
}) {
  const t = useT().admin
  const gate = useActionGate({
    action: t.rosterAdd,
    tx,
    onAct: () => {
      if (treasury) tx.send({ address: treasury, abi: V2_TREASURY_ABI, functionName: 'addLadderToken', args: [project.token] })
    },
    blockersInRevertOrder: revertOrder(
      { id: 'twap', active: !ready, label: t.rosterAdd, reason: t.rosterStatusTwap, tone: 'neutral' },
    ),
  })
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <span className="font-mono text-note text-text-primary">${project.symbol}</span>
        <span className="break-all font-mono text-note text-text-secondary"><AddressLink addr={project.token} /></span>
        <span className={`font-mono text-micro ${ready ? 'text-brand' : 'text-text-tertiary'}`}>
          {reading ? t.rosterReading : ready ? t.rosterStatusReady : t.rosterStatusTwap}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button type="button" className={linkBtn} disabled={!ready} onClick={onExport}>{t.rosterExportSafe}</button>
        <ActionButton gate={gate} size="sm" full={false} showReason={false} />
      </div>
    </div>
  )
}
