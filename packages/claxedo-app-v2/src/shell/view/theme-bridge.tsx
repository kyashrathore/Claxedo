import { createEffect, onCleanup, type JSX } from "solid-js"
import { useTheme, type ThemeStylesheet } from "@/ui"
import { useShellRegistries } from "../registries"
import type { ThemeEntry } from "../types"

function declarations(tokens: Readonly<Record<string, string>>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `${name}:${value}`)
    .join(";")
}

export function stylesheetOf(entry: ThemeEntry): ThemeStylesheet {
  const css = declarations(entry.tokens)
  if (entry.appearance === "light") return { light: css, dark: "" }
  if (entry.appearance === "dark") return { light: "", dark: css }
  return { light: css, dark: css }
}

export function ThemeBridge(): JSX.Element {
  const registries = useShellRegistries()
  const theme = useTheme()
  const registered = new Set<string>()

  createEffect(() => {
    const entries = registries.themes.list()
    const wanted = new Set(entries.map((entry) => entry.id))
    for (const id of registered) {
      if (wanted.has(id)) continue
      theme.unregisterTheme(id)
      registered.delete(id)
    }
    for (const entry of entries) {
      try {
        theme.registerTheme({ id: entry.id, name: entry.name, stylesheet: stylesheetOf(entry) })
        registered.add(entry.id)
      } catch (error) {
        console.error(`Theme "${entry.id}" was rejected by the theme runtime`, error)
      }
    }
  })
  onCleanup(() => {
    for (const id of registered) theme.unregisterTheme(id)
  })
  return null
}
