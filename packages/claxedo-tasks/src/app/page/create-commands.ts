import { asRecord } from "@claxedo/helpers/guards"
import { isTaskAttachmentMime, isTaskCreateStatus, TASKS_BOUNDS, type TaskCreateStatus } from "../../contracts"
import type { Translate } from "../dictionary"
import { tasksRefusalOf } from "../refusal"
import type { PageModel } from "./page-model"
import type { CreateForm, ImageDraft } from "./state"

type OpenForm = Extract<CreateForm, { kind: "open" }>

const MIB = 1024 * 1024

function pickedFiles(value: unknown): { readonly name: string; readonly mimeType: string; readonly dataBase64: string }[] {
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    const file = asRecord(entry)
    return typeof file?.name === "string" && typeof file.mimeType === "string" && typeof file.dataBase64 === "string" ? [{ name: file.name, mimeType: file.mimeType, dataBase64: file.dataBase64 }] : []
  })
}

function imageRefusalText(t: Translate, entry: unknown): string | undefined {
  const refused = asRecord(entry)
  const name = typeof refused?.name === "string" ? refused.name : ""
  if (refused?.reason === "count") return t("claxedo-tasks.image.count", { max: TASKS_BOUNDS.taskAttachmentsMax })
  if (refused?.reason === "size") return t("claxedo-tasks.image.size", { name, limit: Math.round((TASKS_BOUNDS.taskAttachmentMaxBytes / MIB) * 10) / 10 })
  if (refused?.reason === "type") return t("claxedo-tasks.image.type", { name })
  return undefined
}

export function pickedImages(t: Translate, form: OpenForm, files: unknown, refused: unknown, nextKey: () => string): OpenForm {
  const accepted: ImageDraft[] = []
  const refusals = (Array.isArray(refused) ? refused : []).flatMap((entry) => imageRefusalText(t, entry) ?? [])
  for (const file of pickedFiles(files)) {
    if (!isTaskAttachmentMime(file.mimeType)) refusals.push(t("claxedo-tasks.image.type", { name: file.name }))
    else if (form.images.length + accepted.length >= TASKS_BOUNDS.taskAttachmentsMax) refusals.push(t("claxedo-tasks.image.count", { max: TASKS_BOUNDS.taskAttachmentsMax }))
    else accepted.push({ key: nextKey(), filename: file.name, mime: file.mimeType, data: file.dataBase64 })
  }
  return { ...form, images: [...form.images, ...accepted], imageRefusals: [...new Set(refusals)] }
}

export function openForm(key: number, status: TaskCreateStatus): OpenForm {
  return { kind: "open", key, status, images: [], imageRefusals: [], creating: false }
}

export type CreateInput = { readonly title: string; readonly description: string; readonly status: unknown; readonly projectId: string }

function firstOf(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value
}

function createStatusOf(value: unknown): TaskCreateStatus {
  const first = firstOf(value)
  return isTaskCreateStatus(first) ? first : "todo"
}

export function createProjectOf(value: unknown): string {
  const first = firstOf(value)
  return typeof first === "string" ? first : ""
}

function formOf(model: PageModel): OpenForm | undefined {
  const form = model.state().create
  return form.kind === "open" ? form : undefined
}

export function createTaskCreation(model: PageModel, created: (taskId: string) => void) {
  const { deps } = model
  return async (input: CreateInput) => {
    const form = formOf(model)
    if (!form || form.creating) return
    const problem = input.title.trim().length === 0 ? deps.t("claxedo-tasks.create.titleRequired") : input.projectId.length === 0 ? deps.t("claxedo-tasks.create.projectRequired") : undefined
    if (problem) return model.patch({ create: { ...form, problem, refusal: undefined } })
    model.patch({ create: { ...form, creating: true, problem: undefined, refusal: undefined } })
    const attachments = form.images.map((image) => ({ filename: image.filename, mime: image.mime, data: image.data }))
    try {
      const response = await deps.client.command({
        clientRequestId: deps.requestId(),
        command: { type: "task.create", input: { projectId: input.projectId, title: input.title.trim(), description: input.description, workspaceId: null, parentTaskId: null, status: createStatusOf(input.status), attachments } },
      })
      model.patch({ create: { kind: "closed" }, ...(input.projectId === model.projectId() ? {} : { chosenProjectId: input.projectId }) })
      deps.ui.toast({ kind: "success", title: deps.t("claxedo-tasks.create.created") })
      if (response.result.type === "task.create") created(response.result.task.id)
    } catch (error) {
      const latest = formOf(model)
      if (latest) model.patch({ create: { ...latest, creating: false, refusal: tasksRefusalOf(error, deps.t) } })
    }
  }
}
