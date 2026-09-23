/**
 * The client-safe surface of localisation.
 *
 * ⚠ `dictionary.ts` IS DELIBERATELY NOT RE-EXPORTED. It is `server-only` and it
 *   names all seven dictionaries, so pulling it through this barrel would make
 *   any client component importing `@/i18n` either fail to build or drag every
 *   language into the browser bundle. The layout imports `getDictionary` from
 *   `@/i18n/dictionary` directly, which is the only place that needs it.
 */
export { I18nProvider, useT, useLocale } from './I18nProvider'
export { fill, placeholdersIn } from './fill'
export {
  LOCALES, LOCALE_NAMES, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE,
  DEFAULT_LOCALE, ENABLED_LOCALES, LOCALES_ENABLED,
  isLocale, resolveLocale,
  type Locale,
} from './locales'
export type { Dictionary, PartialDictionary } from './types'
