import type { SurfaceComponent, SurfaceMessage } from "@claxedo/plugin-api"
import {
  activeTaskTitle,
  dailyStats,
  elapsedPercent,
  formatClock,
  MODE_LABEL,
  MODES,
  remainingAt,
  type FocusState,
  type Settings,
} from "./model"

export const CATALOG_ID = "https://claxedo.dev/a2ui/v0.9/catalog.json"
const VERSION = "v0.9"

type Binding = { path: string }
type Context = Record<string, Binding | string>
type ButtonOptions = { variant?: "primary" | "default" | "borderless"; icon?: Extract<SurfaceComponent, { component: "Button" }>["icon"] }

export type Notice = { title: string; text: string }

type ChoiceSetting = Exclude<keyof Settings, "autoStartBreaks">

const SETTING_CHOICES: Record<ChoiceSetting, { label: string; unit: string; values: readonly number[] }> = {
  focusMinutes: { label: "Focus length", unit: "minute", values: [15, 20, 25, 30, 45, 50, 60, 90] },
  shortMinutes: { label: "Short break", unit: "minute", values: [3, 5, 10, 15] },
  longMinutes: { label: "Long break", unit: "minute", values: [10, 15, 20, 30] },
  longEvery: { label: "Long break after", unit: "focus block", values: [2, 3, 4, 5, 6, 8] },
  dailyGoalMinutes: { label: "Daily goal", unit: "minute", values: [50, 100, 150, 200, 250, 300, 400] },
}

const SETTING_KEYS: readonly ChoiceSetting[] = ["focusMinutes", "shortMinutes", "longMinutes", "longEvery", "dailyGoalMinutes"]

function text(id: string, value: string | Binding, variant?: "caption" | "body"): SurfaceComponent {
  return variant ? { id, component: "Text", text: value, variant } : { id, component: "Text", text: value }
}

function button(id: string, label: string | Binding, name: string, context?: Context, options: ButtonOptions = {}): SurfaceComponent[] {
  return [{ id, component: "Button", child: `${id}-label`, action: { event: context ? { name, context } : { name } }, ...options }, text(`${id}-label`, label)]
}

function stat(id: string, label: string, key: string): SurfaceComponent {
  return { id, component: "Stat", label, value: { path: `/stats/${key}/value` }, caption: { path: `/stats/${key}/caption` } }
}

function settingPicker(key: ChoiceSetting): SurfaceComponent {
  const { label, unit, values } = SETTING_CHOICES[key]
  return {
    id: `setting-${key}`,
    component: "ChoicePicker",
    label,
    variant: "mutuallyExclusive",
    displayStyle: "dropdown",
    options: values.map((value) => ({ label: `${value} ${unit}${value === 1 ? "" : "s"}`, value: String(value) })),
    value: { path: `/settings/${key}` },
  }
}

const SETTINGS_CONTEXT: Context = { settings: { path: "/settings" } }

export function tasksBody(hasTasks: boolean): SurfaceComponent {
  return hasTasks
    ? { id: "tasks-body", component: "List", children: { componentId: "task-row", path: "/tasks" } }
    : { id: "tasks-body", component: "EmptyState", title: "No tasks yet", description: "Add what you want to focus on, with an estimate in focus blocks." }
}

export function logBody(hasEntries: boolean): SurfaceComponent {
  return hasEntries
    ? {
        id: "log-body",
        component: "Table",
        columns: [
          { key: "time", title: "Started" },
          { key: "mode", title: "Block" },
          { key: "task", title: "Task" },
          { key: "minutes", title: "Length (min)" },
          { key: "outcome", title: "Outcome" },
        ],
        rows: { path: "/log" },
      }
    : { id: "log-body", component: "EmptyState", title: "No blocks yet", description: "Finished and skipped blocks are logged here." }
}

export function taskFormBody(notice: boolean): SurfaceComponent {
  return { id: "task-form", component: "Column", children: ["task-fields", ...(notice ? ["task-notice"] : []), "task-footer"] }
}

export function noticeMessages(surfaceId: string, notice: Notice | null, wasShown: boolean): SurfaceMessage[] {
  if (!notice) return wasShown ? [components(surfaceId, [taskFormBody(false)])] : []
  const callout: SurfaceComponent = { id: "task-notice", component: "Callout", tone: "danger", title: { path: "/notice/title" }, text: { path: "/notice/text" } }
  return [patch(surfaceId, "/notice", notice), ...(wasShown ? [] : [components(surfaceId, [taskFormBody(true), callout])])]
}

export function focusComponents(state: FocusState): SurfaceComponent[] {
  return [
    { id: "root", component: "Column", children: ["header", "timer", "kpis", "tasks", "log", "settings"] },
    { id: "header", component: "Header", title: "Focus timer", subtitle: { path: "/timer/subtitle" }, badges: ["header-status", "header-mode"] },
    { id: "header-status", component: "Badge", text: { path: "/timer/status" }, variant: { path: "/timer/statusTone" } },
    { id: "header-mode", component: "Badge", text: { path: "/timer/mode" }, variant: "accent" },

    { id: "timer", component: "Section", title: { path: "/timer/blockTitle" }, description: { path: "/timer/focusOn" }, child: "timer-body" },
    { id: "timer-body", component: "Column", children: ["clock", "block-progress", "mode-picker", "controls"] },
    { id: "clock", component: "Stat", label: "Time left", value: { path: "/remaining/clock" }, caption: { path: "/timer/cycle" } },
    { id: "block-progress", component: "Progress", value: { path: "/remaining/percent" }, max: 100, label: { path: "/timer/blockLabel" } },
    {
      id: "mode-picker",
      component: "ChoicePicker",
      label: "Mode",
      variant: "mutuallyExclusive",
      displayStyle: "chips",
      options: MODES.map((mode) => ({ label: MODE_LABEL[mode], value: mode })),
      value: { path: "/modeChoice" },
    },
    { id: "controls", component: "Footer", start: ["switch-mode", "reset"], end: ["skip", "pause", "start"] },
    ...button("switch-mode", "Switch mode", "switchMode", { mode: { path: "/modeChoice" }, ...SETTINGS_CONTEXT }, { variant: "borderless" }),
    ...button("reset", "Reset", "reset", SETTINGS_CONTEXT, { variant: "borderless", icon: "refresh" }),
    ...button("skip", "Skip", "skip", SETTINGS_CONTEXT, { icon: "skipNext" }),
    ...button("pause", "Pause", "pause", undefined, { icon: "pause" }),
    ...button("start", "Start", "start", SETTINGS_CONTEXT, { variant: "primary", icon: "play" }),

    { id: "kpis", component: "Grid", columns: 3, children: ["stat-minutes", "stat-blocks", "stat-streak"] },
    stat("stat-minutes", "Focus today", "minutes"),
    stat("stat-blocks", "Completed blocks", "blocks"),
    stat("stat-streak", "Streak", "streak"),

    { id: "tasks", component: "Section", title: "Tasks", description: "The active task is credited for each completed focus block.", child: "tasks-column" },
    { id: "tasks-column", component: "Column", children: ["tasks-body", "task-form"] },
    tasksBody(state.tasks.length > 0),
    { id: "task-row", component: "ListItem", title: { path: "title" }, subtitle: { path: "progress" }, selected: { path: "active" }, meta: ["task-badge"], primaryAction: "task-done", actions: ["task-focus", "task-remove"] },
    { id: "task-badge", component: "Badge", text: { path: "badge" }, variant: { path: "tone" } },
    ...button("task-done", { path: "doneLabel" }, "toggleTask", { id: { path: "id" } }),
    ...button("task-focus", "Focus on this task", "selectTask", { id: { path: "id" } }, { icon: "visibility" }),
    ...button("task-remove", "Remove task", "removeTask", { id: { path: "id" }, title: { path: "title" } }, { icon: "delete" }),
    taskFormBody(false),
    { id: "task-fields", component: "Grid", columns: 2, children: ["task-title", "task-estimate"] },
    { id: "task-title", component: "TextField", label: "Task to focus on", value: { path: "/draft/title" } },
    { id: "task-estimate", component: "TextField", label: "Estimate (blocks)", variant: "number", value: { path: "/draft/estimate" }, validationRegexp: "[0-9]{0,2}" },
    { id: "task-footer", component: "Footer", end: ["add-task"] },
    ...button("add-task", "Add task", "addTask", { title: { path: "/draft/title" }, estimate: { path: "/draft/estimate" } }, { icon: "add" }),

    { id: "log", component: "Section", title: "Session log", description: "Newest first", child: "log-body" },
    logBody(state.log.length > 0),

    { id: "settings", component: "Collapsible", title: "Timer settings", child: "settings-body" },
    { id: "settings-body", component: "Column", children: ["settings-fields", "auto-breaks", "settings-footer"] },
    { id: "settings-fields", component: "Grid", columns: 2, children: SETTING_KEYS.map((key) => `setting-${key}`) },
    ...SETTING_KEYS.map(settingPicker),
    { id: "auto-breaks", component: "Switch", label: "Start breaks automatically", value: { path: "/settings/autoStartBreaks" } },
    { id: "settings-footer", component: "Footer", end: ["apply-settings"] },
    ...button("apply-settings", "Apply settings", "applySettings", SETTINGS_CONTEXT, { icon: "check" }),
  ]
}

export function remainingData(state: FocusState, now: number) {
  return { clock: formatClock(remainingAt(state.timer, now)), percent: elapsedPercent(state.timer, now) }
}

const STATUS = { running: ["Running", "success"], paused: ["Paused", "warning"], idle: ["Ready", "neutral"] } as const

export function timerData(state: FocusState) {
  const { timer, settings } = state
  const task = activeTaskTitle(state)
  const [status, statusTone] = STATUS[timer.status]
  const minutes = Math.round(timer.blockSeconds / 60)
  return {
    status,
    statusTone,
    mode: MODE_LABEL[timer.mode],
    subtitle: `${settings.focusMinutes} min focus · ${settings.shortMinutes} min short break · ${settings.longMinutes} min long break`,
    blockTitle: timer.mode === "focus" ? "Focus block" : MODE_LABEL[timer.mode],
    blockLabel: `${minutes} minute ${MODE_LABEL[timer.mode].toLowerCase()} block`,
    focusOn: timer.mode === "focus" ? (task ? `Focusing on: ${task}` : "Pick a task to focus on") : "Take a break",
    cycle: `${timer.cycleFocusBlocks} of ${settings.longEvery} focus blocks before a long break`,
  }
}

const TASK_TONE: Record<string, string> = { Done: "success", Active: "accent", "Over estimate": "warning", Queued: "neutral" }

export function tasksData(state: FocusState) {
  return state.tasks.map((task) => {
    const badge = task.done ? "Done" : task.id === state.activeTaskId ? "Active" : task.completedBlocks > task.estimate ? "Over estimate" : "Queued"
    return {
      id: task.id,
      title: task.title,
      progress: `${task.completedBlocks} of ${task.estimate} block${task.estimate === 1 ? "" : "s"} done`,
      badge,
      tone: TASK_TONE[badge] ?? "neutral",
      active: task.id === state.activeTaskId,
      doneLabel: task.done ? "Reopen" : "Done",
    }
  })
}

function clockTime(time: number): string {
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

export function logData(state: FocusState) {
  return [...state.log].reverse().map((entry) => ({
    time: clockTime(entry.startedAt),
    mode: MODE_LABEL[entry.mode],
    task: entry.taskTitle || "—",
    minutes: Math.round((entry.seconds / 60) * 10) / 10,
    outcome: entry.outcome === "completed" ? "Completed" : "Skipped",
  }))
}

export function statsData(state: FocusState, now: number) {
  const stats = dailyStats(state.log, now, state.settings.dailyGoalMinutes)
  return {
    minutes: { value: `${stats.focusMinutes} min`, caption: `${stats.goalPercent}% of the ${state.settings.dailyGoalMinutes} minute goal` },
    blocks: { value: String(stats.completedBlocks), caption: "Completed focus blocks today" },
    streak: { value: `${stats.streakDays} day${stats.streakDays === 1 ? "" : "s"}`, caption: "In a row with a completed block" },
  }
}

export function settingsData(settings: Settings) {
  return {
    focusMinutes: [String(settings.focusMinutes)],
    shortMinutes: [String(settings.shortMinutes)],
    longMinutes: [String(settings.longMinutes)],
    longEvery: [String(settings.longEvery)],
    dailyGoalMinutes: [String(settings.dailyGoalMinutes)],
    autoStartBreaks: settings.autoStartBreaks,
  }
}

export function focusData(state: FocusState, now: number) {
  return {
    remaining: remainingData(state, now),
    timer: timerData(state),
    modeChoice: [state.timer.mode],
    settings: settingsData(state.settings),
    draft: { title: "", estimate: "1" },
    tasks: tasksData(state),
    log: logData(state),
    stats: statsData(state, now),
    notice: { title: "", text: "" },
  }
}

type SurfaceDataValue = Extract<SurfaceMessage, { updateDataModel: unknown }>["updateDataModel"]["value"]

export function patch(surfaceId: string, path: string, value: SurfaceDataValue): SurfaceMessage {
  return { version: VERSION, updateDataModel: { surfaceId, path, value } }
}

export function components(surfaceId: string, list: SurfaceComponent[]): SurfaceMessage {
  return { version: VERSION, updateComponents: { surfaceId, components: list } }
}

export function openMessages(surfaceId: string, state: FocusState, now: number): SurfaceMessage[] {
  return [
    { version: VERSION, createSurface: { surfaceId, catalogId: CATALOG_ID } },
    components(surfaceId, focusComponents(state)),
    patch(surfaceId, "/", focusData(state, now)),
  ]
}

export function stateMessages(surfaceId: string, state: FocusState, now: number): SurfaceMessage[] {
  return [
    patch(surfaceId, "/remaining", remainingData(state, now)),
    patch(surfaceId, "/timer", timerData(state)),
    patch(surfaceId, "/modeChoice", [state.timer.mode]),
    patch(surfaceId, "/tasks", tasksData(state)),
    patch(surfaceId, "/log", logData(state)),
    patch(surfaceId, "/stats", statsData(state, now)),
  ]
}
