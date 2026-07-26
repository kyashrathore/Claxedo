import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { UI_CODEX_ICON_ALIASES, UI_CODEX_ICON_TRANSFORMS } from "./codex-icon-map"

/**
 * There are two copies of the Codex alias table: this one, serving the shared
 * `Icon`, and `claxedo-app/src/ui/icons/codex.ts`, serving `ClaxedoIcon`. They
 * are hand-maintained and had already drifted before these assertions existed —
 * `check` resolved to a numbered sprite glyph in one and a hand-drawn custom
 * glyph in the other, so the same semantic name rendered two different marks
 * depending on which component a callsite happened to use.
 *
 * Keeping two tables is the real problem; until one is deleted, this fails the
 * build when they disagree.
 */
const appAliases = (() => {
  const source = readFileSync(new URL("../../../claxedo-app/src/ui/icons/codex.ts", import.meta.url), "utf8")
  const block = source.split("CODEX_ICON_ALIASES = {")[1]?.split("} as const")[0] ?? ""
  return Object.fromEntries(
    [...block.matchAll(/^\s*"?([a-zA-Z0-9-]+)"?:\s*"([a-z0-9-]+)"/gm)].map((m) => [m[1]!, m[2]!]),
  )
})()

const appTransforms = (() => {
  const source = readFileSync(new URL("../../../claxedo-app/src/ui/icons/codex.ts", import.meta.url), "utf8")
  const block = source.split("CODEX_ICON_TRANSFORMS = {")[1]?.split("} as const")[0] ?? ""
  return Object.fromEntries(
    [...block.matchAll(/^\s*"?([a-zA-Z0-9-]+)"?:\s*"([^"]+)"/gm)].map((m) => [m[1]!, m[2]!]),
  )
})()

describe("every referenced glyph is renderable", () => {
  const componentSource = readFileSync(new URL("./icon.tsx", import.meta.url), "utf8")
  const drawn = new Set(
    [...(componentSource.split("const icons = {")[1]?.split(/^}/m)[0] ?? "").matchAll(
      /^\s*"?([a-zA-Z0-9-]+)"?:\s*`/gm,
    )].map((m) => m[1]!),
  )
  const customTable = Object.fromEntries(
    [...(componentSource.split("const CODEX_CUSTOM_GLYPHS = {")[1]?.split("} as const")[0] ?? "").matchAll(
      /"(codex-custom-[a-z0-9-]+)"\s*:\s*"([a-zA-Z0-9-]+)"/g,
    )].map((m) => [m[1]!, m[2]!]),
  )
  const spriteSymbols = new Set(
    [...readFileSync(new URL("../assets/icons/codex/sprite.svg", import.meta.url), "utf8").matchAll(
      /<symbol id="([^"]+)"/g,
    )].map((m) => m[1]!),
  )

  test("every codex-custom alias has an entry in CODEX_CUSTOM_GLYPHS", () => {
    const missing = Object.entries(UI_CODEX_ICON_ALIASES)
      .filter(([, glyph]) => (glyph as string).startsWith("codex-custom-"))
      .filter(([, glyph]) => !customTable[glyph as string])
      .map(([name, glyph]) => `${name} -> ${glyph}`)
    expect(missing).toEqual([])
  })

  test("every CODEX_CUSTOM_GLYPHS target is actually drawn", () => {
    const missing = Object.entries(customTable)
      .filter(([, local]) => !drawn.has(local))
      .map(([glyph, local]) => `${glyph} -> ${local} (not in the local icons table)`)
    expect(missing).toEqual([])
  })

  test("every numbered alias exists in the sprite", () => {
    const missing = Object.entries(UI_CODEX_ICON_ALIASES)
      .filter(([, glyph]) => (glyph as string).startsWith("codex-20-"))
      .filter(([, glyph]) => !spriteSymbols.has(glyph as string))
      .map(([name, glyph]) => `${name} -> ${glyph}`)
    expect(missing).toEqual([])
  })
})

describe("codex alias tables agree across packages", () => {
  test("the app table was parsed", () => {
    expect(Object.keys(appAliases).length).toBeGreaterThan(100)
    expect(Object.keys(appTransforms).length).toBeGreaterThan(5)
  })

  test("no name resolves to a different glyph in the two tables", () => {
    const drift = Object.entries(UI_CODEX_ICON_ALIASES)
      .filter(([name]) => name in appAliases)
      .filter(([name, glyph]) => appAliases[name] !== glyph)
      .map(([name, glyph]) => `${name}: ui=${glyph} app=${appAliases[name]}`)

    expect(drift).toEqual([])
  })

  test("no name is rotated in one table and not the other", () => {
    const shared = Object.keys(UI_CODEX_ICON_ALIASES).filter((name) => name in appAliases)
    const drift = shared
      .filter((name) => (UI_CODEX_ICON_TRANSFORMS as Record<string, string>)[name] !== appTransforms[name])
      .map(
        (name) =>
          `${name}: ui=${(UI_CODEX_ICON_TRANSFORMS as Record<string, string>)[name] ?? "none"} app=${appTransforms[name] ?? "none"}`,
      )

    expect(drift).toEqual([])
  })
})
