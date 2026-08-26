import * as i18n from "@solid-primitives/i18n"
import { desktopApi } from "../api"

// English is the startup fallback. Every other dictionary remains outside the
// initial renderer graph and is fetched only when locale detection or the
// persisted preference selects it.
import { dict as desktopEn } from "./en"
import { dict as appEn } from "@/platform/i18n/en"

export type Locale =
  "en" | "zh" | "zht" | "ko" | "de" | "es" | "fr" | "da" | "ja" | "pl" | "ru" | "ar" | "no" | "br" | "bs"

type RawDictionary = typeof appEn & typeof desktopEn
type Dictionary = i18n.Flatten<RawDictionary>

const LOCALES: readonly Locale[] = [
  "en",
  "zh",
  "zht",
  "ko",
  "de",
  "es",
  "fr",
  "da",
  "ja",
  "pl",
  "ru",
  "bs",
  "ar",
  "no",
  "br",
]

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
  if (!value) return null
  if (typeof value !== "string") return null
  if ((LOCALES as readonly string[]).includes(value)) return value as Locale
  return null
}

function parseRecord(value: unknown) {
  if (!value || typeof value !== "object") return null
  if (Array.isArray(value)) return null
  return value as Record<string, unknown>
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

  const record = parseRecord(value)
  if (!record) return null

  return parseLocale(record.locale)
}

const base = i18n.flatten({ ...appEn, ...desktopEn }) as Dictionary

type NonEnglishLocale = Exclude<Locale, "en">

function loadPair<A extends i18n.BaseDict, D extends i18n.BaseDict>(
  app: Promise<{ dict: A }>,
  desktop: Promise<{ dict: D }>,
): Promise<Dictionary> {
  return Promise.all([app, desktop]).then(([appSource, desktopSource]) => {
    const appDict = i18n.flatten(appSource.dict) as unknown as Dictionary
    const desktopDict = i18n.flatten(desktopSource.dict) as unknown as Dictionary
    return { ...base, ...appDict, ...desktopDict }
  })
}

// Keep the import specifiers literal so Vite emits one on-demand path per
// selected locale rather than a broad variable-import context. App and desktop
// dictionaries for a locale load together and share the same cached promise.
const loaders: Record<NonEnglishLocale, () => Promise<Dictionary>> = {
  zh: () => loadPair(import("@/platform/i18n/zh"), import("./zh")),
  zht: () => loadPair(import("@/platform/i18n/zht"), import("./zht")),
  ko: () => loadPair(import("@/platform/i18n/ko"), import("./ko")),
  de: () => loadPair(import("@/platform/i18n/de"), import("./de")),
  es: () => loadPair(import("@/platform/i18n/es"), import("./es")),
  fr: () => loadPair(import("@/platform/i18n/fr"), import("./fr")),
  da: () => loadPair(import("@/platform/i18n/da"), import("./da")),
  ja: () => loadPair(import("@/platform/i18n/ja"), import("./ja")),
  pl: () => loadPair(import("@/platform/i18n/pl"), import("./pl")),
  ru: () => loadPair(import("@/platform/i18n/ru"), import("./ru")),
  ar: () => loadPair(import("@/platform/i18n/ar"), import("./ar")),
  no: () => loadPair(import("@/platform/i18n/no"), import("./no")),
  br: () => loadPair(import("@/platform/i18n/pt-BR"), import("./br")),
  bs: () => loadPair(import("@/platform/i18n/bs"), import("./bs")),
}

const dictionaries = new Map<Locale, Promise<Dictionary>>([["en", Promise.resolve(base)]])

export function loadDesktopDictionary(locale: Locale): Promise<Dictionary> {
  const hit = dictionaries.get(locale)
  if (hit) return hit

  const pending = loaders[locale as NonEnglishLocale]().catch((error) => {
    dictionaries.delete(locale)
    throw error
  })
  dictionaries.set(locale, pending)
  return pending
}

const state = {
  locale: detectLocale(),
  dict: base,
  init: undefined as Promise<Locale> | undefined,
}

// Start fetching an OS-selected non-English locale immediately, but do not put
// any non-English dictionary in the startup graph. The persisted locale read in
// initI18n remains authoritative if it selects a different language.
if (state.locale !== "en") {
  const detected = state.locale
  void loadDesktopDictionary(detected)
    .then((next) => {
      if (state.locale === detected) state.dict = next
    })
    .catch(() => undefined)
}

const translate = i18n.translator(() => state.dict, i18n.resolveTemplate)

export function t(key: keyof Dictionary, params?: Record<string, string | number>) {
  return translate(key, params)
}

export function initI18n(): Promise<Locale> {
  const cached = state.init
  if (cached) return cached

  const promise = (async () => {
    const raw = await desktopApi()
      .storeGet("opencode.global.dat", "language")
      .catch(() => null)
    const value = parseStored(raw)
    const next = pickLocale(value) ?? state.locale

    state.locale = next
    state.dict = await loadDesktopDictionary(next)
    return next
  })().catch(() => state.locale)

  state.init = promise
  return promise
}
