import type { ComponentType } from 'react'
import { BookOpen, FilePlus, Gift } from 'lucide-react'

import { OuroborosMark } from '@/components/ouroboros/OuroborosMark'
import type { Dictionary } from '@/i18n'

export interface NavItem {
  href: string
  label: string
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>
  exact: boolean
  aliases?: readonly string[]
}

export function siteNav(t: Dictionary): NavItem[] {
  return [
    { href: '/',          label: t.x.navHome,      icon: OuroborosMark, exact: true, aliases: ['/ouroboros'] },
    { href: '/mechanism', label: t.x.navMechanism, icon: BookOpen,      exact: false },
    { href: '/rewards',   label: t.x.navRewards,   icon: Gift,          exact: false },
    { href: '/apply',     label: t.site.navApply,  icon: FilePlus,      exact: false },
  ]
}

export function isActive(item: NavItem, pathname: string | null): boolean {
  if (!pathname) return false
  if (item.aliases?.some(a => pathname === a || pathname.startsWith(`${a}/`))) return true
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`)
}
