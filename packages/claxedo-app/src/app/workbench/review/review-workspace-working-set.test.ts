import { describe, expect, test } from "bun:test"

import {
  createReviewWorkspaceWorkingSetBoundary,
  createReviewWorkspaceWorkingSetStore,
  type ReviewWorkspaceWorkingSetSnapshot,
} from "./review-workspace-working-set"

function snapshot(label = "a"): ReviewWorkspaceWorkingSetSnapshot {
  return {
    tabs: [
      { id: "review", kind: "review" },
      { id: `file:${label}`, kind: "file", tabId: `file:${label}` },
      { id: "context", kind: "context", sessionId: `session:${label}` },
    ],
    activeTabId: `file:${label}`,
    review: {
      scroll: {
        top: 1_200,
        anchorPath: `src/${label}.ts`,
        anchorOffset: -4,
      },
    },
  }
}

describe("Review workspace working-set store", () => {
  test("isolates stored state from callers and provider instances", () => {
    const first = createReviewWorkspaceWorkingSetStore(2)
    const second = createReviewWorkspaceWorkingSetStore(2)
    const input = snapshot()

    first.set("workspace:a", input)
    input.tabs.reverse()
    input.review.scroll.top = 0

    const loaded = first.get("workspace:a")!
    expect(loaded.tabs.map((tab) => tab.id)).toEqual(["review", "file:a", "context"])
    expect(loaded.review.scroll).toEqual({
      top: 1_200,
      anchorPath: "src/a.ts",
      anchorOffset: -4,
    })
    expect(second.get("workspace:a")).toBeUndefined()

    loaded.tabs.splice(0, 1)
    loaded.review.scroll.anchorPath = "mutated.ts"
    expect(first.get("workspace:a")).toEqual(snapshot())
  })

  test("evicts the least-recently-used unbounded history at the configured limit", () => {
    const store = createReviewWorkspaceWorkingSetStore(2)
    store.set("workspace:a", snapshot("a"))
    store.set("workspace:b", snapshot("b"))

    expect(store.get("workspace:a")?.activeTabId).toBe("file:a")
    store.set("workspace:c", snapshot("c"))

    expect(store.size()).toBe(2)
    expect(store.get("workspace:a")?.activeTabId).toBe("file:a")
    expect(store.get("workspace:b")).toBeUndefined()
    expect(store.get("workspace:c")?.activeTabId).toBe("file:c")
  })
})

describe("Review workspace working-set boundary", () => {
  test("preserves the existing default and focused-context initialization without a snapshot", () => {
    const review = createReviewWorkspaceWorkingSetBoundary({})
    expect(review.initial).toEqual({
      tabs: [{ id: "review", kind: "review" }],
      activeTabId: "review",
      review: { scroll: { top: 0 } },
    })

    const context = createReviewWorkspaceWorkingSetBoundary({ fallbackContextSessionId: "session:new" })
    expect(context.initial.tabs.map((tab) => tab.id)).toEqual(["review", "context"])
    expect(context.initial.activeTabId).toBe("context")
  })

  test("restores the exact tab order and active tab", () => {
    const initial = snapshot()
    const boundary = createReviewWorkspaceWorkingSetBoundary({ initial })

    expect(boundary.initial.tabs.map((tab) => tab.id)).toEqual(["review", "file:a", "context"])
    expect(boundary.initial.activeTabId).toBe("file:a")
    expect(boundary.initial.review.scroll.anchorPath).toBe("src/a.ts")
  })

  test("publishes a cloned semantic scroll snapshot with the live tabs and active tab", () => {
    const changes: ReviewWorkspaceWorkingSetSnapshot[] = []
    const boundary = createReviewWorkspaceWorkingSetBoundary({
      initial: snapshot(),
      onChange: (next) => changes.push(next),
    })
    const tabs = [
      { id: "review", kind: "review" } as const,
      { id: "file:b", kind: "file", tabId: "file:b" } as const,
    ]

    boundary.publishScroll(
      { top: 2_400, anchorPath: "src/deep.ts", anchorOffset: 3 },
      tabs,
      "review",
    )

    expect(changes).toEqual([{
      tabs,
      activeTabId: "review",
      review: {
        scroll: { top: 2_400, anchorPath: "src/deep.ts", anchorOffset: 3 },
      },
    }])
    tabs.reverse()
    expect(changes[0]!.tabs.map((tab) => tab.id)).toEqual(["review", "file:b"])

    changes[0]!.review.scroll.top = 0
    boundary.publish([{ id: "review", kind: "review" }], "review")
    expect(changes[1]!.review.scroll.top).toBe(2_400)
  })
})
