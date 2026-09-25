import { createMemo, For, onCleanup, type JSX, type ParentProps } from "solid-js"
import { IconSkinContext, oc2Theme, useTheme, type DesktopTheme, type ThemeVariant } from "@/ui"
import { useShellRegistries } from "../registries"
import type { ThemeEntry } from "../types"

function withTokens(variant: ThemeVariant, tokens: Readonly<Record<string, string>>): ThemeVariant {
  return { ...variant, v2Overrides: { ...variant.v2Overrides, ...tokens } }
}

export function desktopThemeOf(entry: ThemeEntry): DesktopTheme {
  const tokensFor = (appearance: "light" | "dark") => (entry.appearance === undefined || entry.appearance === appearance ? entry.tokens : {})
  return {
    id: entry.id,
    name: entry.name,
    light: withTokens(oc2Theme.light, tokensFor("light")),
    dark: withTokens(oc2Theme.dark, tokensFor("dark")),
  }
}

function RegisteredTheme(props: { readonly entry: ThemeEntry }): JSX.Element {
  const theme = useTheme()
  const id = props.entry.id
  theme.registerTheme(desktopThemeOf(props.entry))
  onCleanup(() => theme.unregisterTheme(id))
  return null
}

export function RegisteredAppearance(props: ParentProps): JSX.Element {
  const registries = useShellRegistries()
  const theme = useTheme()
  const skin = createMemo(() => registries.iconSkins.list().find((entry) => entry.id === theme.themeId())?.icons)
  return (
    <>
      <For each={registries.themes.list()}>{(entry) => <RegisteredTheme entry={entry} />}</For>
      <IconSkinContext.Provider value={skin}>{props.children}</IconSkinContext.Provider>
    </>
  )
}
