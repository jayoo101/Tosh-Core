import { useId } from 'react'
import { cn } from '@/components/ui/cn'

const BARS = [
  { x: 4, opacity: 0.45 },
  { x: 38, opacity: 0.72 },
  { x: 72, opacity: 1 },
]

const BAR_WIDTH = 24
const SLANT = 16

/** The three slanted gold bars. `useId` because the gradient id is document-global. */
export function LogoMark({ className }: { className?: string }) {
  const id = useId()
  return (
    <svg viewBox="0 0 100 100" className={cn('text-brand', className)} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.78" />
        </linearGradient>
      </defs>
      {BARS.map(({ x, opacity }) => (
        <polygon
          key={x}
          points={`${x},6 ${x + BAR_WIDTH},${6 + SLANT} ${x + BAR_WIDTH},${94 - SLANT} ${x},94`}
          fill={`url(#${id})`}
          opacity={opacity}
        />
      ))}
    </svg>
  )
}

/** `TOSH` + gold `X`, one text run so a flex gap cannot split it. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-mono font-bold tracking-widest text-text-primary', className)}>
      TOSH<span className="text-brand">X</span>
    </span>
  )
}
