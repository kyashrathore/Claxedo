import * as i18n from "@solid-primitives/i18n"
import { asRecord } from "@claxedo/helpers/guards"
import { desktopApi } from "../api"

import { dict as desktopEn } from "./en"
import { dict as appEn } from "@/platform/i18n/en"

export type Locale =
  | "en"
  | "zh"
  | "zht"
  | "ko"
  | "de"
  | "es"
  | "fr"
  | "da"
  | "ja"
  | "pl"
  | "ru"
  | "ar"
  | "no"
  | "br"
  | "bs"

type RawDictionary = typeof appEn & typeof desktopEn
type Dictionary = i18n.Flatten<RawDictionary>
type LocaleModule = { dict: i18n.BaseRecordDict }

const LOCALES: readonly Locale[] = ["en", "zh", "zht", "ko", "de", "es", "fr", "da", "ja", "pl", "ru", "bs", "ar", "no", "br"]

// English is the fallback every key resolves through, so it is the only pair
// in the main chunk; a translation loads only once it is the picked locale.
// The app-side file for "br" is pt-BR.ts (see @/platform/i18n/locales.ts).
const loaders = {
  zh: () => Promise.all([import("@/platform/i18n/zh"), import("./zh")]),
  zht: () => Promise.all([import("@/platform/i18n/zht"), import("./zht")]),
  ko: () => Promise.all([import("@/platform/i18n/ko"), import("./ko")]),
  de: () => Promise.all([import("@/platform/i18n/de"), import("./de")]),
  es: () => Promise.all([import("@/platform/i18n/es"), import("./es")]),
  fr: () => Promise.all([import("@/platform/i18n/fr"), import("./fr")]),
  da: () => Promise.all([import("@/platform/i18n/da"), import("./da")]),
  ja: () => Promise.all([import("@/platform/i18n/ja"), import("./ja")]),
  pl: () => Promise.all([import("@/platform/i18n/pl"), import("./pl")]),
  ru: () => Promise.all([import("@/platform/i18n/ru"), import("./ru")]),
  ar: () => Promise.all([import("@/platform/i18n/ar"), import("./ar")]),
  no: () => Promise.all([import("@/platform/i18n/no"), import("./no")]),
  br: () => Promise.all([import("@/platform/i18n/pt-BR"), import("./br")]),
  bs: () => Promise.all([import("@/platform/i18n/bs"), import("./bs")]),
} satisfies Record<Exclude<Locale, "en">, () => Promise<[LocaleModule, LocaleModule]>>

function detectLocale(): Locale {
  if (typeof navigator !== "object") return "en"

  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("en")) return "en"
    if (language.toLowerCase().startsWith("zh")) {
      if (language.toLowerCase().includes("hant")) return "zht"
      return "zh"
    }
    if (language.toLowerCase().startsWith("ko")) return "ko"
    if (language.toLowerCase().startsWith("de")) return "de"
    if (language.toLowerCase().startsWith("es")) return "es"
    if (language.toLowerCase().startsWith("fr")) return "fr"
    if (language.toLowerCase().startsWith("da")) return "da"
    if (language.toLowerCase().startsWith("ja")) return "ja"
    if (language.toLowerCase().startsWith("pl")) return "pl"
    if (language.toLowerCase().startsWith("ru")) return "ru"
    if (language.toLowerCase().startsWith("ar")) return "ar"
    if (
      language.toLowerCase().startsWith("no") ||
      language.toLowerCase().startsWith("nb") ||
      language.toLowerCase().startsWith("nn")
    )
      return "no"
    if (language.toLowerCase().startsWith("pt")) return "br"
    if (language.toLowerCase().startsWith("bs")) return "bs"
  }

  return "en"
}

function parseLocale(value: unknown): Locale | null {
  // Found in the closed list rather than checked-then-asserted: the element
  // that comes back already IS a `Locale`.
  return LOCALES.find((locale) => locale === value) ?? null
}

function parseStored(value: unknown) {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function pickLocale(value: unknown): Locale | null {
  const direct = parseLocale(value)
  if (direct) return direct

  const record = asRecord(value)
  if (!record) return null

  return parseLocale(record.locale)
}

const base = i18n.flatten({ ...appEn, ...desktopEn })

async function build(locale: Locale): Promise<Dictionary> {
  if (locale === "en") return base
  const [app, desktop] = await loaders[locale]()
  return { ...base, ...i18n.flatten(app.dict), ...i18n.flatten(desktop.dict) }
}

const state = {
  locale: detectLocale(),
  dict: base as Dictionary,
  init: undefined as Promise<Locale> | undefined,
}

const translate = i18n.translator(() => state.dict, i18n.resolveTemplate)

export function t(key: keyof Dictionary, params?: Record<string, string | number>) {
  return translate(key, params)
}

/**
 * Until this resolves, `t` answers in English. The stored language wins over
 * the detected one; a store that cannot be read or a translation that fails
 * to load leaves the detected locale reported and the English dictionary live.
 */
export function initI18n(): Promise<Locale> {
  const cached = state.init
  if (cached) return cached

  const promise = (async () => {
    const raw = await desktopApi().storeGet("claxedo.global.dat", "language").catch(() => null)
    const next = pickLocale(parseStored(raw)) ?? state.locale
    state.dict = await build(next)
    state.locale = next
    return next
  })().catch(() => state.locale)

  state.init = promise
  return promise
}
