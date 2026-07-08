/**
 * Tests for StatusEditorDialog state manipulation logic:
 * add, remove, reorder, toggle transitions, and position renumbering.
 *
 */

import { describe, expect, test } from "bun:test"
import type { PageStatus } from "../../utils/pages-api"
import {
  STATUS_PRESET_COLORS,
  addStatusItem,
  moveStatusItemDown,
  moveStatusItemUp,
  removeStatusItem,
  toggleStatusTransition,
  updateStatusItem,
} from "./status-editor-dialog"

function makeStatuses(): PageStatus[] {
  return [
    { id: "draft", name: "Draft", color: "#6b7280", position: 0, transitions: ["in_review"] },
    { id: "in_review", name: "In Review", color: "#f59e0b", position: 1, transitions: ["draft", "done"] },
    { id: "done", name: "Done", color: "#22c55e", position: 2, transitions: [] },
  ]
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("addStatus", () => {
  test("appends a new status with correct defaults", () => {
    const items = makeStatuses()
    const result = addStatusItem(items, "status_test_3")
    expect(result.length).toBe(4)
    const added = result[3]
    expect(added.name).toBe("New Status")
    expect(added.position).toBe(3)
    expect(added.transitions).toEqual([])
  })

  test("color cycles through presets", () => {
    let items: PageStatus[] = []
    const colors = new Set<string>()
    for (let i = 0; i < STATUS_PRESET_COLORS.length; i++) {
      items = addStatusItem(items, `status_test_${i}`)
      colors.add(items[items.length - 1].color)
    }
    expect(colors.size).toBe(STATUS_PRESET_COLORS.length)
  })

  test("new status ID is unique per call", () => {
    const items = makeStatuses()
    const r1 = addStatusItem(items, "status_test_3")
    const r2 = addStatusItem(r1, "status_test_4")
    expect(r1[3].id).not.toBe(r2[4].id)
  })
})

describe("removeStatus", () => {
  test("removes status at given index", () => {
    const items = makeStatuses()
    const result = removeStatusItem(items, 1) // Remove "in_review"
    expect(result.length).toBe(2)
    expect(result.map((s) => s.id)).toEqual(["draft", "done"])
  })

  test("renumbers positions after removal", () => {
    const items = makeStatuses()
    const result = removeStatusItem(items, 0) // Remove "draft"
    expect(result[0].position).toBe(0)
    expect(result[1].position).toBe(1)
    expect(result[0].id).toBe("in_review")
    expect(result[1].id).toBe("done")
  })

  test("removing last item returns empty array", () => {
    const items = [{ id: "only", name: "Only", color: "#000", position: 0, transitions: [] }]
    const result = removeStatusItem(items, 0)
    expect(result).toEqual([])
  })

  test("removing from middle preserves order of remaining", () => {
    const items = makeStatuses()
    const result = removeStatusItem(items, 1)
    expect(result[0].id).toBe("draft")
    expect(result[1].id).toBe("done")
  })
})

describe("moveUp", () => {
  test("swaps item with predecessor", () => {
    const items = makeStatuses()
    const result = moveStatusItemUp(items, 1) // Move "in_review" up
    expect(result[0].id).toBe("in_review")
    expect(result[1].id).toBe("draft")
    expect(result[2].id).toBe("done")
  })

  test("renumbers positions after swap", () => {
    const items = makeStatuses()
    const result = moveStatusItemUp(items, 2) // Move "done" up
    expect(result[0].position).toBe(0)
    expect(result[1].position).toBe(1)
    expect(result[2].position).toBe(2)
    expect(result[1].id).toBe("done")
    expect(result[2].id).toBe("in_review")
  })

  test("no-op when index is 0", () => {
    const items = makeStatuses()
    const result = moveStatusItemUp(items, 0)
    expect(result).toBe(items) // Same reference (no mutation)
  })
})

describe("moveDown", () => {
  test("swaps item with successor", () => {
    const items = makeStatuses()
    const result = moveStatusItemDown(items, 0) // Move "draft" down
    expect(result[0].id).toBe("in_review")
    expect(result[1].id).toBe("draft")
    expect(result[2].id).toBe("done")
  })

  test("renumbers positions after swap", () => {
    const items = makeStatuses()
    const result = moveStatusItemDown(items, 0)
    expect(result[0].position).toBe(0)
    expect(result[1].position).toBe(1)
    expect(result[2].position).toBe(2)
  })

  test("no-op when index is last", () => {
    const items = makeStatuses()
    const result = moveStatusItemDown(items, 2)
    expect(result).toEqual(items) // Same content
  })
})

describe("toggleTransition", () => {
  test("adds transition when not present", () => {
    const items = makeStatuses()
    // "done" (index 2) has no transitions — add "draft"
    const result = toggleStatusTransition(items, 2, "draft")
    expect(result[2].transitions).toEqual(["draft"])
  })

  test("removes transition when already present", () => {
    const items = makeStatuses()
    // "in_review" (index 1) has ["draft", "done"] — remove "draft"
    const result = toggleStatusTransition(items, 1, "draft")
    expect(result[1].transitions).toEqual(["done"])
  })

  test("does not modify other statuses", () => {
    const items = makeStatuses()
    const result = toggleStatusTransition(items, 1, "draft")
    expect(result[0]).toEqual(items[0])
    expect(result[2]).toEqual(items[2])
  })

  test("multiple toggles create / remove correctly", () => {
    let items = makeStatuses()
    // Add "in_review" to "done" transitions
    items = toggleStatusTransition(items, 2, "in_review")
    expect(items[2].transitions).toEqual(["in_review"])
    // Add "draft" to "done" transitions
    items = toggleStatusTransition(items, 2, "draft")
    expect(items[2].transitions).toEqual(["in_review", "draft"])
    // Remove "in_review"
    items = toggleStatusTransition(items, 2, "in_review")
    expect(items[2].transitions).toEqual(["draft"])
  })
})

describe("updateItem", () => {
  test("updates name", () => {
    const items = makeStatuses()
    const result = updateStatusItem(items, 0, { name: "To Do" })
    expect(result[0].name).toBe("To Do")
    expect(result[0].id).toBe("draft") // id unchanged
  })

  test("updates color", () => {
    const items = makeStatuses()
    const result = updateStatusItem(items, 1, { color: "#ff0000" })
    expect(result[1].color).toBe("#ff0000")
  })

  test("does not modify other items", () => {
    const items = makeStatuses()
    const result = updateStatusItem(items, 0, { name: "Changed" })
    expect(result[1]).toEqual(items[1])
    expect(result[2]).toEqual(items[2])
  })
})

describe("complex workflows", () => {
  test("add → rename → reorder → toggle transitions", () => {
    let items = makeStatuses() // draft, in_review, done

    // Add new status
    items = addStatusItem(items, "status_test_3") // draft, in_review, done, new
    expect(items.length).toBe(4)

    // Rename it
    items = updateStatusItem(items, 3, { name: "Blocked" })
    expect(items[3].name).toBe("Blocked")

    // Move it up twice (from index 3 → 2 → 1)
    items = moveStatusItemUp(items, 3) // draft, in_review, blocked, done
    items = moveStatusItemUp(items, 2) // draft, blocked, in_review, done
    expect(items[1].name).toBe("Blocked")
    expect(items[1].position).toBe(1)

    // Add transition from draft to blocked
    items = toggleStatusTransition(items, 0, items[1].id)
    expect(items[0].transitions).toContain(items[1].id)
  })

  test("remove status cleans up cleanly", () => {
    let items = makeStatuses()
    // Remove middle item
    items = removeStatusItem(items, 1)
    expect(items.length).toBe(2)

    // Positions are sequential
    expect(items[0].position).toBe(0)
    expect(items[1].position).toBe(1)

    // Add new and verify position
    items = addStatusItem(items, "status_test_2")
    expect(items[2].position).toBe(2)
  })

  test("transitions survive reordering", () => {
    let items = makeStatuses()
    // "draft" (0) transitions to ["in_review"]
    // Move "in_review" to position 0
    items = moveStatusItemUp(items, 1)
    // Now: in_review (0), draft (1), done (2)
    // "draft" still transitions to "in_review" by ID
    expect(items[1].transitions).toEqual(["in_review"])
  })

  test("remove status drops transitions pointing at the deleted status", () => {
    const result = removeStatusItem(makeStatuses(), 1)
    expect(result.find((item) => item.id === "draft")?.transitions).toEqual([])
  })
})
