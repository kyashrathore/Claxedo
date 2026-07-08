import { describe, test, expect } from "vitest"
import { reduce, emptyState, replayEvents } from "../src/model/reducer"
import type { WorkEvent, WorkItem, WorkGraphState } from "../src/model/types"

function makeEvent(seq: number, type: string, payload: any, actor = "system"): WorkEvent {
  return {
    id: `evt-${seq}`,
    seq,
    type: type as any,
    payload: JSON.stringify(payload),
    actor,
    createdAt: new Date().toISOString(),
  }
}

function makeItem(overrides?: Partial<WorkItem>): WorkItem {
  return {
    id: "item-1",
    title: "Test",
    description: "",
    status: "open",
    labels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe("reducer", () => {
  test("item_created adds item to state", () => {
    const item = makeItem()
    const event = makeEvent(1, "item_created", item)
    const state = reduce(emptyState(), event)
    expect(state.items["item-1"]).toBeDefined()
    expect(state.items["item-1"].title).toBe("Test")
  })

  test("item_updated modifies existing item", () => {
    const item = makeItem()
    const s1 = reduce(emptyState(), makeEvent(1, "item_created", item))
    const s2 = reduce(s1, makeEvent(2, "item_updated", {
      id: "item-1",
      changes: { title: "Updated", status: "in_progress" },
    }))
    expect(s2.items["item-1"].title).toBe("Updated")
    expect(s2.items["item-1"].status).toBe("in_progress")
  })

  test("item_updated on missing item returns same state", () => {
    const event = makeEvent(1, "item_updated", { id: "missing", changes: { title: "x" } })
    const state = reduce(emptyState(), event)
    expect(Object.keys(state.items)).toHaveLength(0)
  })

  test("item_removed deletes item and its edges", () => {
    const item = makeItem()
    let state = reduce(emptyState(), makeEvent(1, "item_created", item))
    state = reduce(state, makeEvent(2, "edge_added", { source: "item-1", target: "item-2" }))
    state = reduce(state, makeEvent(3, "item_removed", { id: "item-1" }))

    expect(state.items["item-1"]).toBeUndefined()
    expect(state.edges).toHaveLength(0)
  })

  test("edge_added adds an edge", () => {
    const state = reduce(emptyState(), makeEvent(1, "edge_added", {
      source: "a",
      target: "b",
    }))
    expect(state.edges).toHaveLength(1)
    expect(state.edges[0]).toEqual({ source: "a", target: "b" })
  })

  test("edge_removed removes matching edge", () => {
    let state = reduce(emptyState(), makeEvent(1, "edge_added", { source: "a", target: "b" }))
    state = reduce(state, makeEvent(2, "edge_added", { source: "b", target: "c" }))
    state = reduce(state, makeEvent(3, "edge_removed", { source: "a", target: "b" }))
    expect(state.edges).toHaveLength(1)
    expect(state.edges[0]).toEqual({ source: "b", target: "c" })
  })

  test("item_hydrated adds item (same as item_created)", () => {
    const item = makeItem({ id: "hydrated-1", provider: "github" })
    const state = reduce(emptyState(), makeEvent(1, "item_hydrated", item))
    expect(state.items["hydrated-1"]).toBeDefined()
    expect(state.items["hydrated-1"].provider).toBe("github")
  })

  test("item_synced updates existing item", () => {
    const item = makeItem()
    let state = reduce(emptyState(), makeEvent(1, "item_created", item))
    state = reduce(state, makeEvent(2, "item_synced", {
      id: "item-1",
      changes: { status: "done" },
    }))
    expect(state.items["item-1"].status).toBe("done")
  })

  test("unknown event type returns same state", () => {
    const state = emptyState()
    const result = reduce(state, makeEvent(1, "unknown_type", {}))
    expect(result).toBe(state)
  })

  test("replayEvents replays full sequence", () => {
    const events = [
      makeEvent(1, "item_created", makeItem({ id: "a", title: "A" })),
      makeEvent(2, "item_created", makeItem({ id: "b", title: "B" })),
      makeEvent(3, "edge_added", { source: "a", target: "b" }),
      makeEvent(4, "item_updated", { id: "a", changes: { status: "done" } }),
    ]

    const state = replayEvents(events)
    expect(Object.keys(state.items)).toHaveLength(2)
    expect(state.items["a"].status).toBe("done")
    expect(state.edges).toHaveLength(1)
  })

  test("replayEvents on empty array returns empty state", () => {
    const state = replayEvents([])
    expect(state.items).toEqual({})
    expect(state.edges).toEqual([])
  })
})
