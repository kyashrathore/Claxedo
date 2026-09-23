import { createContext, createEffect, createMemo, createSignal, useContext, type Accessor, type JSX } from "solid-js"
import { persistedSignal, preferenceKey } from "@/lib/persisted"
import { fillTemplate, lookup, mergeDictionaries, type TemplateParams, type Translations } from "./dictionary"
import { LOCALES, detectLocale, isLocale, localeEntry, type Locale, type LocaleEntry } from "./locales"

export type Translate = (key: string, params?: TemplateParams) => string

export type I18n = {
  readonly locale: Accessor<Locale>
  readonly setLocale: (next: Locale) => void
  readonly locales: readonly LocaleEntry[]
  readonly intlTag: Accessor<string>
  readonly t: Translate
  readonly add: (domain: Translations) => () => void
}

const I18nContext = createContext<I18n>()

const localeCodes = LOCALES.map((entry) => entry.code)

function browserLanguages(): readonly string[] {
  if (typeof navigator !== "object") return []
  return navigator.languages?.length ? navigator.languages : [navigator.language]
}

export function I18nProvider(props: { readonly locale?: Locale; readonly children: JSX.Element }): JSX.Element {
  const [locale, setLocale] = persistedSignal<Locale>(
    preferenceKey("locale"),
    props.locale ?? detectLocale(browserLanguages()),
    (value) => (isLocale(value) ? value : undefined),
  )
  const [domains, setDomains] = createSignal<readonly Translations[]>([])
  const merged = createMemo(() => mergeDictionaries(domains(), localeCodes))
  const intlTag = createMemo(() => localeEntry(locale()).intlTag)

  createEffect(() => {
    if (typeof document !== "object") return
    document.documentElement.lang = intlTag()
  })

  const value: I18n = {
    locale,
    setLocale: (next) => setLocale(next),
    locales: LOCALES,
    intlTag,
    t: (key, params) => fillTemplate(lookup(merged(), locale(), key), params),
    add: (domain) => {
      setDomains((current) => (current.includes(domain) ? current : [...current, domain]))
      return () => setDomains((current) => current.filter((entry) => entry !== domain))
    },
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
