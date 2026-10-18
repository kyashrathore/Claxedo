import { describe, expect, test } from "bun:test"
import {
  addTask,
  applySettings,
  createFocusState,
  dailyStats,
  DEFAULT_SETTINGS,
  elapsedPercent,
  formatClock,
  pause,
  readSettings,
  remainingAt,
  removeTask,
  reset,
  selectTask,
  skip,
  start,
  switchMode,
  tick,
  toggleTaskDone,
  type FocusState,
  type LogEntry,
} from "./model"

const T0 = new Date(2026, 9, 18, 9, 0, 0).getTime()
const MINUTE = 60_000

function runBlock(state: FocusState, startAt: number): { state: FocusState; finished: LogEntry | null; endAt: number } {
  const started = start(state, startAt)
  const endAt = startAt + started.timer.blockSeconds * 1000
  const result = tick(started, endAt)
  return { ...result, endAt }
}

describe("timer transitions", () => {
  test("a fresh state is an idle focus block of the configured length", () => {
    const state = createFocusState()
    expect(state.timer.mode).toBe("focus")
    expect(state.timer.status).toBe("idle")
    expect(state.timer.remainingSeconds).toBe(25 * 60)
  })

  test("running counts down from wall time and pausing keeps the remainder", () => {
    const running = start(createFocusState(), T0)
    expect(remainingAt(running.timer, T0 + 61_000)).toBe(25 * 60 - 61)
    const paused = pause(running, T0 + 61_000)
    expect(paused.timer.status).toBe("paused")
    expect(remainingAt(paused.timer, T0 + 10 * MINUTE)).toBe(25 * 60 - 61)
    const resumed = start(paused, T0 + 10 * MINUTE)
    expect(remainingAt(resumed.timer, T0 + 10 * MINUTE + 1000)).toBe(25 * 60 - 62)
    expect(resumed.timer.startedAt).toBe(T0)
  })

  test("a tick before the end only lowers the remainder", () => {
    const running = start(createFocusState(), T0)
    const { state, finished } = tick(running, T0 + 5000)
    expect(finished).toBeNull()
    expect(state.timer.remainingSeconds).toBe(25 * 60 - 5)
    expect(state.timer.mode).toBe("focus")
    expect(elapsedPercent(state.timer, T0 + 5000)).toBe(0.3)
  })

  test("finishing a focus block logs it, credits the active task and waits on a short break", () => {
    const withTask = addTask(createFocusState(), "Write release notes", "2").state
    const { state, finished } = runBlock(withTask, T0)
    expect(finished?.outcome).toBe("completed")
    expect(finished?.taskTitle).toBe("Write release notes")
    expect(finished?.seconds).toBe(25 * 60)
    expect(state.timer.mode).toBe("short")
    expect(state.timer.status).toBe("idle")
    expect(state.timer.cycleFocusBlocks).toBe(1)
    expect(state.tasks[0]?.completedBlocks).toBe(1)
  })

  test("auto-start breaks starts the break at the moment the focus block ends", () => {
    const auto = applySettings(createFocusState(), { ...DEFAULT_SETTINGS, autoStartBreaks: true })
    const { state, endAt } = runBlock(auto, T0)
    expect(state.timer.mode).toBe("short")
    expect(state.timer.status).toBe("running")
    expect(remainingAt(state.timer, endAt + 60_000)).toBe(4 * 60)
  })

  test("a finished break returns to an idle focus block even with auto-start on", () => {
    const auto = applySettings(createFocusState(), { ...DEFAULT_SETTINGS, autoStartBreaks: true })
    const afterFocus = runBlock(auto, T0)
    const afterBreak = tick(afterFocus.state, afterFocus.endAt + 5 * MINUTE)
    expect(afterBreak.finished?.mode).toBe("short")
    expect(afterBreak.state.timer.mode).toBe("focus")
    expect(afterBreak.state.timer.status).toBe("idle")
  })

  test("every Nth completed focus block is followed by a long break, which resets the cycle", () => {
    let state = applySettings(createFocusState(), { ...DEFAULT_SETTINGS, longEvery: 3 })
    let at = T0
    const breaks: string[] = []
    for (let block = 0; block < 4; block += 1) {
      const focus = runBlock(state, at)
      breaks.push(focus.state.timer.mode)
      const rest = runBlock(focus.state, focus.endAt)
      state = rest.state
      at = rest.endAt
    }
    expect(breaks).toEqual(["short", "short", "long", "short"])
    expect(state.timer.cycleFocusBlocks).toBe(1)
  })
})

describe("skip and reset", () => {
  test("skipping a started focus block logs it as skipped without advancing the cycle", () => {
    const running = start(createFocusState(), T0)
    const { state, finished } = skip(running, T0 + 10 * MINUTE)
    expect(finished?.outcome).toBe("skipped")
    expect(finished?.seconds).toBe(10 * 60)
    expect(state.timer.mode).toBe("short")
    expect(state.timer.status).toBe("idle")
    expect(state.timer.cycleFocusBlocks).toBe(0)
  })

  test("skipping a block that never started logs nothing", () => {
    const { state, finished } = skip(createFocusState(), T0)
    expect(finished).toBeNull()
    expect(state.log).toHaveLength(0)
    expect(state.timer.mode).toBe("short")
  })

  test("skipping a break goes back to focus, and auto-start does not apply to skips", () => {
    const auto = applySettings(createFocusState(), { ...DEFAULT_SETTINGS, autoStartBreaks: true })
    const toBreak = skip(start(auto, T0), T0 + MINUTE)
    expect(toBreak.state.timer.status).toBe("idle")
    const back = skip(toBreak.state, T0 + 2 * MINUTE)
    expect(back.state.timer.mode).toBe("focus")
  })

  test("reset restores the full block, stops it and keeps the cycle", () => {
    const running = start({ ...createFocusState(), timer: { ...createFocusState().timer, cycleFocusBlocks: 2 } }, T0)
    const state = reset(tick(running, T0 + 3 * MINUTE).state)
    expect(state.timer.status).toBe("idle")
    expect(state.timer.remainingSeconds).toBe(25 * 60)
    expect(state.timer.startedAt).toBeNull()
    expect(state.timer.cycleFocusBlocks).toBe(2)
  })

  test("switching mode loads that mode's full duration", () => {
    const state = switchMode(start(createFocusState(), T0), "long")
    expect(state.timer.mode).toBe("long")
    expect(state.timer.status).toBe("idle")
    expect(state.timer.remainingSeconds).toBe(15 * 60)
  })
})

describe("settings", () => {
  test("values from the page are clamped and rounded, with the previous value for anything unreadable", () => {
    const settings = readSettings({ focusMinutes: 500, shortMinutes: "3", longMinutes: "abc", longEvery: 2.6, autoStartBreaks: "yes" }, DEFAULT_SETTINGS)
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, focusMinutes: 90, shortMinutes: 3, longEvery: 3 })
  })

  test("a picker's choice list reads as its first value", () => {
    const settings = readSettings({ focusMinutes: ["50"], shortMinutes: [], longEvery: ["6"], dailyGoalMinutes: ["200"] }, DEFAULT_SETTINGS)
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, focusMinutes: 50, longEvery: 6, dailyGoalMinutes: 200 })
  })

  test("new durations reload an idle block but leave a running one alone", () => {
    const idle = applySettings(createFocusState(), { ...DEFAULT_SETTINGS, focusMinutes: 50 })
    expect(idle.timer.remainingSeconds).toBe(50 * 60)
    const running = applySettings(start(createFocusState(), T0), { ...DEFAULT_SETTINGS, focusMinutes: 50 })
    expect(running.timer.blockSeconds).toBe(25 * 60)
    expect(running.settings.focusMinutes).toBe(50)
  })
})

describe("tasks", () => {
  test("adding validates the name, rejects duplicates and makes the first task active", () => {
    expect(addTask(createFocusState(), "  ", "1").error).toMatch(/Name the task/)
    const first = addTask(createFocusState(), "Review PR", "30")
    expect(first.state.tasks[0]?.estimate).toBe(12)
    expect(first.state.activeTaskId).toBe(first.state.tasks[0]?.id ?? "")
    expect(addTask(first.state, "review pr", "1").error).toMatch(/already/)
  })

  test("finishing or removing the active task moves focus to the next open task", () => {
    const one = addTask(createFocusState(), "A", "1").state
    const two = addTask(one, "B", "1").state
    const [a, b] = two.tasks
    if (!a || !b) throw new Error("tasks missing")
    const done = toggleTaskDone(two, a.id)
    expect(done.activeTaskId).toBe(b.id)
    expect(selectTask(done, a.id).activeTaskId).toBe(b.id)
    expect(removeTask(done, b.id).activeTaskId).toBeNull()
  })
})

describe("daily stats", () => {
  const entry = (endedAt: number, overrides: Partial<LogEntry> = {}): LogEntry => ({
    id: `log-${endedAt}`,
    mode: "focus",
    taskTitle: "",
    startedAt: endedAt - 25 * MINUTE,
    endedAt,
    seconds: 25 * 60,
    outcome: "completed",
    ...overrides,
  })
  const day = (offset: number) => new Date(2026, 9, 18 + offset, 10).getTime()

  test("counts today's completed focus only and the goal percentage", () => {
    const log = [entry(day(0)), entry(day(0) + MINUTE * 30), entry(day(0), { outcome: "skipped", seconds: 600 }), entry(day(0), { mode: "short" }), entry(day(-1))]
    const stats = dailyStats(log, day(0) + 3600_000, 100)
    expect(stats.focusMinutes).toBe(50)
    expect(stats.completedBlocks).toBe(2)
    expect(stats.goalPercent).toBe(50)
  })

  test("the streak counts consecutive days with completed focus ending today", () => {
    expect(dailyStats([entry(day(0)), entry(day(-1)), entry(day(-2)), entry(day(-4))], day(0), 100).streakDays).toBe(3)
    expect(dailyStats([entry(day(-1))], day(0), 100).streakDays).toBe(0)
  })

  test("the goal percentage caps at 100", () => {
    expect(dailyStats([entry(day(0)), entry(day(0))], day(0), 25).goalPercent).toBe(100)
  })
})

test("formatClock pads minutes and seconds", () => {
  expect(formatClock(25 * 60)).toBe("25:00")
  expect(formatClock(61)).toBe("01:01")
  expect(formatClock(-3)).toBe("00:00")
})
