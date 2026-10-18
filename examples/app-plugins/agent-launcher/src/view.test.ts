import { describe, expect, test } from "bun:test"
import { launcherComponents } from "./view"

const components = new Map(launcherComponents({ projects: [{ id: "p1", name: "Claxedo" }], hasLaunches: true, launching: false, hasErrors: false }).map((component) => [component.id, component]))

describe("launched session rows", () => {
  test("open a session from the row's one text action", () => {
    const row = components.get("launch-row")
    if (row?.component !== "ListItem") throw new Error("launch-row is not a ListItem")
    expect([row.primaryAction, row.actions]).toEqual(["launch-row-open", undefined])
    const open = components.get("launch-row-open")
    expect(open?.component === "Button" ? [open.variant, open.action.event.name] : open?.component).toEqual([undefined, "openSession"])
  })
})
