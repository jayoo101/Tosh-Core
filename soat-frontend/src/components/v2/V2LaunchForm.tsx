'use client'

import { useMemo, useState } from 'react'
import { encodeFunctionData, isAddress, keccak256, toHex, type Address, type Hex } from 'viem'
import { useAccount, useReadContracts } from 'wagmi'

import {
  ActionButton, Button, Card, Field, PageHeader, Readout, ReadoutGrid,
  revertOrder, useActionGate, useTxAction,
} from '@/components/ui'
import { fill, useT } from '@/i18n'
import { NATIVE_SYMBOL, TARGET_CHAIN_ID } from '@/lib/chain'
import { V2_FACTORY_ABI } from '@/lib/v2/abis'
import { V2_ENABLED, V2_FACTORY_BNB, V2_FACTORY_USDT } from '@/lib/v2/config'
import { fmtSig, parseAmount } from './fmt'

/** The hook accepts exactly these windows (`InvalidDuration` otherwise). */
const DURATIONS = [3, 24, 72] as const

type Stack = 'bnb' | 'usdt'

/**
 * The factory owner's v2 `createLaunch`. Sends it from a connected owner
 * wallet, or exports a Safe Transaction Builder batch when the owner is a Safe.
 */
export function V2LaunchForm() {
  const t = useT().v2
  const { address } = useAccount()
  const [stack, setStack] = useState<Stack>(V2_FACTORY_BNB ? 'bnb' : 'usdt')
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [developer, setDeveloper] = useState('')
  const [fund, setFund] = useState('')
  const [rawCap, setRawCap] = useState('')
  const [rawAgentCap, setRawAgentCap] = useState('')
  const [hours, setHours] = useState<(typeof DURATIONS)[number]>(24)
  const [salt] = useState<Hex>(() => keccak256(toHex(`${Date.now()}:${Math.random()}`)))

  const factory = stack === 'bnb' ? V2_FACTORY_BNB : V2_FACTORY_USDT
  const unit = stack === 'bnb' ? NATIVE_SYMBOL : 'USDT'
  const { data } = useReadContracts({
    contracts: factory
      ? (['owner', 'minHardCap', 'maxHardCap', 'minAgentCap', 'maxAgentCap'] as const).map(functionName => ({
          address: factory, abi: V2_FACTORY_ABI, functionName, chainId: TARGET_CHAIN_ID,
        }))
      : [],
    query: { enabled: !!factory },
  })
  const val = <T,>(i: number) => (data?.[i]?.status === 'success' ? (data[i].result as T) : undefined)
  const owner = val<Address>(0)
  const [minCap, maxCap, minAgent, maxAgent] = [val<bigint>(1), val<bigint>(2), val<bigint>(3), val<bigint>(4)]

  const hardCap = parseAmount(rawCap) ?? 0n
  // Equal bounds are a platform-wide allowance (BNB: ten 0.01 shares), not a choice.
  const fixedAgentCap = minAgent !== undefined && minAgent === maxAgent ? minAgent : undefined
  const agentCap = fixedAgentCap ?? parseAmount(rawAgentCap) ?? 0n
  const dev = isAddress(developer.trim()) ? (developer.trim() as Address) : undefined
  const fundAddr = isAddress(fund.trim()) ? (fund.trim() as Address) : undefined
  const args = useMemo(
    () => [name.trim(), symbol.trim(), dev!, fundAddr!, salt, hardCap, agentCap, BigInt(hours * 3600)] as const,
    [name, symbol, dev, fundAddr, salt, hardCap, agentCap, hours],
  )

  const problems: [string, boolean][] = [
    [t.lfNeedName, !name.trim() || !symbol.trim()],
    [t.lfNeedDeveloper, !dev],
    [t.lfNeedFund, !fundAddr],
    [fill(t.lfCapRange, { min: fmtSig(minCap), max: fmtSig(maxCap), unit }),
      minCap === undefined || maxCap === undefined || hardCap < minCap || hardCap > maxCap],
    [fill(t.lfAgentRange, { min: fmtSig(minAgent), max: fmtSig(maxAgent), unit }),
      minAgent === undefined || maxAgent === undefined || agentCap < minAgent || agentCap > maxAgent || agentCap > hardCap],
  ]
  const firstProblem = problems.find(([, bad]) => bad)?.[0]
  const isOwner = !!address && !!owner && address.toLowerCase() === owner.toLowerCase()

  const tx = useTxAction({ action: t.lfAction })
  const gate = useActionGate({
    action: t.lfSend,
    tx,
    onAct: () => tx.send({ address: factory!, abi: V2_FACTORY_ABI, functionName: 'createLaunch', args }),
    blockersInRevertOrder: revertOrder(
      { id: 'form', active: firstProblem !== undefined, label: t.lfSend, reason: firstProblem ?? '', tone: 'neutral' },
      { id: 'owner', active: !isOwner, label: t.lfSend, reason: fill(t.lfNotOwner, { owner: owner ?? '—' }), tone: 'neutral' },
    ),
  })

  const exportSafe = () => {
    const data = encodeFunctionData({ abi: V2_FACTORY_ABI, functionName: 'createLaunch', args })
    const batch = {
      version: '1.0',
      chainId: String(TARGET_CHAIN_ID),
      createdAt: Date.now(),
      meta: { name: `ToshX v2 createLaunch ${symbol.trim()}`, description: `${name.trim()} (${unit})` },
      transactions: [{ to: factory, value: '0', data, contractMethod: null, contractInputsValues: null }],
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(batch, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `toshx-v2-createLaunch-${symbol.trim() || 'token'}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!V2_ENABLED || (!V2_FACTORY_BNB && !V2_FACTORY_USDT)) {
    return <Card><p className="text-note text-text-secondary">{t.notDeployed}</p></Card>
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <PageHeader title={t.lfTitle} subtitle={t.lfBlurb} />
      <Card>
        <div className="flex gap-2">
          {V2_FACTORY_BNB && <Button size="sm" variant={stack === 'bnb' ? 'primary' : 'ghost'} label={NATIVE_SYMBOL} onClick={() => setStack('bnb')} />}
          {V2_FACTORY_USDT && <Button size="sm" variant={stack === 'usdt' ? 'primary' : 'ghost'} label="USDT" onClick={() => setStack('usdt')} />}
        </div>
        <Field label={t.lfName} value={name} onValueChange={setName} />
        <Field label={t.lfSymbol} value={symbol} onValueChange={setSymbol} />
        <Field label={t.lfDeveloper} value={developer} onValueChange={setDeveloper} placeholder="0x…" hint={t.lfDeveloperHint} />
        <Field label={t.lfFund} value={fund} onValueChange={setFund} placeholder="0x…" hint={t.lfFundHint} />
        <Field label={`${t.hardCap} (${unit})`} value={rawCap} onValueChange={setRawCap} inputMode="decimal"
          hint={fill(t.lfCapRange, { min: fmtSig(minCap), max: fmtSig(maxCap), unit })} />
        {fixedAgentCap !== undefined ? (
          <Readout label={`${t.perAgentCap} (${unit})`} value={fmtSig(fixedAgentCap)} />
        ) : (
          <Field label={`${t.perAgentCap} (${unit})`} value={rawAgentCap} onValueChange={setRawAgentCap} inputMode="decimal"
            hint={fill(t.lfAgentRange, { min: fmtSig(minAgent), max: fmtSig(maxAgent), unit })} />
        )}
        <div className="flex items-center gap-2">
          <span className="text-label text-text-tertiary">{t.lfDuration}</span>
          {DURATIONS.map(h => (
            <Button key={h} size="sm" variant={hours === h ? 'primary' : 'ghost'} label={`${h}h`} onClick={() => setHours(h)} />
          ))}
        </div>
        <ReadoutGrid columns={2}>
          <Readout label={t.lfOwner} value={owner ?? '—'} />
          <Readout label={t.lfSalt} value={`${salt.slice(0, 10)}…`} />
        </ReadoutGrid>
        <ActionButton gate={gate} />
        <Button variant="ghost" label={t.lfExport} disabled={firstProblem !== undefined} onClick={exportSafe} />
        <p className="text-label text-text-tertiary">{t.lfAfter}</p>
      </Card>
    </div>
  )
}
