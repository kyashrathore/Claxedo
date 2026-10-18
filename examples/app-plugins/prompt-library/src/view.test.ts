import { describe, expect, test } from "bun:test"
import { libraryComponents } from "./view"

describe("structure", () => {
  test("a template row shows Use and keeps the favourite toggle behind a star that shows its state", () => {
    const byId = new Map(libraryComponents({ categories: ["Debugging"], hasFavourites: false, selected: undefined, previewFilled: false, projects: [] }).map((component) => [component.id, component]))
    expect(byId.get("template-card")).toMatchObject({ primaryAction: "tc-use", actions: ["tc-favourite"] })
    expect(byId.get("tc-use")).toMatchObject({ component: "Button", action: { event: { name: "selectTemplate" } } })
    expect(byId.get("tc-favourite")).toMatchObject({ component: "Button", icon: { path: "favouriteIcon" }, action: { event: { name: "toggleFavourite", context: { template: { path: "id" } } } } })
    expect("actions" in (byId.get("library") ?? {})).toBe(false)
  })
})
