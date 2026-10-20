import type { SurfaceComponent } from "@claxedo/plugin-api"
import { TASK_STATUSES, type Preset, type TaskSummary } from "../../contracts"
import { shortAgeText } from "../age"
import type { Translate } from "../dictionary"
import type { Json, JsonObject } from "../surface/json"
import { bound, surfaceButton } from "../surface/parts"
import { PAGE_EVENTS, type TaskTool } from "./events"
import { STATUS_LOOKS, taskKey } from "./model"

export type RowContext = {
  readonly t: Translate
  readonly projectName: string
  readonly now: number
  readonly startWith: Preset | undefined
  readonly keyOf: (taskId: string) => string | undefined
}

function rowBadges(context: RowContext, task: TaskSummary): Json[] {
  return task.archivedAt === null ? [] : [{ text: context.t("claxedo-tasks.row.archived"), tone: "warning" }]
}

function rowFacts(context: RowContext, task: TaskSummary): Json[] {
  const { t } = context
  const parent = task.parentTaskId === null ? undefined : context.keyOf(task.parentTaskId)
  return [
    ...(parent ? [{ text: t("claxedo-tasks.row.subtaskOf", { key: parent }) }] : []),
    ...(task.children.total > 0 ? [{ text: t("claxedo-tasks.row.subtasks", { done: task.children.done, total: task.children.total }) }] : []),
    ...(task.links.count > 0 ? [{ text: task.links.count === 1 ? t("claxedo-tasks.row.sessions.one") : t("claxedo-tasks.row.sessions.other", { count: task.links.count }) }] : []),
    { text: shortAgeText(t, task.updatedAt, context.now) },
  ]
}

function tool(task: TaskSummary, kind: TaskTool, icon: string, label: string): JsonObject {
  return { taskId: task.id, tool: kind, icon, label }
}

function rowTools(context: RowContext, task: TaskSummary): Json[] {
  const { t } = context
  const run =
    task.links.count > 0
      ? [tool(task, "session", "visibility", t("claxedo-tasks.row.openSession", { title: task.title }))]
      : context.startWith && task.archivedAt === null
        ? [tool(task, "start", "play", t("claxedo-tasks.row.start", { title: task.title, preset: context.startWith.name }))]
        : []
  const keep = task.archivedAt === null ? tool(task, "archive", "archive", t("claxedo-tasks.row.archive", { title: task.title })) : tool(task, "restore", "refresh", t("claxedo-tasks.row.restore", { title: task.title }))
  return [...run, keep]
}

export function taskRow(context: RowContext, task: TaskSummary): JsonObject {
  return {
    id: task.id,
    key: taskKey(context.projectName, task),
    title: task.title,
    status: [task.status],
    badges: rowBadges(context, task),
    facts: rowFacts(context, task),
    tools: rowTools(context, task),
    movable: task.archivedAt === null,
  }
}

export function statusOptions(t: Translate) {
  return TASK_STATUSES.map((status) => ({ label: t(STATUS_LOOKS[status].key), value: status, icon: STATUS_LOOKS[status].icon }))
}

export function taskRowComponents(t: Translate): SurfaceComponent[] {
  return [
    {
      id: "task-row",
      component: "ListItem",
      title: bound("title"),
      identifier: bound("key"),
      leading: "task-status",
      layout: "inline",
      meta: ["task-badges", "task-facts"],
      actions: ["task-tools"],
      action: { event: { name: PAGE_EVENTS.openTask, context: { taskId: bound("id") } } },
    },
    { id: "task-status", component: "ChoicePicker", label: t("claxedo-tasks.row.status"), variant: "mutuallyExclusive", displayStyle: "menu", iconOnly: true, options: statusOptions(t), value: bound("status"), change: { event: { name: PAGE_EVENTS.rowStatus, context: { taskId: bound("id") } } } },
    { id: "task-badges", component: "List", direction: "horizontal", children: { componentId: "task-badge", path: "badges" } },
    { id: "task-badge", component: "Badge", text: bound("text"), variant: bound("tone") },
    { id: "task-facts", component: "List", direction: "horizontal", children: { componentId: "task-fact", path: "facts" } },
    { id: "task-fact", component: "Text", variant: "caption", text: bound("text") },
    { id: "task-tools", component: "List", direction: "horizontal", children: { componentId: "task-tool", path: "tools" } },
    ...surfaceButton("task-tool", bound("label"), PAGE_EVENTS.taskTool, { variant: "borderless", icon: bound("icon"), context: { taskId: bound("taskId"), tool: bound("tool") } }),
  ]
}
