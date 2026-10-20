import type { SurfaceComponent } from "@claxedo/plugin-api"
import type { Task } from "../../contracts"
import type { Translate } from "../dictionary"
import type { Json, JsonObject } from "../surface/json"
import { bound, callout, footer, surfaceButton, surfaceColumn, surfaceSection, surfaceText } from "../surface/parts"
import { PAGE_EVENTS } from "./events"
import type { PageView } from "./list-view"
import { projectNameOf, rowContext } from "./list-view"
import { groupLinksBySlot, openableSlot, taskKey } from "./model"
import { statusOptions, taskRow, taskRowComponents } from "./row-items"
import { sessionsComponents, sessionsData, type SlotsView } from "./sessions-view"
import { activePresets, type DetailLoad, type TaskDetail } from "./state"

type Ready = Extract<DetailLoad, { kind: "ready" }>

export function hasUnsavedEdits(detail: TaskDetail): boolean {
  if (detail.load.kind !== "ready") return false
  const task = detail.load.detail.task
  return detail.edit.title !== task.title || detail.edit.description !== task.description
}

function crumbs(view: PageView, task: Task | undefined): SurfaceComponent[] {
  const { t } = view
  const trail = task ? [projectNameOf(view) || task.projectId, taskKey(projectNameOf(view), task)].join(" › ") : undefined
  return [
    { id: "detail-crumbs", component: "Row", align: "center", children: ["detail-back", ...(trail ? ["detail-trail"] : [])] },
    ...surfaceButton("detail-back", t("claxedo-tasks.page.title"), PAGE_EVENTS.back, { variant: "borderless", icon: "arrowBack" }),
    ...(trail ? [surfaceText("detail-trail", trail, "caption")] : []),
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

function editors(t: Translate): SurfaceComponent[] {
  const edits = { title: bound("/detail/title"), description: bound("/detail/description") }
  return [
    { id: "detail-title", component: "TextField", variant: "title", label: t("claxedo-tasks.detail.taskTitle"), placeholder: t("claxedo-tasks.detail.untitled"), value: bound("/detail/title"), submit: { event: { name: PAGE_EVENTS.save, context: { description: edits.description } } }, change: { event: { name: PAGE_EVENTS.edited, context: { description: edits.description } } } },
    { id: "detail-description", component: "RichTextEditor", label: t("claxedo-tasks.detail.description"), placeholder: t("claxedo-tasks.create.descriptionPlaceholder"), value: bound("/detail/description"), submit: { event: { name: PAGE_EVENTS.save, context: { title: edits.title } } }, change: { event: { name: PAGE_EVENTS.edited, context: { title: edits.title } } } },
  ]
}

function saveBar(t: Translate, detail: TaskDetail): SurfaceComponent[] {
  if (!hasUnsavedEdits(detail) && !detail.saving) return []
  const edits = { title: bound("/detail/title"), description: bound("/detail/description") }
  const save = detail.saving
    ? [{ id: "detail-save", component: "Spinner", label: t("claxedo-tasks.detail.saving") } as const]
    : surfaceButton("detail-save", t("claxedo-tasks.detail.save"), PAGE_EVENTS.save, { variant: "primary", context: edits })
  return [
    footer("detail-savebar", ["detail-discard", "detail-save"], ["detail-unsaved"], { sticky: true }),
    surfaceText("detail-unsaved", t("claxedo-tasks.detail.unsaved"), "caption"),
    ...surfaceButton("detail-discard", t("claxedo-tasks.detail.discard"), PAGE_EVENTS.discard, { variant: "borderless", context: edits }),
    ...save,
  ]
}

function imagesSection(t: Translate, ready: Ready): SurfaceComponent[] {
  const attachments = ready.detail.attachments
  if (attachments.length === 0) return []
  const loading = attachments.some((attachment) => ready.images[attachment.id]?.kind !== "ready" && ready.images[attachment.id]?.kind !== "failed")
  const failed = attachments.filter((attachment) => ready.images[attachment.id]?.kind === "failed")
  const notice = failed.length > 0 ? [callout("detail-images-notice", "warning", failed.map((attachment) => t("claxedo-tasks.images.failed", { name: attachment.filename })).join("; "))] : []
  return [
    surfaceSection("detail-images", "detail-images-body", { title: t("claxedo-tasks.images.title"), plain: true }),
    surfaceColumn("detail-images-body", [...notice.map((part) => part.id), "detail-image-list", ...(loading ? ["detail-images-loading"] : [])]),
    ...notice,
    { id: "detail-image-list", component: "List", direction: "horizontal", children: { componentId: "detail-image", path: "/detail/images" } },
    { id: "detail-image", component: "Image", url: bound("url"), variant: "smallFeature", fit: "cover", accessibility: { label: bound("name") } },
    { id: "detail-images-loading", component: "Spinner", label: t("claxedo-tasks.images.loading") },
  ]
}

function subtasksSection(t: Translate, ready: Ready): SurfaceComponent[] {
  const task = ready.detail.task
  if (task.parentTaskId !== null) return []
  const done = ready.children.filter((child) => child.status === "done").length
  const canAdd = task.status !== "done" && task.archivedAt === null
  const adder: SurfaceComponent = canAdd
    ? { id: "detail-subtask-new", component: "TextField", variant: "inline", label: t("claxedo-tasks.subtasks.new"), placeholder: t("claxedo-tasks.subtasks.add"), value: bound("/detail/newSubtask"), submit: { event: { name: PAGE_EVENTS.addSubtask } } }
    : surfaceText("detail-subtask-new", t("claxedo-tasks.subtasks.reopen"), "caption")
  const description = ready.children.length > 0 ? t("claxedo-tasks.subtasks.progress", { done, total: ready.children.length }) : undefined
  return [
    surfaceSection("detail-subtasks", "detail-subtasks-body", { title: t("claxedo-tasks.subtasks.title"), ...(description ? { description } : {}), plain: true }),
    surfaceColumn("detail-subtasks-body", [...(ready.children.length > 0 ? ["detail-subtask-list"] : []), "detail-subtask-new"]),
    { id: "detail-subtask-list", component: "List", children: { componentId: "task-row", path: "/detail/subtasks" } },
    adder,
  ]
}

function propertyColumn(view: PageView, ready: Ready): SurfaceComponent[] {
  const { t } = view
  const task = ready.detail.task
  const archived = task.archivedAt !== null
  const preset = openableSlot(groupLinksBySlot(ready.detail.links))?.current.presetNameAtStart
  const when = (at: number) => new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" })
  const items = [
    archived ? { label: t("claxedo-tasks.detail.status"), value: t("claxedo-tasks.row.archived") } : { label: t("claxedo-tasks.detail.status"), child: "detail-status" },
    { label: t("claxedo-tasks.detail.project"), value: projectNameOf(view) || task.projectId },
    ...(ready.parent ? [{ label: t("claxedo-tasks.detail.parent"), child: "detail-open-parent" }] : []),
    ...(preset ? [{ label: t("claxedo-tasks.detail.preset"), value: preset }] : []),
    ...(task.createdFrom ? [{ label: t("claxedo-tasks.detail.source"), child: "detail-open-source" }] : []),
    { label: t("claxedo-tasks.detail.created"), value: when(task.createdAt) },
    { label: t("claxedo-tasks.detail.updated"), value: when(task.updatedAt) },
  ]
  const parentLabel = ready.parent ? `${taskKey(projectNameOf(view), ready.parent)} ${ready.parent.title}` : ""
  return [
    surfaceColumn("detail-aside", ["detail-props", "detail-archive"]),
    { id: "detail-props", component: "KeyValue", items },
    { id: "detail-status", component: "ChoicePicker", label: t("claxedo-tasks.detail.status"), variant: "mutuallyExclusive", displayStyle: "menu", options: statusOptions(t), value: bound("/detail/status"), change: { event: { name: PAGE_EVENTS.status } } },
    ...surfaceButton("detail-open-parent", parentLabel, PAGE_EVENTS.openParent, { variant: "borderless" }),
    ...surfaceButton("detail-open-source", t("claxedo-tasks.detail.createdFrom"), PAGE_EVENTS.openSource, { variant: "borderless", icon: "visibility" }),
    ...surfaceButton("detail-archive", t(archived ? "claxedo-tasks.detail.restore" : "claxedo-tasks.detail.archive"), archived ? PAGE_EVENTS.restore : PAGE_EVENTS.archive, { variant: "borderless", icon: archived ? "refresh" : "archive" }),
  ]
}

function slotsView(view: PageView, ready: Ready, detail: TaskDetail): SlotsView {
  return { t: view.t, task: ready.detail.task, groups: groupLinksBySlot(ready.detail.links), presets: activePresets(view.state), progress: view.state.progress, chosen: detail.slotPresets }
}

function readyParts(view: PageView, detail: TaskDetail, ready: Ready): SurfaceComponent[] {
  const { t } = view
  const body = [...imagesSection(t, ready), ...subtasksSection(t, ready)]
  const bodyIds = ["detail-images", "detail-subtasks"].filter((id) => body.some((part) => part.id === id))
  return [
    { id: "detail-layout", component: "Grid", layout: "sidebar", children: ["detail-title", "detail-description", ...bodyIds, "detail-sessions", "detail-aside"] },
    ...editors(t),
    ...body,
    ...sessionsComponents(slotsView(view, ready, detail)),
    ...propertyColumn(view, ready),
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
  const bar = ready ? saveBar(view.t, detail) : []
  return [
    surfaceColumn("root", ["detail-crumbs", ...notice.map((part) => part.id), "detail-layout", ...bar.slice(0, 1).map((part) => part.id)]),
    ...crumbs(view, ready?.detail.task),
    ...notice,
    ...(ready ? readyParts(view, detail, ready) : stateParts(view, detail.load)),
    ...bar,
  ]
}

export function detailData(view: PageView, detail: TaskDetail): JsonObject {
  if (detail.load.kind !== "ready") return {}
  const ready = detail.load
  const context = rowContext(view)
  const images: Json[] = ready.detail.attachments.flatMap((attachment) => {
    const image = ready.images[attachment.id]
    return image?.kind === "ready" ? [{ name: attachment.filename, url: image.url }] : []
  })
  return {
    title: detail.edit.title,
    description: detail.edit.description,
    status: [ready.detail.task.status],
    images,
    subtasks: ready.children.map((child) => taskRow({ ...context, keyOf: () => undefined }, child)),
    newSubtask: "",
    slots: sessionsData(slotsView(view, ready, detail)),
  }
}
