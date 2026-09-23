import { createSignal, type Accessor } from "solid-js"
import type { PluginDictionary, PluginI18n } from "@claxedo/plugin-api"

type DictionarySet = Readonly<Record<string, PluginDictionary>>

export function createPluginI18n(language: Accessor<string>): PluginI18n {
  const [sets, setSets] = createSignal<readonly DictionarySet[]>([])
  const lookup = (key: string): string => {
    for (const set of sets()) {
      const value = set[language()]?.[key] ?? set.en?.[key]
      if (value !== undefined) return value
    }
    return key
  }
  return {
    t: (key, params) => interpolate(lookup(key), params),
    add: (added) => {
      setSets((current) => [...current, added])
      return () => setSets((current) => current.filter((set) => set !== added))
    },
  }
}

function interpolate(template: string, params?: Readonly<Record<string, string | number>>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}
