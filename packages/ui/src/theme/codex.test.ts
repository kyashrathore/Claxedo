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
      "codex-surface-overlay": "#1f1f1f",
      "codex-surface-overlay-input": "#2d2d2d",
      "codex-radius-overlay": "10px",
      "codex-surface-tab-selected": "#ededed",
      "codex-text-overlay": "#f4f4f4",
      "codex-text-overlay-muted": "#b8b8b8",
      "codex-border-overlay": "#383838",
      "codex-surface-row-hover": "#0000000a",
      "codex-surface-row-selected": "#0000000f",
      "codex-border-composer": "#d8d8d8",
    })
  })

  test("preserves the verified dark surfaces", () => {
    expect(theme.dark).toMatchObject({
      "codex-surface-sidebar": "#282828",
      "codex-surface-header": "#171717",
      "codex-surface-composer": "#2d2d2d",
      "codex-surface-overlay": "#2d2d2d",
      "codex-surface-overlay-input": "#363636",
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
})
