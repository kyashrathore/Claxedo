import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { surfaceComponentSchema } from "./catalog"
import { SURFACE_ICON_NAMES } from "./icon-names"

describe("SURFACE_ICON_NAMES", () => {
  test("imports nothing, so a host reads the names without building the catalog's schemas", () => {
    const source = readFileSync(new URL("./icon-names.ts", import.meta.url), "utf8")
    expect(source).not.toMatch(/\bimport\b/)
  })

  test("is the catalog's icon vocabulary: an Icon accepts each name and nothing else", () => {
    for (const name of SURFACE_ICON_NAMES) expect(surfaceComponentSchema.safeParse({ id: "icon", component: "Icon", name }).success).toBe(true)
    expect(surfaceComponentSchema.safeParse({ id: "icon", component: "Icon", name: "rocket" }).success).toBe(false)
  })
})
