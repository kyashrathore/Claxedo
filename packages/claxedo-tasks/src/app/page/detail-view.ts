import type { SurfaceComponent } from "@claxedo/plugin-api"
import { TASK_STATUSES, type Task } from "../../contracts"
import { shortAgeText } from "../age"
import type { Translate } from "../dictionary"
import type { Json, JsonObject } from "../surface/json"
import { bound, callout, footer, surfaceButton, surfaceColumn, surfaceSection } from "../surface/parts"
import { PAGE_EVENTS } from "./events"
import type { PageView } from "./list-view"
import { projectNameOf } from "./list-view"
import { groupLinksBySlot, openableSlot, STATUS_LOOKS, taskKey } from "./model"
import { taskRow, taskRowComponents, type RowContext } from "./row-items"
import { sessionsComponents, sessionsData, type SlotsView } from "./sessions-view"
import { activePresets, startWithPreset, type DetailLoad, type TaskDetail } from "./state"

type Ready = Extract<DetailLoad, { kind: "ready" }>

function headerParts(view: PageView, task: Task | undefined): SurfaceComponent[] {
  const { t } = view
  const back = surfaceButton("detail-back", t("claxedo-tasks.detail.back"), PAGE_EVENTS.back, { variant: "borderless", icon: "arrowBack" })
  if (!task) return [{ id: "detail-header", component: "Header", title: t("claxedo-tasks.page.title"), actions: ["detail-back"] }, ...back]
  const look = STATUS_LOOKS[task.status]
  const archived = task.archivedAt !== null
  const subtitle = t("claxedo-tasks.detail.subtitle", { key: taskKey(projectNameOf(view), task), project: projectNameOf(view) || task.projectId, age: shortAgeText(t, task.updatedAt, view.now) })
  return [
    { id: "detail-header", component: "Header", title: task.title, subtitle, badges: ["detail-status-badge", ...(archived ? ["detail-archived-badge"] : [])], actions: ["detail-back", "detail-archive"] },
    { id: "detail-status-badge", component: "Badge", text: t(look.key), variant: look.tone },
    { id: "detail-archived-badge", component: "Badge", text: t("claxedo-tasks.row.archived"), variant: "warning" },
    ...back,
    ...surfaceButton("detail-archive", t(archived ? "claxedo-tasks.detail.restore" : "claxedo-tasks.detail.archive"), archived ? PAGE_EVENTS.restore : PAGE_EVENTS.archive, { icon: archived ? "refresh" : "visibilityOff" }),
  ]
}

function noticeParts(view: PageView, detail: TaskDetail): SurfaceComponent[] {
  const { t, state } = view
  if (detail.conflictTitle !== undefined) return [callout("detail-notice", "warning", t("claxedo-tasks.detail.conflictTitle"), { text: t("claxedo-tasks.detail.conflictText", { title: detail.conflictTitle }) })]
  if (detail.error) return [callout("detail-notice", "danger", t("claxedo-tasks.detail.refused"), { text: detail.error })]
  if (state.startRefusal?.taskId === detail.taskId) {
    return [callout("detail-notice", "warning", t("claxedo-tasks.start.refusedTitle", { title: state.startRefusal.title }), { text: state.startRefusal.message, dismissible: true })]
  }
  return []
}

function taskDetailsSection(t: Translate, detail: TaskDetail): SurfaceComponent[] {
  const save = detail.saving
    ? [{ id: "detail-save", component: "Spinner", label: t("claxedo-tasks.detail.saving") } as const]
    : surfaceButton("detail-save", t("claxedo-tasks.detail.save"), PAGE_EVENTS.save, { variant: "primary", context: { title: bound("/detail/title"), description: bound("/detail/description") } })
  return [
    surfaceSection("detail-details", "detail-details-body", { title: t("claxedo-tasks.detail.details") }),
    surfaceColumn("detail-details-body", ["detail-title", "detail-description", "detail-footer"]),
    { id: "detail-title", component: "TextField", label: t("claxedo-tasks.detail.taskTitle"), value: bound("/detail/title"), submit: { event: { name: PAGE_EVENTS.save, context: { description: bound("/detail/description") } } } },
    { id: "detail-description", component: "TextField", label: t("claxedo-tasks.detail.description"), variant: "longText", value: bound("/detail/description"), submit: { event: { name: PAGE_EVENTS.save, context: { title: bound("/detail/title") } } } },
    footer("detail-footer", ["detail-save"], ["detail-discard"]),
    ...save,
    ...surfaceButton("detail-discard", t("claxedo-tasks.detail.discard"), PAGE_EVENTS.discard, { variant: "borderless", context: { title: bound("/detail/title"), description: bound("/detail/description") } }),
  ]
}

function imagesSection(t: Translate, ready: Ready): SurfaceComponent[] {
  const attachments = ready.detail.attachments
  if (attachments.length === 0) return []
  const loading = attachments.some((attachment) => ready.images[attachment.id]?.kind !== "ready" && ready.images[attachment.id]?.kind !== "failed")
  const failed = attachments.filter((attachment) => ready.images[attachment.id]?.kind === "failed")
  const notice = failed.length > 0 ? [callout("detail-images-notice", "warning", failed.map((attachment) => t("claxedo-tasks.images.failed", { name: attachment.filename })).join("; "))] : []
  return [
    surfaceSection("detail-images", "detail-images-body", { title: t("claxedo-tasks.images.title") }),
    surfaceColumn("detail-images-body", [...notice.map((part) => part.id), "detail-image-grid", ...(loading ? ["detail-images-loading"] : [])]),
    ...notice,
    { id: "detail-image-grid", component: "Grid", columns: 3, gap: "small", children: { componentId: "detail-image", path: "/detail/images" } },
    { id: "detail-image", component: "Image", url: bound("url"), variant: "mediumFeature", accessibility: { label: bound("name") } },
    { id: "detail-images-loading", component: "Spinner", label: t("claxedo-tasks.images.loading") },
  ]
}

function subtasksSection(t: Translate, ready: Ready): SurfaceComponent[] {
  const task = ready.detail.task
  if (task.parentTaskId !== null) return []
  const done = ready.children.filter((child) => child.status === "done").length
  const canAdd = task.status !== "done" && task.archivedAt === null
  const list: SurfaceComponent = ready.children.length > 0
    ? { id: "detail-subtask-list", component: "List", children: { componentId: "task-row", path: "/detail/subtasks" } }
    : { id: "detail-subtask-list", component: "Text", variant: "caption", text: t("claxedo-tasks.subtasks.none") }
  const adder: SurfaceComponent[] = canAdd
    ? [
        { id: "detail-subtask-add", component: "Row", align: "end", children: ["detail-subtask-new", "detail-subtask-submit"] },
        { id: "detail-subtask-new", component: "TextField", weight: 1, label: t("claxedo-tasks.subtasks.new"), value: bound("/detail/newSubtask"), submit: { event: { name: PAGE_EVENTS.addSubtask } } },
        ...surfaceButton("detail-subtask-submit", t("claxedo-tasks.subtasks.add"), PAGE_EVENTS.addSubtask, { icon: "add", context: { title: bound("/detail/newSubtask") } }),
      ]
    : [{ id: "detail-subtask-add", component: "Text", variant: "caption", text: t("claxedo-tasks.subtasks.reopen") }]
  const description = ready.children.length > 0 ? t("claxedo-tasks.subtasks.progress", { done, total: ready.children.length }) : undefined
  return [
    surfaceSection("detail-subtasks", "detail-subtasks-body", { title: t("claxedo-tasks.subtasks.title"), ...(description ? { description } : {}) }),
    surfaceColumn("detail-subtasks-body", ["detail-subtask-list", "detail-subtask-add"]),
    list,
    ...adder,
  ]
}

function statusSection(t: Translate, task: Task): SurfaceComponent[] {
  const actions = [...(task.parentTaskId ? ["detail-open-parent"] : []), ...(task.createdFrom ? ["detail-open-source"] : [])]
  const statuses = TASK_STATUSES.map((status) => ({ label: t(STATUS_LOOKS[status].key), value: status }))
  return [
    surfaceSection("detail-status-section", "detail-status-body", { title: t("claxedo-tasks.detail.statusSection"), actions }),
    surfaceColumn("detail-status-body", task.archivedAt === null ? ["detail-status", "detail-facts"] : ["detail-facts"]),
    { id: "detail-status", component: "ChoicePicker", label: t("claxedo-tasks.detail.status"), variant: "mutuallyExclusive", displayStyle: "dropdown", options: statuses, value: bound("/detail/status"), change: { event: { name: PAGE_EVENTS.status } } },
    { id: "detail-facts", component: "KeyValue", items: bound("/detail/facts") },
    ...surfaceButton("detail-open-parent", t("claxedo-tasks.detail.openParent"), PAGE_EVENTS.openParent, { variant: "borderless", icon: "arrowBack" }),
    ...surfaceButton("detail-open-source", t("claxedo-tasks.detail.createdFrom"), PAGE_EVENTS.openSource, { variant: "borderless", icon: "visibility" }),
  ]
}

function slotsView(view: PageView, ready: Ready, detail: TaskDetail): SlotsView {
  return { t: view.t, task: ready.detail.task, groups: groupLinksBySlot(ready.detail.links), presets: activePresets(view.state), progress: view.state.progress, chosen: detail.slotPresets }
}

function readyParts(view: PageView, detail: TaskDetail, ready: Ready): SurfaceComponent[] {
  const { t } = view
  const task = ready.detail.task
  const main = [...taskDetailsSection(t, detail), ...imagesSection(t, ready), ...subtasksSection(t, ready)]
  const side = [...statusSection(t, task), ...sessionsComponents(slotsView(view, ready, detail))]
  const mainIds = ["detail-details", "detail-images", "detail-subtasks"].filter((id) => main.some((part) => part.id === id))
  return [
    { id: "detail-layout", component: "Grid", columns: 2, gap: "large", children: ["detail-main", "detail-side"] },
    surfaceColumn("detail-main", mainIds),
    surfaceColumn("detail-side", ["detail-status-section", "detail-sessions"]),
    ...main,
    ...side,
    ...taskRowComponents(t),
  ]
}

function stateParts(view: PageView, load: DetailLoad): SurfaceComponent[] {
  const { t } = view
  if (load.kind === "loading") return [{ id: "detail-layout", component: "Spinner", label: t("claxedo-tasks.detail.loading") }]
  if (load.kind === "missing") return [{ id: "detail-layout", component: "EmptyState", title: t("claxedo-tasks.detail.missingTitle"), description: t("claxedo-tasks.detail.missingText") }]
  if (load.kind === "failed") {
    return [
      callout("detail-layout", "danger", t("claxedo-tasks.detail.loadFailed"), { text: load.message, action: "detail-retry" }),
      ...surfaceButton("detail-retry", t("claxedo-tasks.page.retry"), PAGE_EVENTS.retryDetail, { icon: "refresh" }),
    ]
  }
  return []
}

export function detailComponents(view: PageView, detail: TaskDetail): SurfaceComponent[] {
  const ready = detail.load.kind === "ready" ? detail.load : undefined
  const notice = ready ? noticeParts(view, detail) : []
  return [
    surfaceColumn("root", ["detail-header", ...notice.map((part) => part.id), "detail-layout"]),
    ...headerParts(view, ready?.detail.task),
    ...notice,
    ...(ready ? readyParts(view, detail, ready) : stateParts(view, detail.load)),
  ]
}

function facts(view: PageView, ready: Ready): Json[] {
  const { t } = view
  const task = ready.detail.task
  const preset = openableSlot(groupLinksBySlot(ready.detail.links))?.current.presetNameAtStart
  const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
  return [
    { label: t("claxedo-tasks.detail.project"), value: projectNameOf(view) || task.projectId },
    ...(ready.parent ? [{ label: t("claxedo-tasks.detail.parent"), value: `${taskKey(projectNameOf(view), ready.parent)} ${ready.parent.title}` }] : []),
    ...(preset ? [{ label: t("claxedo-tasks.detail.preset"), value: preset }] : []),
    ...(task.workspaceId ? [{ label: t("claxedo-tasks.detail.workspace"), value: task.workspaceId }] : []),
    { label: t("claxedo-tasks.detail.created"), value: when(task.createdAt) },
    { label: t("claxedo-tasks.detail.updated"), value: when(task.updatedAt) },
  ]
}

export function detailData(view: PageView, detail: TaskDetail): JsonObject {
  if (detail.load.kind !== "ready") return {}
  const ready = detail.load
  const context: RowContext = { t: view.t, projectName: projectNameOf(view), dateField: "updated", now: view.now, startWith: startWithPreset(view.state), showStatus: false, titleOf: () => undefined }
  const images = ready.detail.attachments.flatMap((attachment) => {
    const image = ready.images[attachment.id]
    return image?.kind === "ready" ? [{ name: attachment.filename, url: image.url }] : []
  })
  return {
    title: detail.edit.title,
    description: detail.edit.description,
    status: [ready.detail.task.status],
    facts: facts(view, ready),
    images,
    subtasks: ready.children.map((child) => taskRow(context, child)),
    newSubtask: "",
    slots: sessionsData(slotsView(view, ready, detail)),
  }
}
