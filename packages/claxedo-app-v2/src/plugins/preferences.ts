import { createSignal, type Accessor } from "solid-js"
import { persistedSignal, preferenceKey } from "@/lib/persisted"

type PluginChoices = { readonly off: readonly string[]; readonly confirmed: readonly string[] }

export type PluginPreferences = {
  readonly switchedOn: (pluginId: string) => boolean
  readonly setSwitchedOn: (pluginId: string, on: boolean) => void
  readonly confirmed: (pluginId: string) => boolean
  readonly confirm: (pluginId: string) => void
  readonly forget: (pluginId: string) => void
  readonly safeMode: Accessor<boolean>
  readonly leaveSafeMode: () => void
}

const NO_CHOICES: PluginChoices = { off: [], confirmed: [] }

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function readChoices(value: unknown): PluginChoices | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { off, confirmed } = value as Record<string, unknown>
  return isStringList(off) && isStringList(confirmed) ? { off, confirmed } : undefined
}

function without(list: readonly string[], id: string): readonly string[] {
  return list.filter((entry) => entry !== id)
}

export function safeModeRequested(search: string): boolean {
  return new URLSearchParams(search).has("safe-mode")
}

export function createPluginPreferences(scope: string, safeModeAtStart: boolean): PluginPreferences {
  const [choices, setChoices] = persistedSignal(preferenceKey("plugins", scope), NO_CHOICES, readChoices)
  const [safeMode, setSafeMode] = createSignal(safeModeAtStart)
  const update = (change: (current: PluginChoices) => PluginChoices) => setChoices((current) => change(current))
  return {
    switchedOn: (pluginId) => !choices().off.includes(pluginId),
    setSwitchedOn: (pluginId, on) =>
      update((current) => ({ ...current, off: on ? without(current.off, pluginId) : [...without(current.off, pluginId), pluginId] })),
    confirmed: (pluginId) => choices().confirmed.includes(pluginId),
    confirm: (pluginId) => update((current) => ({ ...current, confirmed: [...without(current.confirmed, pluginId), pluginId] })),
    forget: (pluginId) => update((current) => ({ off: without(current.off, pluginId), confirmed: without(current.confirmed, pluginId) })),
    safeMode,
    leaveSafeMode: () => setSafeMode(false),
  }
}
