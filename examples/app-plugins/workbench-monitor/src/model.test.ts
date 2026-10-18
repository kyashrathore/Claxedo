import { describe, expect, test } from "bun:test"
import {
  ALL_TABS,
  appendActivity,
  listPatches,
  monitorView,
  monitorHealth,
  monitorStats,
  moveTarget,
  readFilter,
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
  test("counts open, waiting, working and done tabs, with the done share as a whole percent", () => {
    expect(monitorStats(tabs)).toEqual({
      open: "4",
      focused: "Focused: Router refactor",
      attention: "1",
      failed: "0 failed",
      working: "1",
      background: "0 in background",
      done: "2",
      doneShare: "50% of open tabs",
    })
    const none = monitorStats([])
    expect([none.open, none.focused, none.doneShare]).toEqual(["0", "No tab focused", "0% of open tabs"])
  })

  test("names the workbench health in words, failures first", () => {
    expect(monitorHealth([])).toEqual({ text: "No tabs", tone: "neutral" })
    expect(monitorHealth([...tabs, tab("e", 4, { status: "failed" })])).toEqual({ text: "1 failed", tone: "danger" })
    expect(monitorHealth(tabs)).toEqual({ text: "1 needs attention", tone: "warning" })
    expect(monitorHealth([tab("x", 0, { status: "running_in_background" })])).toEqual({ text: "Working", tone: "accent" })
    expect(monitorHealth([tab("x", 0, { status: "done" })])).toEqual({ text: "All clear", tone: "success" })
  })

  test("counts the open tabs and how many are shown", () => {
    expect(summaryLine(tabs, 4)).toBe("4 open tabs")
    expect(summaryLine(tabs, 2)).toBe("4 open tabs · showing 2")
    expect(summaryLine([tab("x", 0)], 0)).toBe("1 open tab · showing 0")
  })

  test("marks the active tab, gives each status a tone and icon, and labels untitled ones", () => {
    expect(tabRow(tabs[0]!)).toEqual({ id: "a", title: "Router refactor", subtitle: "#1 · session · Active", status: "Working", tone: "accent", icon: "play", active: true })
    const waiting = tabRow(tabs[2]!)
    expect([waiting.subtitle, waiting.status, waiting.tone, waiting.active]).toEqual(["#3 · page", "Needs attention", "warning", false])
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

  test("a status change touches its row, the stats it moves and the raw data only", () => {
    const before = monitorView(tabs, ALL_TABS)
    const after = monitorView(tabs.map((entry) => (entry.id === "a" ? { ...entry, status: "done" as const } : entry)), ALL_TABS)
    expect(viewPatches(before, after).map((entry) => entry.path)).toEqual(["/rows/0", "/stats/working", "/stats/done", "/stats/doneShare", "/raw"])
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
