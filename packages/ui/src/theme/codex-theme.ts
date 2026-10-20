import { parseDesktopTheme } from "./parse"
import codexThemeJson from "./themes/codex.json"

export const codexTheme = parseDesktopTheme(codexThemeJson, "themes/codex.json")
