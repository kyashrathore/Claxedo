import { makePersisted } from "@solid-primitives/storage"
import { createSignal, type Accessor, type Signal } from "solid-js"
import type { Json } from "@claxedo/plugin-api"

type EnablementRecord = { readonly disabled: readonly string[]; readonly confirmed: readonly string[] }

type Persisted<Value> = readonly [Accessor<Value>, (value: Value) => void]

export type PluginPreferences = {
  readonly enabled: (pluginId: string) => boolean
  readonly setEnabled: (pluginId: string, enabled: boolean) => void
  readonly confirmed: (pluginId: string) => boolean
  readonly confirm: (pluginId: string) => void
  readonly forget: (pluginId: string) => void
  readonly safeMode: Accessor<boolean>
  readonly leaveSafeMode: () => void
  readonly persisted: <Value extends Json>(pluginId: string, key: string, initial: Value) => Persisted<Value>
}

const EMPTY: EnablementRecord = { disabled: [], confirmed: [] }

function persistedSignal<Value>(name: string, initial: Value): Persisted<Value> {
  const [value, setValue] = makePersisted<Value, Signal<Value>>(createSignal<Value>(initial), { name })
  return [value, (next) => setValue(() => next)]
}

function memoized<Value>(cache: Map<string, unknown>, name: string, create: () => Persisted<Value>): Persisted<Value> {
  const existing = cache.get(name)
  if (existing) return existing as Persisted<Value>
  const created = create()
  cache.set(name, created)
  return created
}

export function createPluginPreferences(userKey: Accessor<string>, safeModeRequested: boolean): PluginPreferences {
  const cache = new Map<string, unknown>()
  const [safeMode, setSafeMode] = createSignal(safeModeRequested)

  const record = () => {
    const name = `claxedo.plugins.${userKey()}`
    return memoized<EnablementRecord>(cache, name, () => persistedSignal(name, EMPTY))
  }
  const update = (change: (current: EnablementRecord) => EnablementRecord) => {
    const [value, setValue] = record()
    setValue(change(value()))
  }
  const without = (list: readonly string[], id: string) => list.filter((entry) => entry !== id)

  return {
    enabled: (pluginId) => !record()[0]().disabled.includes(pluginId),
    setEnabled: (pluginId, enabled) =>
      update((current) => ({
        ...current,
        disabled: enabled ? without(current.disabled, pluginId) : [...without(current.disabled, pluginId), pluginId],
      })),
    confirmed: (pluginId) => record()[0]().confirmed.includes(pluginId),
    confirm: (pluginId) => update((current) => ({ ...current, confirmed: [...without(current.confirmed, pluginId), pluginId] })),
    forget: (pluginId) =>
      update((current) => ({ disabled: without(current.disabled, pluginId), confirmed: without(current.confirmed, pluginId) })),
    safeMode,
    leaveSafeMode: () => setSafeMode(false),
    persisted: (pluginId, key, initial) => {
      const name = `claxedo.plugin.${pluginId}.${userKey()}.${key}`
      return memoized(cache, name, () => persistedSignal(name, initial))
    },
  }
}

export function safeModeRequested(search: string): boolean {
  return new URLSearchParams(search).has("safe")
}
