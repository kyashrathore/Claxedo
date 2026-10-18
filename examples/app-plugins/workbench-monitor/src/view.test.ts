import { describe, expect, test } from "bun:test"
import type { SurfaceComponent } from "@claxedo/plugin-api"
import { monitorComponents } from "./view"

const components = new Map(monitorComponents(true, true).map((component) => [component.id, component]))

function button(id: string | undefined): Extract<SurfaceComponent, { component: "Button" }> {
  const found = components.get(id ?? "")
  if (found?.component !== "Button") throw new Error(`${id} is not a Button`)
  return found
}

describe("tab rows", () => {
  test("open a tab from the one text action and reorder or close it from icon-only actions", () => {
    const row = components.get("tab-row")
    if (row?.component !== "ListItem") throw new Error("tab-row is not a ListItem")
    const open = button(row.primaryAction)
    expect([open.variant, open.icon, open.action.event.name]).toEqual([undefined, undefined, "activateTab"])
    expect((row.actions ?? []).map((id) => [button(id).icon, button(id).action.event.name])).toEqual([
      ["arrowBack", "moveLeft"],
      ["arrowForward", "moveRight"],
      ["close", "closeTab"],
    ])
  })
})
