import type { LocaleStrings, Translations } from "./dictionary"
import type { Locale } from "./locales"

export type LocaleLoads = {
  readonly stringsOf: (domain: Translations, locale: Locale) => LocaleStrings | undefined
  readonly unloaded: (domain: Translations, locale: Locale) => boolean
  readonly load: (domain: Translations, locale: Locale, onLoaded: (strings: LocaleStrings) => boolean) => Promise<boolean>
  readonly forget: (domain: Translations) => void
}

export function createLocaleLoads(): LocaleLoads {
  const loaded = new Map<Translations, Map<Locale, LocaleStrings>>()
  const loading = new Map<Translations, Map<Locale, Promise<boolean>>>()
  const remember = <T>(store: Map<Translations, Map<Locale, T>>, domain: Translations, locale: Locale, value: T) => {
    const byLocale = store.get(domain) ?? new Map<Locale, T>()
    byLocale.set(locale, value)
    store.set(domain, byLocale)
  }
  return {
    stringsOf: (domain, locale) => {
      const entry = domain[locale]
      return typeof entry === "function" ? loaded.get(domain)?.get(locale) : entry
    },
    unloaded: (domain, locale) => typeof domain[locale] === "function" && !loaded.get(domain)?.has(locale),
    load: (domain, locale, onLoaded) => {
      const inFlight = loading.get(domain)?.get(locale)
      if (inFlight) return inFlight
      const loader = domain[locale]
      if (typeof loader !== "function") return Promise.resolve(false)
      const settle = () => loading.get(domain)?.delete(locale)
      const promise = loader().then(
        (module) => {
          settle()
          remember(loaded, domain, locale, module.default)
          return onLoaded(module.default)
        },
        (error: unknown) => {
          settle()
          throw error
        },
      )
      remember(loading, domain, locale, promise)
      return promise
    },
    forget: (domain) => {
      loaded.delete(domain)
    },
  }
}
