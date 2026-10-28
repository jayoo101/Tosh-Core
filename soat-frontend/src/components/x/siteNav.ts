import { ArrowLeftRight, BadgeCheck, FilePlus, Rocket, Store, type LucideIcon } from 'lucide-react'

import type { Dictionary } from '@/i18n'

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  /** `/` would match every route as a prefix. */
  exact: boolean
}

/** One list for the side rail (desktop) and the header links (below `lg`). */
export function siteNav(t: Dictionary): NavItem[] {
  return [
    { href: '/',          label: t.x.navHome,      icon: Store,          exact: true },
    { href: '/launchpad', label: t.x.navLaunching, icon: Rocket,         exact: false },
    { href: '/launched',  label: t.x.navLaunched,  icon: BadgeCheck,     exact: false },
    { href: '/market',    label: t.x.navMarket,    icon: ArrowLeftRight, exact: false },
    { href: '/apply',     label: t.site.navApply,  icon: FilePlus,       exact: false },
  ]
}

export function isActive(item: NavItem, pathname: string | null): boolean {
  if (!pathname) return false
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`)
}
