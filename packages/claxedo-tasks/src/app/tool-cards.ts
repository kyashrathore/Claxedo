import type { ToolCardLink, ToolCardStatus, ToolCardTemplate, ToolCardText } from "@claxedo/plugin-api"
import type { TasksCardKey } from "./words/card-words"

export type CardTranslate = (key: TasksCardKey) => string

export const TASKS_PAGE_ID = "tasks"
export const TASK_LIST_ROW_CAP = 8
const TASK_ID_LABEL_MAX = 13

function path(pointer: string): ToolCardText {
  return { path: pointer }
}

function shortId(pointer: string): ToolCardText {
  return { path: pointer, max: TASK_ID_LABEL_MAX }
}

function taskNameLabel(task: string): readonly ToolCardText[] {
  return [{ format: `#{${task}/key} {${task}/title}` }, { format: `#{${task}/key}` }, path(`${task}/title`)]
}

function taskLink(task: string, ids: readonly string[], fallbacks: readonly ToolCardText[] = []): ToolCardLink {
  return {
    kind: "page",
    pageId: TASKS_PAGE_ID,
    params: { taskId: { first: ids.map(path) } },
    label: { first: [...taskNameLabel(task), ...ids.map(shortId), ...fallbacks] },
  }
}

function parentLink(ids: readonly string[]): ToolCardLink {
  return { kind: "page", pageId: TASKS_PAGE_ID, params: { taskId: { first: ids.map(path) } }, label: { first: ids.map(shortId) } }
}

function taskStatusCard(t: CardTranslate, value: ToolCardText): ToolCardStatus {
  return {
    value,
    states: {
      backlog: { label: t("claxedo-tasks.card.status.backlog"), icon: "circleDashed" },
      todo: { label: t("claxedo-tasks.card.status.todo"), icon: "circle" },
      doing: { label: t("claxedo-tasks.card.status.doing"), icon: "circleHalf", tone: "info" },
      needs_you: { label: t("claxedo-tasks.card.status.needs_you"), icon: "alertCircle", tone: "warning" },
      done: { label: t("claxedo-tasks.card.status.done"), icon: "checkCircle", tone: "success" },
    },
  }
}

function countText(t: CardTranslate, pointer: string, noun: "task" | "subtask" | "session"): ToolCardText {
  return { count: { path: pointer, one: t(`claxedo-tasks.card.${noun}.one`), other: t(`claxedo-tasks.card.${noun}.other`) } }
}

function replayedNote(t: CardTranslate) {
  return { when: { path: "/result/replayed", equals: true }, text: t("claxedo-tasks.card.note.replayed") }
}

function taskCreate(t: CardTranslate): ToolCardTemplate {
  return {
    tool: "task_create",
    title: t("claxedo-tasks.card.task_create"),
    link: taskLink("/result/task", ["/result/task/id"], [path("/args/title")]),
    status: taskStatusCard(t, { first: [path("/result/task/status"), path("/args/status"), "todo"] }),
    notes: [replayedNote(t)],
    facts: [
      { label: t("claxedo-tasks.card.fact.parent"), value: parentLink(["/result/task/parent", "/args/parent"]) },
      { label: t("claxedo-tasks.card.fact.createdFrom"), value: { kind: "session", sessionId: path("/result/task/createdFrom/sessionId") } },
    ],
  }
}

function taskEdit(t: CardTranslate): ToolCardTemplate {
  return {
    tool: "task_edit",
    title: t("claxedo-tasks.card.task_edit"),
    link: taskLink("/result/task", ["/result/task/id", "/args/task"]),
    status: taskStatusCard(t, path("/result/task/status")),
    notes: [replayedNote(t)],
  }
}

function taskStart(t: CardTranslate): ToolCardTemplate {
  const preset: ToolCardText = { first: [path("/result/preset/name"), path("/args/preset")] }
  return {
    tool: "task_start",
    title: t("claxedo-tasks.card.task_start"),
    link: taskLink("/result/task", ["/result/task/id", "/args/task"]),
    subject: preset,
    notes: [
      { when: { path: "/result/created", equals: false }, text: t("claxedo-tasks.card.note.alreadyRunning") },
      { when: { path: "/args/continue", equals: true }, text: t("claxedo-tasks.card.note.continued") },
    ],
    facts: [
      { label: t("claxedo-tasks.card.fact.session"), value: { kind: "session", sessionId: path("/result/session/sessionId") } },
      { label: t("claxedo-tasks.card.fact.preset"), value: preset },
      { label: t("claxedo-tasks.card.fact.slot"), value: { first: [path("/result/slot"), path("/args/slot")] } },
      { label: t("claxedo-tasks.card.fact.attempt"), value: path("/result/attempt") },
      { label: t("claxedo-tasks.card.fact.placement"), value: path("/result/placement") },
      { label: t("claxedo-tasks.card.fact.destination"), value: path("/result/destination"), mono: true },
    ],
  }
}

function taskGet(t: CardTranslate): ToolCardTemplate {
  return {
    tool: "task_get",
    title: t("claxedo-tasks.card.task_get"),
    link: taskLink("/result/task", ["/result/task/id", "/args/task"]),
    status: taskStatusCard(t, path("/result/task/status")),
    facts: [
      { label: t("claxedo-tasks.card.fact.parent"), value: parentLink(["/result/task/parentTaskId", "/result/task/parent"]) },
      { label: t("claxedo-tasks.card.fact.subtasks"), value: countText(t, "/result/task/children/total", "subtask"), when: { path: "/result/task/children" } },
      { label: t("claxedo-tasks.card.fact.sessions"), value: countText(t, "/result/links", "session"), when: { path: "/result" } },
    ],
  }
}

function taskList(t: CardTranslate): ToolCardTemplate {
  return {
    tool: "task_list",
    title: t("claxedo-tasks.card.task_list"),
    subject: countText(t, "/result/tasks", "task"),
    status: taskStatusCard(t, path("/args/status")),
    rows: {
      path: "/result/tasks",
      link: taskLink("", ["/id"]),
      status: taskStatusCard(t, path("/status")),
      max: TASK_LIST_ROW_CAP,
      more: t("claxedo-tasks.card.more"),
      continued: { when: { path: "/result/nextCursor" }, text: t("claxedo-tasks.card.moreAvailable") },
    },
  }
}

export function taskToolCards(t: CardTranslate): readonly ToolCardTemplate[] {
  return [taskList(t), taskGet(t), taskCreate(t), taskEdit(t), taskStart(t)]
}
