/**
 * Reading pool state, and verifying the constants this tool is pinned to.
 *
 * Infinity ships no `StateView` and no `Quoter` (docs/DEVELOPMENT.md §Pool
 * state), so there is no periphery reader to ask — everything here goes
 * straight to `CLPoolManager`, the same way `auditLaunch.mjs` and the frontend
 * do.
 */

import { ethers } from 'ethers'
import {
  CHAIN_ID, CL_POOL_MANAGER, PERMIT2, CL_POSITION_MANAGER, UNIVERSAL_ROUTER,
  QUOTE_ASSET, POOL_FEE, TICK_SPACING, rpcUrl,
} from './config.mjs'

export const HOOK_ABI = [
  'function getPoolKey() view returns (tuple(address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters))',
  'function getHooksRegistrationBitmap() view returns (uint16)',
  'function projectToken() view returns (address)',
  'function quoteAsset() view returns (address)',
  'function tokenInitialized() view returns (bool)',
]

export const CL_POOL_ABI = [
  'function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 id) view returns (uint128 liquidity)',
]

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]

export const PERMIT2_ABI = [
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]

export function provider() {
  return new ethers.JsonRpcProvider(rpcUrl(), CHAIN_ID)
}

/**
 * The 6-field PoolKey hashed to a pool id.
 *
 * ⚠ Six fields, not V4's five. The tuple gained `poolManager` between
 *   `hooks` and `fee`, and because the action opcodes are numerically
 *   identical to V4's, the key's width is the only structural signal that a
 *   payload was built for the wrong protocol (docs/DEVELOPMENT.md). Encoding a
 *   V4-shaped key here yields a well-formed hash for a pool that does not
 *   exist, and `getSlot0` answers zero rather than reverting.
 */
export function poolIdOf(key) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['tuple(address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters)'],
    [[key.currency0, key.currency1, key.hooks, key.poolManager, key.fee, key.parameters]],
  ))
}

/**
 * Load a pool, and refuse to return one that contradicts the pinned config.
 *
 * The checks are here rather than in a separate command because every caller
 * needs them and none of them would remember to ask. A router or Permit2
 * address that has drifted does not fail loudly at the RPC — it fails at
 * signing time with an allowance error naming a contract the operator never
 * typed, which is a far worse place to learn about it.
 */
export async function loadPool(hookAddress, prov = provider()) {
  const net = await prov.getNetwork()
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`MM_RPC_URL points at chain ${net.chainId}, not ${CHAIN_ID}`)
  }

  const hook = new ethers.Contract(hookAddress, HOOK_ABI, prov)
  const [rawKey, bitmap] = await Promise.all([hook.getPoolKey(), hook.getHooksRegistrationBitmap()])

  const key = {
    currency0: rawKey.currency0,
    currency1: rawKey.currency1,
    hooks: rawKey.hooks,
    poolManager: rawKey.poolManager,
    fee: Number(rawKey.fee),
    parameters: rawKey.parameters,
  }

  if (key.hooks.toLowerCase() !== hookAddress.toLowerCase()) {
    throw new Error(`getPoolKey().hooks is ${key.hooks}, not the hook asked about`)
  }
  if (key.poolManager.toLowerCase() !== CL_POOL_MANAGER.toLowerCase()) {
    throw new Error(`pool runs on manager ${key.poolManager}, not the pinned ${CL_POOL_MANAGER}`)
  }
  if (key.currency0.toLowerCase() !== QUOTE_ASSET.toLowerCase()) {
    throw new Error(`currency0 is ${key.currency0}, not the quote asset ${QUOTE_ASSET}`)
  }
  if (key.fee !== POOL_FEE) throw new Error(`pool fee is ${key.fee}, not ${POOL_FEE}`)

  // `parameters` packs the hook bitmap in the low 16 bits and tickSpacing above
  // it. Both halves are checked because a mismatch in either produces a
  // different pool id, and a wrong pool id reads as an empty pool rather than
  // as an error.
  const packedSpacing = Number((BigInt(key.parameters) >> 16n) & 0xffffffn)
  const packedBitmap = Number(BigInt(key.parameters) & 0xffffn)
  if (packedSpacing !== TICK_SPACING) {
    throw new Error(`tickSpacing packed in parameters is ${packedSpacing}, not ${TICK_SPACING}`)
  }
  if (packedBitmap !== Number(bitmap)) {
    throw new Error(`parameters bitmap ${packedBitmap} disagrees with getHooksRegistrationBitmap() ${bitmap}`)
  }

  const id = poolIdOf(key)
  const pm = new ethers.Contract(CL_POOL_MANAGER, CL_POOL_ABI, prov)
  const [slot0, liquidity] = await Promise.all([pm.getSlot0(id), pm.getLiquidity(id)])

  if (slot0.sqrtPriceX96 === 0n) {
    throw new Error('pool is not initialised — either it never launched, or the key is wrong')
  }
  if (liquidity === 0n) throw new Error('pool is initialised but holds no liquidity')

  return {
    key,
    id,
    bitmap: Number(bitmap),
    sqrtPriceX96: slot0.sqrtPriceX96,
    tick: Number(slot0.tick),
    lpFee: Number(slot0.lpFee),
    protocolFee: Number(slot0.protocolFee),
    liquidity,
    token: key.currency1,
    quote: key.currency0,
  }
}

/**
 * Confirm the pinned periphery addresses are contracts on this chain.
 *
 * Cheap, and it catches the one failure this tool cannot recover from: an
 * address that is an EOA or empty, where `approve` succeeds silently and the
 * swap fails later for a reason that points somewhere else entirely.
 */
export async function verifyInfrastructure(prov = provider()) {
  const targets = {
    'Universal Router': UNIVERSAL_ROUTER,
    Permit2: PERMIT2,
    CLPositionManager: CL_POSITION_MANAGER,
    CLPoolManager: CL_POOL_MANAGER,
  }
  const out = {}
  for (const [name, addr] of Object.entries(targets)) {
    const code = await prov.getCode(addr)
    const bytes = (code.length - 2) / 2
    if (bytes === 0) throw new Error(`${name} at ${addr} has no code on chain ${CHAIN_ID}`)
    out[name] = { address: addr, bytes }
  }
  return out
}

/** Balances and symbols for both legs, for display and for the engine's inventory view. */
export async function readBalances(pool, owner, prov = provider()) {
  const quote = new ethers.Contract(pool.quote, ERC20_ABI, prov)
  const token = new ethers.Contract(pool.token, ERC20_ABI, prov)
  const [qBal, tBal, qSym, tSym, qDec, tDec] = await Promise.all([
    quote.balanceOf(owner), token.balanceOf(owner),
    quote.symbol(), token.symbol(),
    quote.decimals(), token.decimals(),
  ])
  return {
    quote: { balance: qBal, symbol: qSym, decimals: Number(qDec) },
    token: { balance: tBal, symbol: tSym, decimals: Number(tDec) },
  }
}
