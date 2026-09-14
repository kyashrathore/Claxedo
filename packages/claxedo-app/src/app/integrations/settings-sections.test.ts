import { describe, expect, test } from "bun:test"
import { createContributionRegistry } from "./registry"

const section = (id: string, group: "desktop" | "workspace") => ({
  id,
  tier: "claxedo-first-party" as const,
  section: group,
  label: id,
  renderer: () => null,
})

describe("contributed settings sections", () => {
  test("a gate keeps a section out of the list the dialog renders", () => {
    const registry = createContributionRegistry()
    registry.addSettings({ ...section("here", "workspace"), gate: { workspaceId: "ws_1" } })
    registry.addSettings(section("everywhere", "workspace"))

    expect(registry.visibleSettings({ workspaceId: "ws_other" }).map((entry) => entry.id)).toEqual(["everywhere"])
    expect(registry.visibleSettings({ workspaceId: "ws_1" }).map((entry) => entry.id)).toEqual(["here", "everywhere"])
  })

  test("re-registering an id replaces the section rather than listing it twice", () => {
    const registry = createContributionRegistry()
    registry.addSettings(section("presets", "workspace"))
    registry.addSettings({ ...section("presets", "desktop"), label: "Presets" })

    expect(registry.visibleSettings({})).toHaveLength(1)
    expect(registry.visibleSettings({})[0]?.section).toBe("desktop")
  })
})
