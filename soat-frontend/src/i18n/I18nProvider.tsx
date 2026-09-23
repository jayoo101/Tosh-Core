'use client'

import { createContext, useContext, useMemo, type ReactNode } from 'react'

import { EN } from './dict/en'
import type { Dictionary } from './types'
import { DEFAULT_LOCALE, type Locale } from './locales'

/**
 * The active dictionary, for client components.
 *
 * ⚠ THE DEFAULT VALUE IS ENGLISH, AND THAT IS THE LOAD-BEARING DECISION IN THIS
 *   FILE. `useT()` without a provider above it returns the English dictionary
 *   rather than throwing or returning `undefined`, which buys three things:
 *
 *     · Every existing test keeps passing untouched. The golden-master snapshots
 *       mount these panels bare, with no provider, and their whole purpose is to
 *       prove the extraction did not change the English — which they can only do
 *       if the extracted code renders English in that setting.
 *     · A surface somebody forgets to wrap renders in English instead of
 *       crashing. On a page where a wallet is about to sign something, a missing
 *       provider must not be able to take the panel down.
 *     · The dark-launched build needs no provider at all.
 *
 *   The provider is therefore an override, not a requirement. Nothing has to be
 *   wired for the app to work; wiring it is what adds a second language.
 */
interface I18nValue {
  readonly dict: Dictionary
  readonly locale: Locale
}

const I18nContext = createContext<I18nValue>({ dict: EN, locale: DEFAULT_LOCALE })

/**
 * Takes an already-merged dictionary rather than a locale and a loader.
 *
 * The merge happens on the server, in the layout, so the client receives one
 * locale's strings with English already behind every gap. A client-side loader
 * would mean a first paint with no dictionary and a swap on the next tick —
 * which on this app would be a visible flash of English on every page load, and
 * a hydration mismatch to go with it.
 */
export function I18nProvider({
  dict, locale, children,
}: {
  dict: Dictionary
  locale: Locale
  children: ReactNode
}) {
  // The dictionary arrives as a fresh object from the RSC payload on every
  // navigation, so memoising on its identity would be pointless; memoise on the
  // locale, which is what actually changes. Without this, every consumer of the
  // context re-renders on any parent render.
  const value = useMemo<I18nValue>(() => ({ dict, locale }), [locale, dict])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/**
 * The active dictionary.
 *
 * Returns the whole object rather than a `t('a.b')` lookup function on purpose:
 * `t.refund.noneReason` is checked by the compiler, so a key that does not exist
 * cannot be reached by a typo, and deleting a string from `en.ts` breaks every
 * reference to it at build time. A string-path lookup gives up all of that in
 * exchange for slightly shorter call sites.
 */
export function useT(): Dictionary {
  return useContext(I18nContext).dict
}

/** The active locale, for the picker and for anything that formats by language. */
export function useLocale(): Locale {
  return useContext(I18nContext).locale
}
