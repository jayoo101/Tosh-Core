'use client'

import { Panel, Row } from '@/components/x/Panel'
import { Button, formatCountdown, useNowSec, useTxAction } from '@/components/ui'
import { OURO_MINT_ABI } from '@/lib/ouroboros/abis'
import { OURO_MINT } from '@/lib/ouroboros/config'

import { useOuroCopy } from './copy'
import { fmtCompact } from './fmt'
import type { OuroState, OuroUser } from './useOuro'

export function ClaimPanel({ state, user, onDone }: { state: OuroState; user: OuroUser; onDone: () => void }) {
  const c = useOuroCopy()
  const now = useNowSec()
  const l1 = useTxAction({ action: 'claim', onConfirmed: onDone })
  const vest = useTxAction({ action: 'claim', onConfirmed: onDone })

  const unlocked = now >= user.unlockAt
  const claimable = user.vestClaimable + (unlocked ? user.vestLocked : 0n)
  const locked = unlocked ? 0n : user.vestLocked
  const canClaimL1 = state.launched && !user.l1Claimed && user.l1Tokens > 0n

  if (user.l1Shares === 0n && user.vestLocked === 0n && user.vestClaimable === 0n) return null

  return (
    <Panel title={c.claimTitle}>
      <dl className="flex flex-col gap-2 text-note">
        {user.l1Shares > 0n && (
          <Row
            k={`${c.l1Claim} · ${user.l1Shares.toString()} ${c.shares}`}
            v={user.l1Claimed ? c.l1Claimed : state.launched ? fmtCompact(user.l1Tokens) : '—'}
          />
        )}
        <Row k={c.vestLocked} v={locked > 0n ? fmtCompact(locked) : c.nothing} />
        {locked > 0n && <Row k={c.unlockIn} v={formatCountdown(user.unlockAt - now)} />}
        <Row k={c.vestClaimable} v={claimable > 0n ? fmtCompact(claimable) : c.nothing} strong={claimable > 0n} />
      </dl>
      <div className="flex flex-wrap gap-3">
        {canClaimL1 && (
          <Button
            label={c.claimL1}
            onClick={() => OURO_MINT && l1.send({ address: OURO_MINT, abi: OURO_MINT_ABI, functionName: 'claimL1' })}
            disabled={l1.isBusy}
          />
        )}
        {claimable > 0n && (
          <Button
            label={c.claim}
            onClick={() => OURO_MINT && vest.send({ address: OURO_MINT, abi: OURO_MINT_ABI, functionName: 'claim' })}
            disabled={vest.isBusy}
          />
        )}
      </div>
    </Panel>
  )
}
