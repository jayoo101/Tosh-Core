'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'

import {
  ENABLED_LOCALES, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, LOCALE_NAMES,
  LOCALES_ENABLED, isLocale, useLocale,
} from '@/i18n'

/**
 * The language picker, beside the wallet pip in the navbar.
 *
 * ⚠ IT IS IN THE NAVBAR RATHER THAN THE FOOTER ON PURPOSE. A picker in the
 *   footer is found by scrolling and reading, which is exactly what a reader who
 *   needs it cannot do. The one group of people this control exists for are the
 *   ones who cannot read the page it is on, so it has to be where the eye lands
 *   without instruction — next to the wallet, at the top.
 *
 * ⚠ A NATIVE `<select>`, not a styled dropdown. It is keyboard and screen-reader
 *   correct for free, it renders as the platform's own picker on mobile, and it
 *   needs no open/close state that could be left open across a `router.refresh`.
 *   The one thing lost is the terminal look of the rest of the chrome, which is
 *   not worth a custom listbox on a control most users touch once.
 *
 * Each language is named IN ITSELF — `简体中文`, not `Chinese (Simplified)`. A
 * reader looking for their language is scanning for the shape of their own
 * script; the English name of it is no use to them.
 */
export function LocalePicker() {
  const router = useRouter()
  const locale = useLocale()

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const next = e.target.value
      if (!isLocale(next)) return

      /*
       * Written from the client rather than through a server action, because a
       * language preference is not a mutation worth a round trip and a form.
       *
       * `secure` only over https: a dev server on `http://localhost` silently
       * drops a `Secure` cookie, so hard-coding it would make the picker appear
       * to do nothing in development and work in production — the worst way round.
       */
      const secure = window.location.protocol === 'https:' ? '; secure' : ''
      document.cookie =
        `${LOCALE_COOKIE}=${next}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax${secure}`

      // `refresh`, not `reload`. The locale is resolved in the root layout, so
      // the server components have to re-render — but a full page reload would
      // also drop the wallet connection and every cached chain read, which is a
      // heavy price for changing a caption.
      router.refresh()
    },
    [router],
  )

  // Module constant, so this is not a conditional hook — and it is checked after
  // the hooks for exactly that reason. A build with one language renders nothing
  // here at all.
  if (!LOCALES_ENABLED) return null

  return (
    <select
      value={locale}
      onChange={onChange}
      // The control has no visible label; the navbar has no room for one and the
      // selected value already names the language in its own script.
      aria-label="Language"
      className="shrink-0 cursor-pointer rounded-input border border-border-subtle bg-surface-card px-2 py-1 font-mono text-micro text-text-tertiary transition-colors hover:text-text-secondary focus:outline-none focus-visible:border-brand"
    >
      {ENABLED_LOCALES.map((l) => (
        <option key={l} value={l}>{LOCALE_NAMES[l]}</option>
      ))}
    </select>
  )
}
