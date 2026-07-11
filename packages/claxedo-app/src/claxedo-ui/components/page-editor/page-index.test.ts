/**
 * Tests for PageIndex logic: grouping pages by status, allowed transitions,
 * and optimistic state mutations.
 */

import { describe, expect, test } from "bun:test"
import { createRoot, createSignal, createMemo } from "solid-js"
import type { Page, PageStatus } from "../../../utils/pages-api"
import {
  allowedPageStatusTransitions,
  groupPagesByStatus,
  optimisticDropPage,
  optimisticMovePage,
  runOptimisticPageMutation,
} from "./page-index"

// ── Test fixtures ─────────────────────────────────────────────────────

const STATUSES: PageStatus[] = [
  { id: "draft", name: "Draft", color: "#6b7280", position: 0, transitions: ["in_review", "in_progress"] },
  { id: "in_review", name: "In Review", color: "#f59e0b", position: 1, transitions: ["in_progress", "draft"] },
  { id: "in_progress", name: "In Progress", color: "#3b82f6", position: 2, transitions: ["done", "in_review"] },
  { id: "done", name: "Done", color: "#22c55e", position: 3, transitions: ["archived", "in_progress"] },
  { id: "archived", name: "Archived", color: "#9ca3af", position: 4, transitions: ["draft"] },
]

function makePage(id: string, title: string, status: string): Page {
  return {
    id,
    title,
    content: "",
    status,
    visibility: "private",
    version: 1,
    session_id: null,
    directory: null,
    source_kind: null,
    source_repo_root: null,
    source_repo_key: null,
    source_branch: null,
    source_path: null,
    base_commit: null,
    base_blob_sha: null,
    base_tree_sha: null,
    last_materialized_commit: null,
    last_materialized_blob_sha: null,
    last_commit_at: null,
    last_commit_author_id: null,
    commit_status: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("page grouping", () => {
  test("groups pages by their status", () => {
    const pages = [
      makePage("p1", "Draft page", "draft"),
      makePage("p2", "In review page", "in_review"),
      makePage("p3", "Another draft", "draft"),
    ]
    const groups = groupPagesByStatus(pages, STATUSES)
    expect(groups.length).toBe(5)
    const draft = groups.find((g) => g.status.id === "draft")!
    expect(draft.pages.length).toBe(2)
    expect(draft.pages.map((p) => p.id)).toEqual(["p1", "p3"])
    const review = groups.find((g) => g.status.id === "in_review")!
    expect(review.pages.length).toBe(1)
    expect(review.pages[0].id).toBe("p2")
  })

  test("empty statuses group only produces empty groups", () => {
    const groups = groupPagesByStatus([], STATUSES)
    expect(groups.length).toBe(5)
    for (const g of groups) {
      expect(g.pages.length).toBe(0)
    }
  })

  test("orphaned pages with unknown status get __unknown__ group", () => {
    const pages = [
      makePage("p1", "Ghost", "nonexistent_status"),
    ]
    const groups = groupPagesByStatus(pages, STATUSES)
    const unknown = groups.find((g) => g.status.id === "__unknown__")
    expect(unknown).toBeTruthy()
    expect(unknown!.pages.length).toBe(1)
    expect(unknown!.pages[0].id).toBe("p1")
  })

  test("no __unknown__ group when all pages have valid status", () => {
    const pages = [
      makePage("p1", "Draft", "draft"),
      makePage("p2", "Done", "done"),
    ]
    const groups = groupPagesByStatus(pages, STATUSES)
    const unknown = groups.find((g) => g.status.id === "__unknown__")
    expect(unknown).toBeUndefined()
  })

  test("groups preserve status ordering by position", () => {
    const reversed = [...STATUSES].reverse()
    const groups = groupPagesByStatus([], reversed)
    // Groups follow the input statuses order
    expect(groups.map((g) => g.status.id)).toEqual(
      reversed.map((s) => s.id),
    )
  })

  test("all pages appear in exactly one group", () => {
    const pages = [
      makePage("p1", "A", "draft"),
      makePage("p2", "B", "in_progress"),
      makePage("p3", "C", "done"),
      makePage("p4", "D", "archived"),
      makePage("p5", "E", "in_review"),
    ]
    const groups = groupPagesByStatus(pages, STATUSES)
    const allGrouped = groups.flatMap((g) => g.pages)
    expect(allGrouped.length).toBe(pages.length)
    const ids = new Set(allGrouped.map((p) => p.id))
    expect(ids.size).toBe(pages.length)
  })
})

describe("allowed transitions", () => {
  test("draft can transition to in_review and in_progress", () => {
    const page = makePage("p1", "Test", "draft")
    const allowed = allowedPageStatusTransitions(page, STATUSES)
    expect(allowed.map((s) => s.id)).toEqual(["in_review", "in_progress"])
  })

  test("in_review can transition to in_progress and draft", () => {
    const page = makePage("p1", "Test", "in_review")
    const allowed = allowedPageStatusTransitions(page, STATUSES)
    // Filtered from STATUSES array, so order follows position (draft=0, in_progress=2)
    expect(allowed.map((s) => s.id)).toEqual(["draft", "in_progress"])
  })

  test("archived can only transition to draft", () => {
    const page = makePage("p1", "Test", "archived")
    const allowed = allowedPageStatusTransitions(page, STATUSES)
    expect(allowed.map((s) => s.id)).toEqual(["draft"])
  })

  test("page with unknown status returns all statuses as transitions", () => {
    const page = makePage("p1", "Ghost", "nonexistent")
    const allowed = allowedPageStatusTransitions(page, STATUSES)
    expect(allowed.length).toBe(STATUSES.length)
  })

  test("status with no transitions returns empty array", () => {
    const customStatuses: PageStatus[] = [
      { id: "only", name: "Only", color: "#000", position: 0, transitions: [] },
    ]
    const page = makePage("p1", "Test", "only")
    const allowed = allowedPageStatusTransitions(page, customStatuses)
    expect(allowed.length).toBe(0)
  })
})

describe("optimisticMovePage", () => {
  test("rewrites only the target page's status, leaving others untouched", () => {
    const pages = [makePage("p1", "A", "draft"), makePage("p2", "B", "draft")]
    const after = optimisticMovePage(pages, "p1", "in_review")
    const groups = groupPagesByStatus(after, STATUSES)
    expect(groups.find((g) => g.status.id === "draft")!.pages.map((p) => p.id)).toEqual(["p2"])
    expect(groups.find((g) => g.status.id === "in_review")!.pages.map((p) => p.id)).toEqual(["p1"])
  })

  test("returns a new array and does not mutate the input", () => {
    const pages = [makePage("p1", "A", "draft")]
    const after = optimisticMovePage(pages, "p1", "done")
    expect(after).not.toBe(pages)
    expect(pages[0].status).toBe("draft")
    expect(after[0].status).toBe("done")
  })
})

describe("optimisticDropPage", () => {
  test("removes the target page and keeps the rest in order", () => {
    const pages = [makePage("p1", "A", "draft"), makePage("p2", "B", "draft"), makePage("p3", "C", "in_review")]
    expect(optimisticDropPage(pages, "p2").map((p) => p.id)).toEqual(["p1", "p3"])
  })
})

describe("runOptimisticPageMutation", () => {
  function harness(initial: Page[]) {
    let current = initial
    const setCalls: Page[][] = []
    return {
      getPages: () => current,
      setPages: (next: Page[]) => {
        current = next
        setCalls.push(next)
      },
      snapshot: () => current,
      setCalls,
    }
  }

  test("applies the optimistic transform immediately, before the commit resolves", async () => {
    const h = harness([makePage("p1", "A", "draft"), makePage("p2", "B", "draft")])
    let resolveCommit: () => void = () => {}
    const commit = () => new Promise<void>((resolve) => (resolveCommit = resolve))
    const onError = () => {
      throw new Error("onError must not fire on success")
    }
    const run = runOptimisticPageMutation({
      getPages: h.getPages,
      setPages: h.setPages,
      optimistic: (list) => optimisticDropPage(list, "p2"),
      commit,
      onError,
    })
    // Optimistic state is visible synchronously, while commit is still pending.
    expect(h.snapshot().map((p) => p.id)).toEqual(["p1"])
    resolveCommit()
    await run
    // Success: the optimistic edit stays; no rollback happened.
    expect(h.snapshot().map((p) => p.id)).toEqual(["p1"])
    expect(h.setCalls).toHaveLength(1)
  })

  test("rolls back to the exact pre-mutation snapshot and reports the error when commit rejects", async () => {
    const initial = [makePage("p1", "A", "draft"), makePage("p2", "B", "in_review")]
    const h = harness(initial)
    const failure = new Error("network down")
    const errors: unknown[] = []
    await runOptimisticPageMutation({
      getPages: h.getPages,
      setPages: h.setPages,
      optimistic: (list) => optimisticMovePage(list, "p1", "done"),
      commit: () => Promise.reject(failure),
      onError: (err) => errors.push(err),
    })
    // Rolled back to the original reference, and the caller was told why.
    expect(h.snapshot()).toBe(initial)
    expect(h.snapshot().find((p) => p.id === "p1")!.status).toBe("draft")
    expect(errors).toEqual([failure])
    // Exactly two writes: optimistic, then rollback.
    expect(h.setCalls).toHaveLength(2)
  })
})

describe("reactive grouping (SolidJS signals)", () => {
  test("grouped memo reacts to page signal changes", () => {
    let dispose!: () => void
    const results: number[] = []

    createRoot((d) => {
      dispose = d
      const [pages, setPages] = createSignal([
        makePage("p1", "A", "draft"),
        makePage("p2", "B", "in_review"),
      ])
      const grouped = createMemo(() => groupPagesByStatus(pages(), STATUSES))

      // Initial state
      const initial = grouped()
      const draftCount = initial.find((g) => g.status.id === "draft")!.pages.length
      results.push(draftCount)

      // Add a page to draft
      setPages((prev) => [...prev, makePage("p3", "C", "draft")])
      const updated = grouped()
      results.push(updated.find((g) => g.status.id === "draft")!.pages.length)
    })

    expect(results).toEqual([1, 2])
    dispose()
  })

  test("grouped memo reacts to status signal changes", () => {
    let dispose!: () => void
    const results: number[] = []

    createRoot((d) => {
      dispose = d
      const [statuses, setStatuses] = createSignal(STATUSES)
      const pages: Page[] = [
        makePage("p1", "A", "draft"),
        makePage("p2", "B", "custom"),
      ]
      const grouped = createMemo(() => groupPagesByStatus(pages, statuses()))

      // Initial: "custom" is unknown
      results.push(grouped().length) // 5 statuses + 1 unknown = 6

      // Add "custom" status
      setStatuses((prev) => [
        ...prev,
        { id: "custom", name: "Custom", color: "#000", position: 5, transitions: [] },
      ])
      results.push(grouped().length) // 6 statuses, no unknown
    })

    expect(results).toEqual([6, 6])
    dispose()
  })
})
