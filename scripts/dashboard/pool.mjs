/**
 * Reading pool state for the pool-health panel.
 *
 * Infinity ships no `StateView` and no `Quoter` (docs/DEVELOPMENT.md §Pool
 * state), so there is no periphery reader to ask — everything here goes
 * straight to `CLPoolManager`, the same way `auditLaunch.mjs` and the frontend
 * do.
 */

import { ethers } from 'ethers'
import {
  CHAIN_ID, CL_POOL_MANAGER, QUOTE_ASSET, POOL_FEE, TICK_SPACING, HOOK_ABI,
} from './config.mjs'

const CL_POOL_ABI = [
  'function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 id) view returns (uint128 liquidity)',
]

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
 * Every mismatch below would otherwise surface as a well-formed pool id for a
 * pool that does not exist, which reads as an empty pool rather than as an
 * error — a health panel reporting zero depth for a pool that has plenty.
 */
export async function loadPool(hookAddress, prov) {
  const net = await prov.getNetwork()
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`the RPC points at chain ${net.chainId}, not ${CHAIN_ID}`)
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
