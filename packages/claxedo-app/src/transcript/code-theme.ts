import type { ThemeRegistration } from "@pierre/diffs"
import { codeThemeName } from "./code-theme-name"
import palette from "./code-theme.json"

export const codeTheme = { ...palette, name: codeThemeName } satisfies ThemeRegistration
