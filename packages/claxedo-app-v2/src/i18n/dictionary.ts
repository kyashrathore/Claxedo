import type { Locale } from "./locales"

export type Dictionary = Readonly<Record<string, string>>

export type Translations<Keys extends string = string> = {
  readonly en: Readonly<Record<Keys, string>>
} & {
  readonly [L in Exclude<Locale, "en">]?: Readonly<Partial<Record<Keys, string>>>
}

export type TemplateParams = Readonly<Record<string, string | number>>

export type MergedDictionaries = Readonly<Record<Locale, Dictionary>>

export function fillTemplate(text: string, params?: TemplateParams): string {
  if (!params) return text
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

export function mergeDictionaries(domains: readonly Translations[], locales: readonly Locale[]): MergedDictionaries {
  const merged: Record<string, Record<string, string>> = {}
  for (const locale of locales) merged[locale] = {}
  for (const domain of domains) {
    for (const locale of locales) {
      const source = domain[locale]
      if (!source) continue
      const target = merged[locale]
      for (const [key, value] of Object.entries(source)) {
        if (value === undefined) continue
        if (locale === "en" && key in target) {
          console.error(`i18n key "${key}" is defined by two domains; the first definition stays`)
          continue
        }
        if (key in target) continue
        target[key] = value
      }
    }
  }
  return merged as MergedDictionaries
}

export function lookup(merged: MergedDictionaries, locale: Locale, key: string): string {
  return merged[locale][key] ?? merged.en[key] ?? key
}
