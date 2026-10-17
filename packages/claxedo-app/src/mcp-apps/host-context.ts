import { readThemeColorScheme, readThemeTokens, watchThemeTokens, type ThemeColorScheme } from "@/ui/utils"
import { DISPLAY_MODES, MAX_APP_HEIGHT, type DisplayMode } from "./model"

export const STYLE_VARIABLE_SOURCES = {
  "--color-background-primary": "--v2-background-bg-base",
  "--color-background-secondary": "--v2-background-bg-layer-01",
  "--color-background-tertiary": "--v2-background-bg-layer-02",
  "--color-background-inverse": "--v2-background-bg-inverse",
  "--color-background-info": "--v2-state-bg-info",
  "--color-background-danger": "--v2-state-bg-danger",
  "--color-background-success": "--v2-state-bg-success",
  "--color-background-warning": "--v2-state-bg-warning",
  "--color-text-primary": "--v2-text-text-base",
  "--color-text-secondary": "--v2-text-text-muted",
  "--color-text-tertiary": "--v2-text-text-faint",
  "--color-text-inverse": "--v2-text-text-inverse",
  "--color-text-info": "--v2-state-fg-info",
  "--color-text-danger": "--v2-state-fg-danger",
  "--color-text-success": "--v2-state-fg-success",
  "--color-text-warning": "--v2-state-fg-warning",
  "--color-border-primary": "--v2-border-border-base",
  "--color-border-secondary": "--v2-border-border-muted",
  "--color-border-tertiary": "--v2-border-border-strong",
  "--color-border-inverse": "--v2-border-border-inverse",
  "--color-border-info": "--v2-state-border-info",
  "--color-border-danger": "--v2-state-border-danger",
  "--color-border-success": "--v2-state-border-success",
  "--color-border-warning": "--v2-state-border-warning",
  "--color-ring-primary": "--v2-border-border-focus",
  "--font-sans": "--font-family-sans",
  "--font-mono": "--font-family-mono",
  "--font-weight-normal": "--font-weight-regular",
  "--font-weight-medium": "--font-weight-medium",
  "--font-weight-semibold": "--font-weight-semibold",
  "--font-weight-bold": "--font-weight-bold",
  "--font-text-xs-size": "--font-size-x-small",
  "--font-text-sm-size": "--font-size-small",
  "--font-text-md-size": "--font-size-base",
  "--font-text-lg-size": "--font-size-large",
  "--border-radius-xs": "--radius-xs",
  "--border-radius-sm": "--radius-sm",
  "--border-radius-md": "--radius-md",
  "--border-radius-lg": "--radius-lg",
  "--border-radius-xl": "--radius-xl",
  "--shadow-sm": "--shadow-xs",
  "--shadow-md": "--shadow-md",
  "--shadow-lg": "--shadow-lg",
} as const

export type StyleVariable = keyof typeof STYLE_VARIABLE_SOURCES

export type HostTheme = {
  readonly theme: ThemeColorScheme
  readonly variables: Readonly<Partial<Record<StyleVariable, string>>>
}

export type ContainerDimensions = { readonly width: number; readonly maxHeight: number } | { readonly width: number; readonly height: number }

export type HostContext = {
  readonly theme: ThemeColorScheme
  readonly styles: { readonly variables: Readonly<Partial<Record<StyleVariable, string>>> }
  readonly displayMode: DisplayMode
  readonly availableDisplayModes: readonly DisplayMode[]
  readonly containerDimensions: ContainerDimensions
  readonly locale: string
  readonly platform: "web" | "desktop"
}

export type HostContextInput = {
  readonly theme: HostTheme
  readonly displayMode: DisplayMode
  readonly width: number
  readonly viewportHeight: number
  readonly locale: string
  readonly platform: "web" | "desktop"
}

export function hostContext(input: HostContextInput): HostContext {
  return {
    theme: input.theme.theme,
    styles: { variables: input.theme.variables },
    displayMode: input.displayMode,
    availableDisplayModes: DISPLAY_MODES,
    containerDimensions: input.displayMode === "fullscreen" ? { width: input.width, height: input.viewportHeight } : { width: input.width, maxHeight: MAX_APP_HEIGHT },
    locale: input.locale,
    platform: input.platform,
  }
}

export function hostContextChanges(previous: HostContext, next: HostContext): Readonly<Record<string, unknown>> | undefined {
  const before: Readonly<Record<string, unknown>> = previous
  const changed = Object.entries(next).filter(([key, value]) => JSON.stringify(before[key]) !== JSON.stringify(value))
  return changed.length > 0 ? Object.fromEntries(changed) : undefined
}

export function readHostTheme(): HostTheme {
  return { theme: readThemeColorScheme(), variables: readThemeTokens(STYLE_VARIABLE_SOURCES) }
}

export function watchHostTheme(onChange: (theme: HostTheme) => void): () => void {
  return watchThemeTokens(() => onChange(readHostTheme()))
}
