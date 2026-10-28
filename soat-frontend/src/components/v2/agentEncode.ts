import { encodeFunctionData, type Abi, type AbiFunction, type Address, type Hex } from 'viem'

/** One contract call, generated from live state. The user never types these. */
export interface AgentStep {
  note: string
  to: Address
  abi: Abi
  functionName: string
  args?: readonly unknown[]
  value?: bigint
}

export interface EncodedStep { note: string; to: Address; signature: string; args: string; value: bigint; data: Hex }

function fmtArg(v: unknown): string {
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return `[${v.map(fmtArg).join(', ')}]`
  return String(v)
}

export function encode(s: AgentStep): EncodedStep {
  const args = s.args ?? []
  const fn = s.abi.find(
    (i): i is AbiFunction => i.type === 'function' && i.name === s.functionName && i.inputs.length === args.length,
  )
  if (!fn) throw new Error(`AgentModeSheet: ${s.functionName}/${args.length} is not in the ABI`)
  return {
    note: s.note,
    to: s.to,
    signature: `${fn.name}(${fn.inputs.map(i => i.type).join(',')})`,
    args: args.map(fmtArg).join(', '),
    value: s.value ?? 0n,
    data: encodeFunctionData({ abi: [fn], functionName: fn.name, args } as Parameters<typeof encodeFunctionData>[0]),
  }
}
