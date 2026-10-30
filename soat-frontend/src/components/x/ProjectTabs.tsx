'use client'

import { useState, useSyncExternalStore, type ReactNode } from 'react'

export interface Tab { id: string; label: string; content: ReactNode }

function subscribeHash(cb: () => void) {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

/**
 * The detail page's lower half. A `#id` link anywhere on the page (the buy
 * panel's "buy in the bid market") switches to that tab; a click on a tab
 * wins until the hash changes again.
 */
export function ProjectTabs({ tabs }: { tabs: Tab[] }) {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash.slice(1), () => '')
  const [picked, setPicked] = useState<{ id: string; hash: string } | null>(null)
  const fromHash = tabs.some(t => t.id === hash) ? hash : null
  // A tab can drop out from under the pick, e.g. the fund tab on disconnect.
  const kept = picked && tabs.some(t => t.id === picked.id) ? picked : null
  const active = kept && kept.hash === hash ? kept.id : fromHash ?? kept?.id ?? tabs[0]?.id

  return (
    <section
      id="market"
      className="glow-frame glow-delay flex scroll-mt-24 flex-col gap-6 rounded-panel bg-surface-card/80 p-6 md:p-8"
    >
      <div className="-mx-2 flex gap-1 overflow-x-auto px-2 [scrollbar-width:none]" role="tablist">
        {tabs.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={active === t.id}
            aria-controls={`panel-${t.id}`}
            onClick={() => setPicked({ id: t.id, hash })}
            className={`shrink-0 rounded-pill px-4 py-2 text-body font-bold transition-colors ${
              active === t.id ? 'bg-brand text-bg-base' : 'text-text-tertiary hover:bg-surface-hover hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map(t => (
        <div key={t.id} id={`panel-${t.id}`} role="tabpanel" aria-labelledby={`tab-${t.id}`} hidden={active !== t.id}>
          {t.content}
        </div>
      ))}
    </section>
  )
}
