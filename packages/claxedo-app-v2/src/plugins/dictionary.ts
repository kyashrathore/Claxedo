import type { Translations } from "@/i18n"

export class PluginDictionaryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PluginDictionaryError"
  }
}

function isTextRecord(value: unknown): value is Readonly<Record<string, string>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((text) => typeof text === "string")
}

export function moduleDictionary(module: unknown): Translations | undefined {
  const candidate: unknown = (module as { readonly dictionary?: unknown }).dictionary
  if (candidate === undefined) return undefined
  if (typeof candidate !== "object" || candidate === null || !isTextRecord((candidate as { readonly en?: unknown }).en)) {
    throw new PluginDictionaryError("the bundle's dictionary export must be { en: { key: text }, …other locales }")
  }
  if (!Object.values(candidate).every(isTextRecord)) throw new PluginDictionaryError("every locale in the bundle's dictionary must map keys to text")
  return candidate as Translations
}

export function translated(dictionary: Translations | undefined, locale: string, key: string): string {
  const locales = dictionary as Readonly<Record<string, Readonly<Record<string, string>> | undefined>> | undefined
  return locales?.[locale]?.[key] ?? locales?.en?.[key] ?? key
}
