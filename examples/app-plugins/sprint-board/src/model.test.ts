import { describe, expect, test } from "bun:test"
import {
  addDays,
  addTask,
  burndown,
  deleteTask,
  dueStatus,
  filterByOwners,
  isIsoDate,
  moveTask,
  parseOwnerFilter,
  parseTaskDraft,
  seedBoard,
  setWipLimit,
  snapToStoryPoints,
  sprintDay,
  sprintProgress,
  wipStatus,
  type Board,
  type BoardResult,
} from "./model"

const TODAY = "2026-10-18"

function expectOk(result: BoardResult): Board {
  if (!result.ok) throw new Error(result.error)
  return result.board
}

function expectRefused(result: BoardResult): string {
  if (result.ok) throw new Error(`expected a refusal, got: ${result.message}`)
  return result.error
}

const validDraft = { title: "Refund flow for split payments", description: "Partial refunds", owner: ["priya"], priority: ["high"], points: 4, due: "2026-10-20" }

describe("dates", () => {
  test("validates real calendar dates only", () => {
    expect(isIsoDate("2026-02-28")).toBe(true)
    expect(isIsoDate("2026-02-30")).toBe(false)
    expect(isIsoDate("2026-13-01")).toBe(false)
    expect(isIsoDate("18/10/2026")).toBe(false)
  })

  test("adds days across month and year boundaries", () => {
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02")
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31")
  })

  test("sprint day is clamped to the sprint", () => {
    const { sprint } = seedBoard(TODAY)
    expect(sprintDay(sprint, TODAY)).toBe(6)
    expect(sprintDay(sprint, "2020-01-01")).toBe(1)
    expect(sprintDay(sprint, "2030-01-01")).toBe(10)
  })
})

describe("seed", () => {
  test("holds ten tasks spread across every column", () => {
    const board = seedBoard(TODAY)
    expect(board.tasks).toHaveLength(10)
    expect(new Set(board.tasks.map((task) => task.column)).size).toBe(4)
    expect(new Set(board.tasks.map((task) => task.id)).size).toBe(10)
  })

  test("progress counts done points over all points", () => {
    expect(sprintProgress(seedBoard(TODAY))).toEqual({ done: 7, total: 43, percent: 16 })
  })
})

describe("story points", () => {
  test("snap to the nearest planning value, ties going up", () => {
    expect(snapToStoryPoints(4)).toBe(5)
    expect(snapToStoryPoints(6)).toBe(5)
    expect(snapToStoryPoints(7)).toBe(8)
    expect(snapToStoryPoints(11)).toBe(13)
    expect(snapToStoryPoints(Number.NaN)).toBe(1)
  })
})

describe("task drafts", () => {
  const { sprint } = seedBoard(TODAY)

  test("parse the surface's form shape", () => {
    const parsed = parseTaskDraft({ ...validDraft, title: "  Refund   flow  " }, sprint)
    expect(parsed).toEqual({ ok: true, draft: { title: "Refund flow", description: "Partial refunds", owner: "priya", priority: "high", points: 5, due: "2026-10-20" } })
  })

  test("reject a short title, an unknown owner, a missing priority and a due date before the sprint", () => {
    expect(parseTaskDraft({ ...validDraft, title: "ab" }, sprint).ok).toBe(false)
    expect(parseTaskDraft({ ...validDraft, owner: ["nobody"] }, sprint).ok).toBe(false)
    expect(parseTaskDraft({ ...validDraft, owner: [] }, sprint).ok).toBe(false)
    expect(parseTaskDraft({ ...validDraft, priority: [] }, sprint).ok).toBe(false)
    expect(parseTaskDraft({ ...validDraft, due: "2026-02-30" }, sprint).ok).toBe(false)
    expect(parseTaskDraft({ ...validDraft, due: addDays(sprint.start, -1) }, sprint).ok).toBe(false)
    expect(parseTaskDraft(null, sprint).ok).toBe(false)
  })

  test("accept an empty due date", () => {
    const parsed = parseTaskDraft({ ...validDraft, due: "" }, sprint)
    expect(parsed.ok && parsed.draft.due).toBe("")
  })
})

describe("adding and deleting", () => {
  test("a new task gets the next id and lands in Backlog", () => {
    const board = seedBoard(TODAY)
    const parsed = parseTaskDraft(validDraft, board.sprint)
    if (!parsed.ok) throw new Error(parsed.error)
    const next = expectOk(addTask(board, parsed.draft))
    const added = next.tasks.at(-1)
    expect(added?.id).toBe("T-111")
    expect(added?.column).toBe("backlog")
    expect(next.nextId).toBe(112)
    expect(board.tasks).toHaveLength(10)
  })

  test("an enforced Backlog limit refuses new tasks", () => {
    const board = expectOk(setWipLimit(seedBoard(TODAY), "backlog", true, 3))
    const parsed = parseTaskDraft(validDraft, board.sprint)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(expectRefused(addTask(board, parsed.draft))).toContain("Backlog is at its WIP limit (3/3)")
  })

  test("delete removes exactly one task and refuses an unknown id", () => {
    const board = expectOk(deleteTask(seedBoard(TODAY), "T-104"))
    expect(board.tasks.map((task) => task.id)).not.toContain("T-104")
    expect(board.tasks).toHaveLength(9)
    expect(sprintProgress(board).done).toBe(4)
    expectRefused(deleteTask(board, "T-104"))
  })
})

describe("moving", () => {
  test("forward into Done stamps the completion day and back out clears it", () => {
    const board = seedBoard(TODAY)
    const done = expectOk(moveTask(board, "T-102", 1, TODAY))
    expect(done.tasks.find((task) => task.id === "T-102")).toEqual({ ...board.tasks[1]!, column: "done", doneOn: TODAY })
    const reopened = expectOk(moveTask(done, "T-102", -1, TODAY))
    expect(reopened.tasks.find((task) => task.id === "T-102")?.doneOn).toBeUndefined()
    expect(reopened.tasks.find((task) => task.id === "T-102")?.column).toBe("review")
  })

  test("refuses to move past the first or last column", () => {
    const board = seedBoard(TODAY)
    expect(expectRefused(moveTask(board, "T-103", -1, TODAY))).toContain("cannot move further")
    expect(expectRefused(moveTask(board, "T-104", 1, TODAY))).toContain("cannot move further")
    expectRefused(moveTask(board, "T-999", 1, TODAY))
  })

  test("an enforced WIP limit refuses a move into a full column", () => {
    const board = seedBoard(TODAY)
    expect(wipStatus(board, "review")).toEqual({ count: 2, limit: 2, enforce: true, exceeded: false, full: true })
    expect(expectRefused(moveTask(board, "T-101", 1, TODAY))).toBe("Review is at its WIP limit (2/2). Finish or move a task out first.")
  })

  test("an advisory limit allows the move and reports the column as exceeded", () => {
    const advisory = expectOk(setWipLimit(seedBoard(TODAY), "review", false, 2))
    const moved = expectOk(moveTask(advisory, "T-101", 1, TODAY))
    expect(wipStatus(moved, "review")).toEqual({ count: 3, limit: 2, enforce: false, exceeded: true, full: false })
  })
})

describe("WIP limits", () => {
  test("clamp the limit and coerce enforce to a boolean", () => {
    const board = expectOk(setWipLimit(seedBoard(TODAY), "progress", "yes", 99))
    expect(board.wip.progress).toEqual({ enforce: false, limit: 20 })
    expect(expectOk(setWipLimit(board, "progress", true, 0)).wip.progress).toEqual({ enforce: true, limit: 1 })
  })

  test("lowering a limit below the current count reports it and marks the column exceeded", () => {
    const result = setWipLimit(seedBoard(TODAY), "progress", true, 1)
    expect(result.ok && result.message).toContain("already holds 2")
    expect(wipStatus(expectOk(result), "progress").exceeded).toBe(true)
  })

  test("refuse an unknown column or a non-numeric limit", () => {
    expectRefused(setWipLimit(seedBoard(TODAY), "archive", true, 3))
    expectRefused(setWipLimit(seedBoard(TODAY), "review", true, "many"))
  })
})

describe("owner filter", () => {
  test("keeps only known owners in team order", () => {
    expect(parseOwnerFilter(["sam", "ghost", "maya", 3])).toEqual(["maya", "sam"])
    expect(parseOwnerFilter("maya")).toEqual([])
  })

  test("an empty filter shows everyone", () => {
    const { tasks } = seedBoard(TODAY)
    expect(filterByOwners(tasks, [])).toHaveLength(10)
    expect(filterByOwners(tasks, ["maya", "luis"]).map((task) => task.id)).toEqual(["T-101", "T-102", "T-107", "T-110"])
  })
})

describe("burndown", () => {
  test("has one row per sprint day with a straight ideal line", () => {
    const days = burndown(seedBoard(TODAY), TODAY)
    expect(days).toHaveLength(10)
    expect(days[0]?.ideal).toBe(43)
    expect(days[9]?.ideal).toBe(0)
    expect(days[0]?.date).toBe("2026-10-13")
  })

  test("actual remaining subtracts points completed up to each day and stops at today", () => {
    const days = burndown(seedBoard(TODAY), TODAY)
    expect(days.map((day) => day.remaining)).toEqual([43, 40, 39, 39, 36, 36, undefined, undefined, undefined, undefined])
    expect(days.map((day) => day.completed)).toEqual([0, 3, 1, 0, 3, 0, 0, 0, 0, 0])
  })

  test("completing a task today burns it on today's row", () => {
    const board = expectOk(moveTask(seedBoard(TODAY), "T-107", 1, TODAY))
    const today = burndown(board, TODAY)[5]
    expect(today?.completed).toBe(8)
    expect(today?.remaining).toBe(28)
  })
})

describe("due status", () => {
  const board = seedBoard(TODAY)
  const task = board.tasks[0]!

  test("describes upcoming, today, tomorrow and overdue tasks", () => {
    expect(dueStatus({ ...task, due: "2026-10-21" }, TODAY)).toEqual({ label: "Due in 3 days", overdue: false })
    expect(dueStatus({ ...task, due: "2026-10-19" }, TODAY)).toEqual({ label: "Due tomorrow", overdue: false })
    expect(dueStatus({ ...task, due: TODAY }, TODAY)).toEqual({ label: "Due today", overdue: false })
    expect(dueStatus({ ...task, due: "2026-10-17" }, TODAY)).toEqual({ label: "Overdue by 1 day", overdue: true })
    expect(dueStatus({ ...task, due: "2026-10-10" }, TODAY)).toEqual({ label: "Overdue by 8 days", overdue: true })
  })

  test("a done task is never overdue and a task without a date says so", () => {
    expect(dueStatus({ ...task, column: "done", due: "2026-10-10" }, TODAY).overdue).toBe(false)
    expect(dueStatus({ ...task, due: "" }, TODAY).label).toBe("No due date")
  })
})
