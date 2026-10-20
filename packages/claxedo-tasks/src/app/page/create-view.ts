import type { ProjectSummary, SurfaceComponent } from "@claxedo/plugin-api"
import { TASK_ATTACHMENT_MIMES, TASK_CREATE_STATUSES, TASKS_BOUNDS } from "../../contracts"
import type { Translate } from "../dictionary"
import { fieldReason } from "../refusal"
import type { JsonObject } from "../surface/json"
import { bound, callout, footer, surfaceButton, surfaceColumn, surfaceText } from "../surface/parts"
import { PAGE_EVENTS } from "./events"
import type { PageView } from "./list-view"
import { STATUS_LOOKS } from "./model"
import type { CreateForm } from "./state"

type OpenForm = Extract<CreateForm, { kind: "open" }>

export function projectOptions(projects: readonly ProjectSummary[]) {
  return projects.map((project) => ({ label: project.name, value: project.id, icon: "folder" as const }))
}

const CREATE_FIELDS = {
  title: bound("/create/title"),
  description: bound("/create/description"),
  status: bound("/create/status"),
  project: bound("/create/project"),
}

function fieldsBut(key: keyof typeof CREATE_FIELDS) {
  return Object.fromEntries(Object.entries(CREATE_FIELDS).filter(([name]) => name !== key))
}

function createNotice(t: Translate, form: OpenForm): SurfaceComponent[] {
  if (form.refusal) {
    const reasons = Object.entries(form.refusal.fields).map(([path, reason]) => `${path}: ${fieldReason(t, reason)}`).join("; ")
    return [callout("create-notice", "danger", t("claxedo-tasks.create.refused"), { text: reasons || form.refusal.message })]
  }
  if (form.problem) return [callout("create-notice", "danger", form.problem)]
  if (form.imageRefusals.length > 0) return [callout("create-notice", "warning", t("claxedo-tasks.image.refusedTitle"), { text: form.imageRefusals.join("; "), dismissible: true })]
  return []
}

function closing(t: Translate, form: OpenForm): SurfaceComponent[] {
  const submit = form.creating
    ? [{ id: "create-creating", component: "Spinner", label: t("claxedo-tasks.create.creating") } as const]
    : surfaceButton("create-submit", t("claxedo-tasks.create.submit"), PAGE_EVENTS.submitCreate, { variant: "primary", context: CREATE_FIELDS })
  return [
    footer("create-footer", [submit[0]?.id ?? "create-submit"], ["create-cancel"]),
    ...submit,
    ...surfaceButton("create-cancel", t("claxedo-tasks.create.cancel"), PAGE_EVENTS.cancelCreate, { variant: "borderless" }),
  ]
}

function imageParts(t: Translate, form: OpenForm): SurfaceComponent[] {
  const room = form.images.length < TASKS_BOUNDS.taskAttachmentsMax
  return [
    {
      id: "create-attach",
      component: "FilePicker",
      variant: "button",
      label: t("claxedo-tasks.create.attach", { max: TASKS_BOUNDS.taskAttachmentsMax }),
      accept: [...TASK_ATTACHMENT_MIMES],
      maxBytes: TASKS_BOUNDS.taskAttachmentMaxBytes,
      maxFiles: room ? TASKS_BOUNDS.taskAttachmentsMax - form.images.length : 1,
      fitImages: true,
      paste: "section",
      pick: { event: { name: PAGE_EVENTS.createImages } },
    },
    { id: "create-images", component: "List", direction: "horizontal", children: { componentId: "create-image", path: "/create/images" } },
    { id: "create-image", component: "Image", url: bound("url"), variant: "thumbnail", fit: "cover", accessibility: { label: bound("name") }, actions: ["create-image-remove"] },
    ...surfaceButton("create-image-remove", bound("removeLabel"), PAGE_EVENTS.removeImage, { variant: "borderless", icon: "close", context: { key: bound("key") } }),
  ]
}

function propertyBar(t: Translate, view: PageView): SurfaceComponent[] {
  const statuses = TASK_CREATE_STATUSES.map((status) => ({ label: t(STATUS_LOOKS[status].key), value: status, icon: STATUS_LOOKS[status].icon }))
  const projects = projectOptions(view.projects)
  return [
    { id: "create-bar", component: "Row", align: "center", children: ["create-status", ...(projects.length > 0 ? ["create-project"] : []), "create-attach"] },
    { id: "create-status", component: "ChoicePicker", label: t("claxedo-tasks.create.status"), variant: "mutuallyExclusive", displayStyle: "menu", options: statuses, value: bound("/create/status") },
    ...(projects.length > 0 ? [{ id: "create-project", component: "ChoicePicker", label: t("claxedo-tasks.create.project"), variant: "mutuallyExclusive", displayStyle: "menu", options: projects, value: bound("/create/project") } as const] : []),
  ]
}

export function createComponents(t: Translate, form: OpenForm, view: PageView): SurfaceComponent[] {
  const notice = createNotice(t, form)
  return [
    { id: "create-dialog", component: "Dialog", title: t("claxedo-tasks.create.title"), open: bound("/create/open"), child: "create-body", close: { event: { name: PAGE_EVENTS.cancelCreate } } },
    surfaceColumn("create-body", ["create-crumbs", "create-title", "create-description", ...(form.images.length > 0 ? ["create-images"] : []), ...notice.map((part) => part.id), "create-bar", "create-footer"]),
    surfaceText("create-crumbs", bound("/create/crumbs"), "caption"),
    { id: "create-title", component: "TextField", variant: "title", label: t("claxedo-tasks.create.taskTitle"), placeholder: t("claxedo-tasks.create.taskTitle"), value: bound("/create/title"), submit: { event: { name: PAGE_EVENTS.submitCreate, context: fieldsBut("title") } } },
    { id: "create-description", component: "RichTextEditor", label: t("claxedo-tasks.create.description"), placeholder: t("claxedo-tasks.create.descriptionPlaceholder"), value: bound("/create/description"), submit: { event: { name: PAGE_EVENTS.submitCreate, context: fieldsBut("description") } } },
    ...notice,
    ...propertyBar(t, view),
    ...imageParts(t, form),
    ...closing(t, form),
  ]
}

export function createData(t: Translate, form: OpenForm, view: PageView): JsonObject {
  const project = view.projects.find((entry) => entry.id === view.projectId)?.name ?? t("claxedo-tasks.page.noProject")
  return {
    key: form.key,
    open: true,
    crumbs: t("claxedo-tasks.create.crumbs", { project }),
    title: "",
    description: "",
    status: [form.status],
    project: view.projectId ? [view.projectId] : [],
    images: form.images.map((image) => ({ key: image.key, name: image.filename, removeLabel: t("claxedo-tasks.create.removeImage", { name: image.filename }), url: `data:${image.mime};base64,${image.data}` })),
  }
}
