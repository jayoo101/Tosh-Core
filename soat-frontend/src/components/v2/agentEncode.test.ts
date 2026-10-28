import { describe, expect, it } from 'vitest'
import { decodeFunctionData, erc20Abi } from 'viem'

import { V2_BIDBOOK_ABI, V2_HOOK_ABI } from '@/lib/v2/abis'
import { encode } from './agentEncode'

const HOOK = '0x00000000000000000000000000000000000000aa'
const BOOK = '0x00000000000000000000000000000000000000bb'

/** The instructions an Agent executes are generated, never typed: they must decode back to the same call. */
describe('Agent step encoding', () => {
  it('buyGenesis carries signature, arguments and value', () => {
    const e = encode({ note: 'buy', to: HOOK, abi: V2_HOOK_ABI, functionName: 'buyGenesis', args: [5n * 10n ** 17n, 123n], value: 5n * 10n ** 17n })
    expect(e.signature).toBe('buyGenesis(uint256,uint256)')
    expect(e.args).toBe('500000000000000000, 123')
    expect(e.value).toBe(5n * 10n ** 17n)
    expect(decodeFunctionData({ abi: V2_HOOK_ABI, data: e.data }).args).toEqual([5n * 10n ** 17n, 123n])
  })

  it('fill formats its id and qty arrays', () => {
    const e = encode({ note: 'sell', to: BOOK, abi: V2_BIDBOOK_ABI, functionName: 'fill', args: [HOOK, [1n, 2n], [3n, 4n], 9n] })
    expect(e.signature).toBe('fill(address,uint256[],uint256[],uint256)')
    expect(e.args).toBe(`${HOOK}, [1, 2], [3, 4], 9`)
    expect(e.value).toBe(0n)
  })

  it('a no-argument call encodes to its selector', () => {
    const e = encode({ note: 'launch', to: HOOK, abi: V2_HOOK_ABI, functionName: 'launch' })
    expect(e.signature).toBe('launch()')
    expect(e.data).toHaveLength(10)
  })

  it('approve decodes back to spender and amount', () => {
    const e = encode({ note: 'approve', to: HOOK, abi: erc20Abi, functionName: 'approve', args: [BOOK, 7n] })
    expect(decodeFunctionData({ abi: erc20Abi, data: e.data }).args).toEqual([BOOK, 7n])
  })

  it('refuses a function the ABI does not have', () => {
    expect(() => encode({ note: 'x', to: HOOK, abi: erc20Abi, functionName: 'nope' })).toThrow()
  })
})
