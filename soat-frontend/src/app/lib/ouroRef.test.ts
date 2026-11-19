import { describe, expect, it, vi } from 'vitest'
import { verifyMessage } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

vi.mock('@/app/lib/serverRpc', () => ({
  serverPublicClient: () => ({ verifyMessage }),
}))

import { parseRefAction, RefError, verifyRefSigner } from './ouroRef'
import { refMessage, type RefAction } from '@/lib/ouroboros/ref'

const account = privateKeyToAccount(generatePrivateKey())

async function signed(request: RefAction, issuedAt = Date.now()) {
  return { issuedAt, signature: await account.signMessage({ message: refMessage(request, issuedAt) }) }
}

describe('referral requests', () => {
  it('rejects rates above the treasury share and malformed fields', () => {
    expect(() => parseRefAction({ action: 'setRate', code: 'abc', rateBps: 2001 })).toThrow(RefError)
    expect(() => parseRefAction({ action: 'setRate', code: 'abc', rateBps: 5.5 })).toThrow(RefError)
    expect(() => parseRefAction({ action: 'setRate', code: 'A-B', rateBps: 500 })).toThrow(RefError)
    expect(() => parseRefAction({ action: 'createLink', code: 'abc', partner: '0x12', label: '', rateBps: 0 }))
      .toThrow(RefError)
    expect(() => parseRefAction({ action: 'recordPayout', txHash: '0xabc' })).toThrow(RefError)
    expect(() => parseRefAction({ action: 'drop' })).toThrow(RefError)
  })

  it('keeps only the fields of the action, lowercasing addresses', () => {
    const partner = '0xC2EA14cE2112B18AFBC78fE78C969b3002F07cbB'
    expect(parseRefAction({ action: 'createLink', code: 'abc', partner, label: 'x', rateBps: 500, extra: 1 }))
      .toEqual({ action: 'createLink', code: 'abc', partner: partner.toLowerCase(), label: 'x', rateBps: 500 })
    expect(parseRefAction({ action: 'list', code: 'abc' })).toEqual({ action: 'list' })
  })

  it('accepts the signer of the exact request', async () => {
    const request: RefAction = { action: 'setRate', code: 'abc', rateBps: 500 }
    const { issuedAt, signature } = await signed(request)
    expect(await verifyRefSigner(request, issuedAt, account.address, signature)).toBe(account.address)
  })

  it('refuses a signature over a different request, address or time', async () => {
    const { issuedAt, signature } = await signed({ action: 'setRate', code: 'abc', rateBps: 500 })
    await expect(verifyRefSigner({ action: 'setRate', code: 'abc', rateBps: 2000 }, issuedAt, account.address, signature))
      .rejects.toMatchObject({ status: 401 })
    const other = privateKeyToAccount(generatePrivateKey()).address
    await expect(verifyRefSigner({ action: 'setRate', code: 'abc', rateBps: 500 }, issuedAt, other, signature))
      .rejects.toMatchObject({ status: 401 })
    await expect(verifyRefSigner({ action: 'setRate', code: 'abc', rateBps: 500 }, issuedAt + 1, account.address, signature))
      .rejects.toMatchObject({ status: 401 })
  })

  it('refuses a signature older than ten minutes', async () => {
    const request: RefAction = { action: 'view' }
    const { issuedAt, signature } = await signed(request, Date.now() - 11 * 60_000)
    await expect(verifyRefSigner(request, issuedAt, account.address, signature)).rejects.toMatchObject({ status: 401 })
  })
})
