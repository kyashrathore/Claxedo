import { createLocaleLoads, type LocaleLoads } from "./locale-loads"
import type { Locale } from "./locales"

export type LocaleStrings<Keys extends string = string> = Readonly<Partial<Record<Keys, string>>>

export type LocaleLoader<Keys extends string = string> = () => Promise<{ readonly default: LocaleStrings<Keys> }>

export type Translations<Keys extends string = string> = {
  readonly en: Readonly<Record<Keys, string>>
} & {
  readonly [L in Exclude<Locale, "en">]?: LocaleStrings<Keys> | LocaleLoader<Keys>
}

export type TemplateParams = Readonly<Record<string, string | number>>

export function fillTemplate(text: string, params?: TemplateParams): string {
  if (!params) return text
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

type Resolved = { readonly text: string; readonly found: boolean }

type Dictionaries = {
  readonly add: (domain: Translations) => boolean
  readonly remove: (domain: Translations) => boolean
  readonly resolve: (locale: Locale, key: string) => Resolved
  readonly pending: (locale: Locale) => boolean
  readonly load: (locale: Locale) => Promise<boolean>
}

function foldStrings(target: Record<string, string>, source: LocaleStrings, locale: Locale) {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (key in target) {
      if (locale === "en") console.error(`i18n key "${key}" is defined by two domains; the first definition stays`)
      continue
    }
    target[key] = value
  }
}

type Tables = {
  readonly dictionary: (locale: Locale) => Record<string, string>
  readonly fold: (domain: Translations) => void
  readonly foldLoaded: (locale: Locale, strings: LocaleStrings) => void
  readonly clear: () => void
}

function createTables(domains: readonly Translations[], loads: LocaleLoads): Tables {
  const built = new Map<Locale, Record<string, string>>()
  const fold = (target: Record<string, string>, domain: Translations, locale: Locale) => {
    const source = loads.stringsOf(domain, locale)
    if (source) foldStrings(target, source, locale)
  }
  return {
    dictionary: (locale) => {
      const existing = built.get(locale)
      if (existing) return existing
      const target: Record<string, string> = {}
      for (const domain of domains) fold(target, domain, locale)
      built.set(locale, target)
      return target
    },
    fold: (domain) => {
      for (const [locale, target] of built) fold(target, domain, locale)
    },
    foldLoaded: (locale, strings) => {
      const target = built.get(locale)
      if (target) foldStrings(target, strings, locale)
    },
    clear: () => built.clear(),
  }
}

export function createDictionaries(): Dictionaries {
  const domains: Translations[] = []
  const loads = createLocaleLoads()
  const tables = createTables(domains, loads)
  const loadOne = (domain: Translations, locale: Locale) =>
    loads.load(domain, locale, (strings) => {
      if (!domains.includes(domain)) return false
      tables.foldLoaded(locale, strings)
      return true
    })
  return {
    add: (domain) => {
      if (domains.includes(domain)) return false
      domains.push(domain)
      tables.fold(domain)
      return true
    },
    remove: (domain) => {
      const index = domains.indexOf(domain)
      if (index < 0) return false
      domains.splice(index, 1)
      loads.forget(domain)
      tables.clear()
      return true
    },
    resolve: (locale, key) => {
      const own = tables.dictionary(locale)[key]
      if (own !== undefined) return { text: own, found: true }
      return { text: tables.dictionary("en")[key] ?? key, found: false }
    },
    pending: (locale) => domains.some((domain) => loads.unloaded(domain, locale)),
    load: async (locale) => {
      const results = await Promise.all(domains.filter((domain) => loads.unloaded(domain, locale)).map((domain) => loadOne(domain, locale)))
      return results.some(Boolean)
    },
  }
}
