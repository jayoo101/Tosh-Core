'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'

import {
  ENABLED_LOCALES, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, LOCALE_NAMES,
  LOCALES_ENABLED, isLocale, useLocale, type Locale,
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
 * ⚠ TWO LANGUAGES GET A TOGGLE, MORE GET A `<select>`. A toggle shows both
 *   options at once, so the way back is visible to someone who switched by
 *   accident and can no longer read the page. It does not scale: seven segments
 *   will not fit a navbar that already overflows at 390px, so past two the
 *   native select takes over — keyboard, screen-reader and mobile picker
 *   correct for free.
 *
 * Each language is named IN ITSELF — `中`, `简体中文`, not `Chinese`. A reader
 * looking for their language is scanning for the shape of their own script.
 */
const SHORT_NAMES: Readonly<Record<Locale, string>> = {
  'en':    'EN',
  'zh-CN': '中',
  'zh-TW': '繁',
  'ja':    '日',
  'ko':    '한',
  'vi':    'VI',
  'ru':    'RU',
}

export function LocalePicker() {
  const router = useRouter()
  const locale = useLocale()

  const choose = useCallback(
    (next: string) => {
      if (!isLocale(next) || next === locale) return

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
    [locale, router],
  )

  // Module constant, so this is not a conditional hook — and it is checked after
  // the hooks for exactly that reason. A build with one language renders nothing
  // here at all.
  if (!LOCALES_ENABLED) return null

  if (ENABLED_LOCALES.length === 2) {
    return (
      <div
        role="group"
        aria-label="Language"
        className="flex shrink-0 items-center rounded-input border border-border-subtle bg-surface-card p-0.5 font-mono text-micro"
      >
        {ENABLED_LOCALES.map((l) => {
          const active = l === locale
          return (
            <button
              key={l}
              type="button"
              lang={l}
              onClick={() => choose(l)}
              aria-pressed={active}
              title={LOCALE_NAMES[l]}
              className={`min-w-7 rounded-[3px] px-2 py-0.5 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-brand
                ${active
                  ? 'bg-brand/15 text-brand'
                  : 'text-text-tertiary hover:text-text-secondary'}`}
            >
              {SHORT_NAMES[l]}
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <select
      value={locale}
      onChange={(e) => choose(e.target.value)}
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
