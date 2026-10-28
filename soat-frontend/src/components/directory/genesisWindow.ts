export interface GenesisWindow {
  /** 0–100, how much of the window has ELAPSED. It positions the flame on the
   *  fuse; the lit stretch is what lies AHEAD of it. See `burn` in `Progress`. */
  elapsedPct: number
  /** `HH:MM:SS` remaining; the words around it are the dictionary's. */
  clock: string
  /** The chosen window in whole hours — 3, 24 or 72. */
  hours: number
}

/**
 * The genesis countdown, as a fraction of the window the creator chose.
 *
 * ⚠ `elapsedPct` IS WHAT HAS ELAPSED, NOT WHAT REMAINS, and that is the one
 *   thing here worth a test. Both directions render and both animate, so an
 *   inversion is invisible in review and obvious on screen.
 *
 *   It was the other way for exactly one reason: a bar that fills as a
 *   deadline nears could be read as progress toward a goal, the way the old
 *   soft-cap bar was. That argument did not survive contact with the screen —
 *   a track whose fill retreats leftward while a clock counts down reads as
 *   running backwards, because every other elapsed-time bar people use fills
 *   left to right. Direction now matches the convention, and the caption
 *   (`HH:MM:SS left`) carries the "toward what" the fill cannot.
 *
 *   The field is named for what it holds rather than called `pct`, so the
 *   inversion could not be applied by editing one expression and leaving four
 *   call sites drawing the complement of what they think they are drawing.
 *
 * Returns `undefined` — draw nothing — rather than a zeroed window whenever
 * the inputs cannot support a fraction: before the first poll
 * resolves `genesisDeadline`, or once the clock has run out. A bar pinned at 0
 * says "this window has not started" in a phase where that is not yet true.
 */
export function genesisWindow({
  genesisDeadline, genesisDuration, nowSec,
}: {
  genesisDeadline: bigint
  genesisDuration: bigint
  nowSec:          number
}): GenesisWindow | undefined {
  if (genesisDeadline === 0n || genesisDuration === 0n) return undefined

  const remaining = Number(genesisDeadline) - nowSec
  const total = Number(genesisDuration)
  if (remaining <= 0 || total <= 0) return undefined

  const h = Math.floor(remaining / 3600)
  const m = Math.floor((remaining % 3600) / 60)
  const s = remaining % 60
  const pad = (n: number) => String(n).padStart(2, '0')

  return {
    elapsedPct: Math.max(0, Math.min(100, ((total - remaining) / total) * 100)),
    clock: `${pad(h)}:${pad(m)}:${pad(s)}`,
    hours: Math.round(total / 3600),
  }
}
