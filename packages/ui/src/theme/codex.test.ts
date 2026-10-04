import { describe, expect, test } from "bun:test"
import codexThemeJson from "./themes/codex.json"
import { contrastRatio } from "./color"
import { resolveTheme } from "./resolve"
import type { DesktopTheme, HexColor } from "./types"

/*
 * Codex names the semantic shell roles rather than a private `codex-*` family,
 * so the shell stylesheet can be written once for every theme. These are the
 * approved values, read from the shipped Codex app.
 */
const approved = {
  light: {
    "shell-surface-sidebar": "#f9f9f9",
    "shell-surface-header": "#ffffff",
    "shell-surface-composer": "#ffffff",
    "shell-surface-context-card": "#f7f7f7",
    "overlay-surface": "#ffffff",
    "overlay-surface-input": "#00000014",
    "tab-surface-selected": "#ededed",
    "overlay-text": "#171717",
    "overlay-text-muted": "#6f6f6f",
    "overlay-border": "#e0e0e0",
    "row-surface-hover": "#0000000a",
    "row-surface-selected": "#1a1c1f0d",
    "shell-border-sidebar": "#ededed",
    "shell-border-header": "#ededed",
    "composer-border": "#d8d8d8",
  },
  dark: {
    "shell-surface-sidebar": "#181818",
    "shell-surface-header": "#0d0d0d",
    "shell-surface-composer": "#212121",
    "shell-surface-context-card": "#1c1c1c",
    "overlay-surface": "#212121",
    "overlay-surface-input": "#ffffff0f",
    "tab-surface-selected": "#1c1c1c",
    "overlay-text": "#f2f2f2",
    "overlay-text-muted": "#bdbdbd",
    "overlay-border": "#414141",
    "row-surface-hover": "#282828",
    "row-surface-selected": "#303030",
    "composer-border": "#303030",
  },
} as const

describe("Codex theme", () => {
  const theme = resolveTheme(codexThemeJson as DesktopTheme)

  test("matches the approved light and dark semantic palette", () => {
    expect(theme.light).toMatchObject(approved.light)
    expect(theme.dark).toMatchObject(approved.dark)
  })

  test("keeps overlay text readable in both variants", () => {
    expect(contrast(approved.light["overlay-text"], approved.light["overlay-surface"])).toBeGreaterThanOrEqual(7)
    expect(contrast(approved.dark["overlay-text"], approved.dark["overlay-surface"])).toBeGreaterThanOrEqual(7)
    expect(contrast(approved.light["overlay-text-muted"], approved.light["overlay-surface"])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(approved.dark["overlay-text-muted"], approved.dark["overlay-surface"])).toBeGreaterThanOrEqual(4.5)
  })

  /*
   * The shell behind the workbench and the workspace panel is one continuous
   * surface. When `background-stronger` diverged from `background-base` it read
   * as a grey band under the header and a grey right-hand panel, because both
   * are painted by the same `bg-background-stronger` containers. Dark already
   * held them equal; light is now the same shape.
   */
  test("keeps the workbench backdrop continuous with the shell", () => {
    expect(theme.light["background-stronger"]).toBe(theme.light["background-base"])
    expect(theme.dark["background-stronger"]).toBe(theme.dark["background-base"])
  })

  /*
   * The installed app uses gray-0 for both its main surface and prominent
   * cards. A gray canvas behind a white card adds a visible edge before the
   * elevation is even painted, making the correct half-pixel stroke look too
   * thick. Its sidebar is the separate gray-50 application surface.
   */
  test("keeps light overlays on Codex's white main surface", () => {
    expect(theme.light).toMatchObject({
      "background-base": "#ffffff",
      "background-stronger": "#ffffff",
      "surface-base": "#ffffff",
      "shell-surface-header": "#ffffff",
      "overlay-surface": "#ffffff",
      "shell-surface-sidebar": "#f9f9f9",
    })
    expect(theme.light["background-base"]).toBe(theme.light["overlay-surface"])
  })

  test("preserves the verified dark surfaces", () => {
    expect(theme.dark).toMatchObject({
      "border-base": "#303030",
      "border-weak-base": "#282828",
      "border-weaker-base": "#212121",
    })
  })

  /*
   * Elevation is calibrated against Codex's own scale, but a box-shadow is a
   * geometry-plus-color string and `desktop-theme.schema.json` constrains
   * override values to colors. The scale therefore lives in the Codex CSS layer
   * (`ui-overrides.css`), and the theme must not smuggle it back in here.
   */
  test("keeps non-color values out of the theme overrides", () => {
    for (const scheme of ["light", "dark"] as const) {
      for (const [role, value] of Object.entries(codexThemeJson[scheme].overrides)) {
        expect(value, `${scheme}/${role}`).toMatch(/^(#[0-9a-fA-F]{3,8}|var\(--[a-z0-9-]+\))$/)
      }
    }
  })
})

function contrast(a: HexColor, b: HexColor) {
  return contrastRatio(a, b)
}
