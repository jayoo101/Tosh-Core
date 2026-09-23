/**
 * Which languages this build offers, and how a request is matched to one.
 *
 * ── WHY THERE IS NO `[lang]` ROUTE SEGMENT ───────────────────────────────────
 *
 * The Next.js guide puts every page under `app/[lang]` and negotiates in
 * `proxy.ts`. That buys locale-prefixed URLs, which are worth having when a
 * crawler can read the localised page — and here it cannot. `/`, `/projects`
 * and `/projects/[address]` all delegate to client components that read their
 * content off the chain, so the prerendered HTML a crawler sees carries almost
 * no copy in any language. The SEO the prefix pays for does not exist yet.
 *
 * What the prefix would cost is concrete: seven pages move, and `/r/[code]`
 * referral links — already shared outside this app and impossible to recall —
 * would every one of them start taking a redirect hop through the negotiator.
 *
 * So the locale rides in a cookie. If server-rendered marketing pages ever
 * arrive, prefixes are additive and can be put in front of this.
 *
 * ── WHY `NEXT_PUBLIC_LOCALES` GATES IT ───────────────────────────────────────
 *
 * Unset means English only, and then `resolveLocale` never reads a cookie —
 * which keeps `/` and `/projects` statically prerendered, because reading
 * `cookies()` is what opts a route into dynamic rendering. A build with the
 * variable absent is therefore not merely "English": it is byte-for-byte the
 * app that existed before any of this, with the whole mechanism shipped dark.
 * Turning one language on is an env change, and turning it off again is the
 * same change backwards — no revert, no redeploy of application code.
 */

/**
 * Every locale with a dictionary file, in the order a picker should list them.
 *
 * `en` is first and is the fallback for every key any other locale is missing.
 */
export const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'vi', 'ru'] as const

export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'

/** What the picker shows, written in the language it selects. */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  'en':    'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  'ja':    '日本語',
  'ko':    '한국어',
  'vi':    'Tiếng Việt',
  'ru':    'Русский',
}

/**
 * The cookie the choice lives in.
 *
 * Not prefixed `__Host-`: that prefix requires `Secure`, which a `localhost`
 * dev server cannot set, and a language preference is not worth a setting that
 * behaves differently in development than in production.
 */
export const LOCALE_COOKIE = 'tosh_locale'

/** A year. The preference is not a session; re-asking every week is the bug. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

export function isLocale(value: string | undefined | null): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/**
 * The locales this build will actually serve.
 *
 * ⚠ SPELLED OUT, NOT COMPUTED. Next inlines `NEXT_PUBLIC_*` by substituting the
 *   literal source text `process.env.NEXT_PUBLIC_LOCALES` at build time, so a
 *   computed member access is never a substitution target and `process.env` is
 *   an empty object in the browser. `providers.tsx` has the same warning over
 *   `trimmedEnv`, written after a premium RPC endpoint silently went dead in
 *   every deployed build for exactly this reason.
 *
 * Unknown entries are dropped rather than throwing. A typo in an env var should
 * cost that one language, not the deployment — and `guard:i18n` fails the build
 * on it, which is where a typo belongs.
 */
export const ENABLED_LOCALES: readonly Locale[] = (() => {
  const raw = process.env.NEXT_PUBLIC_LOCALES
  if (typeof raw !== 'string' || raw.trim() === '') return [DEFAULT_LOCALE]

  const asked = raw.split(',').map((s) => s.trim()).filter(isLocale)
  // `en` is not optional. It is the per-key fallback for every other locale, so
  // a build that dropped it would render dictionary keys wherever a translation
  // was missing.
  return [DEFAULT_LOCALE, ...asked.filter((l) => l !== DEFAULT_LOCALE)]
})()

/**
 * Whether anything in this build can be read in more than one language.
 *
 * The gate on every cost localisation adds: the cookie read, the picker in the
 * navbar, the non-English dictionary in the payload. All of it stays off until
 * a second locale is switched on.
 */
export const LOCALES_ENABLED: boolean = ENABLED_LOCALES.length > 1

/**
 * The locale for a request, given whatever the cookie said.
 *
 * ⚠ NO `Accept-Language` NEGOTIATION, deliberately. The header describes the
 *   browser's configuration, not a choice, and it is wrong in the case this app
 *   is most likely to meet: a Chinese-speaking user on a machine or a browser
 *   shipped in English. Guessing from it would hand that user English while
 *   silently claiming to know their preference. An explicit picker that
 *   remembers is both simpler and correct, and it makes the default state
 *   ("English, because nobody has chosen") honest.
 *
 * A cookie naming a locale this build does not serve — left over from a
 * deployment that had it enabled, or hand-edited — resolves to English rather
 * than to a dictionary that is not there.
 */
export function resolveLocale(cookieValue: string | undefined): Locale {
  if (!LOCALES_ENABLED) return DEFAULT_LOCALE
  if (!isLocale(cookieValue)) return DEFAULT_LOCALE
  return ENABLED_LOCALES.includes(cookieValue) ? cookieValue : DEFAULT_LOCALE
}
