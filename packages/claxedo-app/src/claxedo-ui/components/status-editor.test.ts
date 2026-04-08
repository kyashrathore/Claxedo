/**
 * Tests for StatusEditorDialog state manipulation logic:
 * add, remove, reorder, toggle transitions, and position renumbering.
 *
 * The component uses signals internally; we replicate the same logic
 * as pure functions to test correctness without mounting JSX.
 */

import { describe, expect, test } from "bun:test"
import type { PageStatus } from "../../utils/pages-api"

// ── Replicate the state manipulation logic from StatusEditorDialog ────

function makeStatuses(): PageStatus[] {
  return [
    { id: "draft", name: "Draft", color: "#6b7280", position: 0, transitions: ["in_review"] },
    { id: "in_review", name: "In Review", color: "#f59e0b", position: 1, transitions: ["draft", "done"] },
    { id: "done", name: "Done", color: "#22c55e", position: 2, transitions: [] },
  ]
}

function addStatus(items: PageStatus[]): PageStatus[] {
  const PRESET_COLORS = ["#6b7280", "#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#9ca3af"]
  const id = `status_test_${items.length}`
  return [
    ...items,
    {
      id,
      name: "New Status",
      color: PRESET_COLORS[items.length % PRESET_COLORS.length],
      position: items.length,
      transitions: [],
    },
  ]
}

function removeStatus(items: PageStatus[], index: number): PageStatus[] {
  const next = items.filter((_, i) => i !== index)
  return next.map((item, i) => ({ ...item, position: i }))
}

function moveUp(items: PageStatus[], index: number): PageStatus[] {
  if (index === 0) return items
  const next = [...items]
  ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
  return next.map((item, i) => ({ ...item, position: i }))
}

function moveDown(items: PageStatus[], index: number): PageStatus[] {
  if (index >= items.length - 1) return items
  const next = [...items]
  ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
  return next.map((item, i) => ({ ...item, position: i }))
}

function toggleTransition(items: PageStatus[], index: number, targetId: string): PageStatus[] {
  return items.map((item, i) => {
    if (i !== index) return item
    const has = item.transitions.includes(targetId)
    return {
      ...item,
      transitions: has
        ? item.transitions.filter((t) => t !== targetId)
        : [...item.transitions, targetId],
    }
  })
}

function updateItem(items: PageStatus[], index: number, patch: Partial<PageStatus>): PageStatus[] {
  return items.map((item, i) => (i === index ? { ...item, ...patch } : item))
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("addStatus", () => {
  test("appends a new status with correct defaults", () => {
    const items = makeStatuses()
    const result = addStatus(items)
    expect(result.length).toBe(4)
    const added = result[3]
    expect(added.name).toBe("New Status")
    expect(added.position).toBe(3)
    expect(added.transitions).toEqual([])
  })

  test("color cycles through presets", () => {
    let items: PageStatus[] = []
    const colors = new Set<string>()
    for (let i = 0; i < 10; i++) {
      items = addStatus(items)
      colors.add(items[items.length - 1].color)
    }
    // 10 preset colors → 10 unique colors
    expect(colors.size).toBe(10)
  })

  test("new status ID is unique per call", () => {
    const items = makeStatuses()
    const r1 = addStatus(items)
    const r2 = addStatus(r1)
    expect(r1[3].id).not.toBe(r2[4].id)
  })
})

describe("removeStatus", () => {
  test("removes status at given index", () => {
    const items = makeStatuses()
    const result = removeStatus(items, 1) // Remove "in_review"
    expect(result.length).toBe(2)
    expect(result.map((s) => s.id)).toEqual(["draft", "done"])
  })

  test("renumbers positions after removal", () => {
    const items = makeStatuses()
    const result = removeStatus(items, 0) // Remove "draft"
    expect(result[0].position).toBe(0)
    expect(result[1].position).toBe(1)
    expect(result[0].id).toBe("in_review")
    expect(result[1].id).toBe("done")
  })

  test("removing last item returns empty array", () => {
    const items = [{ id: "only", name: "Only", color: "#000", position: 0, transitions: [] }]
    const result = removeStatus(items, 0)
    expect(result).toEqual([])
  })

  test("removing from middle preserves order of remaining", () => {
    const items = makeStatuses()
    const result = removeStatus(items, 1)
    expect(result[0].id).toBe("draft")
    expect(result[1].id).toBe("done")
  })
})

describe("moveUp", () => {
  test("swaps item with predecessor", () => {
    const items = makeStatuses()
    const result = moveUp(items, 1) // Move "in_review" up
    expect(result[0].id).toBe("in_review")
    expect(result[1].id).toBe("draft")
    expect(result[2].id).toBe("done")
  })

  test("renumbers positions after swap", () => {
    const items = makeStatuses()
    const result = moveUp(items, 2) // Move "done" up
    expect(result[0].position).toBe(0)
    expect(result[1].position).toBe(1)
    expect(result[2].position).toBe(2)
    expect(result[1].id).toBe("done")
    expect(result[2].id).toBe("in_review")
  })

  test("no-op when index is 0", () => {
    const items = makeStatuses()
    const result = moveUp(items, 0)
    expect(result).toBe(items) // Same reference (no mutation)
  })
})

describe("moveDown", () => {
  test("swaps item with successor", () => {
    const items = makeStatuses()
    const result = moveDown(items, 0) // Move "draft" down
    expect(result[0].id).toBe("in_review")
    expect(result[1].id).toBe("draft")
    expect(result[2].id).toBe("done")
  })

  test("renumbers positions after swap", () => {
    const items = makeStatuses()
    const result = moveDown(items, 0)
    expect(result[0].position).toBe(0)
    expect(result[1].position).toBe(1)
    expect(result[2].position).toBe(2)
  })

  test("no-op when index is last", () => {
    const items = makeStatuses()
    const result = moveDown(items, 2)
    expect(result).toEqual(items) // Same content
  })
})

describe("toggleTransition", () => {
  test("adds transition when not present", () => {
    const items = makeStatuses()
    // "done" (index 2) has no transitions — add "draft"
    const result = toggleTransition(items, 2, "draft")
    expect(result[2].transitions).toEqual(["draft"])
  })

  test("removes transition when already present", () => {
    const items = makeStatuses()
    // "in_review" (index 1) has ["draft", "done"] — remove "draft"
    const result = toggleTransition(items, 1, "draft")
    expect(result[1].transitions).toEqual(["done"])
  })

  test("does not modify other statuses", () => {
    const items = makeStatuses()
    const result = toggleTransition(items, 1, "draft")
    expect(result[0]).toEqual(items[0])
    expect(result[2]).toEqual(items[2])
  })

  test("multiple toggles create / remove correctly", () => {
    let items = makeStatuses()
    // Add "in_review" to "done" transitions
    items = toggleTransition(items, 2, "in_review")
    expect(items[2].transitions).toEqual(["in_review"])
    // Add "draft" to "done" transitions
    items = toggleTransition(items, 2, "draft")
    expect(items[2].transitions).toEqual(["in_review", "draft"])
    // Remove "in_review"
    items = toggleTransition(items, 2, "in_review")
    expect(items[2].transitions).toEqual(["draft"])
  })
})

describe("updateItem", () => {
  test("updates name", () => {
    const items = makeStatuses()
    const result = updateItem(items, 0, { name: "To Do" })
    expect(result[0].name).toBe("To Do")
    expect(result[0].id).toBe("draft") // id unchanged
  })

  test("updates color", () => {
    const items = makeStatuses()
    const result = updateItem(items, 1, { color: "#ff0000" })
    expect(result[1].color).toBe("#ff0000")
  })

  test("does not modify other items", () => {
    const items = makeStatuses()
    const result = updateItem(items, 0, { name: "Changed" })
    expect(result[1]).toEqual(items[1])
    expect(result[2]).toEqual(items[2])
  })
})

describe("complex workflows", () => {
  test("add → rename → reorder → toggle transitions", () => {
    let items = makeStatuses() // draft, in_review, done

    // Add new status
    items = addStatus(items) // draft, in_review, done, new
    expect(items.length).toBe(4)

    // Rename it
    items = updateItem(items, 3, { name: "Blocked" })
    expect(items[3].name).toBe("Blocked")

    // Move it up twice (from index 3 → 2 → 1)
    items = moveUp(items, 3) // draft, in_review, blocked, done
    items = moveUp(items, 2) // draft, blocked, in_review, done
    expect(items[1].name).toBe("Blocked")
    expect(items[1].position).toBe(1)

    // Add transition from draft to blocked
    items = toggleTransition(items, 0, items[1].id)
    expect(items[0].transitions).toContain(items[1].id)
  })

  test("remove status cleans up cleanly", () => {
    let items = makeStatuses()
    // Remove middle item
    items = removeStatus(items, 1)
    expect(items.length).toBe(2)

    // Positions are sequential
    expect(items[0].position).toBe(0)
    expect(items[1].position).toBe(1)

    // Add new and verify position
    items = addStatus(items)
    expect(items[2].position).toBe(2)
  })

  test("transitions survive reordering", () => {
    let items = makeStatuses()
    // "draft" (0) transitions to ["in_review"]
    // Move "in_review" to position 0
    items = moveUp(items, 1)
    // Now: in_review (0), draft (1), done (2)
    // "draft" still transitions to "in_review" by ID
    expect(items[1].transitions).toEqual(["in_review"])
  })
})
