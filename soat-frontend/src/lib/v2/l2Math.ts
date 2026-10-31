import { V2, V31 } from './config'

/** Seconds to the next `interval` boundary after `from`, or 0 with no anchor. The chain skips halted time, so this holds only while unhalted. */
export function untilNext(now: number, from: bigint, interval: number): number {
  if (from === 0n) return 0
  const idle = Math.max(0, now - Number(from))
  return interval - (idle % interval)
}

/** A v3.1 project's supply split. The pool and the L2 curve scale by raised / hard cap; the rest is never minted. */
export function v31Split(sold: bigint, raised: bigint, hardCap: bigint) {
  const ratio = hardCap > 0n ? (raised * V2.ONE) / hardCap : 0n
  const scale = (x: bigint) => (x * ratio) / V2.ONE
  const pool = scale(V31.GENESIS_SUPPLY - V31.SALE_SUPPLY)
  const l2 = scale(V31.L2_SUPPLY)
  return { ratio, sold, pool, l2, unminted: V31.MAX_SUPPLY - sold - pool - l2 }
}
