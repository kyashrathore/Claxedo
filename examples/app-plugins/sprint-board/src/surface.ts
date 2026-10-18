import type { SurfaceComponent, SurfaceMessage } from "@claxedo/plugin-api"
import {
  COLUMNS,
  addDays,
  PRIORITIES,
  STORY_POINTS,
  TEAM,
  burndown,
  columnTitle,
  daysBetween,
  dueStatus,
  filterByOwners,
  ownerName,
  priorityLabel,
  priorityTone,
  sprintDay,
  sprintHealth,
  sprintProgress,
  wipLabel,
  wipStatus,
  wipTone,
  type Board,
  type ColumnId,
  type Task,
} from "./model"

export const SURFACE_CATALOG_ID = "https://claxedo.dev/a2ui/v0.9/catalog.json"
const VERSION = "v0.9" as const

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export type Notice = { readonly title: string; readonly text: string }

export const NO_NOTICE: Notice = { title: "", text: "" }

function when<Item extends Json>(condition: boolean, item: Item): Item[] {
  return condition ? [item] : []
}

function label(id: string, text: string): SurfaceComponent {
  return { id, component: "Text", text }
}

export function rootComponent(notice: boolean): SurfaceComponent {
  return { id: "root", component: "Column", children: ["header", ...(notice ? ["notice"] : []), "kpis", "filter", "compose", "board", "burndown"] }
}

export function composeBody(error: boolean): SurfaceComponent {
  return { id: "compose-body", component: "Column", children: ["compose-fields", "draft-priority", "draft-description", "compose-hint", ...(error ? ["compose-error"] : []), "compose-footer"] }
}

function stat(id: string, title: string, key: string): SurfaceComponent {
  return { id, component: "Stat", label: title, value: { path: `/kpis/${key}/value` }, caption: { path: `/kpis/${key}/caption` } }
}

export function sprintBoardComponents(composeOpen: boolean): SurfaceComponent[] {
  return [
    rootComponent(false),

    { id: "header", component: "Header", title: { path: "/header/title" }, subtitle: { path: "/header/subtitle" }, icon: "calendarToday", badges: ["header-health", "header-project"] },
    { id: "header-health", component: "Badge", text: { path: "/header/health/label" }, variant: { path: "/header/health/tone" } },
    { id: "header-project", component: "Badge", text: { path: "/header/project" } },

    { id: "kpis", component: "Grid", columns: 4, children: ["kpi-done", "kpi-remaining", "kpi-time", "kpi-session"] },
    stat("kpi-done", "Points done", "done"),
    stat("kpi-remaining", "Remaining", "remaining"),
    stat("kpi-time", "Time left", "time"),
    stat("kpi-session", "This session", "session"),

    { id: "notice", component: "Callout", tone: "warning", title: { path: "/notice/title" }, text: { path: "/notice/text" }, dismissible: true },

    { id: "filter", component: "Section", title: "Team", description: { path: "/filter/summary" }, actions: ["filter-clear", "filter-apply"], child: "filter-picker" },
    {
      id: "filter-picker",
      component: "ChoicePicker",
      label: "Filter by owner",
      variant: "multipleSelection",
      displayStyle: "chips",
      options: TEAM.map((owner) => ({ label: owner.name, value: owner.id })),
      value: { path: "/filter/owners" },
    },
    { id: "filter-clear", component: "Button", variant: "borderless", child: "filter-clear-label", action: { event: { name: "clearFilter" } } },
    label("filter-clear-label", "Show everyone"),
    { id: "filter-apply", component: "Button", icon: "search", child: "filter-apply-label", action: { event: { name: "applyFilter", context: { owners: { path: "/filter/owners" } } } } },
    label("filter-apply-label", "Apply filter"),

    { id: "compose", component: "Collapsible", title: "New task", open: composeOpen, child: "compose-body" },
    composeBody(false),
    { id: "compose-fields", component: "Grid", columns: 2, children: ["draft-title", "draft-owner", "draft-points", "draft-due"] },
    { id: "draft-title", component: "TextField", label: "Task title", value: { path: "/draft/title" } },
    {
      id: "draft-owner",
      component: "ChoicePicker",
      label: "Owner",
      variant: "mutuallyExclusive",
      displayStyle: "dropdown",
      options: TEAM.map((owner) => ({ label: owner.name, value: owner.id })),
      value: { path: "/draft/owner" },
    },
    {
      id: "draft-points",
      component: "ChoicePicker",
      label: "Story points",
      variant: "mutuallyExclusive",
      displayStyle: "dropdown",
      options: STORY_POINTS.map((points) => ({ label: `${points} pt${points === 1 ? "" : "s"}`, value: String(points) })),
      value: { path: "/draft/points" },
    },
    { id: "draft-due", component: "DateTimeInput", label: "Due date", enableDate: true, enableTime: false, min: { path: "/header/sprintStart" }, value: { path: "/draft/due" } },
    {
      id: "draft-priority",
      component: "ChoicePicker",
      label: "Priority",
      variant: "mutuallyExclusive",
      displayStyle: "chips",
      options: PRIORITIES.map((priority) => ({ label: priority.label, value: priority.id })),
      value: { path: "/draft/priority" },
    },
    { id: "draft-description", component: "TextField", label: "Description", variant: "longText", value: { path: "/draft/description" } },
    { id: "compose-hint", component: "Text", variant: "caption", text: "New tasks land in Backlog." },
    { id: "compose-error", component: "Callout", tone: "danger", title: { path: "/compose/error/title" }, text: { path: "/compose/error/text" } },
    { id: "compose-footer", component: "Footer", end: ["compose-submit"] },
    { id: "compose-submit", component: "Button", variant: "primary", icon: "add", child: "compose-submit-label", action: { event: { name: "addTask", context: { draft: { path: "/draft" } } } } },
    label("compose-submit-label", "Add task"),

    { id: "board", component: "Grid", columns: 4, children: { componentId: "lane", path: "/columns" } },
    { id: "lane", component: "Section", title: { path: "title" }, description: { path: "pointsLabel" }, child: "lane-body" },
    { id: "lane-wip", component: "Badge", text: { path: "wipLabel" }, variant: { path: "wipTone" } },
    { id: "lane-body", component: "Column", children: ["lane-status", "lane-empty", "lane-tasks", "lane-limit"] },
    { id: "lane-status", component: "Row", children: ["lane-wip"] },
    { id: "lane-empty", component: "List", children: { componentId: "lane-empty-state", path: "empty" } },
    { id: "lane-empty-state", component: "EmptyState", title: { path: "title" }, description: { path: "description" } },
    { id: "lane-tasks", component: "List", children: { componentId: "task", path: "tasks" } },
    { id: "lane-limit", component: "Collapsible", title: "WIP limit", child: "wip-body" },
    { id: "wip-body", component: "Column", children: ["wip-enforce", "wip-limit", "wip-footer"] },
    { id: "wip-enforce", component: "Switch", label: "Enforce WIP limit", value: { path: "wip/enforce" } },
    { id: "wip-limit", component: "TextField", label: "Limit", variant: "number", validationRegexp: "[0-9]{1,2}", value: { path: "wip/limit" } },
    { id: "wip-footer", component: "Footer", end: ["wip-save"] },
    {
      id: "wip-save",
      component: "Button",
      child: "wip-save-label",
      action: { event: { name: "saveWip", context: { column: { path: "id" }, enforce: { path: "wip/enforce" }, limit: { path: "wip/limit" } } } },
    },
    label("wip-save-label", "Save limit"),

    {
      id: "task",
      component: "ListItem",
      title: { path: "title" },
      subtitle: { path: "subtitle" },
      meta: ["task-due", "task-priority", "task-points"],
      primaryAction: "task-forward",
      actions: ["task-back", "task-delete"],
    },
    { id: "task-due", component: "Badge", text: { path: "due" }, variant: { path: "dueTone" } },
    { id: "task-priority", component: "Badge", text: { path: "priority" }, variant: { path: "priorityTone" } },
    { id: "task-points", component: "Badge", text: { path: "points" } },
    { id: "task-forward", component: "List", direction: "horizontal", children: { componentId: "task-forward-button", path: "forward" } },
    { id: "task-forward-button", component: "Button", child: "task-forward-label", action: { event: { name: "move", context: { id: { path: "id" }, step: 1 } } } },
    { id: "task-forward-label", component: "Text", text: { path: "label" } },
    { id: "task-back", component: "List", direction: "horizontal", children: { componentId: "task-back-button", path: "back" } },
    { id: "task-back-button", component: "Button", icon: "arrowBack", child: "task-back-label", action: { event: { name: "move", context: { id: { path: "id" }, step: -1 } } } },
    { id: "task-back-label", component: "Text", text: { path: "label" } },
    { id: "task-delete", component: "Button", icon: "delete", child: "task-delete-label", action: { event: { name: "delete", context: { id: { path: "id" } } } } },
    label("task-delete-label", "Delete task"),

    { id: "burndown", component: "Collapsible", title: "Burndown", child: "burndown-body" },
    { id: "burndown-body", component: "Column", children: ["burndown-summary", "burndown-table"] },
    { id: "burndown-summary", component: "Text", variant: "caption", text: { path: "/burndownSummary" } },
    {
      id: "burndown-table",
      component: "Table",
      columns: [
        { key: "day", title: "Day" },
        { key: "date", title: "Date" },
        { key: "ideal", title: "Ideal remaining (pts)" },
        { key: "remaining", title: "Actual remaining (pts)" },
        { key: "completed", title: "Completed (pts)" },
        { key: "trend", title: "Trend" },
      ],
      rows: { path: "/burndown" },
    },
  ]
}

export type ViewContext = {
  readonly today: string
  readonly owners: readonly string[]
  readonly projectName: string | undefined
  readonly session: { readonly added: number; readonly removed: number }
  readonly formatDate: (iso: string) => string
}

function advanceLabel(target: ColumnId): string {
  if (target === "done") return "Done"
  return target === "progress" ? "Start →" : `${columnTitle(target)} →`
}

function taskView(task: Task, context: ViewContext): Json {
  const index = COLUMNS.findIndex((column) => column.id === task.column)
  const previous = COLUMNS[index - 1]
  const next = COLUMNS[index + 1]
  const due = dueStatus(task, context.today)
  return {
    id: task.id,
    title: task.title,
    subtitle: `${task.id} · ${ownerName(task.owner)}`,
    due: task.due === "" ? due.label : task.column === "done" ? `Was due ${context.formatDate(task.due)}` : `${due.label} · ${context.formatDate(task.due)}`,
    dueTone: due.overdue ? "danger" : "neutral",
    priority: priorityLabel(task.priority),
    priorityTone: priorityTone(task.priority),
    points: `${task.points} pt${task.points === 1 ? "" : "s"}`,
    back: previous === undefined ? [] : [{ id: task.id, label: `Move back to ${previous.title}` }],
    forward: next === undefined ? [] : [{ id: task.id, label: advanceLabel(next.id) }],
  }
}

const COLUMN_DISPLAY_KEYS = ["title", "wipLabel", "wipTone", "pointsLabel", "empty", "tasks"] as const

export type ColumnDisplay = Readonly<Record<(typeof COLUMN_DISPLAY_KEYS)[number], Json>>

function columnDisplay(board: Board, column: ColumnId, context: ViewContext): ColumnDisplay {
  const all = board.tasks.filter((task) => task.column === column)
  const visible = filterByOwners(all, context.owners)
  const status = wipStatus(board, column)
  const points = visible.reduce((sum, task) => sum + task.points, 0)
  const hidden = all.length - visible.length
  return {
    title: columnTitle(column),
    wipLabel: wipLabel(status),
    wipTone: wipTone(status),
    pointsLabel: `${visible.length} task${visible.length === 1 ? "" : "s"} · ${points} pts${hidden > 0 ? ` · ${hidden} hidden by filter` : ""}`,
    empty: when(visible.length === 0, {
      title: all.length === 0 ? "No tasks" : "No tasks for this filter",
      description: all.length === 0 ? `Move a task into ${columnTitle(column)}.` : `${hidden} task${hidden === 1 ? "" : "s"} hidden by the owner filter.`,
    }),
    tasks: visible.map((task) => taskView(task, context)),
  }
}

export type BoardDisplay = {
  readonly header: Json
  readonly kpis: Json
  readonly summary: string
  readonly burndown: Json
  readonly burndownSummary: string
  readonly columns: readonly ColumnDisplay[]
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

export function boardDisplay(board: Board, context: ViewContext): BoardDisplay {
  const progress = sprintProgress(board)
  const shown = filterByOwners(board.tasks, context.owners).length
  const days = burndown(board, context.today)
  const health = sprintHealth(days)
  const end = addDays(board.sprint.start, board.sprint.days - 1)
  const left = Math.max(0, daysBetween(context.today, end) + 1)
  return {
    header: {
      title: board.sprint.name,
      subtitle: board.sprint.goal,
      health: { label: health.label, tone: health.tone },
      project: context.projectName ?? "No project selected",
      sprintStart: board.sprint.start,
    },
    kpis: {
      done: { value: `${progress.percent}%`, caption: `${progress.done} of ${progress.total} points done (${progress.percent}%)` },
      remaining: {
        value: `${progress.total - progress.done} pts`,
        caption: health.day ? `Ideal line on day ${health.day.day}: ${health.day.ideal} pts` : "The sprint has not started",
      },
      time: { value: plural(left, "day"), caption: `Day ${sprintDay(board.sprint, context.today)} of ${board.sprint.days} · ends ${context.formatDate(end)}` },
      session: { value: `${context.session.added} added`, caption: `${context.session.removed} deleted on this page` },
    },
    summary:
      context.owners.length === 0
        ? `Showing all ${board.tasks.length} tasks`
        : `Showing ${shown} of ${board.tasks.length} tasks for ${context.owners.map(ownerName).join(", ")}`,
    burndown: days.map((day) => ({
      day: `Day ${day.day}`,
      date: context.formatDate(day.date),
      ideal: day.ideal,
      remaining: day.remaining ?? null,
      completed: day.completed,
      trend: day.remaining === undefined ? "" : day.remaining > day.ideal ? "Behind" : "On track",
    })),
    burndownSummary: health.day
      ? `${health.day.remaining} points remain on day ${health.day.day}; the ideal line is ${health.day.ideal}. Scope counts every task currently on the board.`
      : "The sprint has not started yet.",
    columns: COLUMNS.map((column) => columnDisplay(board, column.id, context)),
  }
}

export function emptyDraft(today: string): Record<string, Json> {
  return { title: "", description: "", owner: [], priority: ["medium"], points: ["3"], due: today }
}

export function wipData(board: Board, column: ColumnId): Json {
  return { enforce: board.wip[column].enforce, limit: String(board.wip[column].limit) }
}

export function initialData(board: Board, display: BoardDisplay, owners: readonly string[], today: string): Record<string, Json> {
  return {
    header: display.header,
    kpis: display.kpis,
    notice: NO_NOTICE,
    filter: { owners: [...owners], summary: display.summary },
    draft: emptyDraft(today),
    compose: { error: NO_NOTICE },
    burndown: display.burndown,
    burndownSummary: display.burndownSummary,
    columns: COLUMNS.map((column, index) => ({ id: column.id, ...display.columns[index], wip: wipData(board, column.id) })),
  }
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function update(surfaceId: string, path: string, value: Json): SurfaceMessage {
  return { version: VERSION, updateDataModel: { surfaceId, path, value } }
}

export function replaceComponents(surfaceId: string, components: SurfaceComponent[]): SurfaceMessage {
  return { version: VERSION, updateComponents: { surfaceId, components } }
}

export function openingMessages(surfaceId: string, components: SurfaceComponent[], data: Record<string, Json>): SurfaceMessage[] {
  return [
    { version: VERSION, createSurface: { surfaceId, catalogId: SURFACE_CATALOG_ID } },
    replaceComponents(surfaceId, components),
    update(surfaceId, "/", data),
  ]
}

export function displayPatches(surfaceId: string, before: BoardDisplay, after: BoardDisplay): SurfaceMessage[] {
  const changed = (a: Json | undefined, b: Json) => JSON.stringify(a) !== JSON.stringify(b)
  const patches: SurfaceMessage[] = []
  for (const key of ["header", "kpis"] as const) {
    const was = before[key]
    const now = after[key]
    if (!isObject(was) || !isObject(now)) continue
    for (const [field, value] of Object.entries(now)) if (changed(was[field], value)) patches.push(update(surfaceId, `/${key}/${field}`, value))
  }
  const top: [Exclude<keyof BoardDisplay, "columns" | "header" | "kpis">, string][] = [
    ["summary", "/filter/summary"],
    ["burndown", "/burndown"],
    ["burndownSummary", "/burndownSummary"],
  ]
  for (const [key, path] of top) if (changed(before[key], after[key])) patches.push(update(surfaceId, path, after[key]))
  after.columns.forEach((column, index) => {
    const previous = before.columns[index]
    for (const key of COLUMN_DISPLAY_KEYS) {
      if (changed(previous?.[key], column[key])) patches.push(update(surfaceId, `/columns/${index}/${key}`, column[key]))
    }
  })
  return patches
}
