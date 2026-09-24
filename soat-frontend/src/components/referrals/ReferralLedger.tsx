'use client'

import { useCallback, useMemo } from 'react'
import Link from 'next/link'
import { useAccount, useReadContract, useReadContracts } from 'wagmi'
import type { Address } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS, HOOK_ABI,
  REFERRAL_BPS, PROJECT_REFERRAL_BPS, LIFETIME_REFERRAL_BPS,
  CHAIN_BYLINE,
} from '@/lib/contracts'
import { QUOTE_SYMBOL } from '@/lib/contracts'
import { useDirectoryProjects, SCAN_DEPTH, type DirectoryProject } from '@/components/directory/useDirectoryProjects'
import {
  Badge, Card, PageHeader, Readout, ReadoutGrid, Skeleton,
  ActionButton, useActionGate, revertOrder, useTxAction,
} from '@/components/ui'
import { fmtQuote, fmtQuoteFull } from '@/components/ProjectTerminal/format'
import { fill, Linked, useT } from '@/i18n'

// ─────────────────────────────────────────────────────────────────────────────
// REFERRAL LEDGER  ·  every project that owes this wallet, in one place
// ─────────────────────────────────────────────────────────────────────────────
//
// Commission is accrued and claimed PER PROJECT: each hook holds its own
// `referralAccrued` mapping and its own `claimReferralReward()`. That is the
// right shape on chain — a referrer's claim is against the project whose raise
// it came out of, not against a platform pot that would have to be solvent
// across all of them — but it means there is no single balance to read and no
// single call to claim. Without this page a sharer has to remember which
// projects they promoted and open each one to find out whether it owes them.
//
// So this is a view, not a mechanism. It adds no contract, holds no funds, and
// every claim button below sends the same `claimReferralReward()` the project
// page already offers. What it adds is the enumeration.
//
// ── Two numbers per row, because they mean different things ──────────────────
//
// `referralAccrued` is what the link has earned. `claimableReferral` is what
// can be withdrawn right now, and it returns ZERO until the project launches —
// a failed genesis refunds depositors in full and never pays commission at
// all. Showing only the claimable figure would tell a sharer mid-raise that
// they have earned nothing; showing only the accrued figure would imply money
// they cannot touch and might never receive. Both, labelled.
//
// ── Which projects get a row ─────────────────────────────────────────────────
//
// Only those that have accrued something or bound at least one wallet. Listing
// every project on the platform with a zero against it would bury the two
// lines that matter under a directory the user already has.
//
// Bounded by `SCAN_DEPTH`, which matters more here than on the directory: a
// grid that shows recent projects is doing its job, whereas a ledger that
// misses one is telling a referrer they are owed nothing. The bound is stated
// on screen once it starts cutting, and the project's own desk remains the
// route to anything past it.

/** Whole percents at these rates — see the note in `ReferralPanel`. */
const REFERRAL_PCT = REFERRAL_BPS / 100
const PROJECT_PCT = PROJECT_REFERRAL_BPS / 100
const LIFETIME_PCT = LIFETIME_REFERRAL_BPS / 100

interface LedgerRow {
  project:  DirectoryProject
  accrued:  bigint
  /** Zero until `launched`, which is the contract's own answer and not ours. */
  claimable: bigint
  /** Wallets this referrer bound to this project. */
  recruits: bigint
  /**
   * At least one of this project's three legs did not come back.
   *
   * ⚠ WITHOUT THIS, A FAILED LEG WAS INDISTINGUISHABLE FROM A ZERO, and this
   *   page is the fallback route for commission the project page does not show.
   *   A project whose legs all failed was `continue`d out of the list entirely,
   *   and a project whose `claimableReferral` alone failed rendered a row with
   *   no claim action. Both looked like "you are owed nothing here."
   */
  degraded: boolean
}

function ReferralRow({ row, onClaimed }: { row: LedgerRow; onClaimed: () => void }) {
  const { project, accrued, claimable, recruits, degraded } = row
  const t = useT().referralLedger

  const { send, isPending, isConfirming } = useTxAction({
    action: t.txAction,
    onConfirmed: onClaimed,
  })

  const handleClaim = useCallback(() => {
    send({
      address: project.hook, abi: HOOK_ABI,
      functionName: 'claimReferralReward', args: [],
    })
  }, [project.hook, send])

  const gate = useActionGate({
    action: t.action,
    onAct: handleClaim,
    tx: { isPending, isConfirming },
    blockersInRevertOrder: revertOrder(
      {
        id: 'not-launched',
        active: !project.launched,
        label: t.lockedLabel,
        reason: t.lockedReason,
        tone: 'neutral',
      },
      {
        // ⚠ `degraded` DELIBERATELY DOES NOT APPEAR IN THIS LIST. Every blocker
        //   here disables the button — there is no advisory kind — and disabling
        //   is the opposite of what a failed read calls for. `claimReferralReward`
        //   takes no amount and pays whatever the hook actually owes, so pressing
        //   it on an unread figure is safe and is exactly the right move when the
        //   cause is a flaky RPC. The warning is rendered in the card instead.
        id: 'nothing-to-claim',
        active: !degraded && claimable === 0n,
        label: t.nothingLabel,
        reason: t.nothingReason,
        tone: 'neutral',
      },
    ),
  })

  return (
    <Card
      as="li"
      tone={claimable > 0n ? 'ok' : 'default'}
      title={
        <Link href={`/projects/${project.token}`} className="hover:text-brand transition-colors">
          {project.symbol}
        </Link>
      }
      subtitle={project.name}
      status={
        <Badge tone={project.launched ? 'ok' : 'warn'}>
          {project.launched ? t.launched : t.inGenesis}
        </Badge>
      }
    >
      <ReadoutGrid columns={3}>
        <Readout
          layout="stack"
          label={t.claimable}
          value={`${fmtQuote(claimable)} ${QUOTE_SYMBOL}`}
          hint={claimable === 0n ? t.claimableHint : fmtQuoteFull(claimable)}
          tone={claimable > 0n ? 'ok' : 'mute'}
        />
        <Readout
          layout="stack"
          label={t.earned}
          value={`${fmtQuote(accrued)} ${QUOTE_SYMBOL}`}
          hint={accrued === 0n ? t.earnedHint : fmtQuoteFull(accrued)}
          tone={accrued > 0n ? 'ink' : 'mute'}
        />
        <Readout
          layout="stack"
          label={t.brought}
          value={recruits.toString()}
          hint={t.broughtHint}
          tone={recruits > 0n ? 'ink' : 'mute'}
        />
      </ReadoutGrid>

      {/* Same shape as the `scanTruncated` notice at the foot of this page, and
          for the same reason: a figure this page could not read must not be
          published as a figure it read as zero. The claim button stays armed. */}
      {degraded && (
        <p className="text-label text-warning tracking-wider leading-relaxed">
          {'// '}{t.degraded}
        </p>
      )}

      <ActionButton gate={gate} />
    </Card>
  )
}

export function ReferralLedger() {
  const { address: userAddress } = useAccount()
  const { projects, loading: projectsLoading, launchCount } = useDirectoryProjects()
  const t = useT().referralLedger

  // The enumeration is the whole product here, and it is bounded. Past
  // `SCAN_DEPTH` launches an older project's commission stops appearing, which
  // on a page that says "every project" reads as "you are owed nothing". The
  // money is never stranded — a launched project keeps its own claim while it
  // owes anything, so the project page still pays it — but the reader has to be
  // told where to go rather than left to conclude the balance is gone.
  const scanTruncated = launchCount > SCAN_DEPTH

  // Lifetime recruits are a factory-level counter, so it is one read rather
  // than a sum over the rows below — and it deliberately counts wallets this
  // referrer bound platform-wide, including ones whose projects never launched
  // and therefore never appear with a balance.
  const { data: lifetimeCountRaw } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'referralCount',
    args: userAddress ? [userAddress] : undefined,
    query: { enabled: !!userAddress },
  })
  const lifetimeRecruits = (lifetimeCountRaw as bigint | undefined) ?? 0n

  // Three reads per project in one multicall. `claimableReferral` is asked of
  // the hook rather than derived from `launched && accrued`, so the unlock
  // rule stays in the contract that enforces it.
  const ledgerQuery = useReadContracts({
    contracts: projects.flatMap(p => [
      {
        address: p.hook, abi: HOOK_ABI, functionName: 'referralAccrued' as const,
        args: [userAddress as Address] as const,
      },
      {
        address: p.hook, abi: HOOK_ABI, functionName: 'claimableReferral' as const,
        args: [userAddress as Address] as const,
      },
      {
        address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'projectReferralCount' as const,
        args: [p.hook, userAddress as Address] as const,
      },
    ]),
    query: {
      enabled: !!userAddress && projects.length > 0,
      refetchInterval: 20_000,
    },
  })

  const rows: LedgerRow[] = useMemo(() => {
    const data = ledgerQuery.data
    if (!data) return []

    const out: LedgerRow[] = []
    for (let i = 0; i < projects.length; i++) {
      const off = i * 3
      const accruedOk = data[off]?.status === 'success'
      const claimableOk = data[off + 1]?.status === 'success'
      const recruitsOk = data[off + 2]?.status === 'success'
      const accrued = accruedOk ? (data[off].result as bigint) : 0n
      const claimable = claimableOk ? (data[off + 1].result as bigint) : 0n
      const recruits = recruitsOk ? (data[off + 2].result as bigint) : 0n
      const degraded = !accruedOk || !claimableOk || !recruitsOk

      // The skip now needs the zeros to be REAL zeros. It is the cheaper of the
      // two failures to miss — a dropped row cannot be argued with, whereas a
      // row that admits it is incomplete at least sends the reader to refresh.
      if (!degraded && accrued === 0n && recruits === 0n) continue
      out.push({ project: projects[i], accrued, claimable, recruits, degraded })
    }

    // Claimable first, because that is the only row with an action on it.
    out.sort((a, b) => {
      if (a.claimable !== b.claimable) return a.claimable > b.claimable ? -1 : 1
      return a.accrued > b.accrued ? -1 : a.accrued < b.accrued ? 1 : 0
    })
    return out
  }, [ledgerQuery.data, projects])

  const totals = useMemo(() => {
    let claimable = 0n
    let accrued = 0n
    for (const r of rows) {
      claimable += r.claimable
      accrued += r.accrued
    }
    return { claimable, accrued, locked: accrued - claimable }
  }, [rows])

  const refetchLedger = ledgerQuery.refetch
  const handleClaimed = useCallback(() => { void refetchLedger() }, [refetchLedger])

  const loading = projectsLoading || (!!userAddress && projects.length > 0 && ledgerQuery.isLoading)

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10 flex flex-col gap-card-lg">
      <PageHeader
        eyebrow={t.eyebrow}
        title={t.title}
        accent={t.accent}
        subtitle={fill(t.subtitle, { project: PROJECT_PCT, lifetime: LIFETIME_PCT, total: REFERRAL_PCT })}
        status={<Badge tone="neutral">{CHAIN_BYLINE}</Badge>}
      />

      {!userAddress ? (
        <Card title={t.connectTitle} subtitle={t.connectSubtitle}>
          <p className="text-note text-text-secondary leading-relaxed">
            {t.connectBody}
          </p>
        </Card>
      ) : (
        <>
          <ReadoutGrid columns={3}>
            <Readout
              layout="stack"
              label={t.totalClaimable}
              value={`${fmtQuote(totals.claimable)} ${QUOTE_SYMBOL}`}
              hint={totals.claimable === 0n ? t.totalClaimableHint : fmtQuoteFull(totals.claimable)}
              tone={totals.claimable > 0n ? 'ok' : 'mute'}
              loading={loading}
            />
            <Readout
              layout="stack"
              label={t.totalLocked}
              value={`${fmtQuote(totals.locked)} ${QUOTE_SYMBOL}`}
              hint={t.totalLockedHint}
              tone={totals.locked > 0n ? 'warn' : 'mute'}
              loading={loading}
            />
            <Readout
              layout="stack"
              label={t.totalBrought}
              value={lifetimeRecruits.toString()}
              hint={fill(t.totalBroughtHint, { lifetime: LIFETIME_PCT })}
              tone={lifetimeRecruits > 0n ? 'ink' : 'mute'}
              loading={loading}
            />
          </ReadoutGrid>

          {loading ? (
            <div className="flex flex-col gap-card">
              <Skeleton className="h-32" />
              <Skeleton className="h-32" />
            </div>
          ) : rows.length === 0 ? (
            <Card title={t.emptyTitle} subtitle={t.emptySubtitle}>
              <div className="flex flex-col gap-3 text-note text-text-secondary leading-relaxed">
                <p>
                  {t.emptyEarns}
                </p>
                <p>
                  {fill(t.emptyConditions, { project: PROJECT_PCT, lifetime: LIFETIME_PCT })}
                </p>
                {/* Said "It is not on launched projects", which the desk itself
                    contradicts: it hides on a launched project only when there
                    is nothing to collect, precisely so the claim does not
                    vanish at the moment launch() makes the money withdrawable.
                    And "the claim is here, on this page" sent readers of THIS
                    card hunting for a button that only exists on a row, which
                    an empty ledger has none of. Both now say what happens. */}
                <p className="text-text-tertiary">
                  <Linked text={t.emptyDesks} href="/projects" className="text-brand hover:underline" />
                </p>
              </div>
            </Card>
          ) : (
            <ul className="flex flex-col gap-card list-none p-0 m-0">
              {rows.map(row => (
                <ReferralRow key={row.project.hook} row={row} onClaimed={handleClaimed} />
              ))}
            </ul>
          )}

          <p className="text-label text-text-quiet tracking-wider leading-relaxed">
            {'// '}{t.perProject}
          </p>

          {scanTruncated && (
            <p className="text-label text-warning tracking-wider leading-relaxed">
              {'// '}{fill(t.truncated, { depth: SCAN_DEPTH, count: launchCount })}
            </p>
          )}
        </>
      )}
    </main>
  )
}
