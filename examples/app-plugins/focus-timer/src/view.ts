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
} from "./model"

export const CATALOG_ID = "https://claxedo.dev/a2ui/v0.9/catalog.json"
const VERSION = "v0.9"

type Context = Record<string, { path: string } | string>

function text(id: string, value: string | { path: string }, variant?: "h1" | "h2" | "h3" | "h4" | "h5" | "caption" | "body"): SurfaceComponent {
  return variant ? { id, component: "Text", text: value, variant } : { id, component: "Text", text: value }
}

function button(id: string, label: string | { path: string }, name: string, context?: Context, variant?: "primary" | "default" | "borderless"): SurfaceComponent[] {
  return [
    { id, component: "Button", child: `${id}-label`, action: { event: context ? { name, context } : { name } }, ...(variant ? { variant } : {}) },
    text(`${id}-label`, label),
  ]
}

const SETTINGS_CONTEXT: Context = { settings: { path: "/settings" } }

export function tasksBody(hasTasks: boolean): SurfaceComponent {
  return hasTasks
    ? { id: "tasks-body", component: "List", children: { componentId: "task-card", path: "/tasks" } }
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
          { key: "minutes", title: "Minutes" },
          { key: "outcome", title: "Outcome" },
        ],
        rows: { path: "/log" },
      }
    : { id: "log-body", component: "EmptyState", title: "No blocks yet", description: "Finished and skipped blocks are logged here." }
}

export function focusComponents(state: FocusState): SurfaceComponent[] {
  return [
    { id: "root", component: "Column", children: ["header", "timer-card", "sections"] },
    { id: "header", component: "Row", align: "center", children: ["header-icon", "header-title", "header-status", "header-mode"] },
    { id: "header-icon", component: "Icon", name: "notifications" },
    { ...text("header-title", "Focus timer", "h2"), weight: 1 },
    { id: "header-status", component: "Badge", text: { path: "/timer/status" } },
    { id: "header-mode", component: "Badge", text: { path: "/timer/mode" }, variant: "accent" },

    { id: "timer-card", component: "Card", child: "timer-column" },
    { id: "timer-column", component: "Column", align: "center", children: ["mode-row", "clock", "block-progress", "focus-on", "cycle", "controls"] },
    { id: "mode-row", component: "Row", align: "end", children: ["mode-picker", "switch-mode"] },
    {
      id: "mode-picker",
      component: "ChoicePicker",
      label: "Mode",
      variant: "mutuallyExclusive",
      displayStyle: "chips",
      options: MODES.map((mode) => ({ label: MODE_LABEL[mode], value: mode })),
      value: { path: "/modeChoice" },
    },
    ...button("switch-mode", "Switch mode", "switchMode", { mode: { path: "/modeChoice" }, ...SETTINGS_CONTEXT }, "borderless"),
    text("clock", { path: "/remaining/clock" }, "h1"),
    { id: "block-progress", component: "Progress", value: { path: "/remaining/percent" }, max: 100, label: { path: "/timer/blockLabel" } },
    text("focus-on", { path: "/timer/focusOn" }, "body"),
    text("cycle", { path: "/timer/cycle" }, "caption"),
    { id: "controls", component: "Row", justify: "center", children: ["start", "pause", "skip", "reset"] },
    ...button("start", "Start", "start", SETTINGS_CONTEXT, "primary"),
    ...button("pause", "Pause", "pause"),
    ...button("skip", "Skip", "skip", SETTINGS_CONTEXT),
    ...button("reset", "Reset", "reset", SETTINGS_CONTEXT, "borderless"),

    {
      id: "sections",
      component: "Tabs",
      tabs: [
        { title: "Tasks", child: "tasks-tab" },
        { title: "Today", child: "today-tab" },
        { title: "Session log", child: "log-tab" },
        { title: "Settings", child: "settings-tab" },
      ],
    },

    { id: "tasks-tab", component: "Column", children: ["task-form", "tasks-body"] },
    { id: "task-form", component: "Row", align: "end", children: ["task-title", "task-estimate", "add-task"] },
    { id: "task-title", component: "TextField", label: "Task to focus on", value: { path: "/draft/title" }, weight: 3 },
    { id: "task-estimate", component: "TextField", label: "Estimate (blocks)", variant: "number", value: { path: "/draft/estimate" }, validationRegexp: "[0-9]{0,2}", weight: 1 },
    ...button("add-task", "Add task", "addTask", { title: { path: "/draft/title" }, estimate: { path: "/draft/estimate" } }, "primary"),
    tasksBody(state.tasks.length > 0),
    { id: "task-card", component: "Card", child: "task-row" },
    { id: "task-row", component: "Row", align: "center", children: ["task-text", "task-badge", "task-focus", "task-done", "task-remove"] },
    { id: "task-text", component: "Column", children: ["task-name", "task-progress"], weight: 1 },
    text("task-name", { path: "title" }, "h5"),
    text("task-progress", { path: "progress" }, "caption"),
    { id: "task-badge", component: "Badge", text: { path: "badge" } },
    ...button("task-focus", "Focus", "selectTask", { id: { path: "id" } }, "borderless"),
    ...button("task-done", { path: "doneLabel" }, "toggleTask", { id: { path: "id" } }, "borderless"),
    ...button("task-remove", "Remove", "removeTask", { id: { path: "id" }, title: { path: "title" } }, "borderless"),

    { id: "today-tab", component: "Column", children: ["stats-row", "goal-progress", "goal-slider", "set-goal"] },
    { id: "stats-row", component: "Row", children: ["stat-minutes", "stat-blocks", "stat-streak"] },
    ...statCard("stat-minutes", "/stats/focusMinutes", "Focus minutes today"),
    ...statCard("stat-blocks", "/stats/completedBlocks", "Completed blocks"),
    ...statCard("stat-streak", "/stats/streak", "Day streak"),
    { id: "goal-progress", component: "Progress", value: { path: "/stats/goalPercent" }, max: 100, label: { path: "/stats/goalLabel" } },
    { id: "goal-slider", component: "Slider", label: "Daily goal (minutes)", min: 25, max: 480, step: 25, value: { path: "/settings/dailyGoalMinutes" } },
    ...button("set-goal", "Set daily goal", "applySettings", SETTINGS_CONTEXT),

    { id: "log-tab", component: "Column", children: ["log-body"] },
    logBody(state.log.length > 0),

    { id: "settings-tab", component: "Column", children: ["focus-slider", "short-slider", "long-slider", "every-slider", "auto-breaks", "settings-divider", "apply-settings"] },
    { id: "focus-slider", component: "Slider", label: "Focus (minutes)", min: 5, max: 90, step: 5, value: { path: "/settings/focusMinutes" } },
    { id: "short-slider", component: "Slider", label: "Short break (minutes)", min: 1, max: 30, value: { path: "/settings/shortMinutes" } },
    { id: "long-slider", component: "Slider", label: "Long break (minutes)", min: 5, max: 60, step: 5, value: { path: "/settings/longMinutes" } },
    { id: "every-slider", component: "Slider", label: "Long break every (focus blocks)", min: 2, max: 8, value: { path: "/settings/longEvery" } },
    { id: "auto-breaks", component: "Switch", label: "Auto-start breaks", value: { path: "/settings/autoStartBreaks" } },
    { id: "settings-divider", component: "Divider" },
    ...button("apply-settings", "Apply settings", "applySettings", SETTINGS_CONTEXT, "primary"),
  ]
}

function statCard(id: string, path: string, caption: string): SurfaceComponent[] {
  return [
    { id, component: "Card", child: `${id}-column`, weight: 1 },
    { id: `${id}-column`, component: "Column", children: [`${id}-value`, `${id}-caption`] },
    text(`${id}-value`, { path }, "h3"),
    text(`${id}-caption`, caption, "caption"),
  ]
}

export function remainingData(state: FocusState, now: number) {
  return { clock: formatClock(remainingAt(state.timer, now)), percent: elapsedPercent(state.timer, now) }
}

export function timerData(state: FocusState) {
  const { timer, settings } = state
  const task = activeTaskTitle(state)
  const status = timer.status === "running" ? "Running" : timer.status === "paused" ? "Paused" : "Ready"
  return {
    status,
    mode: MODE_LABEL[timer.mode],
    blockLabel: `${MODE_LABEL[timer.mode]} · ${formatClock(timer.blockSeconds)}`,
    focusOn: timer.mode === "focus" ? (task ? `Focusing on: ${task}` : "Pick a task to focus on") : "Take a break",
    cycle: `${timer.cycleFocusBlocks} of ${settings.longEvery} focus blocks before a long break`,
  }
}

export function tasksData(state: FocusState) {
  return state.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    progress: `${task.completedBlocks} of ${task.estimate} blocks`,
    badge: task.done ? "Done" : task.id === state.activeTaskId ? "Active" : task.completedBlocks > task.estimate ? "Over estimate" : "Queued",
    doneLabel: task.done ? "Reopen" : "Done",
  }))
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
    focusMinutes: String(stats.focusMinutes),
    completedBlocks: String(stats.completedBlocks),
    streak: String(stats.streakDays),
    goalPercent: stats.goalPercent,
    goalLabel: `${stats.focusMinutes} of ${state.settings.dailyGoalMinutes} minutes (${stats.goalPercent}%)`,
  }
}

export function focusData(state: FocusState, now: number) {
  return {
    remaining: remainingData(state, now),
    timer: timerData(state),
    modeChoice: [state.timer.mode],
    settings: state.settings,
    draft: { title: "", estimate: "1" },
    tasks: tasksData(state),
    log: logData(state),
    stats: statsData(state, now),
  }
}

export function patch(surfaceId: string, path: string, value: SurfaceDataValue): SurfaceMessage {
  return { version: VERSION, updateDataModel: { surfaceId, path, value } }
}

type SurfaceDataValue = Extract<SurfaceMessage, { updateDataModel: unknown }>["updateDataModel"]["value"]

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
