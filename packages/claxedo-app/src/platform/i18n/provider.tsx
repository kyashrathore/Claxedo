import * as i18n from "@solid-primitives/i18n"
import { createEffect, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { Persist, persisted } from "@/platform/persistence/persist"
import { dict as en } from "@/platform/i18n/en"
import { dict as uiEn } from "@opencode-ai/ui/i18n/en"
import { LOCALE_ENTRIES, type LocaleCode } from "@/platform/i18n/locales"

export type Locale = LocaleCode

type RawDictionary = typeof en & typeof uiEn
type Dictionary = i18n.Flatten<RawDictionary>

// Every one of LOCALES/INTL/LABEL_KEY/localeMatchers below is derived from
// LOCALE_ENTRIES (src/i18n/locales.ts) — that manifest is the only place a
// contributor edits to add a language. See src/i18n/locale-parity.test.ts for
// the tests that keep the manifest, en.ts, and @/ui's i18n in sync.
const ENTRY_BY_CODE = new Map(LOCALE_ENTRIES.map((entry) => [entry.code, entry]))

const LOCALES: readonly Locale[] = LOCALE_ENTRIES.map((entry) => entry.code)

const INTL: Record<Locale, string> = Object.fromEntries(
  LOCALE_ENTRIES.map((entry) => [entry.code, entry.intlTag]),
) as Record<Locale, string>

const LABEL_KEY: Record<Locale, keyof Dictionary> = Object.fromEntries(
  LOCALE_ENTRIES.map((entry) => [entry.code, entry.labelKey]),
) as Record<Locale, keyof Dictionary>

const localeMatchers: Array<{ locale: Locale; match: (language: string) => boolean }> = LOCALE_ENTRIES.map(
  (entry) => ({ locale: entry.code, match: entry.matches }),
)

const base = i18n.flatten({ ...en, ...uiEn })
const dicts = new Map<Locale, Dictionary>([["en", base]])

function loadDict(locale: Locale) {
  const hit = dicts.get(locale)
  if (hit) return Promise.resolve(hit)
  if (locale === "en") return Promise.resolve(base)
  const entry = ENTRY_BY_CODE.get(locale)
  if (!entry) return Promise.resolve(base)
  return entry.loader().then((source) => {
    const next = { ...base, ...i18n.flatten(source.dict) } as Dictionary
    dicts.set(locale, next)
    return next
  })
}

export function loadLocaleDict(locale: Locale) {
  return loadDict(locale).then(() => undefined)
}

function cookie(locale: Locale) {
  return `oc_locale=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`
}

export function normalizeLocale(value: string): Locale {
  return LOCALES.includes(value as Locale) ? (value as Locale) : "en"
}

function detectLocale(): Locale {
  if (typeof navigator !== "object") return "en"

  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    const normalized = language.toLowerCase()
    const match = localeMatchers.find((entry) => entry.match(normalized))
    if (match) return match.locale
  }

  return "en"
}

function readStoredLocale() {
  if (typeof localStorage !== "object") return
  try {
    const raw = localStorage.getItem("opencode.global.dat:language")
    if (!raw) return
    const next = JSON.parse(raw) as { locale?: string }
    if (typeof next?.locale !== "string") return
    return normalizeLocale(next.locale)
  } catch {
    return
  }
}

const warm = readStoredLocale() ?? detectLocale()
if (warm !== "en") void loadDict(warm)

const languageContextInput = {
  name: "Language", gate: true,
  init: (props: { locale?: Locale; strings?: Record<string, Record<string, string>> } = {}) => {
    const initial = props.locale ?? readStoredLocale() ?? detectLocale()
    const [store, setStore, _, ready] = persisted(
      Persist.global("language", ["language.v1"]),
      createStore({
        locale: initial,
      }),
    )

    const locale = createMemo<Locale>(() => normalizeLocale(store.locale))
    const intl = createMemo(() => INTL[locale()])

    const [loaded, setLoaded] = createSignal<Dictionary>(dicts.get(initial) ?? base)
    createEffect(() => {
      const current = locale()
      void loadDict(current).then((next) => {
        if (locale() === current) setLoaded(() => next)
      })
    })

    const dict = createMemo<Dictionary>(() => {
      const current = locale()
      return { ...loaded(), ...(props.strings?.[current] ?? {}) }
    })
    const t = i18n.translator(dict, i18n.resolveTemplate) as (
      key: keyof Dictionary,
      params?: Record<string, string | number | boolean>,
    ) => string

    const label = (value: Locale) => t(LABEL_KEY[value])

    createEffect(() => {
      if (typeof document !== "object") return
      document.documentElement.lang = locale()
      document.cookie = cookie(locale())
    })

    return {
      ready,
      locale,
      intl,
      locales: LOCALES,
      label,
      t,
      setLocale(next: Locale) {
        setStore("locale", normalizeLocale(next))
      },
    }
  },
}
export const { use: useLanguage, provider: LanguageProvider } = createSimpleContext<
  ReturnType<typeof languageContextInput.init>,
  { locale?: Locale; strings?: Record<string, Record<string, string>> }
>(languageContextInput)
