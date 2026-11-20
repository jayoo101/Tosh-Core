import { OuroborosApp } from '@/components/ouroboros/OuroborosApp'

export default function HomePage() {
  return (
    <main className="relative isolate">
      <div aria-hidden className="toshx-grid toshx-grid-dim" />
      <div className="relative z-10 mx-auto w-full max-w-7xl px-4 py-6 font-sans text-text-primary sm:px-6 md:px-8 md:py-8">
        <OuroborosApp />
      </div>
    </main>
  )
}
