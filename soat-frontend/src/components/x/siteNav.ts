import { ArrowLeftRight, BadgeCheck, CirclePlus, FileText, LayoutGrid, Rocket, Store, Wallet, type LucideIcon } from 'lucide-react'

import type { Dictionary } from '@/i18n'
import { LAUNCHES_PAUSED } from '@/lib/launchGate'

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
    { href: '/',          label: t.x.navHome,        icon: Store,      exact: true },
    { href: '/launchpad', label: t.x.navLaunching,   icon: Rocket,     exact: false },
    { href: '/launched',  label: t.x.navLaunched,    icon: BadgeCheck, exact: false },
    { href: '/market',    label: t.x.navMarket,      icon: ArrowLeftRight, exact: false },
    { href: '/projects',  label: t.site.navDirectory, icon: LayoutGrid, exact: false },
    { href: '/portfolio', label: t.site.navPortfolio, icon: Wallet,     exact: false },
    ...(LAUNCHES_PAUSED ? [] : [{ href: '/launch', label: t.site.navLaunch, icon: CirclePlus, exact: false }]),
    { href: '/apply',     label: t.site.navApply,     icon: FileText,   exact: false },
  ]
}

export function isActive(item: NavItem, pathname: string | null): boolean {
  if (!pathname) return false
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`)
}
