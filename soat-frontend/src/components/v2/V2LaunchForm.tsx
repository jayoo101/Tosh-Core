'use client'

import { useRef, useState } from 'react'
import { encodeFunctionData, getAddress, keccak256, toHex, zeroAddress, type Address, type Hex } from 'viem'
import { useAccount, useReadContracts } from 'wagmi'

import {
  ActionButton, Button, Card, Field, PageHeader, Readout,
  revertOrder, useActionGate, useTxAction,
} from '@/components/ui'
import { fill, useT } from '@/i18n'
import { NATIVE_SYMBOL, TARGET_CHAIN_ID } from '@/lib/chain'
import { V2_FACTORY_ABI, V2_GATEWAY_ABI } from '@/lib/v2/abis'
import { V2_ENABLED, V2_FACTORY_BNB, V2_FACTORY_USDT } from '@/lib/v2/config'
import { fmtSig, parseAmount } from './fmt'
import { ProjectInfoPanel } from './ProjectInfoPanel'

/** The hook accepts exactly these windows (`InvalidDuration` otherwise). */
const DURATIONS = [3, 24, 72] as const

/** Downloads a Safe Transaction Builder file with one call. */
function downloadSafeBatch(to: Address, data: Hex, label: string, description: string, file: string) {
  const batch = {
    version: '1.0',
    chainId: String(TARGET_CHAIN_ID),
    createdAt: Date.now(),
    meta: { name: label, description },
    transactions: [{ to, value: '0', data, contractMethod: null, contractInputsValues: null }],
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(batch, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = file
  a.click()
  URL.revokeObjectURL(url)
}

const short = (a: string | undefined) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—')

function checksummed(raw: string): Address | undefined {
  try {
    return getAddress(raw.trim())
  } catch {
    return undefined
  }
}

type Stack = 'bnb' | 'usdt'

/**
 * The factory owner's v2 `createLaunch`. Sends it from a connected owner
 * wallet, or exports a Safe Transaction Builder batch when the owner is a Safe.
 *
 * When the factory is owned by a `ToshLaunchGateway` (the live setup), the
 * call goes to the gateway instead, which the Safe and each of its current
 * signers may send.
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
  const [launchTx, setLaunchTx] = useState<Hex | undefined>()
  // Drawn on first use, not during render, where server and browser would draw different ones.
  const saltRef = useRef<Hex | null>(null)

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

  // `safe()` answering is what marks the owner as a gateway; a Safe or an EOA owner fails it.
  const { data: gw } = useReadContracts({
    contracts: owner
      ? [
          { address: owner, abi: V2_GATEWAY_ABI, functionName: 'safe', chainId: TARGET_CHAIN_ID },
          { address: owner, abi: V2_GATEWAY_ABI, functionName: 'canLaunch', args: [address ?? zeroAddress], chainId: TARGET_CHAIN_ID },
        ]
      : [],
    query: { enabled: !!owner },
  })
  const gatewaySafe = gw?.[0]?.status === 'success' ? gw[0].result : undefined
  const gateway = gatewaySafe ? owner : undefined
  const target = gateway ?? factory

  const hardCap = parseAmount(rawCap) ?? 0n
  // Equal bounds are a platform-wide allowance (BNB: ten 0.01 shares), not a choice.
  const fixedAgentCap = minAgent !== undefined && minAgent === maxAgent ? minAgent : undefined
  const agentCap = fixedAgentCap ?? parseAmount(rawAgentCap) ?? 0n
  const dev = checksummed(developer)
  const fundAddr = checksummed(fund)
  const args = () => {
    saltRef.current ??= keccak256(toHex(`${Date.now()}:${Math.random()}`))
    return [name.trim(), symbol.trim(), dev!, fundAddr!, saltRef.current, hardCap, agentCap, BigInt(hours * 3600)] as const
  }

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
  const canSend = gateway
    ? !!address && gw?.[1]?.status === 'success' && gw[1].result === true
    : !!address && !!owner && address.toLowerCase() === owner.toLowerCase()

  const tx = useTxAction({ action: t.lfAction, onConfirmed: r => setLaunchTx(r.transactionHash) })
  const gate = useActionGate({
    action: t.lfSend,
    tx,
    onAct: () => gateway
      ? tx.send({ address: gateway, abi: V2_GATEWAY_ABI, functionName: 'createLaunch', args: args() })
      : tx.send({ address: factory!, abi: V2_FACTORY_ABI, functionName: 'createLaunch', args: args() }),
    blockersInRevertOrder: revertOrder(
      { id: 'form', active: firstProblem !== undefined, label: t.lfSend, reason: firstProblem ?? '', tone: 'neutral' },
      { id: 'owner', active: !canSend, label: t.lfSend,
        reason: gatewaySafe ? fill(t.lfNotSigner, { safe: gatewaySafe }) : fill(t.lfNotOwner, { owner: owner ?? '—' }), tone: 'neutral' },
    ),
  })

  const exportSafe = () => {
    if (!target) return
    const data = encodeFunctionData({ abi: V2_FACTORY_ABI, functionName: 'createLaunch', args: args() })
    downloadSafeBatch(target, data, `ToshX v2 createLaunch ${symbol.trim()}`, `${name.trim()} (${unit})`,
      `toshx-v2-createLaunch-${symbol.trim() || 'token'}.json`)
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
          <div className="flex flex-col gap-1">
            <Readout label={`${t.perAgentCap} (${unit})`} value={fmtSig(fixedAgentCap)} />
            <p className="text-label text-text-quiet">{t.lfAgentFixed}</p>
          </div>
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
        {gatewaySafe
          ? <Readout label={t.lfGatewaySafe} value={short(gatewaySafe)} />
          : <Readout label={t.lfOwner} value={short(owner)} />}
        <ActionButton gate={gate} />
        <Button variant="ghost" label={t.lfExport} disabled={firstProblem !== undefined} onClick={exportSafe} />
        <p className="text-label text-text-tertiary">{t.lfAfter}</p>
      </Card>
      <ProjectInfoPanel launchTx={launchTx} />
    </div>
  )
}
