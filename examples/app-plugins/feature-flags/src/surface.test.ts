import { describe, expect, test } from "bun:test"
import type { SurfaceComponent } from "@claxedo/plugin-api"
import { effectiveSetting, seedFlags, stageEdits, type FlagStore } from "./model"
import { displayEntries, flagComponents } from "./surface"

const NOW = new Date("2026-10-18T09:00:00Z")
const components = new Map(flagComponents().map((component) => [component.id, component]))

function component(id: string | undefined): SurfaceComponent {
  const found = components.get(id ?? "")
  if (!found) throw new Error(`missing component ${id}`)
  return found
}

function listItem(id: string): Extract<SurfaceComponent, { component: "ListItem" }> {
  const found = component(id)
  if (found.component !== "ListItem") throw new Error(`${id} is not a ListItem`)
  return found
}

function templateButton(id: string | undefined): Extract<SurfaceComponent, { component: "Button" }> {
  const found = component(id)
  const button = found.component === "List" && !Array.isArray(found.children) ? component(found.children.componentId) : found
  if (button.component !== "Button") throw new Error(`${id} is not a Button`)
  return button
}

function stageProdOn(store: FlagStore, keys: readonly string[]): FlagStore {
  return stageEdits(
    store,
    "prod",
    keys.map((key) => {
      const flag = store.flags.find((entry) => entry.key === key)
      if (!flag) throw new Error(`no flag ${key}`)
      return { key, ...effectiveSetting(store, "prod", flag), enabled: true, rollout: 10 }
    }),
  )
}

describe("flag rows", () => {
  test("show Undo edit as the one text action and keep the Enabled switch with rollout and targeting", () => {
    const row = listItem("flag-item")
    expect(row.actions).toBeUndefined()
    expect(templateButton(row.primaryAction).variant).toBeUndefined()
    const tuning = component("flag-tuning-body")
    expect(tuning.component === "Column" ? tuning.children : []).toEqual(["flag-enabled", "flag-tuning-fields", "flag-applied"])
  })

  test("pending changes undo from their one text action", () => {
    const change = listItem("change")
    expect([change.primaryAction, change.actions]).toEqual(["change-undo", undefined])
    expect(templateButton(change.primaryAction).variant).toBeUndefined()
  })
})

describe("promotion warnings", () => {
  test("collect every warning into one notice", () => {
    const store = stageProdOn(seedFlags(NOW), ["one-click-reorder", "instant-refunds"])
    const pending = displayEntries(store, { query: "", formatTime: (iso) => iso }).get("/pending")
    const warnings = typeof pending === "object" && pending !== null && !Array.isArray(pending) ? pending.warnings : undefined
    expect(warnings).toEqual([
      {
        title: "2 flags reach Production before Staging",
        text: "one-click-reorder turns on in Production while it is off in Staging. instant-refunds turns on in Production while it is off in Staging.",
      },
    ])
  })

  test("show no notice when nothing reaches Production early", () => {
    const pending = displayEntries(seedFlags(NOW), { query: "", formatTime: (iso) => iso }).get("/pending")
    expect(typeof pending === "object" && pending !== null && !Array.isArray(pending) ? pending.warnings : undefined).toEqual([])
  })
})
