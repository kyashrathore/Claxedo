import { describe, expect, test } from "bun:test"
import type { SurfaceComponent } from "@claxedo/plugin-api"
import { seedBoard } from "./model"
import { boardDisplay, sprintBoardComponents, type ViewContext } from "./surface"

const TODAY = "2026-10-18"
const components = new Map(sprintBoardComponents(false).map((component) => [component.id, component]))

function component(id: string | undefined): SurfaceComponent {
  const found = components.get(id ?? "")
  if (!found) throw new Error(`missing component ${id}`)
  return found
}

function rowButton(id: string | undefined): Extract<SurfaceComponent, { component: "Button" }> {
  const found = component(id)
  const button = found.component === "List" && !Array.isArray(found.children) ? component(found.children.componentId) : found
  if (button.component !== "Button") throw new Error(`${id} is not a Button`)
  return button
}

function field(value: unknown, key: string): unknown[] {
  const list = typeof value === "object" && value !== null && !Array.isArray(value) ? Object.entries(value).find(([name]) => name === key)?.[1] : undefined
  return Array.isArray(list) ? list.map((entry) => (typeof entry === "object" && entry !== null && "label" in entry ? entry.label : entry)) : []
}

const context: ViewContext = { today: TODAY, owners: [], projectName: "Checkout", session: { added: 0, removed: 0 }, formatDate: (iso) => iso }

describe("task rows", () => {
  test("show one text action and keep the rest icon-only, delete last", () => {
    const task = component("task")
    if (task.component !== "ListItem") throw new Error("task is not a ListItem")
    const primary = rowButton(task.primaryAction)
    expect([primary.variant, primary.icon]).toEqual([undefined, undefined])
    const icons = (task.actions ?? []).map((id) => rowButton(id).icon)
    expect(icons).toEqual(["arrowBack", "delete"])
  })

  test("name the next column on the advance action and the previous one on move back", () => {
    const display = boardDisplay(seedBoard(TODAY), context)
    const labels = (column: number) => {
      const tasks = display.columns[column]?.tasks
      const task = Array.isArray(tasks) ? tasks[0] : undefined
      return { forward: field(task, "forward"), back: field(task, "back") }
    }
    expect(labels(0)).toEqual({ forward: ["Start →"], back: [] })
    expect(labels(1)).toEqual({ forward: ["Review →"], back: ["Move back to Backlog"] })
    expect(labels(2)).toEqual({ forward: ["Done"], back: ["Move back to In progress"] })
    expect(labels(3)).toEqual({ forward: [], back: ["Move back to Review"] })
  })
})

describe("header", () => {
  test("keeps the subtitle to one short line", () => {
    const header = boardDisplay(seedBoard(TODAY), context).header
    const subtitle = typeof header === "object" && header !== null && !Array.isArray(header) ? header.subtitle : undefined
    expect(typeof subtitle === "string" ? subtitle.length : Infinity).toBeLessThanOrEqual(60)
  })
})
