/* eslint-disable @next/next/no-img-element -- decorative SVGs, nothing for the optimiser to do */

/** The two oversized gold marks fixed behind every page. The tiled pattern is `body::before`. */
export function Backdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <img
        src="/images/binance-mark.svg"
        alt=""
        className="binance-mark absolute -right-40 -bottom-40 size-[42rem] rotate-12 opacity-[0.04]"
      />
      <img
        src="/images/binance-mark.svg"
        alt=""
        className="binance-mark absolute -top-24 -left-32 size-96 -rotate-12 opacity-[0.03]"
      />
    </div>
  )
}
