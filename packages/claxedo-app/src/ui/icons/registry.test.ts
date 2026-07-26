import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { appIconNames } from "@/ui/icons/catalog"
import { CODEX_ICON_ALIASES, CODEX_ICON_TRANSFORMS, codexIconLibrary } from "@/ui/icons/codex"
import { openCodeIconLibrary } from "@/ui/icons/opencode"
import { defineIconLibrary } from "@/ui/icons/registry"

/**
 * The sprite these ids address, read from disk on purpose.
 *
 * `codexIconLibrary` builds its glyph set out of the alias table's own values,
 * so `resolve()` cannot fail for a catalog name — asserting that it succeeds is
 * true by construction and proves nothing. A typo like `codex-20-999` would
 * satisfy it happily and then render an empty box. The assertions that bite are
 * the ones below, which check each resolved id against the actual asset.
 */
const spriteURL = new URL("../../../../ui/src/assets/icons/codex/sprite.svg", import.meta.url)
const sprite = readFileSync(spriteURL, "utf8")
const spriteSymbols = new Set([...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]!))

/** The hand-drawn glyphs live inline in the component, so parse its table. */
const componentSource = readFileSync(new URL("../controls/claxedo-icon.tsx", import.meta.url), "utf8")
const customGlyphs = new Set(
  [...(componentSource.split("const customGlyphs")[1]?.split("} as const")[0] ?? "").matchAll(
    /"(codex-custom-[a-z0-9-]+)"\s*:/g,
  )].map((m) => m[1]!),
)

describe("icon library registry", () => {
  test("uses the same name when the target library exposes it", () => {
    const library = defineIconLibrary<"add" | "remove", "add" | "trash">({
      name: "example",
      glyphs: ["add", "trash"],
      aliases: { remove: "trash" },
    })

    expect(library.resolve("add")).toBe("add")
    expect(library.resolve("remove")).toBe("trash")
  })

  test("throws when identity and manual mappings are both missing", () => {
    const library = defineIconLibrary<"missing", "present">({
      name: "example",
      glyphs: ["present"],
    })

    expect(() => library.resolve("missing")).toThrow("add an explicit alias")
  })

  test("maps every icon in the app catalog in both bundled libraries", () => {
    for (const icon of appIconNames) {
      expect(codexIconLibrary.resolve(icon), icon).toBeTruthy()
      expect(openCodeIconLibrary.resolve(icon), icon).toBeTruthy()
    }
  })
})

describe("resolved glyphs exist as real assets", () => {
  test("the sprite is readable and populated", () => {
    expect(spriteSymbols.size).toBeGreaterThan(100)
  })

  test("every numbered id resolves to a symbol in the sprite", () => {
    const missing = appIconNames
      .map((icon) => [icon, codexIconLibrary.resolve(icon)] as const)
      .filter(([, glyph]) => glyph.startsWith("codex-20-"))
      .filter(([, glyph]) => !spriteSymbols.has(glyph))
      .map(([icon, glyph]) => `${icon} -> ${glyph} (not in sprite.svg)`)

    expect(missing).toEqual([])
  })

  test("every codex-custom id is drawn by the icon component", () => {
    const missing = appIconNames
      .map((icon) => [icon, codexIconLibrary.resolve(icon)] as const)
      .filter(([, glyph]) => glyph.startsWith("codex-custom-"))
      .filter(([, glyph]) => !customGlyphs.has(glyph))
      .map(([icon, glyph]) => `${icon} -> ${glyph} (no entry in customGlyphs)`)

    expect(missing).toEqual([])
  })

  test("every glyph id is either numbered or custom — no third shape", () => {
    for (const icon of appIconNames) {
      const glyph = codexIconLibrary.resolve(icon)
      expect(
        glyph.startsWith("codex-20-") || glyph.startsWith("codex-custom-"),
        `${icon} -> ${glyph}`,
      ).toBe(true)
    }
  })
})

describe("alias hygiene", () => {
  test("no alias points at a numbered glyph the sprite does not carry", () => {
    const unknown = Object.entries(CODEX_ICON_ALIASES)
      .filter(([, glyph]) => (glyph as string).startsWith("codex-20-"))
      .filter(([, glyph]) => !spriteSymbols.has(glyph as string))
    expect(unknown).toEqual([])
  })

  test("no custom glyph is drawn but never reachable", () => {
    // A hand-drawn glyph with no alias pointing at it is dead artwork: it costs
    // bundle size and reads as supported when nothing can render it.
    const reachable = new Set(appIconNames.map((icon) => codexIconLibrary.resolve(icon)))
    const unreachable = [...customGlyphs].filter((glyph) => !reachable.has(glyph))
    expect(unreachable).toEqual([])
  })

  test("every rotation names a real catalog icon", () => {
    const names = new Set<string>(appIconNames)
    for (const icon of Object.keys(CODEX_ICON_TRANSFORMS)) {
      expect(names.has(icon), `${icon} has a transform but is not in the catalog`).toBe(true)
    }
  })
})
