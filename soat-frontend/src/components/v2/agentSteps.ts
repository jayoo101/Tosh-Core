import { erc20Abi, type Address } from 'viem'

import { WRAP_VARS } from '@/components/ProjectTerminal/useWrapNative'
import { fill, type useT } from '@/i18n'
import { WRAPPED_NATIVE_ABI } from '@/lib/quoteAssets'
import type { V2Quote } from '@/lib/v2/config'
import type { AgentStep } from './AgentModeSheet'
import { fmtSig } from './fmt'

type Dict = ReturnType<typeof useT>

/** Wrap (on a BNB stack) and approve `amount` of the quote asset for `spender`. */
export function prepSteps(quote: V2Quote, spender: Address, amount: bigint, t: Dict['v2']): AgentStep[] {
  const steps: AgentStep[] = []
  if (quote.native) {
    steps.push({
      note: fill(t.agentNoteWrap, { ...WRAP_VARS, amount: fmtSig(amount) }),
      to: quote.asset, abi: WRAPPED_NATIVE_ABI, functionName: 'deposit', value: amount,
    })
  }
  steps.push(approveStep(quote.asset, quote.native ? WRAP_VARS.wrapped : quote.symbol, spender, amount, t))
  return steps
}

export function approveStep(token: Address, symbol: string, spender: Address, amount: bigint, t: Dict['v2']): AgentStep {
  return {
    note: fill(t.agentNoteApprove, { amount: fmtSig(amount), symbol, spender }),
    to: token, abi: erc20Abi, functionName: 'approve', args: [spender, amount],
  }
}
