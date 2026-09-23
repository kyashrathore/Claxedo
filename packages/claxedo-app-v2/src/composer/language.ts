import { createContext, useContext, type Accessor } from "solid-js"

export type TextParams = Readonly<Record<string, string | number>>

export const LocaleContext = createContext<Accessor<string>>()

export function useLocale(): Accessor<string> {
  return useContext(LocaleContext) ?? (() => "en")
}

export function fillText(template: string, params?: TextParams) {
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

export function createText<Key extends string>(
  dictionaries: { readonly en: Record<Key, string> } & Readonly<Record<string, Partial<Record<Key, string>>>>,
) {
  return function useText() {
    const locale = useLocale()
    return (key: Key, params?: TextParams) => fillText(dictionaries[locale()]?.[key] ?? dictionaries.en[key], params)
  }
}
