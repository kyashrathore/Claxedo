import { createSignal, type Accessor } from "solid-js"
import { createDictionaries, fillTemplate, type TemplateParams, type Translations } from "./dictionary"
import type { Locale } from "./locales"

export type Translate = (key: string, params?: TemplateParams) => string

export type TranslationRegistry = {
  readonly t: Translate
  readonly add: (domain: Translations) => () => void
}

export function createTranslationRegistry(locale: Accessor<Locale>): TranslationRegistry {
  const dictionaries = createDictionaries()
  const [added, markAdded] = createSignal(undefined, { equals: false })
  const [removed, markRemoved] = createSignal(undefined, { equals: false })
  return {
    t: (key, params) => {
      removed()
      const resolved = dictionaries.resolve(locale(), key)
      if (!resolved.found) added()
      return fillTemplate(resolved.text, params)
    },
    add: (domain) => {
      if (dictionaries.add(domain)) markAdded()
      return () => {
        if (dictionaries.remove(domain)) markRemoved()
      }
    },
  }
}
