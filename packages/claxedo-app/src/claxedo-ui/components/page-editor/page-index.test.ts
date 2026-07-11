/**
 * Tests for PageIndex logic: grouping pages by status, allowed transitions,
 * and optimistic state mutations.
 */

import { describe, expect, test } from "bun:test"
import { createRoot, createSignal, createMemo } from "solid-js"
import type { Page, PageStatus } from "../../../utils/pages-api"
import { allowedPageStatusTransitions, groupPagesByStatus } from "./page-index"

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

describe("optimistic mutations", () => {
  test("optimistic delete removes page from list", () => {
    const pages = [
      makePage("p1", "A", "draft"),
      makePage("p2", "B", "draft"),
      makePage("p3", "C", "in_review"),
    ]
    const after = pages.filter((p) => p.id !== "p2")
    expect(after.length).toBe(2)
    expect(after.map((p) => p.id)).toEqual(["p1", "p3"])
  })

  test("optimistic transition moves page between groups", () => {
    const pages = [
      makePage("p1", "A", "draft"),
      makePage("p2", "B", "draft"),
    ]
    // Simulate: transition p1 from draft to in_review
    const after = pages.map((p) => (p.id === "p1" ? { ...p, status: "in_review" } : p))

    const groups = groupPagesByStatus(after, STATUSES)
    const draft = groups.find((g) => g.status.id === "draft")!
    expect(draft.pages.length).toBe(1)
    expect(draft.pages[0].id).toBe("p2")
    const review = groups.find((g) => g.status.id === "in_review")!
    expect(review.pages.length).toBe(1)
    expect(review.pages[0].id).toBe("p1")
  })

  test("optimistic create prepends page", () => {
    const pages = [
      makePage("p1", "Existing", "done"),
    ]
    const created = makePage("p2", "New", "draft")
    const after = [created, ...pages]
    expect(after.length).toBe(2)
    expect(after[0].id).toBe("p2")
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
