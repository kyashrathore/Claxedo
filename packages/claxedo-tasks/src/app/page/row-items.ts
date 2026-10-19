import type { SurfaceComponent } from "@claxedo/plugin-api"
import type { Preset, TaskStatus, TaskSummary } from "../../contracts"
import { shortAgeText } from "../age"
import type { Translate } from "../dictionary"
import type { Json, JsonObject } from "../surface/json"
import { bound, surfaceButton } from "../surface/parts"
import { PAGE_EVENTS, type TaskTool } from "./events"
import { nextStatus, previousStatus, STATUS_LOOKS, taskKey, type TaskDateField } from "./model"

export type RowContext = {
  readonly t: Translate
  readonly projectName: string
  readonly dateField: TaskDateField
  readonly now: number
  readonly startWith: Preset | undefined
  readonly showStatus: boolean
  readonly titleOf: (taskId: string) => string | undefined
}

function badge(text: string, tone: string): JsonObject {
  return { text, tone }
}

function rowBadges(context: RowContext, task: TaskSummary): Json[] {
  const { t } = context
  const look = STATUS_LOOKS[task.status]
  return [
    ...(context.showStatus ? [badge(t(look.key), look.tone)] : []),
    ...(task.archivedAt === null ? [] : [badge(t("claxedo-tasks.row.archived"), "warning")]),
    ...(task.children.total > 0 ? [badge(t("claxedo-tasks.row.subtasks", { done: task.children.done, total: task.children.total }), task.children.done === task.children.total ? "success" : "neutral")] : []),
    ...(task.links.count > 0 ? [badge(task.links.count === 1 ? t("claxedo-tasks.row.sessions.one") : t("claxedo-tasks.row.sessions.other", { count: task.links.count }), "accent")] : []),
  ]
}

function rowSubtitle(context: RowContext, task: TaskSummary): string {
  const { t } = context
  const at = context.dateField === "created" ? task.createdAt : task.updatedAt
  const age = shortAgeText(t, at, context.now)
  const parent = task.parentTaskId === null ? undefined : context.titleOf(task.parentTaskId)
  return [
    taskKey(context.projectName, task),
    ...(parent ? [t("claxedo-tasks.row.subtaskOf", { title: parent })] : []),
    t(context.dateField === "created" ? "claxedo-tasks.row.created" : "claxedo-tasks.row.updated", { age }),
  ].join(" · ")
}

function tool(task: TaskSummary, kind: TaskTool, icon: string, label: string): JsonObject {
  return { taskId: task.id, tool: kind, icon, label }
}

function moveTool(context: RowContext, task: TaskSummary, kind: "next" | "previous", status: TaskStatus | undefined): Json[] {
  if (!status || task.archivedAt !== null) return []
  return [tool(task, kind, kind === "next" ? "arrowForward" : "arrowBack", context.t("claxedo-tasks.row.moveTo", { title: task.title, status: context.t(STATUS_LOOKS[status].key) }))]
}

function rowTools(context: RowContext, task: TaskSummary): Json[] {
  const { t } = context
  const run =
    task.links.count > 0
      ? [tool(task, "session", "visibility", t("claxedo-tasks.row.openSession", { title: task.title }))]
      : context.startWith && task.archivedAt === null
        ? [tool(task, "start", "play", t("claxedo-tasks.row.start", { title: task.title, preset: context.startWith.name }))]
        : []
  return [...run, ...moveTool(context, task, "previous", previousStatus(task.status)), ...moveTool(context, task, "next", nextStatus(task.status))]
}

export function taskRow(context: RowContext, task: TaskSummary): JsonObject {
  return {
    id: task.id,
    title: task.title,
    subtitle: rowSubtitle(context, task),
    icon: STATUS_LOOKS[task.status].icon,
    badges: rowBadges(context, task),
    tools: rowTools(context, task),
    movable: task.archivedAt === null,
  }
}

export function taskRowComponents(t: Translate): SurfaceComponent[] {
  return [
    { id: "task-row", component: "ListItem", title: bound("title"), subtitle: bound("subtitle"), icon: bound("icon"), meta: ["task-badges"], primaryAction: "task-open", actions: ["task-tools"] },
    { id: "task-badges", component: "List", direction: "horizontal", children: { componentId: "task-badge", path: "badges" } },
    { id: "task-badge", component: "Badge", text: bound("text"), variant: bound("tone") },
    ...surfaceButton("task-open", t("claxedo-tasks.row.open"), PAGE_EVENTS.openTask, { context: { taskId: bound("id") } }),
    { id: "task-tools", component: "List", direction: "horizontal", children: { componentId: "task-tool", path: "tools" } },
    ...surfaceButton("task-tool", bound("label"), PAGE_EVENTS.taskTool, { icon: bound("icon"), context: { taskId: bound("taskId"), tool: bound("tool") } }),
  ]
}
