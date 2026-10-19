import type { ProjectSummary, SurfaceComponent } from "@claxedo/plugin-api"
import { TASK_ATTACHMENT_MIMES, TASK_CREATE_STATUSES, TASKS_BOUNDS } from "../../contracts"
import type { Translate } from "../dictionary"
import { fieldReason } from "../refusal"
import type { JsonObject } from "../surface/json"
import { bound, callout, footer, surfaceButton, surfaceColumn, surfaceSection } from "../surface/parts"
import { PAGE_EVENTS } from "./events"
import { STATUS_LOOKS } from "./model"
import type { CreateForm } from "./state"

type OpenForm = Extract<CreateForm, { kind: "open" }>

const CREATE_CONTEXT = {
  title: bound("/create/title"),
  description: bound("/create/description"),
  status: bound("/create/status"),
  project: bound("/create/project"),
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
    : surfaceButton("create-submit", t("claxedo-tasks.create.submit"), PAGE_EVENTS.submitCreate, { variant: "primary", context: CREATE_CONTEXT })
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
      id: "create-images",
      component: "FilePicker",
      label: t("claxedo-tasks.create.images"),
      accept: [...TASK_ATTACHMENT_MIMES],
      maxBytes: TASKS_BOUNDS.taskAttachmentMaxBytes,
      maxFiles: room ? TASKS_BOUNDS.taskAttachmentsMax - form.images.length : 1,
      fitImages: true,
      paste: "section",
      pick: { event: { name: PAGE_EVENTS.createImages } },
    },
    { id: "create-previews", component: "Grid", columns: 4, gap: "small", children: { componentId: "create-preview", path: "/create/images" } },
    surfaceColumn("create-preview", ["create-preview-image", "create-preview-remove"]),
    { id: "create-preview-image", component: "Image", url: bound("url"), variant: "smallFeature", fit: "cover", accessibility: { label: bound("name") } },
    ...surfaceButton("create-preview-remove", t("claxedo-tasks.create.removeImage"), PAGE_EVENTS.removeImage, { variant: "borderless", icon: "close", context: { key: bound("key") } }),
  ]
}

export function createComponents(t: Translate, form: OpenForm, projects: readonly ProjectSummary[]): SurfaceComponent[] {
  const notice = createNotice(t, form)
  const statuses = TASK_CREATE_STATUSES.map((status) => ({ label: t(STATUS_LOOKS[status].key), value: status }))
  return [
    surfaceSection("create", "create-body", { title: t("claxedo-tasks.create.title") }),
    surfaceColumn("create-body", [...notice.map((part) => part.id), "create-title", "create-description", "create-grid", "create-images", "create-previews", "create-footer"]),
    ...notice,
    { id: "create-title", component: "TextField", label: t("claxedo-tasks.create.taskTitle"), value: bound("/create/title"), submit: { event: { name: PAGE_EVENTS.submitCreate, context: { description: bound("/create/description"), status: bound("/create/status"), project: bound("/create/project") } } } },
    { id: "create-description", component: "TextField", label: t("claxedo-tasks.create.description"), variant: "longText", value: bound("/create/description") },
    { id: "create-grid", component: "Grid", columns: 2, children: ["create-status", "create-project"] },
    { id: "create-status", component: "ChoicePicker", label: t("claxedo-tasks.create.status"), variant: "mutuallyExclusive", displayStyle: "chips", options: statuses, value: bound("/create/status") },
    { id: "create-project", component: "Combobox", label: t("claxedo-tasks.create.project"), value: bound("/create/project"), options: projects.map((project) => ({ label: project.name, value: project.id })), placeholder: t("claxedo-tasks.toolbar.projectSearch") },
    ...imageParts(t, form),
    ...closing(t, form),
  ]
}

export function createData(t: Translate, form: OpenForm, projectId: string | undefined): JsonObject {
  return {
    key: form.key,
    title: "",
    description: "",
    status: [form.status],
    project: projectId ?? "",
    images: form.images.map((image) => ({ key: image.key, name: image.filename, url: `data:${image.mime};base64,${image.data}` })),
  }
}
