import 'server-only'

import { cookies } from 'next/headers'

import { getDictionary } from './dictionary'
import { DEFAULT_LOCALE, LOCALES_ENABLED, LOCALE_COOKIE, resolveLocale, type Locale } from './locales'
import type { Dictionary } from './types'

/**
 * Which language to render, from the cookie the picker writes.
 *
 * ⚠ THE COOKIE IS NOT READ ON A SINGLE-LANGUAGE BUILD, and that guard is the
 *   whole reason localisation can ship dark. `cookies()` is a dynamic API: one
 *   call opts the route out of static rendering, so reading it unconditionally
 *   would turn `/` and `/projects` — both prerendered today — into per-request
 *   renders in exchange for nothing, on a build that serves one language.
 *
 *   With `NEXT_PUBLIC_LOCALES` unset this returns immediately and the route stays
 *   static. The same holds for every `generateMetadata` that calls it.
 */
export async function requestLocale(): Promise<Locale> {
  if (!LOCALES_ENABLED) return DEFAULT_LOCALE
  const jar = await cookies()
  return resolveLocale(jar.get(LOCALE_COOKIE)?.value)
}

/** The request's locale and its merged dictionary, for server components. */
export async function requestDictionary(): Promise<{ locale: Locale; dict: Dictionary }> {
  const locale = await requestLocale()
  return { locale, dict: await getDictionary(locale) }
}
