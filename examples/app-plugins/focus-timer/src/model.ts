export type Mode = "focus" | "short" | "long"
export type TimerStatus = "idle" | "running" | "paused"
export type Outcome = "completed" | "skipped"

export const MODES: readonly Mode[] = ["focus", "short", "long"]

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value)
}

export const MODE_LABEL: Record<Mode, string> = { focus: "Focus", short: "Short break", long: "Long break" }

export type Settings = {
  focusMinutes: number
  shortMinutes: number
  longMinutes: number
  longEvery: number
  dailyGoalMinutes: number
  autoStartBreaks: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  focusMinutes: 25,
  shortMinutes: 5,
  longMinutes: 15,
  longEvery: 4,
  dailyGoalMinutes: 100,
  autoStartBreaks: false,
}

const SETTING_RANGES: Record<Exclude<keyof Settings, "autoStartBreaks">, readonly [number, number]> = {
  focusMinutes: [1, 90],
  shortMinutes: [1, 30],
  longMinutes: [1, 60],
  longEvery: [2, 8],
  dailyGoalMinutes: [25, 480],
}

export type Task = { id: string; title: string; estimate: number; completedBlocks: number; done: boolean }

export type LogEntry = {
  id: string
  mode: Mode
  taskTitle: string
  startedAt: number
  endedAt: number
  seconds: number
  outcome: Outcome
}

export type Timer = {
  mode: Mode
  status: TimerStatus
  blockSeconds: number
  remainingSeconds: number
  endsAt: number | null
  startedAt: number | null
  cycleFocusBlocks: number
}

export type FocusState = {
  settings: Settings
  timer: Timer
  tasks: Task[]
  activeTaskId: string | null
  log: LogEntry[]
  nextId: number
}

export type Change = { state: FocusState; error?: string }
export type TickResult = { state: FocusState; finished: LogEntry | null }

export function durationSeconds(settings: Settings, mode: Mode): number {
  const minutes = mode === "focus" ? settings.focusMinutes : mode === "short" ? settings.shortMinutes : settings.longMinutes
  return minutes * 60
}

function freshTimer(settings: Settings, mode: Mode, cycleFocusBlocks: number): Timer {
  const blockSeconds = durationSeconds(settings, mode)
  return { mode, status: "idle", blockSeconds, remainingSeconds: blockSeconds, endsAt: null, startedAt: null, cycleFocusBlocks }
}

export function createFocusState(settings: Settings = DEFAULT_SETTINGS): FocusState {
  return { settings, timer: freshTimer(settings, "focus", 0), tasks: [], activeTaskId: null, log: [], nextId: 1 }
}

export function remainingAt(timer: Timer, now: number): number {
  if (timer.status !== "running" || timer.endsAt === null) return timer.remainingSeconds
  return Math.max(0, Math.ceil((timer.endsAt - now) / 1000))
}

export function elapsedPercent(timer: Timer, now: number): number {
  return Math.round(((timer.blockSeconds - remainingAt(timer, now)) / timer.blockSeconds) * 1000) / 10
}

export function start(state: FocusState, now: number): FocusState {
  const { timer } = state
  if (timer.status === "running") return state
  return {
    ...state,
    timer: { ...timer, status: "running", endsAt: now + timer.remainingSeconds * 1000, startedAt: timer.startedAt ?? now },
  }
}

export function pause(state: FocusState, now: number): FocusState {
  const { timer } = state
  if (timer.status !== "running") return state
  return { ...state, timer: { ...timer, status: "paused", remainingSeconds: remainingAt(timer, now), endsAt: null } }
}

export function toggle(state: FocusState, now: number): FocusState {
  return state.timer.status === "running" ? pause(state, now) : start(state, now)
}

function activeTask(state: FocusState): Task | undefined {
  return state.tasks.find((task) => task.id === state.activeTaskId)
}

function breakAfter(cycleFocusBlocks: number, longEvery: number): Mode {
  return cycleFocusBlocks >= longEvery ? "long" : "short"
}

function finishBlock(state: FocusState, now: number, outcome: Outcome): TickResult {
  const { timer, settings } = state
  const task = activeTask(state)
  const seconds = timer.blockSeconds - remainingAt(timer, now)
  const finished: LogEntry | null =
    timer.startedAt === null
      ? null
      : {
          id: `log-${state.nextId}`,
          mode: timer.mode,
          taskTitle: timer.mode === "focus" ? (task?.title ?? "") : "",
          startedAt: timer.startedAt,
          endedAt: now,
          seconds,
          outcome,
        }
  const countsFocus = timer.mode === "focus" && outcome === "completed"
  const cycle = countsFocus ? timer.cycleFocusBlocks + 1 : timer.cycleFocusBlocks
  const nextMode: Mode = timer.mode === "focus" ? (outcome === "completed" ? breakAfter(cycle, settings.longEvery) : "short") : "focus"
  const nextTimer = freshTimer(settings, nextMode, timer.mode === "long" ? 0 : cycle)
  const autoStart = nextMode !== "focus" && outcome === "completed" && settings.autoStartBreaks
  const tasks = countsFocus && task
    ? state.tasks.map((item) => (item.id === task.id ? { ...item, completedBlocks: item.completedBlocks + 1 } : item))
    : state.tasks
  const next: FocusState = {
    ...state,
    tasks,
    timer: autoStart ? { ...nextTimer, status: "running", endsAt: now + nextTimer.blockSeconds * 1000, startedAt: now } : nextTimer,
    log: finished ? [...state.log, finished] : state.log,
    nextId: finished ? state.nextId + 1 : state.nextId,
  }
  return { state: next, finished }
}

export function tick(state: FocusState, now: number): TickResult {
  if (state.timer.status !== "running") return { state, finished: null }
  const remaining = remainingAt(state.timer, now)
  if (remaining > 0) return { state: { ...state, timer: { ...state.timer, remainingSeconds: remaining } }, finished: null }
  return finishBlock(state, now, "completed")
}

export function skip(state: FocusState, now: number): TickResult {
  return finishBlock(state, now, "skipped")
}

export function reset(state: FocusState): FocusState {
  return { ...state, timer: freshTimer(state.settings, state.timer.mode, state.timer.cycleFocusBlocks) }
}

export function switchMode(state: FocusState, mode: Mode): FocusState {
  return { ...state, timer: freshTimer(state.settings, mode, state.timer.cycleFocusBlocks) }
}

function clamp(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  const raw = Array.isArray(value) ? value[0] : value
  const number = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function readSettings(raw: unknown, fallback: Settings): Settings {
  const source = isRecord(raw) ? raw : {}
  return {
    focusMinutes: clamp(source.focusMinutes, SETTING_RANGES.focusMinutes, fallback.focusMinutes),
    shortMinutes: clamp(source.shortMinutes, SETTING_RANGES.shortMinutes, fallback.shortMinutes),
    longMinutes: clamp(source.longMinutes, SETTING_RANGES.longMinutes, fallback.longMinutes),
    longEvery: clamp(source.longEvery, SETTING_RANGES.longEvery, fallback.longEvery),
    dailyGoalMinutes: clamp(source.dailyGoalMinutes, SETTING_RANGES.dailyGoalMinutes, fallback.dailyGoalMinutes),
    autoStartBreaks: typeof source.autoStartBreaks === "boolean" ? source.autoStartBreaks : fallback.autoStartBreaks,
  }
}

export function applySettings(state: FocusState, settings: Settings): FocusState {
  const next = { ...state, settings }
  return state.timer.status === "idle" ? { ...next, timer: freshTimer(settings, state.timer.mode, state.timer.cycleFocusBlocks) } : next
}

export function addTask(state: FocusState, title: string, estimate: unknown): Change {
  const name = title.trim()
  if (!name) return { state, error: "Name the task first." }
  if (state.tasks.some((task) => task.title.toLowerCase() === name.toLowerCase())) return { state, error: `"${name}" is already on the list.` }
  const task: Task = { id: `task-${state.nextId}`, title: name, estimate: clamp(estimate, [1, 12], 1), completedBlocks: 0, done: false }
  return {
    state: { ...state, tasks: [...state.tasks, task], activeTaskId: state.activeTaskId ?? task.id, nextId: state.nextId + 1 },
  }
}

export function selectTask(state: FocusState, id: string): FocusState {
  return state.tasks.some((task) => task.id === id && !task.done) ? { ...state, activeTaskId: id } : state
}

export function toggleTaskDone(state: FocusState, id: string): FocusState {
  const tasks = state.tasks.map((task) => (task.id === id ? { ...task, done: !task.done } : task))
  const nowDone = tasks.find((task) => task.id === id)?.done === true
  const activeTaskId = nowDone && state.activeTaskId === id ? (tasks.find((task) => !task.done)?.id ?? null) : state.activeTaskId
  return { ...state, tasks, activeTaskId }
}

export function removeTask(state: FocusState, id: string): FocusState {
  const tasks = state.tasks.filter((task) => task.id !== id)
  const activeTaskId = state.activeTaskId === id ? (tasks.find((task) => !task.done)?.id ?? null) : state.activeTaskId
  return { ...state, tasks, activeTaskId }
}

export function activeTaskTitle(state: FocusState): string | null {
  return activeTask(state)?.title ?? null
}

export type DailyStats = { focusMinutes: number; completedBlocks: number; streakDays: number; goalPercent: number }

function dayKey(time: number): string {
  return new Date(time).toDateString()
}

function previousDay(time: number): number {
  const date = new Date(time)
  date.setDate(date.getDate() - 1)
  return date.getTime()
}

export function dailyStats(log: readonly LogEntry[], now: number, goalMinutes: number): DailyStats {
  const focus = log.filter((entry) => entry.mode === "focus" && entry.outcome === "completed")
  const today = focus.filter((entry) => dayKey(entry.endedAt) === dayKey(now))
  const focusMinutes = Math.floor(today.reduce((sum, entry) => sum + entry.seconds, 0) / 60)
  const days = new Set(focus.map((entry) => dayKey(entry.endedAt)))
  let streakDays = 0
  for (let day = now; days.has(dayKey(day)); day = previousDay(day)) streakDays += 1
  return {
    focusMinutes,
    completedBlocks: today.length,
    streakDays,
    goalPercent: Math.min(100, Math.round((focusMinutes / goalMinutes) * 100)),
  }
}

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`
}
