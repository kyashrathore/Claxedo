import { describe, expect, test } from "bun:test"
import {
  ALL_TABS,
  appendActivity,
  doneShare,
  listPatches,
  monitorView,
  moveTarget,
  readFilter,
  statusCounts,
  summaryLine,
  tabChanges,
  tabRow,
  viewPatches,
  visibleTabs,
  type Tab,
} from "./model"

function tab(id: string, index: number, overrides: Partial<Tab> = {}): Tab {
  return { id, title: `Tab ${id}`, kind: "session", status: "idle", active: false, index, ...overrides }
}

const tabs: Tab[] = [
  tab("a", 0, { title: "Router refactor", status: "working", active: true }),
  tab("b", 1, { title: "auth docs", status: "done" }),
  tab("c", 2, { title: "Billing bug", status: "attention", kind: "page" }),
  tab("d", 3, { title: "", status: "done" }),
]

describe("filtering and sorting", () => {
  test("keeps tab order by default and filters by status and by title or kind", () => {
    expect(visibleTabs(tabs, ALL_TABS).map((entry) => entry.id)).toEqual(["a", "b", "c", "d"])
    expect(visibleTabs(tabs, { ...ALL_TABS, statuses: ["done"] }).map((entry) => entry.id)).toEqual(["b", "d"])
    expect(visibleTabs(tabs, { ...ALL_TABS, query: "BUG" }).map((entry) => entry.id)).toEqual(["c"])
    expect(visibleTabs(tabs, { ...ALL_TABS, query: "page" }).map((entry) => entry.id)).toEqual(["c"])
  })

  test("sorts by title case-insensitively and by status urgency, ties by tab order", () => {
    expect(visibleTabs(tabs, { ...ALL_TABS, sort: "title" }).map((entry) => entry.id)).toEqual(["b", "c", "a", "d"])
    expect(visibleTabs(tabs, { ...ALL_TABS, sort: "status" }).map((entry) => entry.id)).toEqual(["c", "a", "b", "d"])
  })

  test("reads the filter from an action context and drops unknown values", () => {
    expect(readFilter({ statuses: ["done", "bogus"], query: "  auth ", sort: ["title"] })).toEqual({ statuses: ["done"], query: "auth", sort: "title" })
    expect(readFilter({ sort: ["nope"] })).toEqual(ALL_TABS)
  })
})

describe("summary", () => {
  test("counts every status, including empty ones", () => {
    const counts = statusCounts(tabs)
    expect(counts.done).toBe("Done 2")
    expect(counts.failed).toBe("Failed 0")
  })

  test("reports the done share as a whole percent", () => {
    expect(doneShare(tabs)).toEqual({ percent: 50, label: "2 of 4 done" })
    expect(doneShare([])).toEqual({ percent: 0, label: "0 of 0 done" })
  })

  test("names the focused tab and how many are shown", () => {
    expect(summaryLine(tabs, 4)).toBe("4 open tabs · focused: Router refactor")
    expect(summaryLine([tab("x", 0)], 0)).toBe("1 open tab · showing 0")
  })

  test("marks the active tab and labels untitled ones", () => {
    expect(tabRow(tabs[0]!)).toEqual({ id: "a", position: "#1", title: "Router refactor", meta: "session", status: "Working", marker: "● Active" })
    expect(tabRow(tabs[3]!).title).toBe("Untitled")
  })
})

describe("moving", () => {
  test("refuses to move past either end", () => {
    expect(moveTarget(tabs, "a", "left")).toBeUndefined()
    expect(moveTarget(tabs, "a", "right")).toBe(1)
    expect(moveTarget(tabs, "d", "right")).toBeUndefined()
    expect(moveTarget(tabs, "missing", "left")).toBeUndefined()
  })
})

describe("changes", () => {
  test("describes opened, closed, renamed, status and focus changes", () => {
    const next: Tab[] = [
      tab("a", 0, { title: "Router refactor", status: "done", active: false }),
      tab("c", 1, { title: "Billing bug fix", status: "attention", kind: "page", active: true }),
      tab("e", 2, { title: "New session" }),
    ]
    expect(tabChanges(tabs, next)).toEqual([
      "“Router refactor”: Working → Done",
      "“Billing bug” renamed to “Billing bug fix”",
      "Focused “Billing bug fix”",
      "Opened “New session”",
      "Closed “auth docs”",
      "Closed “Untitled”",
    ])
  })

  test("reports a reorder only when kept tabs change relative order", () => {
    const swapped = [{ ...tabs[1]!, index: 0 }, { ...tabs[0]!, index: 1 }, tabs[2]!, tabs[3]!]
    expect(tabChanges(tabs, swapped)).toEqual(["Tabs reordered"])
    expect(tabChanges(tabs, tabs.slice(1).map((entry, index) => ({ ...entry, index })))).toEqual(["Closed “Router refactor”"])
  })
})

describe("patches", () => {
  test("patches only the rows that changed, or the whole list when its length changes", () => {
    expect(listPatches("/rows", [1, 2, 3], [1, 5, 3])).toEqual([{ path: "/rows/1", value: 5 }])
    expect(listPatches("/rows", [1, 2], [1, 2, 3])).toEqual([{ path: "/rows", value: [1, 2, 3] }])
  })

  test("a status change touches its row, two counts, the done share and the raw data only", () => {
    const before = monitorView(tabs, ALL_TABS)
    const after = monitorView(tabs.map((entry) => (entry.id === "a" ? { ...entry, status: "done" as const } : entry)), ALL_TABS)
    expect(viewPatches(before, after).map((entry) => entry.path)).toEqual(["/rows/0", "/counts/working", "/counts/done", "/done", "/raw"])
    expect(viewPatches(before, before)).toEqual([])
  })

  test("appends activity at the end, and rewrites the log once it passes the limit", () => {
    const first = appendActivity([], [{ time: "1", event: "a" }], 2)
    expect(first.patches).toEqual([{ path: "/activity/0", value: { time: "1", event: "a" } }])
    const trimmed = appendActivity(first.log, [{ time: "2", event: "b" }, { time: "3", event: "c" }], 2)
    expect(trimmed.log.map((entry) => entry.event)).toEqual(["b", "c"])
    expect(trimmed.patches).toEqual([{ path: "/activity", value: trimmed.log }])
  })
})
