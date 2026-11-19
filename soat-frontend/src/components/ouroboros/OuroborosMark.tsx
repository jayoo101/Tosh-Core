import { cn } from '@/components/ui/cn'

const R = 32

function at(deg: number, r: number): string {
  const a = (deg * Math.PI) / 180
  return `${(50 + r * Math.sin(a)).toFixed(2)} ${(50 - r * Math.cos(a)).toFixed(2)}`
}

/** A ring band from `a0` to `a1` degrees (clockwise from twelve o'clock), half-width easing from `w0` to `w1`. */
function band(a0: number, a1: number, w0: number, w1: number): string {
  const n = 16
  const outer: string[] = []
  const inner: string[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const deg = a0 + (a1 - a0) * t
    const w = w0 + (w1 - w0) * t
    outer.push(at(deg, R + w))
    inner.unshift(at(deg, R - w))
  }
  return `M${outer.join(' L')} L${inner.join(' L')} Z`
}

function circle(deg: number, r: number, radius: number): string {
  const [x, y] = at(deg, r).split(' ').map(Number)
  return `M${x - radius} ${y} a${radius} ${radius} 0 1 0 ${radius * 2} 0 a${radius} ${radius} 0 1 0 ${-radius * 2} 0 Z`
}

/** Tail to neck in three bands, lightest first — the opacities of `LogoMark`'s bars. */
const BODY = [
  { d: band(22, 122, 3, 6.5), opacity: 0.45 },
  { d: band(130, 232, 7, 9), opacity: 0.72 },
  { d: band(240, 336, 9.5, 11), opacity: 1 },
]

/** The head closes on the tail; the eye is cut out (even-odd), so any background shows through. */
const HEAD = `${circle(354, R, 13.5)} ${circle(359, R + 5, 3.2)}`

/** The Ouroboros mark: a snake ring swallowing its tail. Takes `currentColor`, so nav states recolour it. */
export function OuroborosMark({ className }: { className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }) {
  return (
    <svg viewBox="0 0 100 100" className={cn(className)} aria-hidden="true" focusable="false">
      {BODY.map(({ d, opacity }) => <path key={d} d={d} fill="currentColor" opacity={opacity} />)}
      <path d={HEAD} fill="currentColor" fillRule="evenodd" />
    </svg>
  )
}
