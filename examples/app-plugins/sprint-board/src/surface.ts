import type { SurfaceComponent, SurfaceMessage } from "@claxedo/plugin-api"
import {
  COLUMNS,
  addDays,
  PRIORITIES,
  TEAM,
  burndown,
  columnTitle,
  dueStatus,
  filterByOwners,
  isUrgent,
  ownerName,
  priorityLabel,
  sprintDay,
  sprintProgress,
  wipStatus,
  WIP_LIMIT_RANGE,
  type Board,
  type ColumnId,
  type Task,
} from "./model"

export const SURFACE_CATALOG_ID = "https://claxedo.dev/a2ui/v0.9/catalog.json"
const VERSION = "v0.9" as const

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

function when<Item extends Json>(condition: boolean, item: Item): Item[] {
  return condition ? [item] : []
}

function label(id: string, text: string): SurfaceComponent {
  return { id, component: "Text", text }
}

export function sprintBoardComponents(composeOpen: boolean): SurfaceComponent[] {
  return [
    { id: "root", component: "Column", children: ["header-card", "filter-row", "compose", "board", "burndown"] },

    { id: "header-card", component: "Card", child: "header" },
    { id: "header", component: "Column", children: ["header-top", "header-stats"] },
    { id: "header-top", component: "Row", align: "center", children: ["header-icon", "header-titles", "header-day", "header-project"] },
    { id: "header-icon", component: "Icon", name: "event" },
    { id: "header-titles", component: "Column", weight: 1, children: ["header-title", "header-subtitle"] },
    { id: "header-title", component: "Text", variant: "h1", text: { path: "/header/title" } },
    { id: "header-subtitle", component: "Text", variant: "caption", text: { path: "/header/subtitle" } },
    { id: "header-day", component: "Badge", variant: "accent", text: { path: "/header/day" } },
    { id: "header-project", component: "Badge", text: { path: "/header/project" } },
    { id: "header-stats", component: "Row", align: "center", children: ["header-progress", "header-session"] },
    { id: "header-progress", component: "Progress", weight: 3, value: { path: "/progress/percent" }, max: 100, label: { path: "/progress/label" } },
    { id: "header-session", component: "Column", weight: 1, children: ["session-caption", "session-diff"] },
    { id: "session-caption", component: "Text", variant: "caption", text: "Tasks added / removed this session" },
    { id: "session-diff", component: "DiffStat", additions: { path: "/session/added" }, deletions: { path: "/session/removed" } },

    { id: "filter-row", component: "Row", align: "end", children: ["filter-picker", "filter-apply", "filter-clear", "filter-summary"] },
    {
      id: "filter-picker",
      component: "ChoicePicker",
      weight: 1,
      label: "Filter by owner",
      variant: "multipleSelection",
      displayStyle: "chips",
      options: TEAM.map((owner) => ({ label: owner.name, value: owner.id })),
      value: { path: "/filter/owners" },
    },
    { id: "filter-apply", component: "Button", child: "filter-apply-label", action: { event: { name: "applyFilter", context: { owners: { path: "/filter/owners" } } } } },
    label("filter-apply-label", "Apply filter"),
    { id: "filter-clear", component: "Button", variant: "borderless", child: "filter-clear-label", action: { event: { name: "clearFilter" } } },
    label("filter-clear-label", "Show everyone"),
    { id: "filter-summary", component: "Text", variant: "caption", text: { path: "/filter/summary" } },

    { id: "compose", component: "Collapsible", title: "New task", open: composeOpen, child: "compose-body" },
    { id: "compose-body", component: "Column", children: ["draft-title", "draft-description", "compose-choices", "compose-numbers", "compose-hint", "compose-submit"] },
    { id: "draft-title", component: "TextField", label: "Task title", value: { path: "/draft/title" } },
    { id: "draft-description", component: "TextField", label: "Description", variant: "longText", value: { path: "/draft/description" } },
    { id: "compose-choices", component: "Row", align: "end", children: ["draft-owner", "draft-priority"] },
    {
      id: "draft-owner",
      component: "ChoicePicker",
      weight: 1,
      label: "Owner",
      variant: "mutuallyExclusive",
      displayStyle: "dropdown",
      options: TEAM.map((owner) => ({ label: owner.name, value: owner.id })),
      value: { path: "/draft/owner" },
    },
    {
      id: "draft-priority",
      component: "ChoicePicker",
      weight: 1,
      label: "Priority",
      variant: "mutuallyExclusive",
      displayStyle: "chips",
      options: PRIORITIES.map((priority) => ({ label: priority.label, value: priority.id })),
      value: { path: "/draft/priority" },
    },
    { id: "compose-numbers", component: "Row", align: "end", children: ["draft-points", "draft-due"] },
    { id: "draft-points", component: "Slider", weight: 1, label: "Story points", min: 1, max: 13, step: 1, value: { path: "/draft/points" } },
    { id: "draft-due", component: "DateTimeInput", weight: 1, label: "Due date", enableDate: true, enableTime: false, min: { path: "/header/sprintStart" }, value: { path: "/draft/due" } },
    { id: "compose-hint", component: "Text", variant: "caption", text: "Points snap to the planning scale 1, 2, 3, 5, 8, 13. New tasks land in Backlog." },
    { id: "compose-submit", component: "Button", variant: "primary", child: "compose-submit-label", action: { event: { name: "addTask", context: { draft: { path: "/draft" } } } } },
    label("compose-submit-label", "Add task"),

    { id: "board", component: "Row", align: "start", children: { componentId: "column-card", path: "/columns" } },
    { id: "column-card", component: "Card", weight: 1, child: "column-body" },
    { id: "column-body", component: "Column", children: ["column-head", "column-points", "column-warnings", "column-wip", "column-empty", "column-tasks"] },
    { id: "column-head", component: "Row", align: "center", justify: "spaceBetween", children: ["column-title", "column-count"] },
    { id: "column-title", component: "Text", variant: "h3", text: { path: "title" } },
    { id: "column-count", component: "Badge", text: { path: "wipLabel" } },
    { id: "column-points", component: "Text", variant: "caption", text: { path: "pointsLabel" } },
    { id: "column-warnings", component: "List", children: { componentId: "column-warning", path: "warning" } },
    { id: "column-warning", component: "Row", align: "center", children: ["column-warning-icon", "column-warning-badge"] },
    { id: "column-warning-icon", component: "Icon", name: "warning" },
    { id: "column-warning-badge", component: "Badge", variant: "accent", text: { path: "text" } },
    { id: "column-wip", component: "Collapsible", title: "WIP limit", child: "wip-body" },
    { id: "wip-body", component: "Column", children: ["wip-enforce", "wip-limit", "wip-save"] },
    { id: "wip-enforce", component: "Switch", label: "Enforce WIP limit", value: { path: "wip/enforce" } },
    { id: "wip-limit", component: "Slider", label: "Limit", min: WIP_LIMIT_RANGE.min, max: WIP_LIMIT_RANGE.max, step: 1, value: { path: "wip/limit" } },
    {
      id: "wip-save",
      component: "Button",
      child: "wip-save-label",
      action: { event: { name: "saveWip", context: { column: { path: "id" }, enforce: { path: "wip/enforce" }, limit: { path: "wip/limit" } } } },
    },
    label("wip-save-label", "Save limit"),
    { id: "column-empty", component: "List", children: { componentId: "column-empty-state", path: "empty" } },
    { id: "column-empty-state", component: "EmptyState", title: { path: "title" }, description: { path: "description" } },
    { id: "column-tasks", component: "List", children: { componentId: "task-card", path: "tasks" } },

    { id: "task-card", component: "Card", child: "task-body" },
    { id: "task-body", component: "Column", children: ["task-title", "task-description", "task-badges", "task-due", "task-actions"] },
    { id: "task-title", component: "Text", variant: "h5", text: { path: "title" } },
    { id: "task-description", component: "Text", variant: "caption", text: { path: "description" } },
    { id: "task-badges", component: "Row", align: "center", children: ["task-key", "task-owner", "task-urgent", "task-calm", "task-points"] },
    { id: "task-key", component: "Text", variant: "caption", text: { path: "id" } },
    { id: "task-owner", component: "Badge", text: { path: "owner" } },
    { id: "task-urgent", component: "List", direction: "horizontal", children: { componentId: "task-urgent-badge", path: "urgent" } },
    { id: "task-urgent-badge", component: "Badge", variant: "accent", text: { path: "text" } },
    { id: "task-calm", component: "List", direction: "horizontal", children: { componentId: "task-calm-badge", path: "calm" } },
    { id: "task-calm-badge", component: "Badge", text: { path: "text" } },
    { id: "task-points", component: "Badge", text: { path: "points" } },
    { id: "task-due", component: "Text", variant: "caption", text: { path: "due" } },
    { id: "task-actions", component: "Row", align: "center", children: ["task-back", "task-forward", "task-delete"] },
    { id: "task-back", component: "List", direction: "horizontal", children: { componentId: "task-back-button", path: "back" } },
    { id: "task-back-button", component: "Button", child: "task-back-label", action: { event: { name: "move", context: { id: { path: "id" }, step: -1 } } } },
    { id: "task-back-label", component: "Text", text: { path: "label" } },
    { id: "task-forward", component: "List", direction: "horizontal", children: { componentId: "task-forward-button", path: "forward" } },
    { id: "task-forward-button", component: "Button", child: "task-forward-label", action: { event: { name: "move", context: { id: { path: "id" }, step: 1 } } } },
    { id: "task-forward-label", component: "Text", text: { path: "label" } },
    { id: "task-delete", component: "Button", variant: "borderless", child: "task-delete-label", action: { event: { name: "delete", context: { id: { path: "id" } } } } },
    label("task-delete-label", "Delete"),

    { id: "burndown", component: "Collapsible", title: "Burndown", open: true, child: "burndown-body" },
    { id: "burndown-body", component: "Column", children: ["burndown-caption", "burndown-divider", "burndown-table"] },
    { id: "burndown-caption", component: "Text", variant: "caption", text: { path: "/burndownSummary" } },
    { id: "burndown-divider", component: "Divider" },
    {
      id: "burndown-table",
      component: "Table",
      columns: [
        { key: "day", title: "Day" },
        { key: "date", title: "Date" },
        { key: "ideal", title: "Ideal remaining" },
        { key: "remaining", title: "Actual remaining" },
        { key: "completed", title: "Completed" },
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
  readonly formatDate: (iso: string) => string
}

function taskView(task: Task, context: ViewContext): Json {
  const index = COLUMNS.findIndex((column) => column.id === task.column)
  const previous = COLUMNS[index - 1]
  const next = COLUMNS[index + 1]
  const due = dueStatus(task, context.today)
  const priority = priorityLabel(task.priority)
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    owner: ownerName(task.owner),
    urgent: when(isUrgent(task.priority), { text: priority }),
    calm: when(!isUrgent(task.priority), { text: priority }),
    points: `${task.points} pt${task.points === 1 ? "" : "s"}`,
    due: due.overdue ? `⚠ ${due.label}` : task.due === "" ? due.label : `${due.label} · ${context.formatDate(task.due)}`,
    back: when(previous !== undefined, { id: task.id, label: `← ${previous?.title ?? ""}` }),
    forward: when(next !== undefined, { id: task.id, label: `${next?.title ?? ""} →` }),
  }
}

const COLUMN_DISPLAY_KEYS = ["title", "wipLabel", "pointsLabel", "warning", "empty", "tasks"] as const

export type ColumnDisplay = Readonly<Record<(typeof COLUMN_DISPLAY_KEYS)[number], Json>>

function columnDisplay(board: Board, column: ColumnId, context: ViewContext): ColumnDisplay {
  const all = board.tasks.filter((task) => task.column === column)
  const visible = filterByOwners(all, context.owners)
  const status = wipStatus(board, column)
  const points = visible.reduce((sum, task) => sum + task.points, 0)
  const hidden = all.length - visible.length
  return {
    title: columnTitle(column),
    wipLabel: `${status.count} / ${status.limit}${status.enforce ? "" : " advisory"}`,
    pointsLabel: `${points} pts${hidden > 0 ? ` · ${hidden} hidden by filter` : ""}`,
    warning: [
      ...when(status.exceeded, { text: `Over WIP limit: ${status.count}/${status.limit}` }),
      ...when(!status.exceeded && status.full && status.enforce, { text: "At WIP limit" }),
    ],
    empty: when(visible.length === 0, {
      title: all.length === 0 ? "No tasks" : "No tasks for this filter",
      description: all.length === 0 ? `Move a task into ${columnTitle(column)}.` : `${hidden} task${hidden === 1 ? "" : "s"} hidden by the owner filter.`,
    }),
    tasks: visible.map((task) => taskView(task, context)),
  }
}

export type BoardDisplay = {
  readonly header: Json
  readonly progress: Json
  readonly summary: string
  readonly burndown: Json
  readonly burndownSummary: string
  readonly columns: readonly ColumnDisplay[]
}

export function boardDisplay(board: Board, context: ViewContext): BoardDisplay {
  const progress = sprintProgress(board)
  const shown = filterByOwners(board.tasks, context.owners).length
  const days = burndown(board, context.today)
  const latest = [...days].reverse().find((day) => day.remaining !== undefined)
  return {
    header: {
      title: `${board.sprint.name} board`,
      subtitle: `${board.sprint.goal} · ${context.formatDate(board.sprint.start)} – ${context.formatDate(addDays(board.sprint.start, board.sprint.days - 1))}`,
      day: `Day ${sprintDay(board.sprint, context.today)} of ${board.sprint.days}`,
      project: context.projectName ? `Project: ${context.projectName}` : "No project selected",
      sprintStart: board.sprint.start,
    },
    progress: { percent: progress.percent, label: `${progress.done} of ${progress.total} points done (${progress.percent}%)` },
    summary:
      context.owners.length === 0
        ? `Showing all ${board.tasks.length} tasks`
        : `Showing ${shown} of ${board.tasks.length} tasks for ${context.owners.map(ownerName).join(", ")}`,
    burndown: days.map((day) => ({
      day: `Day ${day.day}`,
      date: context.formatDate(day.date),
      ideal: day.ideal,
      remaining: day.remaining ?? "—",
      completed: day.completed,
      trend: day.remaining === undefined ? "" : day.remaining > day.ideal ? "Behind" : "On track",
    })),
    burndownSummary: latest
      ? `${latest.remaining} points remain on day ${latest.day}; the ideal line is ${latest.ideal}. Scope counts every task currently on the board.`
      : "The sprint has not started yet.",
    columns: COLUMNS.map((column) => columnDisplay(board, column.id, context)),
  }
}

export function emptyDraft(today: string): Record<string, Json> {
  return { title: "", description: "", owner: [], priority: ["medium"], points: 3, due: today }
}

export function initialData(board: Board, display: BoardDisplay, owners: readonly string[], session: { added: number; removed: number }, today: string): Record<string, Json> {
  return {
    header: display.header,
    progress: display.progress,
    session,
    filter: { owners: [...owners], summary: display.summary },
    draft: emptyDraft(today),
    burndown: display.burndown,
    burndownSummary: display.burndownSummary,
    columns: COLUMNS.map((column, index) => ({
      id: column.id,
      ...display.columns[index],
      wip: { enforce: board.wip[column.id].enforce, limit: board.wip[column.id].limit },
    })),
  }
}

export function update(surfaceId: string, path: string, value: Json): SurfaceMessage {
  return { version: VERSION, updateDataModel: { surfaceId, path, value } }
}

export function openingMessages(surfaceId: string, components: SurfaceComponent[], data: Record<string, Json>): SurfaceMessage[] {
  return [
    { version: VERSION, createSurface: { surfaceId, catalogId: SURFACE_CATALOG_ID } },
    { version: VERSION, updateComponents: { surfaceId, components } },
    { version: VERSION, updateDataModel: { surfaceId, path: "/", value: data } },
  ]
}

export function displayPatches(surfaceId: string, before: BoardDisplay, after: BoardDisplay): SurfaceMessage[] {
  const changed = (a: Json | undefined, b: Json) => JSON.stringify(a) !== JSON.stringify(b)
  const patches: SurfaceMessage[] = []
  const top: [Exclude<keyof BoardDisplay, "columns">, string][] = [
    ["header", "/header"],
    ["progress", "/progress"],
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
