'use client'

/**
 * Tosh Admin · OPERATOR CONSOLE
 *
 * Two groups, neither of them an ambient owner check:
 *
 *   ROSTER      the v2 buyback treasuries' ladder roster. Gated on each
 *               treasury's own owner; writes export as a Safe batch.
 *               → V2RosterPanel.tsx
 *   FRONT PAGE  the homepage feature pin, authorised by a content credential
 *               rather than a wallet. → FeaturedProject.tsx
 *
 * Every other owner power (pause, blacklist, ladder halt, ownership) is a Safe
 * transaction on the factory or its gateway and has no lever here.
 */

import { useMemo } from 'react'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { TARGET_CHAIN_ID, CHAIN_BYLINE } from '@/lib/contracts'
import { WithoutWalletPicker } from '@/components/WalletPicker'
import { LocalePicker } from '@/components/LocalePicker'
import { fill, useT, type Dictionary } from '@/i18n'
import { Line, GroupHeader } from './shared'
import { FeaturedProjectPanel } from './FeaturedProject'
import { V2RosterPanel } from './V2RosterPanel'

// ─────────────────────────────────────────────────────────────────────────────
// CHROME
// ─────────────────────────────────────────────────────────────────────────────

function WalletBar() {
  const t = useT().admin
  const { address, isConnected } = useAccount()
  const { connect }    = useConnect()
  const { disconnect } = useDisconnect()

  if (!isConnected) {
    return (
      <button
        onClick={() => connect({ connector: injected() })}
        className="px-4 py-1.5 border border-text-primary text-text-primary text-label font-mono
                   tracking-[0.32em] uppercase font-bold rounded-xl
                   hover:border-brand hover:text-brand transition-colors"
      >
        {t.connect}
      </button>
    )
  }
  return (
    <div className="flex items-center gap-3 font-mono text-label tracking-wider">
      <span className="text-brand tabular-nums">
        {address?.slice(0, 6)}…{address?.slice(-4)}
      </span>
      <button
        onClick={() => disconnect()}
        className="px-2 py-1 text-text-tertiary hover:text-danger transition-colors
                   tracking-[0.32em] uppercase"
      >
        {t.disconnect}
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP RUNNING ORDER
// ─────────────────────────────────────────────────────────────────────────────

type GroupKey = 'roster' | 'g6'
type Group = { chip: string; header: { index: string; title: string; blurb: string } }

const GROUP_ORDER: readonly GroupKey[] = ['roster', 'g6']

function groupsFor(t: Dictionary['admin']): Record<GroupKey, Group> {
  return {
    roster: {
      chip: t.rosterChip,
      header: { index: t.rosterIndex, title: t.rosterGroupTitle, blurb: t.rosterGroupBlurb },
    },
    g6: {
      chip: t.featChip,
      header: { index: t.featIndex, title: t.featGroupTitle, blurb: t.featGroupBlurb },
    },
  }
}

/**
 * Jump bar between the groups. Plain anchors, so it works before hydration
 * and a middle-click still opens a section in a new tab.
 */
function GroupJumpBar({ groups, label }: { groups: Record<GroupKey, Group>; label: string }) {
  return (
    <nav
      aria-label={label}
      className="sticky top-0 z-30 -mx-6 mb-2 px-6 border-b border-border-subtle/60
                 bg-bg-base/95 backdrop-blur overflow-x-auto"
    >
      <ul className="flex items-center gap-1 min-w-max">
        {GROUP_ORDER.map(key => (
          <li key={key}>
            <a
              href={`#${key}`}
              className="inline-flex items-center min-h-11 px-2 rounded-lg
                         font-mono text-label uppercase tracking-wide
                         text-text-tertiary hover:text-brand hover:bg-surface-hover/40
                         transition-colors"
            >
              {groups[key].chip}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const t = useT().admin
  const groups = useMemo(() => groupsFor(t), [t])

  return (
    <WithoutWalletPicker>
      <div className="text-text-primary font-sans">
        <header className="border-b border-border-subtle/60 px-6 py-6">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full bg-admin dot-breathe" />
                <span className="text-label font-mono text-admin uppercase tracking-widest">
                  {t.eyebrow}
                </span>
              </div>
              <h1 className="text-2xl font-black tracking-tight text-text-primary">
                {t.titleLead} <span className="text-brand">{t.titleBrand}</span>
              </h1>
              <p className="text-xs text-text-tertiary mt-1 font-mono">{CHAIN_BYLINE}</p>
            </div>
            <div className="flex items-center gap-3">
              <LocalePicker />
              <WalletBar />
            </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 pb-24 pt-4">
        <GroupJumpBar groups={groups} label={t.jumpAria} />

        <GroupHeader anchor="roster" {...groups.roster.header} />
        <V2RosterPanel />

        <GroupHeader anchor="g6" {...groups.g6.header} />
        <FeaturedProjectPanel />

        <div className="pt-12">
          <Line />
          <p className="text-label text-text-quiet tracking-[0.4em] uppercase text-center pt-6">
            {t.footerV2} · {fill(t.footerChain, { id: TARGET_CHAIN_ID })}
          </p>
        </div>
      </main>
    </div>
    </WithoutWalletPicker>
  )
}
