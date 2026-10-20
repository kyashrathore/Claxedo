import { createContext, createEffect, createMemo, createSignal, useContext, type Accessor, type JSX } from "solid-js"
import { persistedSignal, preferenceKey } from "@/lib/persisted"
import type { TemplateParams, Translations } from "./dictionary"
import { createTranslationRegistry, type Translate } from "./translations"
import { LOCALES, detectLocale, isLocale, localeEntry, type Locale, type LocaleEntry } from "./locales"

export type I18n = {
  readonly locale: Accessor<Locale>
  readonly setLocale: (next: Locale) => void
  readonly locales: readonly LocaleEntry[]
  readonly intlTag: Accessor<string>
  readonly ready: Accessor<boolean>
  readonly t: Translate
  readonly add: (domain: Translations) => () => void
}

const I18nContext = createContext<I18n>()

function browserLanguages(): readonly string[] {
  if (typeof navigator !== "object") return []
  return navigator.languages?.length ? navigator.languages : [navigator.language]
}

export type I18nProviderProps = {
  readonly locale?: Locale
  readonly dictionaries?: readonly Translations[]
  readonly children: JSX.Element
}

export function I18nProvider(props: I18nProviderProps): JSX.Element {
  const [locale, setLocale] = persistedSignal<Locale>(
    preferenceKey("locale"),
    props.locale ?? detectLocale(browserLanguages()),
    (value) => (isLocale(value) ? value : undefined),
  )
  const translations = createTranslationRegistry(locale)
  for (const dictionary of props.dictionaries ?? []) translations.add(dictionary)
  const [ready, setReady] = createSignal(!translations.pending(locale()))
  if (!ready()) void translations.load(locale()).then(() => setReady(true))
  const intlTag = createMemo(() => localeEntry(locale()).intlTag)

  createEffect(() => {
    if (typeof document !== "object") return
    document.documentElement.lang = intlTag()
  })

  const value: I18n = {
    locale,
    setLocale: (next) => void translations.load(next).then(() => setLocale(next)),
    locales: LOCALES,
    intlTag,
    ready,
    t: translations.t,
    add: translations.add,
  }
  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>
}

export function useI18n(): I18n {
  const i18n = useContext(I18nContext)
  if (!i18n) throw new Error("useI18n needs an I18nProvider above it")
  return i18n
}

export type DomainTranslate<Keys extends string> = (key: Keys, params?: TemplateParams) => string

export function useTranslator<Keys extends string>(domain: Translations<Keys>): DomainTranslate<Keys> {
  const i18n = useI18n()
  i18n.add(domain)
  return (key, params) => i18n.t(key, params)
}
