import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { switcherCardChanges, switcherCardStatus, switcherCardTodo } from "./rail-switcher-card-details"

const NOW = Date.UTC(2026, 8, 23, 12)
const minutesAgo = (minutes: number) => NOW - minutes * 60_000

beforeEach(() => setSystemTime(NOW))
afterEach(() => setSystemTime())

describe("switcher card status", () => {
  test("working counts from the turn's user message", () => {
    expect(switcherCardStatus({ status: "working", turnStartedAt: () => minutesAgo(4), waitingSince: () => undefined }))
      .toEqual({ text: "Working for 4m" })
  })

  test("waiting counts from the oldest open permission and takes the warning tone", () => {
    expect(switcherCardStatus({ status: "permission", turnStartedAt: () => undefined, waitingSince: () => minutesAgo(12) }))
      .toEqual({ text: "Waiting for you · 12m", tone: "warning" })
  })

  test("a state with no known start says so without a duration", () => {
    expect(switcherCardStatus({ status: "working", turnStartedAt: () => undefined, waitingSince: () => undefined }))
      .toEqual({ text: "Working" })
    expect(switcherCardStatus({ status: "permission", turnStartedAt: () => undefined, waitingSince: () => undefined }))
      .toEqual({ text: "Waiting for you", tone: "warning" })
  })

  test("a failed turn is critical; idle and done have no status row", () => {
    expect(switcherCardStatus({ status: "error", turnStartedAt: () => undefined, waitingSince: () => undefined }))
      .toEqual({ text: "Last turn failed", tone: "critical" })
    for (const status of ["idle", "done", undefined] as const) {
      expect(switcherCardStatus({ status, turnStartedAt: () => minutesAgo(1), waitingSince: () => minutesAgo(1) })).toBeUndefined()
    }
  })
})

describe("switcher card todo", () => {
  const todo = (content: string, status: string) => ({ content, status, priority: "medium" })

  test("names the in-progress item and counts completed over total", () => {
    expect(switcherCardTodo([
      todo("Dedupe tabs", "completed"),
      todo("Prune idle tabs", "in_progress"),
      todo("Status mark", "pending"),
    ])).toEqual({ text: "Prune idle tabs", done: 1, total: 3 })
  })

  test("counts without a name when nothing is in progress, and is absent for an empty list", () => {
    expect(switcherCardTodo([todo("a", "completed"), todo("b", "pending")])).toEqual({ text: undefined, done: 1, total: 2 })
    expect(switcherCardTodo([])).toBeUndefined()
    expect(switcherCardTodo(undefined)).toBeUndefined()
  })
})

describe("switcher card changes", () => {
  test("sums files and lines across the session diff", () => {
    expect(switcherCardChanges([
      { file: "a.ts", additions: 80, deletions: 10 },
      { file: "b.ts", additions: 4, deletions: 2 },
    ])).toEqual({ files: 2, added: 84, removed: 12 })
    expect(switcherCardChanges([])).toBeUndefined()
  })
})
