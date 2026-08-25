'use client'


import { useState, useCallback, useEffect, useMemo } from 'react'
import {
  useBalance,
  useReadContract,
  useReadContracts,
  useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi'
import { isAddress, getAddress, type Address } from 'viem'
import {
  FACTORY_ABI,
  FACTORY_ADDRESS,
  HOOK_ABI,
  TREASURY_ABI,
  LADDER_TREASURY_ADDRESS,
  hasLadderTreasury,
  TARGET_CHAIN_ID,
  DEAD_ADDRESS,
  ZERO_ADDRESS,
} from '@/lib/contracts'
import {
  Section,
  labelCls,
  ScopeNote,
  Field,
  WriteButton,
  Readout,
  AlarmLine,
  TxLine,
  AddressLink,
  StatusBadge,
  ConfirmDialog,
  fmtEth,
  shortErr,
} from './shared'

// ─────────────────────────────────────────────────────────────────────────────
// G4 · LADDER TREASURY CURATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors `ToshLadderTreasury.addLadderToken`'s own admission test before the
 * wallet opens.  Two conditions, in order:
 *
 *   1. `factory.tokenToHook(token) != 0` — this platform launched the token.
 *   2. that hook has already run `launch()` — an unlaunched hook has no pool
 *      key, so the treasury's `InvalidPoolKey` arm would reject it.
 *
 * Checking condition 2 here is what turns an opaque on-chain revert into an
 * explanation the operator can act on.
 */
export function useLadderTokenEligibility(raw: string) {
  const trimmed = raw.trim()
  const valid   = !!trimmed && isAddress(trimmed)
  const token   = valid ? getAddress(trimmed) : undefined

  const { data: hookAddr, isLoading: hookLoading } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'tokenToHook',
    args: token ? [token] : undefined,
    query: { enabled: !!token },
  })

  const hook       = hookAddr as Address | undefined
  const knownToken = !!hook && hook !== ZERO_ADDRESS

  const { data: launchedRaw, isLoading: launchedLoading } = useReadContract({
    address: hook, abi: HOOK_ABI, functionName: 'launched',
    query: { enabled: knownToken },
  })

  return {
    trimmed,
    valid,
    token,
    hook,
    knownToken,
    hookLoading,
    launched: launchedRaw === true,
    launchedLoading: knownToken && launchedLoading,
  }
}

export function LadderTreasuryPanel() {
  const [tokenInput, setTokenInput] = useState('')
  const [error, setError]           = useState<string | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState<Address | null>(null)

  const treasury = LADDER_TREASURY_ADDRESS as Address

  // ── Treasury state ────────────────────────────────────────────────────────
  const { data: coreData, refetch: refetchCore } = useReadContracts({
    contracts: [
      { address: treasury, abi: TREASURY_ABI, functionName: 'ladderTokenCount' },
      { address: treasury, abi: TREASURY_ABI, functionName: 'currentCursor' },
      { address: treasury, abi: TREASURY_ABI, functionName: 'nextSpendAmount' },
      { address: treasury, abi: TREASURY_ABI, functionName: 'factory' },
    ],
    query: { enabled: hasLadderTreasury, refetchInterval: 12_000 },
  })

  const tokenCount  = (coreData?.[0]?.result as bigint | undefined) ?? 0n
  const cursor      = (coreData?.[1]?.result as bigint | undefined) ?? 0n
  const nextSpend   = coreData?.[2]?.result as bigint | undefined
  const boundFactory = coreData?.[3]?.result as Address | undefined

  const { data: treasuryBalance, refetch: refetchBalance } = useBalance({
    address: treasury,
    query: { enabled: hasLadderTreasury, refetchInterval: 12_000 },
  })

  // ── The listed tokens themselves ──────────────────────────────────────────
  const indices = useMemo(
    () => Array.from({ length: Number(tokenCount) }, (_, i) => BigInt(i)),
    [tokenCount],
  )
  const { data: tokenData, refetch: refetchTokens } = useReadContracts({
    contracts: indices.map(i => ({
      address: treasury, abi: TREASURY_ABI, functionName: 'ladderTokens', args: [i],
    })),
    query: { enabled: hasLadderTreasury && indices.length > 0 },
  })
  const listed = useMemo<Address[]>(
    () => (tokenData ?? [])
      .map(r => r.result as Address | undefined)
      .filter((a): a is Address => !!a),
    [tokenData],
  )

  // ── Add-token precheck ────────────────────────────────────────────────────
  const {
    trimmed, valid, token, hook, knownToken, hookLoading, launched, launchedLoading,
  } = useLadderTokenEligibility(tokenInput)

  const alreadyListed = !!token && listed.some(t => t.toLowerCase() === token.toLowerCase())

  const { writeContract, isPending, data: txHash, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => {
    if (!isSuccess) return
    void refetchCore()
    void refetchTokens()
    void refetchBalance()
  }, [isSuccess, refetchCore, refetchTokens, refetchBalance])

  const txBusy = isPending || isConfirming

  const eligibility: { ok: boolean; note: React.ReactNode } = (() => {
    if (!trimmed)        return { ok: false, note: null }
    if (!valid)          return { ok: false, note: <span className="text-danger">→ NOT_A_VALID_ADDRESS</span> }
    if (hookLoading)     return { ok: false, note: <span className="text-text-tertiary">→ resolving factory.tokenToHook…</span> }
    if (!knownToken)     return { ok: false, note: <span className="text-danger">→ NOT_LAUNCHED_HERE · factory.tokenToHook returned 0</span> }
    if (alreadyListed)   return { ok: false, note: <span className="text-text-tertiary">→ ALREADY_LISTED</span> }
    if (launchedLoading) return { ok: false, note: <span className="text-text-tertiary">→ reading hook.launched()…</span> }
    if (!launched) {
      return {
        ok: false,
        note: <span className="text-danger">→ HOOK_NOT_LAUNCHED · no pool key yet, treasury would revert InvalidPoolKey</span>,
      }
    }
    return {
      ok: true,
      note: <span className="text-brand">→ HOOK {hook!.slice(0, 10)}… · LAUNCHED · ELIGIBLE</span>,
    }
  })()

  const handleAdd = useCallback(() => {
    setError(null)
    if (!eligibility.ok || !token) return
    writeContract({
      address: treasury, abi: TREASURY_ABI, functionName: 'addLadderToken',
      args: [token],
      chainId: TARGET_CHAIN_ID,
    })
  }, [eligibility.ok, token, treasury, writeContract])

  const handleRemove = useCallback(() => {
    if (!pendingRemoval) return
    const target = pendingRemoval
    setPendingRemoval(null)
    setError(null)
    writeContract({
      address: treasury, abi: TREASURY_ABI, functionName: 'removeLadderToken',
      args: [target],
      chainId: TARGET_CHAIN_ID,
    })
  }, [pendingRemoval, treasury, writeContract])

  if (!hasLadderTreasury) {
    return (
      <Section
        id="G4-A" title="LADDER TREASURY CURATION"
        subtitle="addLadderToken / removeLadderToken · buyback round-robin roster"
      >
        <ScopeNote tone="warn">
          NEXT_PUBLIC_TREASURY_ADDRESS is not set, so this panel has no contract
          to talk to. Add the deployed ToshLadderTreasury address to
          .env.local and restart the dev server.
        </ScopeNote>
      </Section>
    )
  }

  return (
    <Section
      id="G4-A" title="LADDER TREASURY CURATION"
      subtitle="addLadderToken / removeLadderToken · the round-robin roster the piggyback buyback spends against"
      action={<StatusBadge ok={listed.length > 0} okLabel={`${listed.length} listed`} badLabel="empty roster" />}
    >
      <Readout label="TREASURY" value={<AddressLink addr={treasury} />} />
      <Readout label="BOUND FACTORY" value={<AddressLink addr={boundFactory} />}
               hint={boundFactory && boundFactory.toLowerCase() !== FACTORY_ADDRESS.toLowerCase()
                 ? 'MISMATCH — this treasury is bound to a different factory'
                 : null} />
      <Readout label="TREASURY ETH BALANCE" value={fmtEth(treasuryBalance?.value)} tone="fluo" />
      <Readout label="ROUND-ROBIN CURSOR" value={`${cursor.toString()} / ${tokenCount.toString()}`} />
      <Readout label="NEXT SPEND PER TRIGGER" value={fmtEth(nextSpend)} />

      <ScopeNote>
        One-way valve by construction. The treasury has no withdraw, no transfer
        and no owner payout path — the only exit for a wei that lands here is
        _buyAndBurn, which swaps ETH for a listed token and sends the proceeds to{' '}
        <span className="text-text-secondary">{DEAD_ADDRESS}</span>. Owner authority on
        this contract is curation only.
      </ScopeNote>
      <ScopeNote tone="warn">
        Curation is not neutral, though. That guarantee is about custody, not
        beneficiaries: nobody can take this ETH, but the roster below decides
        which order books absorb it, and buying pressure that ends in a burn is
        still buying pressure. Narrowing the roster to one token points what is
        left of the reservoir at a single price.
        <br /><br />
        Two things bound that, and neither is the valve. Each cycle&apos;s spend is
        divided by the batch size of 3 rather than by the number of listings, so
        a one-token roster deploys a third of the rate a full one does; and the
        buyback&apos;s sqrt floor refuses to fill more than ~10 % above a pool&apos;s
        TWAP, which rate-limits the rest. Treat curation as an economic dial and
        keep it behind the same multisig review as the others.
      </ScopeNote>

      {/* ── Roster ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5">
        <span className={labelCls}>LISTED TOKENS</span>
        {listed.length === 0 ? (
          <p className="text-note font-mono text-text-tertiary py-3">
            roster empty — buybacks are inert until at least one token is listed
          </p>
        ) : (
          <div className="border border-border-subtle rounded-lg divide-y divide-border-subtle/60">
            {listed.map((t, i) => (
              <div key={t} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-mono text-label text-text-quiet tabular-nums">
                    {i.toString().padStart(2, '0')}
                  </span>
                  {BigInt(i) === cursor && (
                    <span className="text-micro font-mono tracking-widest text-brand">▸NEXT</span>
                  )}
                  <span className="font-mono text-note text-text-secondary break-all">
                    <AddressLink addr={t} />
                  </span>
                </div>
                <WriteButton
                  label="remove"
                  onClick={() => setPendingRemoval(t)}
                  busy={txBusy}
                  small
                  danger
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Add ─────────────────────────────────────────────────────────── */}
      <Field
        label="ADD TOKEN · MUST BE LAUNCHED BY THIS FACTORY"
        value={tokenInput}
        onChange={v => { setTokenInput(v); setError(null) }}
        placeholder="0x… project token address"
        disabled={txBusy}
        errored={!!trimmed && !eligibility.ok && !hookLoading}
        fluo={eligibility.ok}
        hint={eligibility.note}
      />
      <div className="flex justify-start">
        <WriteButton
          label="list token"
          onClick={handleAdd}
          locked={!eligibility.ok}
          busy={txBusy}
        />
      </div>

      <AlarmLine msg={error ?? shortErr(writeError)} />
      <TxLine hash={txHash} label="addLadderToken / removeLadderToken" />

      <ConfirmDialog
        open={!!pendingRemoval}
        title="Delist from the buyback roster?"
        body={
          <>
            <p className="break-all text-text-secondary">{pendingRemoval}</p>
            <p className="mt-3 text-text-tertiary">
              Removal is swap-and-pop: the last entry moves into this slot and the
              round-robin cursor is re-modulated against the shorter array. The
              rotation order changes for the remaining tokens — that is expected,
              the cursor only has to stay in range and be eventually fair.
            </p>
          </>
        }
        confirmLabel="delist"
        onConfirm={handleRemove}
        onCancel={() => setPendingRemoval(null)}
        danger
      />
    </Section>
  )
}
