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
import { useDirectoryProjects, type DirectoryProject } from '@/components/directory/useDirectoryProjects'
import {
  Badge, Card, PageHeader, Readout, ReadoutGrid, Skeleton,
  ActionButton, useActionGate, revertOrder, useTxAction,
} from '@/components/ui'
import { fmt, fmtFull } from '@/components/ProjectTerminal/format'

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
}

function ReferralRow({ row, onClaimed }: { row: LedgerRow; onClaimed: () => void }) {
  const { project, accrued, claimable, recruits } = row

  const { send, isPending, isConfirming } = useTxAction({
    action: 'claim commission',
    onConfirmed: onClaimed,
  })

  const handleClaim = useCallback(() => {
    send({
      address: project.hook, abi: HOOK_ABI,
      functionName: 'claimReferralReward', args: [],
    })
  }, [project.hook, send])

  const gate = useActionGate({
    action: 'claim',
    onAct: handleClaim,
    tx: { isPending, isConfirming },
    blockersInRevertOrder: revertOrder(
      {
        id: 'not-launched',
        active: !project.launched,
        label: 'Locked until launch',
        reason:
          'Commission unlocks when the project calls launch(). A raise that is never launched '
          + 'refunds depositors in full and never pays commission, so this is the '
          + 'contract holding the money until the outcome is known.',
        tone: 'neutral',
      },
      {
        id: 'nothing-to-claim',
        active: claimable === 0n,
        label: 'Nothing to claim',
        reason: 'This project has launched and everything it owed this wallet is already withdrawn.',
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
          {project.launched ? 'launched' : 'in genesis'}
        </Badge>
      }
    >
      <ReadoutGrid columns={3}>
        <Readout
          layout="stack"
          label="CLAIMABLE"
          value={`${fmt(claimable)} ETH`}
          hint={claimable === 0n ? 'unlocks at launch()' : fmtFull(claimable, 18)}
          tone={claimable > 0n ? 'ok' : 'mute'}
        />
        <Readout
          layout="stack"
          label="EARNED"
          value={`${fmt(accrued)} ETH`}
          hint={accrued === 0n ? 'no deposits through your link yet' : fmtFull(accrued, 18)}
          tone={accrued > 0n ? 'ink' : 'mute'}
        />
        <Readout
          layout="stack"
          label="WALLETS BROUGHT"
          value={recruits.toString()}
          hint="bound to you on this project"
          tone={recruits > 0n ? 'ink' : 'mute'}
        />
      </ReadoutGrid>

      <ActionButton gate={gate} />
    </Card>
  )
}

export function ReferralLedger() {
  const { address: userAddress } = useAccount()
  const { projects, loading: projectsLoading } = useDirectoryProjects()

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
      const accrued = data[off]?.status === 'success' ? (data[off].result as bigint) : 0n
      const claimable = data[off + 1]?.status === 'success' ? (data[off + 1].result as bigint) : 0n
      const recruits = data[off + 2]?.status === 'success' ? (data[off + 2].result as bigint) : 0n

      if (accrued === 0n && recruits === 0n) continue
      out.push({ project: projects[i], accrued, claimable, recruits })
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
        eyebrow="// referral ledger"
        title="Your"
        accent="commission"
        subtitle={
          `${PROJECT_PCT}% of every genesis deposit made through your link on a project you have `
          + `staked, plus ${LIFETIME_PCT}% for life on every wallet you first brought to Tosh. `
          + `${REFERRAL_PCT}% in total, carved from the raise and not from anyone's allocation.`
        }
        status={<Badge tone="neutral">{CHAIN_BYLINE}</Badge>}
      />

      {!userAddress ? (
        <Card title="Connect a wallet" subtitle="The ledger is keyed to an address">
          <p className="text-note text-text-secondary leading-relaxed">
            Commission accrues to whichever address a referral link named, so there is nothing
            to show until one is connected. Nothing here is a transaction — connecting only
            reads what the projects already owe.
          </p>
        </Card>
      ) : (
        <>
          <ReadoutGrid columns={3}>
            <Readout
              layout="stack"
              label="CLAIMABLE NOW"
              value={`${fmt(totals.claimable)} ETH`}
              hint={totals.claimable === 0n ? 'across every launched project' : fmtFull(totals.claimable, 18)}
              tone={totals.claimable > 0n ? 'ok' : 'mute'}
              loading={loading}
            />
            <Readout
              layout="stack"
              label="LOCKED UNTIL LAUNCH"
              value={`${fmt(totals.locked)} ETH`}
              hint="earned on raises still in genesis"
              tone={totals.locked > 0n ? 'warn' : 'mute'}
              loading={loading}
            />
            <Readout
              layout="stack"
              label="WALLETS BROUGHT TO TOSH"
              value={lifetimeRecruits.toString()}
              hint={`each pays you ${LIFETIME_PCT}% for life`}
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
            <Card title="No commission yet" subtitle="What earns it">
              <div className="flex flex-col gap-3 text-note text-text-secondary leading-relaxed">
                <p>
                  Nothing has accrued to this wallet. A referral link earns on the deposits
                  made through it, so the ledger fills in as the people you shared with
                  arrive — not when the link is created.
                </p>
                <p>
                  Two conditions decide what a link pays, and both are worth checking before
                  sharing. You need your own PoG attestation, or neither leg binds. And the{' '}
                  {PROJECT_PCT}% project leg only binds on a project you already hold a
                  deposit in — so deposit first, then share, or that share of the carve goes
                  to the buyback reservoir instead of to you. The {LIFETIME_PCT}% lifetime
                  leg has no such condition.
                </p>
                {/* Names genesis specifically because that is where the desk now
                    is. It used to render on every phase, which made this line
                    true of any project page and also sent people to get a link
                    for a raise that had already closed. */}
                <p className="text-text-tertiary">
                  Any project still in genesis carries its own referral desk, with the link
                  and a live read on whether it will pay there. It is not on launched
                  projects, because a link cannot earn on a raise that has closed — the
                  claim for one that already earned is here, on this page.{' '}
                  <Link href="/projects" className="text-brand hover:underline">
                    Browse projects
                  </Link>
                  .
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
            {'// '}Claims are per project, because each project holds its own commission
            reserve. There is no single button that drains them all, and there deliberately
            is not: a platform-wide pot would have to stay solvent across every raise at once.
          </p>
        </>
      )}
    </main>
  )
}
