import { describe, expect, test } from "bun:test"
import type { SurfaceComponent } from "@claxedo/plugin-api"
import { seedTrip } from "./model"
import { budgetComponents, slotBody } from "./surface"

const components = new Map(budgetComponents(seedTrip("2026-10-18")).map((component) => [component.id, component]))

function component(id: string | undefined): SurfaceComponent {
  const found = components.get(id ?? "")
  if (!found) throw new Error(`missing component ${id}`)
  return found
}

function rowActionIcons(id: string): unknown[] {
  const row = component(id)
  if (row.component !== "ListItem") throw new Error(`${id} is not a ListItem`)
  expect(row.primaryAction).toBeUndefined()
  return (row.actions ?? []).map((action) => {
    const button = component(action)
    return button.component === "Button" ? button.icon : button.component
  })
}

describe("rows", () => {
  test("delete an expense or remove a person from an icon-only action", () => {
    expect(rowActionIcons("expense")).toEqual(["delete"])
    expect(rowActionIcons("person")).toEqual(["delete"])
  })
})

describe("notices", () => {
  test("a refused row action is a warning the person dismisses; a form error blocks until fixed", () => {
    const tones = ["people-error", "expenses-error", "form-error", "budgets-error"].map((id) => {
      const callout = component(id)
      return callout.component === "Callout" ? [callout.tone, callout.dismissible ?? false] : callout.component
    })
    expect(tones).toEqual([
      ["warning", true],
      ["warning", true],
      ["danger", false],
      ["danger", false],
    ])
  })

  test("a people error sits between the new participant field and its Footer", () => {
    const body = slotBody("people", true)
    expect(body.component === "Column" ? body.children : []).toEqual(["people-list", "people-empty", "new-participant", "people-error", "people-footer"])
    const footer = component("people-footer")
    expect(footer.component === "Footer" ? footer.end : []).toEqual(["add-participant"])
  })
})
