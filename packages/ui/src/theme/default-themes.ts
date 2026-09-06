import type { DesktopTheme } from "./types"
import { parseDesktopTheme } from "./parse"
import oc2ThemeJson from "./themes/oc-2.json"
import amoledThemeJson from "./themes/amoled.json"
import auraThemeJson from "./themes/aura.json"
import ayuThemeJson from "./themes/ayu.json"
import carbonfoxThemeJson from "./themes/carbonfox.json"
import catppuccinThemeJson from "./themes/catppuccin.json"
import catppuccinFrappeThemeJson from "./themes/catppuccin-frappe.json"
import catppuccinMacchiatoThemeJson from "./themes/catppuccin-macchiato.json"
import cobalt2ThemeJson from "./themes/cobalt2.json"
import codexThemeJson from "./themes/codex.json"
import cursorThemeJson from "./themes/cursor.json"
import draculaThemeJson from "./themes/dracula.json"
import everforestThemeJson from "./themes/everforest.json"
import flexokiThemeJson from "./themes/flexoki.json"
import githubThemeJson from "./themes/github.json"
import gruvboxThemeJson from "./themes/gruvbox.json"
import kanagawaThemeJson from "./themes/kanagawa.json"
import lucentOrngThemeJson from "./themes/lucent-orng.json"
import materialThemeJson from "./themes/material.json"
import matrixThemeJson from "./themes/matrix.json"
import mercuryThemeJson from "./themes/mercury.json"
import monokaiThemeJson from "./themes/monokai.json"
import nightowlThemeJson from "./themes/nightowl.json"
import nordThemeJson from "./themes/nord.json"
import oneDarkThemeJson from "./themes/one-dark.json"
import oneDarkProThemeJson from "./themes/onedarkpro.json"
import opencodeThemeJson from "./themes/opencode.json"
import orngThemeJson from "./themes/orng.json"
import osakaJadeThemeJson from "./themes/osaka-jade.json"
import palenightThemeJson from "./themes/palenight.json"
import rosepineThemeJson from "./themes/rosepine.json"
import shadesOfPurpleThemeJson from "./themes/shadesofpurple.json"
import solarizedThemeJson from "./themes/solarized.json"
import synthwave84ThemeJson from "./themes/synthwave84.json"
import tokyonightThemeJson from "./themes/tokyonight.json"
import vercelThemeJson from "./themes/vercel.json"
import vesperThemeJson from "./themes/vesper.json"
import zenburnThemeJson from "./themes/zenburn.json"

export const oc2Theme = parseDesktopTheme(oc2ThemeJson, "themes/oc-2.json")
export const amoledTheme = parseDesktopTheme(amoledThemeJson, "themes/amoled.json")
export const auraTheme = parseDesktopTheme(auraThemeJson, "themes/aura.json")
export const ayuTheme = parseDesktopTheme(ayuThemeJson, "themes/ayu.json")
export const carbonfoxTheme = parseDesktopTheme(carbonfoxThemeJson, "themes/carbonfox.json")
export const catppuccinTheme = parseDesktopTheme(catppuccinThemeJson, "themes/catppuccin.json")
export const catppuccinFrappeTheme = parseDesktopTheme(catppuccinFrappeThemeJson, "themes/catppuccin-frappe.json")
export const catppuccinMacchiatoTheme = parseDesktopTheme(catppuccinMacchiatoThemeJson, "themes/catppuccin-macchiato.json")
export const cobalt2Theme = parseDesktopTheme(cobalt2ThemeJson, "themes/cobalt2.json")
export const codexTheme = parseDesktopTheme(codexThemeJson, "themes/codex.json")
export const cursorTheme = parseDesktopTheme(cursorThemeJson, "themes/cursor.json")
export const draculaTheme = parseDesktopTheme(draculaThemeJson, "themes/dracula.json")
export const everforestTheme = parseDesktopTheme(everforestThemeJson, "themes/everforest.json")
export const flexokiTheme = parseDesktopTheme(flexokiThemeJson, "themes/flexoki.json")
export const githubTheme = parseDesktopTheme(githubThemeJson, "themes/github.json")
export const gruvboxTheme = parseDesktopTheme(gruvboxThemeJson, "themes/gruvbox.json")
export const kanagawaTheme = parseDesktopTheme(kanagawaThemeJson, "themes/kanagawa.json")
export const lucentOrngTheme = parseDesktopTheme(lucentOrngThemeJson, "themes/lucent-orng.json")
export const materialTheme = parseDesktopTheme(materialThemeJson, "themes/material.json")
export const matrixTheme = parseDesktopTheme(matrixThemeJson, "themes/matrix.json")
export const mercuryTheme = parseDesktopTheme(mercuryThemeJson, "themes/mercury.json")
export const monokaiTheme = parseDesktopTheme(monokaiThemeJson, "themes/monokai.json")
export const nightowlTheme = parseDesktopTheme(nightowlThemeJson, "themes/nightowl.json")
export const nordTheme = parseDesktopTheme(nordThemeJson, "themes/nord.json")
export const oneDarkTheme = parseDesktopTheme(oneDarkThemeJson, "themes/one-dark.json")
export const oneDarkProTheme = parseDesktopTheme(oneDarkProThemeJson, "themes/onedarkpro.json")
export const opencodeTheme = parseDesktopTheme(opencodeThemeJson, "themes/opencode.json")
export const orngTheme = parseDesktopTheme(orngThemeJson, "themes/orng.json")
export const osakaJadeTheme = parseDesktopTheme(osakaJadeThemeJson, "themes/osaka-jade.json")
export const palenightTheme = parseDesktopTheme(palenightThemeJson, "themes/palenight.json")
export const rosepineTheme = parseDesktopTheme(rosepineThemeJson, "themes/rosepine.json")
export const shadesOfPurpleTheme = parseDesktopTheme(shadesOfPurpleThemeJson, "themes/shadesofpurple.json")
export const solarizedTheme = parseDesktopTheme(solarizedThemeJson, "themes/solarized.json")
export const synthwave84Theme = parseDesktopTheme(synthwave84ThemeJson, "themes/synthwave84.json")
export const tokyonightTheme = parseDesktopTheme(tokyonightThemeJson, "themes/tokyonight.json")
export const vercelTheme = parseDesktopTheme(vercelThemeJson, "themes/vercel.json")
export const vesperTheme = parseDesktopTheme(vesperThemeJson, "themes/vesper.json")
export const zenburnTheme = parseDesktopTheme(zenburnThemeJson, "themes/zenburn.json")

export const DEFAULT_THEMES: Record<string, DesktopTheme> = {
  "oc-2": oc2Theme,
  amoled: amoledTheme,
  aura: auraTheme,
  ayu: ayuTheme,
  carbonfox: carbonfoxTheme,
  catppuccin: catppuccinTheme,
  "catppuccin-frappe": catppuccinFrappeTheme,
  "catppuccin-macchiato": catppuccinMacchiatoTheme,
  cobalt2: cobalt2Theme,
  codex: codexTheme,
  cursor: cursorTheme,
  dracula: draculaTheme,
  everforest: everforestTheme,
  flexoki: flexokiTheme,
  github: githubTheme,
  gruvbox: gruvboxTheme,
  kanagawa: kanagawaTheme,
  "lucent-orng": lucentOrngTheme,
  material: materialTheme,
  matrix: matrixTheme,
  mercury: mercuryTheme,
  monokai: monokaiTheme,
  nightowl: nightowlTheme,
  nord: nordTheme,
  "one-dark": oneDarkTheme,
  onedarkpro: oneDarkProTheme,
  opencode: opencodeTheme,
  orng: orngTheme,
  "osaka-jade": osakaJadeTheme,
  palenight: palenightTheme,
  rosepine: rosepineTheme,
  shadesofpurple: shadesOfPurpleTheme,
  solarized: solarizedTheme,
  synthwave84: synthwave84Theme,
  tokyonight: tokyonightTheme,
  vercel: vercelTheme,
  vesper: vesperTheme,
  zenburn: zenburnTheme,
}
