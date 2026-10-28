'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { useT } from '@/i18n'
import { isActive, siteNav } from './siteNav'

const ITEM_SIZE = 48
const ITEM_GAP = 12

/** Desktop navigation: an icon column with a gold indicator that slides to the active route. */
export function SideRail() {
  const pathname = usePathname()
  const t = useT()
  if (pathname?.startsWith('/admin')) return null

  const items = siteNav(t)
  const activeIndex = items.findIndex(item => isActive(item, pathname))

  return (
    <aside
      className="sticky top-16 z-10 hidden h-[calc(100dvh-4rem)] w-20 shrink-0 flex-col items-center overflow-y-auto border-r border-border-subtle py-6 lg:flex"
      aria-label={t.x.sideNav}
    >
      <nav className="relative flex flex-col items-center gap-3 pl-2">
        <div className="rail-glider-track" aria-hidden="true">
          {activeIndex >= 0 && (
            <div className="rail-glider" style={{ transform: `translateY(${activeIndex * (ITEM_SIZE + ITEM_GAP)}px)` }} />
          )}
        </div>
        {items.map((item, index) => {
          const active = index === activeIndex
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.label}
              title={item.label}
              aria-current={active ? 'page' : undefined}
              className={`relative z-10 flex size-12 items-center justify-center rounded-panel transition-colors duration-300 ${
                active ? 'text-brand' : 'text-text-tertiary hover:text-text-primary'
              }`}
            >
              <Icon className="size-5" aria-hidden />
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
