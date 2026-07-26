import { describe, expect, test } from "bun:test"
import { appIconNames } from "@/ui/icons/catalog"
import { codexIconLibrary } from "@/ui/icons/codex"
import { codexIconManifest } from "@/ui/icons/manifest"
import { openCodeIconLibrary } from "@/ui/icons/opencode"
import { defineIconLibrary } from "@/ui/icons/registry"

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

    expect(() => library.resolve("missing")).toThrow('add an explicit alias')
  })

  test("maps every icon in the app catalog in both bundled libraries", () => {
    for (const icon of appIconNames) {
      expect(codexIconLibrary.resolve(icon)).toBeTruthy()
      expect(openCodeIconLibrary.resolve(icon)).toBeTruthy()
    }
  })

  test("documents every Codex icon and valid state pair", () => {
    for (const icon of appIconNames) {
      expect(codexIconManifest[icon].glyph).toBe(codexIconLibrary.resolve(icon))
      expect(codexIconManifest[icon].description.length).toBeGreaterThan(0)

      const active = codexIconManifest[icon].active
      if (active) expect(codexIconManifest[active]).toBeTruthy()
    }
  })
})
