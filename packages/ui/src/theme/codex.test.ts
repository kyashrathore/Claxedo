import { describe, expect, test } from "bun:test"
import codexThemeJson from "./themes/codex.json"
import { resolveTheme } from "./resolve"
import type { DesktopTheme } from "./types"

describe("Codex shell surfaces", () => {
  const theme = resolveTheme(codexThemeJson as DesktopTheme)

  test("provides coherent light surfaces", () => {
    expect(theme.light).toMatchObject({
      "codex-surface-sidebar": "#f3f3f3",
      "codex-surface-header": "#f7f7f7",
      "codex-surface-composer": "#ffffff",
      "codex-surface-overlay": "#ffffff",
      "codex-surface-overlay-input": "#00000014",
      "codex-radius-overlay": "10px",
      "codex-surface-tab-selected": "#ededed",
      "codex-text-overlay": "#1f1f1f",
      "codex-text-overlay-muted": "#777777",
      "codex-border-overlay": "#e0e0e0",
      "codex-surface-row-hover": "#0000000a",
      "codex-surface-row-selected": "#0000000f",
      "codex-border-composer": "#d8d8d8",
    })
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
   * Elevation is calibrated against Codex's own scale, read from the shipped
   * app: `--elevation-200-geo` (0 2px 4px -1px) at 8% light / 20% dark for
   * raised surfaces, `--shadow` (0 10px 15px -3px, 0 4px 6px -4px) at 10% / 20%
   * for overlays, and a sidebar ambient down at 3-5%. These are quiet on
   * purpose — the hairline carries the edge, not the shadow.
   */
  test("matches the Codex elevation scale", () => {
    expect(theme.light).toMatchObject({
      "codex-shadow-raised": "0 2px 4px -1px #00000014",
      "codex-shadow-overlay": "0 10px 15px -3px #0000001a, 0 4px 6px -4px #0000001a",
      "codex-shadow-sidebar-edge": "inset -14px 0 14px -14px #0000001a",
    })
    expect(theme.dark).toMatchObject({
      "codex-shadow-raised": "0 2px 4px -1px #00000033",
      "codex-shadow-overlay": "0 10px 15px -3px #00000033, 0 4px 6px -4px #00000033",
      "codex-shadow-sidebar-edge": "inset -14px 0 14px -14px #00000040",
    })
  })

  /*
   * Codex's own tooltip is NOT inverted: the shipped app defines
   * `--tooltip-background-color: var(--color-surface-elevated)` (gray-0, i.e.
   * white in light) with `--tooltip-text-color: var(--color-text)`. Its dark
   * chip is a separate "compact" variant we do not have. So tooltips follow the
   * overlay family with everything else that floats, and the inverted family is
   * left serving toasts alone.
   */
  test("keeps light-mode floating surfaces light", () => {
    expect(theme.light["codex-surface-overlay"]).toBe("#ffffff")
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
      "codex-surface-sidebar": "#282828",
      "codex-surface-header": "#171717",
      "codex-surface-composer": "#2d2d2d",
      "codex-surface-overlay": "#2d2d2d",
      "codex-surface-overlay-input": "#ffffff0f",
      "codex-radius-overlay": "10px",
      "codex-surface-tab-selected": "#242424",
      "codex-text-overlay": "#f2f2f2",
      "codex-text-overlay-muted": "#bdbdbd",
      "codex-border-overlay": "#414141",
      "codex-surface-row-hover": "#343434",
      "codex-surface-row-selected": "#3a3a3a",
      "codex-border-composer": "#3b3b3b",
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
    expect(theme.dark["codex-surface-inverted"]).toBe(theme.dark["codex-surface-overlay"])
  })
})
