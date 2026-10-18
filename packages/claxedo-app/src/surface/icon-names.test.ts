/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { SURFACE_ICON_NAMES } from "@claxedo/plugin-api/surface"
import { KIT_ICONS, surfaceIconName, surfaceIconSource } from "./icon-names"

describe("surface icons", () => {
  test("draws every catalog icon name, from the kit or the surface's own glyphs", () => {
    const sources = SURFACE_ICON_NAMES.map(surfaceIconSource)
    expect(sources.filter((source) => source.kind === "kit").length).toBe(Object.keys(KIT_ICONS).length)
    expect(new Set(sources.filter((source) => source.kind === "glyph").map((source) => source.name)).size).toBe(SURFACE_ICON_NAMES.length - Object.keys(KIT_ICONS).length)
  })

  test("draws the person, star, heart, calendar, home, mail and play names with their own glyphs", () => {
    for (const name of ["person", "star", "starOff", "favorite", "favoriteOff", "calendarToday", "event", "home", "mail", "play"] as const) {
      expect(surfaceIconSource(name)).toEqual({ kind: "glyph", name })
    }
  })

  test("reads only catalog names from a bound value", () => {
    expect(surfaceIconName("star")).toBe("star")
    expect(["volumeUp", "rocket", 3, null].map(surfaceIconName)).toEqual([undefined, undefined, undefined, undefined])
  })
})
