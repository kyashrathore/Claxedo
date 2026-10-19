/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { SURFACE_CATALOG_ID } from "@claxedo/plugin-api/surface"
import { boundChoices, chosenValues, choose, matchingChoices, steppedActive } from "./combobox-options"
import { pathsOverlap } from "./data-path"
import { surfaceState } from "./model"
import { createSurface } from "./store"

describe("combobox options", () => {
  test("reads only well-formed options from a bound list", () => {
    expect(boundChoices([{ label: "Claxedo", value: "p1", description: "app" }, { label: "No value" }, "loose", { label: "Docs", value: "p2" }])).toEqual([
      { label: "Claxedo", value: "p1", description: "app" },
      { label: "Docs", value: "p2" },
    ])
    expect(boundChoices(undefined)).toEqual([])
  })

  test("filters by label and description only when it filters locally", () => {
    const choices = [{ label: "Claxedo", value: "a", description: "desktop app" }, { label: "Docs", value: "b" }]
    expect(matchingChoices(choices, "APP", true).map((choice) => choice.value)).toEqual(["a"])
    expect(matchingChoices(choices, "APP", false)).toBe(choices)
    expect(matchingChoices(choices, "  ", true)).toBe(choices)
  })

  test("one value replaces the choice; many toggle it", () => {
    expect(chosenValues("p1", false)).toEqual(["p1"])
    expect(chosenValues("", false)).toEqual([])
    expect(chosenValues(["a", 3, "b"], true)).toEqual(["a", "b"])
    expect(choose(["a"], "b", false)).toEqual(["b"])
    expect(choose(["a", "b"], "a", true)).toEqual(["b"])
    expect(choose(["a"], "b", true)).toEqual(["a", "b"])
  })

  test("the active option wraps around and starts at the end the arrow points from", () => {
    expect([steppedActive(-1, 1, 3), steppedActive(-1, -1, 3), steppedActive(2, 1, 3), steppedActive(0, -1, 3), steppedActive(0, 1, 0)]).toEqual([0, 2, 0, 2, -1])
  })
})

test("a search is shown until the producer's next patch under the options path", () => {
  createRoot((dispose) => {
    const surface = createSurface("s1")
    surface.apply({ version: "v0.9", createSurface: { surfaceId: "s1", catalogId: SURFACE_CATALOG_ID } })
    let searching = true
    const options = ["projects"]
    surface[surfaceState].watchPatches((path) => {
      if (pathsOverlap(path, options)) searching = false
    })
    surface.apply({ version: "v0.9", updateDataModel: { surfaceId: "s1", path: "/query", value: "cl" } })
    expect(searching).toBe(true)
    surface.apply({ version: "v0.9", updateDataModel: { surfaceId: "s1", path: "/projects", value: [{ label: "Claxedo", value: "p1" }] } })
    expect(searching).toBe(false)
    dispose()
  })
})
