'use client'

import { BookOpen, Layers, TrendingUp } from 'lucide-react'

import { useT } from '@/i18n'

export function Features() {
  const t = useT().x
  const features = [
    { icon: TrendingUp, step: t.featCurveStep, title: t.featCurveTitle, body: t.featCurveBody },
    { icon: BookOpen, step: t.featBookStep, title: t.featBookTitle, body: t.featBookBody },
    { icon: Layers, step: t.featShelfStep, title: t.featShelfTitle, body: t.featShelfBody },
  ]
  return (
    <section id="how" aria-labelledby="how-title" className="flex scroll-mt-24 flex-col gap-6">
      <h2 id="how-title" className="text-gold-shimmer w-fit text-section font-black">{t.featTitle}</h2>
      <ol className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {features.map(({ icon: Icon, step, title, body }, idx) => (
          <li key={step} className={`glow-frame flex flex-col gap-4 rounded-panel bg-surface-card p-6 ${idx === 1 ? 'glow-delay' : ''}`}>
            <div className="flex items-center gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-card bg-surface-hover text-brand">
                <Icon className="size-5" aria-hidden />
              </span>
              <span className="font-mono text-readout font-bold uppercase tracking-wider text-brand">{step}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <h3 className="font-bold text-text-primary">{title}</h3>
              <p className="text-pretty text-body text-text-tertiary">{body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
