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
    "shell-surface-sidebar": "#f3f3f3",
    "shell-surface-header": "#f7f7f7",
    "shell-surface-composer": "#ffffff",
    "shell-surface-context-card": "#f7f7f7",
    "overlay-surface": "#ffffff",
    "overlay-surface-input": "#00000014",
    "tab-surface-selected": "#ededed",
    "overlay-text": "#171717",
    "overlay-text-muted": "#6f6f6f",
    "overlay-border": "#e0e0e0",
    "row-surface-hover": "#0000000a",
    "row-surface-selected": "#0000000f",
    "composer-border": "#d8d8d8",
  },
  dark: {
    "shell-surface-sidebar": "#282828",
    "shell-surface-header": "#171717",
    "shell-surface-composer": "#2d2d2d",
    "shell-surface-context-card": "#242424",
    "overlay-surface": "#2d2d2d",
    "overlay-surface-input": "#ffffff0f",
    "tab-surface-selected": "#242424",
    "overlay-text": "#f2f2f2",
    "overlay-text-muted": "#bdbdbd",
    "overlay-border": "#414141",
    "row-surface-hover": "#343434",
    "row-surface-selected": "#3a3a3a",
    "composer-border": "#3b3b3b",
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
   * Codex's own tooltip is NOT inverted: the shipped app defines
   * `--tooltip-background-color: var(--color-surface-elevated)` (gray-0, i.e.
   * white in light) with `--tooltip-text-color: var(--color-text)`. Its dark
   * chip is a separate "compact" variant we do not have. So tooltips follow the
   * overlay family with everything else that floats, and the inverted family is
   * left serving toasts alone — which is why it survives the rename to semantic
   * roles: there is no semantic role for "inverted chip".
   */
  test("keeps light-mode floating surfaces light and toasts inverted", () => {
    expect(theme.light["overlay-surface"]).toBe("#ffffff")
    expect(theme.light).toMatchObject({
      "codex-surface-inverted": "#1f1f1f",
      "codex-surface-inverted-hover": "#343434",
      "codex-border-inverted": "#383838",
      "codex-text-inverted": "#f4f4f4",
      "codex-text-inverted-muted": "#b8b8b8",
      "codex-icon-inverted": "#d8d8d8",
      "codex-icon-inverted-muted": "#9f9f9f",
    })
  })

  test("preserves the verified dark surfaces", () => {
    expect(theme.dark).toMatchObject({
      "border-base": "#3b3b3b",
      "border-weak-base": "#333333",
      "border-weaker-base": "#2a2a2a",
    })
  })

  /* Dark mode already had one coherent elevated family; splitting the roles
     must not move it, so both resolve to the same verified values. */
  test("leaves dark surfaces unsplit", () => {
    expect(theme.dark).toMatchObject({
      "codex-surface-inverted": "#2d2d2d",
      "codex-surface-inverted-hover": "#3a3a3a",
      "codex-border-inverted": "#414141",
      "codex-text-inverted": "#f2f2f2",
      "codex-text-inverted-muted": "#bdbdbd",
      "codex-icon-inverted": "#dedede",
      "codex-icon-inverted-muted": "#a3a3a3",
    })
    expect(theme.dark["codex-surface-inverted"]).toBe(theme.dark["overlay-surface"])
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
