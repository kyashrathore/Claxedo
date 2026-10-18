import { describe, expect, test } from "bun:test"
import { addTask, createFocusState, skip, start, toggleTaskDone, type Change, type FocusState } from "./model"
import { focusComponents, settingsData, statsData, tasksData, timerData } from "./view"

const T0 = new Date(2026, 9, 18, 9, 0, 0).getTime()

function must(change: Change): FocusState {
  if (change.error) throw new Error(change.error)
  return change.state
}

describe("view data", () => {
  test("the timer says its status as a word with a tone and names the task in focus", () => {
    const state = must(addTask(createFocusState(), "Write docs", "2"))
    expect(timerData(state)).toMatchObject({
      status: "Ready",
      statusTone: "neutral",
      subtitle: "25 min focus · 5 min short break · 15 min long break",
      focusOn: "Focusing on: Write docs",
      blockLabel: "25 minute focus block",
    })
    expect(timerData(start(state, T0))).toMatchObject({ status: "Running", statusTone: "success" })
    expect(timerData(skip(start(state, T0), T0 + 60_000).state)).toMatchObject({ mode: "Short break", blockTitle: "Short break", focusOn: "Take a break" })
  })

  test("only the clock shows the remaining time, so it is the one place a countdown changes", () => {
    const texts = JSON.stringify([timerData(createFocusState()), statsData(createFocusState(), T0), focusComponents(createFocusState())])
    expect(texts).not.toContain("25:00")
  })

  test("task rows carry a toned badge and mark the active one", () => {
    const state = toggleTaskDone(must(addTask(must(addTask(createFocusState(), "Write docs", "1")), "Review", "2")), "task-2")
    expect(tasksData(state)).toEqual([
      { id: "task-1", title: "Write docs", progress: "0 of 1 block done", badge: "Active", tone: "accent", active: true, doneLabel: "Done" },
      { id: "task-2", title: "Review", progress: "0 of 2 blocks done", badge: "Done", tone: "success", active: false, doneLabel: "Reopen" },
    ])
  })

  test("a task row shows Done or Reopen and keeps Focus and Remove behind icons", () => {
    const byId = new Map(focusComponents(createFocusState()).map((component) => [component.id, component]))
    expect(byId.get("task-row")).toMatchObject({ primaryAction: "task-done", actions: ["task-focus", "task-remove"] })
    expect(byId.get("task-focus")).toMatchObject({ component: "Button", icon: "visibility" })
    expect(byId.get("task-remove")).toMatchObject({ component: "Button", icon: "delete" })
  })

  test("stats carry units and settings travel as picker choices", () => {
    expect(statsData(createFocusState(), T0)).toEqual({
      minutes: { value: "0 min", caption: "0% of the 100 minute goal" },
      blocks: { value: "0", caption: "Completed focus blocks today" },
      streak: { value: "0 days", caption: "In a row with a completed block" },
    })
    expect(settingsData(createFocusState().settings)).toEqual({
      focusMinutes: ["25"],
      shortMinutes: ["5"],
      longMinutes: ["15"],
      longEvery: ["4"],
      dailyGoalMinutes: ["100"],
      autoStartBreaks: false,
    })
  })
})
