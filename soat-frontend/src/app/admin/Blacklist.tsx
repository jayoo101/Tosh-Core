'use client'

/**
 * G3-C · BLACKLIST — batch bans, plus a single-wallet release.
 *
 * The textarea is deliberately forgiving about what it is fed and strict about
 * what it sends: rows are classified, counted and shown before anything is
 * signed, and only the valid ones go on the wire.
 */

import { useState, useCallback, useMemo } from 'react'
import { useReadContract } from 'wagmi'
import { isAddress, getAddress, type Abi, type Address } from 'viem'
import {
  FACTORY_ABI,
  FACTORY_ADDRESS,
  ADMIN_BATCH_MAX,
  BAN_DURATIONS,
  type BanDurationKey,
} from '@/lib/contracts'
import {
  ActionButton, useActionGate, useTxAction, revertOrder,
  classifyHorizon, formatHorizonUtc,
  type ActionBlocker,
} from '@/components/ui'
import {
  Line,
  Section,
  labelCls,
  ScopeNote,
  Field,
  TextAreaField,
  parseAddressGrid,
  useNowSec,
  type AddressRowStatus,
  type ParsedAddressRow,
} from './shared'

export const ROW_TAG: Record<AddressRowStatus, { tag: string; cls: string }> = {
  'valid':     { tag: '[OK]  ', cls: 'text-text-primary' },
  'duplicate': { tag: '[DUP] ', cls: 'text-text-tertiary' },
  'invalid':   { tag: '[ERR] ', cls: 'text-danger' },
  'over-cap':  { tag: '[CAP] ', cls: 'text-text-tertiary' },
}

export function BlacklistRowList({ rows }: { rows: ParsedAddressRow[] }) {
  const RENDER_CAP   = 250
  const renderedRows = rows.slice(0, RENDER_CAP)
  const truncated    = rows.length - renderedRows.length

  return (
    <div className="border border-border-subtle rounded-lg overflow-hidden">
      <div className="grid grid-cols-[3rem_5rem_1fr] gap-3 px-3 py-1.5 border-b border-border-subtle
                      text-label tracking-[0.32em] uppercase text-text-tertiary">
        <span>idx</span>
        <span>state</span>
        <span>address</span>
      </div>
      <div className="max-h-72 overflow-y-auto divide-y divide-border-subtle/60 font-mono">
        {renderedRows.map(row => {
          const t = ROW_TAG[row.status]
          return (
            <div
              key={`${row.index}-${row.raw}`}
              className="grid grid-cols-[3rem_5rem_1fr] gap-3 items-center px-3 py-1 text-note tabular-nums"
            >
              <span className="text-text-quiet">
                {row.index.toString(16).toUpperCase().padStart(3, '0')}
              </span>
              <span className={t.cls}>{t.tag}</span>
              <span className={`break-all ${row.status === 'invalid' ? 'text-danger' : 'text-text-secondary'}`}>
                {row.display}
              </span>
            </div>
          )
        })}
      </div>
      {truncated > 0 && (
        <p className="px-3 py-1.5 text-center text-label text-text-tertiary border-t border-border-subtle tracking-wider">
          +{truncated} ROWS BUFFERED · DUMP CAPPED AT {RENDER_CAP}
        </p>
      )}
    </div>
  )
}

/** Single-address lift, kept separate from the batch textarea. */
export function SingleLiftRow() {
  const [addr, setAddr] = useState('')
  const nowSec = useNowSec()

  const trimmed = addr.trim()
  const valid   = trimmed !== '' && isAddress(trimmed)

  const { data: bannedUntil, refetch } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'blacklistedUntil',
    args: valid ? [getAddress(trimmed)] : undefined,
    query: { enabled: valid },
  })

  const tx = useTxAction({
    action: 'lift the ban',
    onConfirmed: () => { void refetch() },
  })

  const until = bannedUntil as bigint | undefined
  // `setBlacklist` stores `type(uint256).max` verbatim but any other duration as
  // `block.timestamp + duration`, so an unreachable ban need not equal the
  // sentinel.  Testing for the sentinel alone let such a stamp reach `Date` and
  // take the panel down with a RangeError.
  const banHorizon = classifyHorizon(until ?? 0n, nowSec)
  const isBanned   = banHorizon.kind === 'pending' || banHorizon.kind === 'unbounded'
  const bannedUntilTxt = banHorizon.kind === 'pending'
    ? (formatHorizonUtc(banHorizon, 'second') ?? 'PERMANENT')
    : 'PERMANENT'

  const gate = useActionGate({
    action: 'Lift single ban',
    onAct: () => {
      if (!valid) return
      tx.send({
        address: FACTORY_ADDRESS,
        abi: FACTORY_ABI as unknown as Abi,
        functionName: 'liftBlacklist',
        args: [[getAddress(trimmed)]],
      })
    },
    tx,
    blockersInRevertOrder: revertOrder(
      {
        id: 'address-missing',
        active: trimmed === '',
        label: 'Enter an address',
        reason: 'Paste the wallet to release.',
        tone: 'neutral',
      },
      {
        id: 'address-invalid',
        active: trimmed !== '' && !valid,
        label: '[not_an_address]',
        reason: 'That is not a well-formed 20-byte address.',
      },
      {
        id: 'ban-lookup-pending',
        active: valid && until === undefined,
        label: 'Reading ban status…',
        reason: 'Waiting on blacklistedUntil for this wallet.',
        tone: 'neutral',
      },
      {
        id: 'not-banned',
        active: valid && until !== undefined && !isBanned,
        label: '[not_banned]',
        reason: 'This wallet is not currently banned, so there is nothing to lift.',
        tone: 'neutral',
      },
    ),
  })

  return (
    <div className="flex flex-col gap-3 pt-2">
      <Field
        label="SINGLE-ADDRESS LIFT · LOOKUP + RELEASE"
        value={addr}
        onChange={setAddr}
        placeholder="0x… one wallet to release"
        disabled={tx.isBusy}
        errored={trimmed.length > 0 && !valid}
        fluo={valid && isBanned}
        hint={valid && isBanned
          ? <span className="text-danger">→ BANNED UNTIL {bannedUntilTxt}</span>
          : null}
      />
      <ActionButton gate={gate} size="sm" full={false} />
    </div>
  )
}

export function BlacklistConsole() {
  const [addresses, setAddresses] = useState('')
  const [duration, setDuration]   = useState<BanDurationKey>('24 HOURS')

  const tx = useTxAction({ action: 'update the blacklist' })

  const rows   = useMemo(() => parseAddressGrid(addresses), [addresses])
  const counts = useMemo(() => {
    const c = { valid: 0, duplicate: 0, invalid: 0, overCap: 0 }
    for (const r of rows) {
      if      (r.status === 'valid')     c.valid++
      else if (r.status === 'duplicate') c.duplicate++
      else if (r.status === 'invalid')   c.invalid++
      else if (r.status === 'over-cap')  c.overCap++
    }
    return c
  }, [rows])

  const sendable = useMemo<Address[]>(
    () => rows.filter(r => r.status === 'valid').map(r => r.display as Address),
    [rows],
  )
  const overBatchLimit = counts.overCap > 0

  const send = useCallback((functionName: 'setBlacklist' | 'liftBlacklist') => {
    if (sendable.length === 0) return
    tx.send({
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI as unknown as Abi,
      functionName,
      args: functionName === 'setBlacklist'
        ? [sendable, BAN_DURATIONS[duration]]
        : [sendable],
    })
  }, [sendable, duration, tx])

  // Both levers send the same list, so they refuse for the same reason.
  const emptyBatch: ActionBlocker = {
    id: 'no-sendable-addresses',
    active: sendable.length === 0,
    label: addresses.trim() === '' ? 'Paste addresses' : '[no_valid_addresses]',
    reason: addresses.trim() === ''
      ? 'Paste one or more wallets above, one per line or comma-separated.'
      : 'Nothing in that dump parsed as a fresh, valid address.',
    tone: addresses.trim() === '' ? 'neutral' : 'danger',
  }

  const banGate = useActionGate({
    action: `Engage ban · ${sendable.length}`,
    onAct: () => send('setBlacklist'),
    tx,
    blockersInRevertOrder: revertOrder(emptyBatch),
  })

  const liftGate = useActionGate({
    action: `Lift batch · ${sendable.length}`,
    onAct: () => send('liftBlacklist'),
    tx,
    blockersInRevertOrder: revertOrder(emptyBatch),
  })

  return (
    <Section
      id="G3-C" title="BLACKLIST BATCH"
      subtitle={`setBlacklist / liftBlacklist · hard cap ${ADMIN_BATCH_MAX} wallets per transaction`}
    >
      <TextAreaField
        label={`TARGET DUMP · ONE PER LINE OR COMMA-SEPARATED (MAX ${ADMIN_BATCH_MAX})`}
        value={addresses}
        onChange={setAddresses}
        placeholder={'0xAbCdEf…\n0x1234567…'}
        rows={4}
        disabled={tx.isBusy}
      />

      <div className="grid grid-cols-4 border border-border-subtle divide-x divide-border-subtle rounded-lg overflow-hidden">
        {([
          ['VALID',     counts.valid,     'text-text-primary'],
          ['DUPLICATE', counts.duplicate, 'text-text-tertiary'],
          ['INVALID',   counts.invalid,   counts.invalid > 0 ? 'text-danger' : 'text-text-quiet'],
          ['OVERCAP',   counts.overCap,   counts.overCap > 0 ? 'text-danger' : 'text-text-quiet'],
        ] as const).map(([label, value, cls]) => (
          <div key={label} className="px-3 py-2 flex flex-col gap-1">
            <span className={labelCls}>{label}</span>
            <span className={`font-mono text-base font-bold tabular-nums ${cls}`}>
              {value.toString().padStart(3, '0')}
            </span>
          </div>
        ))}
      </div>

      {rows.length > 0 && <BlacklistRowList rows={rows} />}

      {overBatchLimit && (
        <p className="font-mono text-label tracking-[0.32em] uppercase text-danger">
          → BATCH OVER {ADMIN_BATCH_MAX} · rows past index {ADMIN_BATCH_MAX - 1} dropped from the wire
        </p>
      )}

      <label className="flex flex-col gap-1.5">
        <span className={labelCls}>BAN DURATION</span>
        <select
          value={duration}
          onChange={e => setDuration(e.target.value as BanDurationKey)}
          disabled={tx.isBusy}
          className="bg-surface-card/50 border border-border-subtle focus:border-brand rounded-lg
                     px-3 py-2.5 font-mono text-sm text-text-primary tabular-nums
                     transition-colors duration-150 disabled:opacity-40"
        >
          {(Object.keys(BAN_DURATIONS) as BanDurationKey[]).map(d => (
            <option key={d} value={d} className="bg-bg-base text-text-primary">{d}</option>
          ))}
        </select>
      </label>

      <ScopeNote>
        Durations are relative: the contract stores block.timestamp + duration.
        PERMANENT is the type(uint256).max sentinel, which the contract writes
        verbatim instead of adding, so it never overflows and never expires.
      </ScopeNote>

      <div className="flex items-start gap-4 flex-wrap">
        <ActionButton gate={banGate} full={false} intent="danger" />
        <ActionButton gate={liftGate} full={false} showReason={false} />
      </div>

      <Line className="mt-2" />
      <SingleLiftRow />
    </Section>
  )
}
