import { batch } from "solid-js"
import type { PluginApi, ThemeAppearance, ThemeDefinition } from "@claxedo/plugin-api"
import type { Disposer, ThemeEntry } from "@/shell"
import { PluginEntryError, type BindingScope } from "./services"

type Appearance = Pick<PluginApi, "themes" | "icons">

type ThemeSet = Map<ThemeAppearance, ThemeDefinition>

function mergedValue(scope: BindingScope, name: string, light: string, dark: string): string {
  if (light === dark) return light
  if (CSS.supports("color", light) && CSS.supports("color", dark)) return `light-dark(${light}, ${dark})`
  throw new PluginEntryError(scope.manifest.id, `the theme token ${name} differs between light and dark but is not a color`)
}

function mergedTokens(scope: BindingScope, light: ThemeDefinition, dark: ThemeDefinition): Readonly<Record<string, string>> {
  const names = new Set([...Object.keys(light.tokens), ...Object.keys(dark.tokens)])
  const tokens: Record<string, string> = {}
  for (const name of names) {
    const lightValue = light.tokens[name]
    const darkValue = dark.tokens[name]
    if (lightValue === undefined || darkValue === undefined) {
      throw new PluginEntryError(scope.manifest.id, `the theme ${light.id} must name ${name} for both light and dark`)
    }
    tokens[name] = mergedValue(scope, name, lightValue, darkValue)
  }
  return tokens
}

function themeEntry(scope: BindingScope, set: ThemeSet): ThemeEntry | undefined {
  const light = set.get("light")
  const dark = set.get("dark")
  if (light && dark) return { id: light.id, name: light.name, tokens: mergedTokens(scope, light, dark) }
  const only = light ?? dark
  return only && { id: only.id, name: only.name, appearance: only.appearance, tokens: only.tokens }
}

function themeBinding(scope: BindingScope): PluginApi["themes"] {
  const { themes } = scope.services.registries
  const sets = new Map<string, ThemeSet>()
  const shown = new Map<string, Disposer>()
  const releases = new Map<string, Disposer>()
  const show = (id: string, set: ThemeSet) =>
    batch(() => {
      shown.get(id)?.()
      shown.delete(id)
      const entry = themeEntry(scope, set)
      if (entry) shown.set(id, themes.add(entry))
    })
  return {
    register: (theme) => {
      const set = sets.get(theme.id) ?? new Map<ThemeAppearance, ThemeDefinition>()
      if (set.has(theme.appearance)) throw new PluginEntryError(scope.manifest.id, `the ${theme.appearance} theme ${theme.id} is already registered`)
      if (set.size === 0) releases.set(theme.id, scope.services.claims.claim(`theme:${theme.id}`, scope.manifest.id))
      set.set(theme.appearance, theme)
      sets.set(theme.id, set)
      show(theme.id, set)
      return scope.sink.track(() => {
        set.delete(theme.appearance)
        show(theme.id, set)
        if (set.size > 0) return
        releases.get(theme.id)?.()
        releases.delete(theme.id)
      })
    },
  }
}

export function appearanceBindings(scope: BindingScope): Appearance {
  const { iconSkins } = scope.services.registries
  return {
    themes: themeBinding(scope),
    icons: {
      registerSkin: (skin) => {
        const release = scope.services.claims.claim(`skin:${skin.id}`, scope.manifest.id)
        const remove = iconSkins.add({ id: skin.id, icons: skin.icons })
        return scope.sink.track(() => {
          remove()
          release()
        })
      },
    },
  }
}
