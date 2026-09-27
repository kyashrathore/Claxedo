import type { Locale } from "./locales"

export type Translations<Keys extends string = string> = {
  readonly en: Readonly<Record<Keys, string>>
} & {
  readonly [L in Exclude<Locale, "en">]?: Readonly<Partial<Record<Keys, string>>>
}

export type TemplateParams = Readonly<Record<string, string | number>>

export function fillTemplate(text: string, params?: TemplateParams): string {
  if (!params) return text
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

export type Resolved = { readonly text: string; readonly found: boolean }

export type Dictionaries = {
  readonly add: (domain: Translations) => boolean
  readonly remove: (domain: Translations) => boolean
  readonly resolve: (locale: Locale, key: string) => Resolved
}

function fold(target: Record<string, string>, domain: Translations, locale: Locale) {
  const source = domain[locale]
  if (!source) return
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (key in target) {
      if (locale === "en") console.error(`i18n key "${key}" is defined by two domains; the first definition stays`)
      continue
    }
    target[key] = value
  }
}

export function createDictionaries(): Dictionaries {
  const domains: Translations[] = []
  const built = new Map<Locale, Record<string, string>>()
  const dictionary = (locale: Locale) => {
    const existing = built.get(locale)
    if (existing) return existing
    const target: Record<string, string> = {}
    for (const domain of domains) fold(target, domain, locale)
    built.set(locale, target)
    return target
  }
  return {
    add: (domain) => {
      if (domains.includes(domain)) return false
      domains.push(domain)
      for (const [locale, target] of built) fold(target, domain, locale)
      return true
    },
    remove: (domain) => {
      const index = domains.indexOf(domain)
      if (index < 0) return false
      domains.splice(index, 1)
      built.clear()
      return true
    },
    resolve: (locale, key) => {
      const own = dictionary(locale)[key]
      if (own !== undefined) return { text: own, found: true }
      return { text: dictionary("en")[key] ?? key, found: false }
    },
  }
}
