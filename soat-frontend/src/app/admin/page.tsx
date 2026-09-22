'use client'

/**
 * Tosh Admin · OPERATOR CONSOLE  (v5.0)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Pure black canvas, hairline gray dividers, white type, fluorescent green ONLY
 * where a guard engages or where a focused write button takes the wheel.
 *
 * The console is organised as five governance groups that mirror the on-chain
 * authority surface exactly, one module per group:
 *
 *   G1  FACTORY CONTROL      launchFee · defaultSoftCap · maxPogAllocationLimit
 *                            · cooldownDuration · quotaWindowDuration
 *                            → FactoryDials.tsx
 *   G2  SIGNER & FEE         setPogSigner, plus the immutable platformTreasury
 *                            readout — 0.30 % of every buy lands there and no
 *                            setter exists  → Signers.tsx
 *   G3  SAFETY & RISK        pause / unpause          → CircuitBreaker.tsx
 *                            haltLadderMinting        → LadderHalt.tsx
 *                            setBlacklist / lift      → Blacklist.tsx
 *   G4  TREASURY CURATION    addLadderToken / removeLadderToken
 *                            → LadderTreasury.tsx
 *   G5  OWNERSHIP            transferOwnership / acceptOwnership (2-step, both
 *                            the factory AND the ladder treasury)
 *                            → Ownership.tsx
 *
 * This file is the chrome and the group running order.  `shared.tsx` holds the
 * write verdict and the primitives every panel renders through.
 *
 * ACCESS MODEL
 * ────────────
 * Every write on this page is `onlyOwner` on-chain, so the UI does not need to
 * hide anything to be safe — it needs to stop a non-owner from burning gas on a
 * transaction the contract will reject.  A non-owner therefore gets the full
 * read-only console with every write lever disabled, rather than a redirect.
 * `ActionGateProvider` carries that verdict as the page's ambient gate, and
 * every `useActionGate` on the page consults it before anything else, so a new
 * panel cannot forget to honour it.  A wallet that is merely disconnected is
 * NOT an authority failure and must not be reported as one: the gate resolves
 * that case to `Connect Wallet` before it ever asks about ownership.
 *
 * Local guards mirrored from Solidity (so the wallet never opens for a
 * transaction that is already known to revert):
 *
 *   defaultSoftCap  < MIN_SOFT_CAP_PROD (100 BEM)   → blocked
 *   cooldown/quota  > MAX_COOLDOWN (7 d)            → blocked
 *   blacklist batch > ADMIN_BATCH_MAX (200)         → truncated on the wire
 *   addLadderToken  → token must be factory-launched AND its hook must have
 *                     launched (an unlaunched hook has no pool key, and the
 *                     treasury's `InvalidPoolKey` arm would reject it)
 */

import { useMemo } from 'react'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { type Address } from 'viem'
import { injected } from 'wagmi/connectors'
import {
  FACTORY_ADDRESS,
  TARGET_CHAIN_ID,
  CHAIN_BYLINE,
} from '@/lib/contracts'
import { useProtocolOwner } from '@/lib/useProtocolOwner'
import { ActionGateProvider, type AmbientGate } from '@/components/ui'
import { Line, GroupHeader, AddressLink } from './shared'
import { LaunchFeePanel, SoftCapPanel, PogLimitPanel, CooldownDurationPanel, QuotaWindowPanel } from './FactoryDials'
import { PogSignerPanel, PlatformTreasuryPanel } from './Signers'
import { CircuitBreakerPanel } from './CircuitBreaker'
import { LadderHaltPanel } from './LadderHalt'
import { BlacklistConsole } from './Blacklist'
import { LadderTreasuryPanel } from './LadderTreasury'
import { OwnershipPanel } from './Ownership'
import { FeaturedProjectPanel } from './FeaturedProject'
import { InitcodeHashMonitor, ExchangeRatePanel } from './Monitors'

// ─────────────────────────────────────────────────────────────────────────────
// CHROME
// ─────────────────────────────────────────────────────────────────────────────

function WalletBar() {
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
        connect wallet
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
        disc
      </button>
    </div>
  )
}

/**
 * Page-wide verdict banner shown whenever writes are unavailable.
 *
 * The arms are ordered the way the action gate resolves them — disconnected
 * before unresolved — so the banner and the buttons never disagree about why
 * the page is read-only.  A visitor with no wallet gets "connect one", not
 * "reading factory.owner()", which is a question they cannot answer.
 */
function AccessBanner({
  isConnected, ownerLoading, owner, isOwner,
}: {
  isConnected:  boolean
  ownerLoading: boolean
  owner:        Address | undefined
  isOwner:      boolean
}) {
  if (isOwner) return null

  const [title, body] = !isConnected
    ? ['VIEW ONLY · WALLET DISCONNECTED',
       'Every value below is live on-chain and safe to read. Connect the owner wallet to unlock writes.']
    : ownerLoading
      ? ['RESOLVING AUTHORITY', 'Reading factory.owner() — levers stay locked until it resolves.']
      : ['VIEW ONLY · NOT THE OWNER',
         'This wallet is not the factory owner. Every write on this page is onlyOwner on-chain and would revert, so the levers are disabled rather than left to burn gas.']

  return (
    <div className="mt-6 border border-danger/40 rounded-2xl p-5 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-danger" aria-hidden />
        <span className="text-label font-mono tracking-[0.4em] uppercase text-danger">
          {title}
        </span>
      </div>
      <p className="text-xs text-text-secondary leading-relaxed max-w-2xl">{body}</p>
      {owner && (
        <p className="text-note font-mono text-text-tertiary break-all">
          owner <AddressLink addr={owner} />
        </p>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP RUNNING ORDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One record per governance group, feeding BOTH the jump bar and the headings.
 *
 * They share a source because they drifted when they did not: the console is
 * fourteen panels and twelve thousand pixels tall, and a jump bar whose labels
 * disagree with the headings they land on is worse than no jump bar at all.
 * `chip` is the short form the bar can afford at 390 px; `header` is the full
 * heading, and the key is the anchor.
 */
const GROUPS = {
  g1: {
    chip: 'Dials',
    header: {
      index: 'G1 · FACTORY CONTROL',
      title: 'Platform parameters',
      blurb: 'Global dials on ToshFactory. Every one of these is forward-looking: a live raise keeps the terms frozen into its hook at construction, so retuning here governs the next launch, never the current one.',
    },
  },
  g2: {
    chip: 'Signer',
    header: {
      index: 'G2 · SIGNER AND FEE RECIPIENT',
      title: 'Oracle signer and platform revenue',
      blurb: 'Two addresses the factory holds, with opposite mutability. The PoG signer is the EOA whose attestations registerPoG() trusts, and it rotates from here. The platform fee recipient collects 0.30 % of every buy and is immutable — it has no setter, so redirecting platform revenue would mean deploying a new factory.',
    },
  },
  g3: {
    chip: 'Safety',
    header: {
      index: 'G3 · SAFETY & RISK',
      title: 'Circuit breaker and blacklist',
      blurb: "Incident controls. The circuit breaker and the blacklist are scoped to the factory's own entry points; the ladder halt is the single exception that reaches a launched project, and it expires on its own.",
    },
  },
  g4: {
    chip: 'Roster',
    header: {
      index: 'G4 · TREASURY CURATION',
      title: 'Buyback ladder roster',
      blurb: 'The only owner authority the ladder treasury exposes. Curation decides which launched tokens the burn engine rotates through; it cannot move funds.',
    },
  },
  g5: {
    chip: 'Owner',
    header: {
      index: 'G5 · OWNERSHIP',
      title: 'Two-step handoff',
      blurb: 'Ownable2Step on both contracts. Initiating a transfer changes nothing until the recipient accepts, which is what makes a mistyped address recoverable.',
    },
  },
  g6: {
    chip: 'Front page',
    header: {
      index: 'G6 · PRESENTATION',
      title: 'Homepage feature pin',
      blurb: "The only group here that is not a protocol power. It decides which of the launches the homepage already shows gets the double-width card, and it is the one control on this page a browser wallet is irrelevant to — the authorisation is a content credential, not the owner Safe, because nothing in it can reach a contract.",
    },
  },
  diag: {
    chip: 'Diag',
    header: {
      index: 'DIAG · DIAGNOSTICS',
      title: 'Build fingerprint and off-chain config',
      blurb: 'Read-only telemetry plus the one control on this page that is an owner-signed API call rather than a transaction. G6 is off-chain too, and differs in what authorises it.',
    },
  },
} as const

const GROUP_ORDER = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'diag'] as const

/**
 * Jump bar for a console that is fourteen phone screens tall.
 *
 * The reason this exists is G3.  An operator who needs the circuit breaker
 * needs it during an incident, and it sits six screens down behind the fee
 * dials — findable by scrolling, which is exactly the wrong thing to be doing
 * at that moment.  Plain anchors, so it works before hydration and a
 * middle-click still opens a section in a new tab.
 */
function GroupJumpBar() {
  return (
    <nav
      aria-label="Console sections"
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
              {GROUPS[key].chip}
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
  const { address, isConnected } = useAccount()
  const { owner, isOwner, isLoading: ownerLoading } = useProtocolOwner()

  const access = useMemo<AmbientGate>(() => {
    if (ownerLoading) {
      return { allowed: false, reason: 'Reading factory.owner().', label: '[resolving]' }
    }
    if (!isOwner) {
      return {
        allowed: false,
        reason: 'This wallet is not the factory owner. Every write here is onlyOwner on-chain and would revert.',
        label: '[read_only]',
      }
    }
    return { allowed: true, reason: null }
  }, [ownerLoading, isOwner])

  return (
    <ActionGateProvider value={access}>
      <div className="text-text-primary font-sans">
        <header className="border-b border-border-subtle/60 px-6 py-6">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full bg-admin dot-breathe" />
                <span className="text-label font-mono text-admin uppercase tracking-widest">
                  Operator Console
                </span>
                {!access.allowed && (
                  <span className="text-label font-mono text-danger uppercase tracking-widest">
                    · read-only
                  </span>
                )}
              </div>
              <h1 className="text-2xl font-black tracking-tight text-text-primary">
                Protocol <span className="text-brand">Control</span>
              </h1>
              <p className="text-xs text-text-tertiary mt-1 font-mono">
                {CHAIN_BYLINE} ·{' '}
                {FACTORY_ADDRESS.slice(0, 10)}…{FACTORY_ADDRESS.slice(-6)}
              </p>
            </div>
            <WalletBar />
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 pb-24 pt-4">
        <GroupJumpBar />

        <AccessBanner
          isConnected={isConnected}
          ownerLoading={ownerLoading}
          owner={owner}
          isOwner={isOwner}
        />

        <GroupHeader anchor="g1" {...GROUPS.g1.header} />
        <LaunchFeePanel />
        <SoftCapPanel />
        <PogLimitPanel />
        <CooldownDurationPanel />
        <QuotaWindowPanel />

        <GroupHeader anchor="g2" {...GROUPS.g2.header} />
        <PogSignerPanel />
        <PlatformTreasuryPanel />

        <GroupHeader anchor="g3" {...GROUPS.g3.header} />
        <CircuitBreakerPanel />
        <LadderHaltPanel />
        <BlacklistConsole />

        <GroupHeader anchor="g4" {...GROUPS.g4.header} />
        <LadderTreasuryPanel />

        <GroupHeader anchor="g5" {...GROUPS.g5.header} />
        <OwnershipPanel connected={address} />

        <GroupHeader anchor="g6" {...GROUPS.g6.header} />
        <FeaturedProjectPanel />

        <GroupHeader anchor="diag" {...GROUPS.diag.header} />
        <InitcodeHashMonitor />
        <ExchangeRatePanel />

        <div className="pt-12">
          <Line />
          <p className="text-label text-text-quiet tracking-[0.4em] uppercase text-center pt-6">
            every on-chain write here is onlyOwner · chain {TARGET_CHAIN_ID}
          </p>
        </div>
      </main>
    </div>
    </ActionGateProvider>
  )
}
