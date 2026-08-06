import { describe, expect, test } from "bun:test"
import Ajv from "ajv"
import schema from "./desktop-theme.schema.json"
import { contrastRatio } from "./color"
import { DEFAULT_THEMES } from "./default-themes"
import type { DesktopTheme, HexColor } from "./types"
import { SEMANTIC_THEME_ROLE_FALLBACKS, resolveTheme, themeToCss } from "./resolve"

const roles = Object.keys(SEMANTIC_THEME_ROLE_FALLBACKS) as (keyof typeof SEMANTIC_THEME_ROLE_FALLBACKS)[]
const modes = ["light", "dark"] as const
const syntheticSeedsTheme = {
  name: "Synthetic seeds coverage",
  id: "synthetic-seeds",
  light: {
    seeds: {
      neutral: "#f4f4f4",
      primary: "#2563eb",
      success: "#168447",
      warning: "#c65d19",
      error: "#d43d37",
      info: "#247cc0",
      interactive: "#147cc1",
      diffAdd: "#168447",
      diffDelete: "#d43d37",
    },
  },
  dark: {
    seeds: {
      neutral: "#171717",
      primary: "#369ce8",
      success: "#35bd70",
      warning: "#f28b45",
      error: "#ef5350",
      info: "#58a6e7",
      interactive: "#58a6e7",
      diffAdd: "#35bd70",
      diffDelete: "#ef5350",
    },
  },
} satisfies DesktopTheme

describe("semantic theme contract", () => {
  test("snapshots every resolved token for every theme and mode", () => {
    expect({
      ...Object.fromEntries(Object.entries(DEFAULT_THEMES).map(([id, theme]) => [id, resolveTheme(theme)])),
      [syntheticSeedsTheme.id]: resolveTheme(syntheticSeedsTheme),
    }).toMatchSnapshot()
  })

  /*
   * `tokens[role] = tokens[fallback]` writes `undefined` when a fallback token
   * is missing, and `themeToCss` then emits the literal string "undefined" as
   * the variable's value. Every bundled theme has to clear that in both modes.
   */
  test("resolves every role for every bundled theme variant", () => {
    for (const [id, theme] of Object.entries(DEFAULT_THEMES)) {
      const resolved = resolveTheme(theme)

      for (const mode of modes) {
        for (const role of roles) {
          const value = resolved[mode][role]
          expect(typeof value, `${id}/${mode}/${role}`).toBe("string")
          expect(value, `${id}/${mode}/${role}`).toBeTruthy()
          expect(value, `${id}/${mode}/${role}`).not.toBe("undefined")
        }
      }
    }
  })

  test("never emits the string \"undefined\" into generated CSS", () => {
    for (const [id, theme] of [...Object.entries(DEFAULT_THEMES), [syntheticSeedsTheme.id, syntheticSeedsTheme]] as const) {
      const resolved = resolveTheme(theme)
      for (const mode of modes) {
        expect(themeToCss(resolved[mode]), `${id}/${mode}`).not.toContain("undefined")
      }
    }
  })

  test("keeps composer and context-card roles independently overrideable", () => {
    const theme = structuredClone(DEFAULT_THEMES["oc-2"])
    theme.light.overrides = {
      ...theme.light.overrides,
      "shell-surface-composer": "#010203",
      "shell-surface-context-card": "#040506",
    }

    expect(resolveTheme(theme).light).toMatchObject({
      "shell-surface-composer": "#010203",
      "shell-surface-context-card": "#040506",
    })
  })

  test("derives Vercel icon roles with visible shell and overlay contrast", () => {
    const resolved = resolveTheme(DEFAULT_THEMES.vercel)

    for (const mode of modes) {
      expect(
        contrastRatio(
          resolved[mode]["icon-interaction-muted"] as HexColor,
          resolved[mode]["shell-surface-sidebar"] as HexColor,
        ),
        `vercel/${mode}/icon-interaction-muted`,
      ).toBeGreaterThanOrEqual(3)
      expect(
        contrastRatio(resolved[mode]["overlay-icon-muted"] as HexColor, resolved[mode]["overlay-surface"] as HexColor),
        `vercel/${mode}/overlay-icon-muted`,
      ).toBeGreaterThanOrEqual(3)
    }
  })

  test("keeps semantic icons visible on every opaque bundled surface", () => {
    const pairs = [
      ["icon-interaction-muted", "shell-surface-sidebar"],
      ["icon-interaction-muted", "shell-surface-header"],
      ["icon-interaction-muted", "shell-surface-composer"],
      ["icon-interaction-muted", "shell-surface-context-card"],
      ["overlay-icon-muted", "overlay-surface"],
    ] as const

    for (const [id, theme] of Object.entries(DEFAULT_THEMES)) {
      const resolved = resolveTheme(theme)
      for (const mode of modes) {
        for (const [role, surface] of pairs) {
          const foreground = resolved[mode][role]
          const background = resolved[mode][surface]
          if (!isOpaqueHex(foreground) || !isOpaqueHex(background)) continue
          expect(contrastRatio(foreground, background), `${id}/${mode}/${role}/${surface}`).toBeGreaterThanOrEqual(3)
        }
      }
    }
  })

  test("validates every bundled theme against the desktop schema", async () => {
    const validate = new Ajv({ strict: false }).compile(schema)

    for await (const file of new Bun.Glob("themes/*.json").scan({ cwd: import.meta.dir, absolute: true })) {
      const theme = await Bun.file(file).json()
      expect(validate(theme), `${file}: ${JSON.stringify(validate.errors)}`).toBe(true)
    }
  })
})

function isOpaqueHex(value: string): value is HexColor {
  return /^#[\da-f]{6}$/i.test(value)
}
