'use client'

/**
 * What is left of the terminal's local primitives.
 *
 * `Section`, `Readout`, `ProgressBar`, `Field` and `WriteButton` have all moved
 * to `@/components/ui` — as `Card`, `Readout`, `Progress`, `Field` and
 * `ActionButton` + `useActionGate`.  These two have not: `AlarmLine` and
 * `TxLine` belong to the toast and `AddressLink` surfaces.
 */

import { useWaitForTransactionReceipt } from 'wagmi'

import { basescanTx } from './format'

export function AlarmLine({ msg }: { msg: string | null }) {
  if (!msg) return null
  return (
    <p className="text-[10px] font-mono text-[#888] tracking-wider leading-relaxed">
      <span className="text-danger">[REVERT]</span> {msg}
    </p>
  )
}

export function TxLine({ hash, label }: { hash?: `0x${string}`; label: string }) {
  const { isLoading, isSuccess } = useWaitForTransactionReceipt({ hash })
  if (!hash) return null
  const stateTxt = isLoading
    ? 'CONFIRMING'
    : isSuccess ? 'ACKNOWLEDGED' : 'PENDING'
  const tone = isSuccess ? 'text-brand' : 'text-[#888]'
  return (
    <p className="text-[10px] font-mono tracking-wider flex items-center gap-3 flex-wrap">
      <span className={tone}>[TX]</span>
      <span className="text-[#888]">{label}</span>
      <span className={tone}>{stateTxt}</span>
      <a href={basescanTx(hash)} target="_blank" rel="noopener noreferrer"
         className="text-[#555] hover:text-brand break-all">
        {hash.slice(0, 10)}…{hash.slice(-6)}
      </a>
    </p>
  )
}
