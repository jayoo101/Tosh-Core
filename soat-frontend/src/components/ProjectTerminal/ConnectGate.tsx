import { Section } from './primitives'


// ─────────────────────────────────────────────────────────────────────────────
// CONNECT GATE
// ─────────────────────────────────────────────────────────────────────────────

export function ConnectGate() {
  return (
    <Section id="GATE" title="ACCESS GATE" subtitle="Wallet not connected">
      <p className="text-sm text-[#CCC] leading-relaxed max-w-prose">
        Connect your wallet to deposit ETH into this genesis, mint from the
        4000-rung shelf ladder, or claim a refund.  Audit-cliff guards
        (<span className="text-tosh-fluo">H-01</span>, <span className="text-tosh-fluo">M-01</span>,
        <span className="text-tosh-fluo"> L-01</span>) are mirrored client-side once a
        wallet is bound.
      </p>
    </Section>
  )
}
