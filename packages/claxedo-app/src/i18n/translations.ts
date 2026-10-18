import { createSignal, untrack, type Accessor } from "solid-js"
import { createDictionaries, fillTemplate, type TemplateParams, type Translations } from "./dictionary"
import type { Locale } from "./locales"

export type Translate = (key: string, params?: TemplateParams) => string

export type TranslationRegistry = {
  readonly t: Translate
  readonly add: (domain: Translations) => () => void
  readonly pending: (locale: Locale) => boolean
  readonly load: (locale: Locale) => Promise<void>
}

export function createTranslationRegistry(locale: Accessor<Locale>): TranslationRegistry {
  const dictionaries = createDictionaries()
  const [added, markAdded] = createSignal(undefined, { equals: false })
  const [removed, markRemoved] = createSignal(undefined, { equals: false })
  const load = async (target: Locale) => {
    try {
      if (await dictionaries.load(target)) markAdded()
    } catch (error) {
      console.warn(`The ${target} strings could not be loaded; English shows for the keys they cover`, { error })
    }
  }
  return {
    t: (key, params) => {
      removed()
      const resolved = dictionaries.resolve(locale(), key)
      if (!resolved.found) added()
      return fillTemplate(resolved.text, params)
    },
    add: (domain) => {
      if (dictionaries.add(domain)) {
        markAdded()
        const current = untrack(locale)
        if (dictionaries.pending(current)) void load(current)
      }
      return () => {
        if (dictionaries.remove(domain)) markRemoved()
      }
    },
    pending: dictionaries.pending,
    load,
  }
}
