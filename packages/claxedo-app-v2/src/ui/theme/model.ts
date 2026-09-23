export type ColorScheme = "light" | "dark" | "system"

export type ColorMode = "light" | "dark"

export type ThemeStylesheet = { light: string; dark: string }

export type ThemeRecord = { id: string; name: string; stylesheet: ThemeStylesheet }

export const defaultThemeId = "claxedo"

export const themeStorageKeys = {
  theme: "claxedo-theme",
  colorScheme: "claxedo-color-scheme",
  stylesheet: (mode: ColorMode) => `claxedo-theme-css-${mode}`,
} as const

export const colorSchemes: readonly ColorScheme[] = ["light", "dark", "system"]

export const isColorScheme = (value: unknown): value is ColorScheme =>
  colorSchemes.some((scheme) => scheme === value)

export const chromeColor = (mode: ColorMode) => (mode === "dark" ? "#161616" : "#ffffff")

export const themeIdPattern = /^[a-z0-9-]+$/
