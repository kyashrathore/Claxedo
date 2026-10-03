import { isRecord } from "@claxedo/helpers/guards"
import { readField, readString } from "@claxedo/helpers/readers"
import type { Translations } from "@/i18n"

export class PluginDictionaryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PluginDictionaryError"
  }
}

function isTextRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every((text) => typeof text === "string")
}

function isDictionary(value: Record<string, unknown>): value is Translations {
  return Object.values(value).every(isTextRecord)
}

export function moduleDictionary(module: unknown): Translations | undefined {
  const candidate = readField(module, "dictionary")
  if (candidate === undefined) return undefined
  if (!isRecord(candidate) || !isTextRecord(candidate.en)) {
    throw new PluginDictionaryError("the bundle's dictionary export must be { en: { key: text }, …other locales }")
  }
  if (!isDictionary(candidate)) throw new PluginDictionaryError("every locale in the bundle's dictionary must map keys to text")
  return candidate
}

export function translated(dictionary: Translations | undefined, locale: string, key: string): string {
  return readString(readField(dictionary, locale), key) ?? readString(dictionary?.en, key) ?? key
}
