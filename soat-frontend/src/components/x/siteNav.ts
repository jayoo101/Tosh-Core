import type { ComponentType } from 'react'
import { FilePlus, Store } from 'lucide-react'

import { OuroborosMark } from '@/components/ouroboros/OuroborosMark'
import type { Dictionary } from '@/i18n'

export interface NavItem {
  href: string
  label: string
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>
  /** `/` would match every route as a prefix. */
  exact: boolean
}

/**
 * One list for the side rail (desktop) and the header links (below `lg`).
 * `/launchpad`, `/launched` and `/market` still serve; they are off the nav
 * while Ouroboros is the lead.
 */
export function siteNav(t: Dictionary): NavItem[] {
  return [
    { href: '/ouroboros', label: t.x.navOuroboros, icon: OuroborosMark,  exact: false },
    { href: '/',          label: t.x.navHome,      icon: Store,          exact: true },
    { href: '/apply',     label: t.site.navApply,  icon: FilePlus,       exact: false },
  ]
}

export function isActive(item: NavItem, pathname: string | null): boolean {
  if (!pathname) return false
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`)
}
