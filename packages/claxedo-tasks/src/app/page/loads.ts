import { TasksApiError, type TasksClient } from "../../client/client"
import { encodeAttachmentData } from "../../attachments"
import type { TaskAttachment, TaskSummary } from "../../contracts"
import { allPages, allPresets } from "../paging"
import { tasksRefusalOf } from "../refusal"
import type { PageModel } from "./page-model"
import type { AttachmentImage, DetailLoad, TaskDetail } from "./state"

function listQuery(model: PageModel, projectId: string) {
  const state = model.state()
  return { projectId, status: null, parent: "any" as const, includeArchived: state.collection === "all" }
}

export function createListLoads(model: PageModel) {
  const { deps } = model
  let generation = 0
  const reload = async (quiet = false) => {
    const projectId = model.projectId()
    const current = ++generation
    if (!projectId) return model.patch({ list: { kind: "idle" } })
    if (!quiet || model.state().list.kind !== "ready") model.patch({ list: { kind: "loading" } })
    try {
      const page = await deps.client.listTasks({ ...listQuery(model, projectId), cursor: null })
      if (current === generation) model.patch({ list: { kind: "ready", tasks: page.items, nextCursor: page.nextCursor ?? null, more: "idle" } })
    } catch (error) {
      if (current === generation) model.patch({ list: { kind: "failed", message: tasksRefusalOf(error, deps.t).message } })
    }
  }
  const more = async () => {
    const list = model.state().list
    const projectId = model.projectId()
    if (list.kind !== "ready" || !list.nextCursor || list.more === "loading" || !projectId) return
    const current = generation
    model.patch({ list: { ...list, more: "loading" } })
    try {
      const page = await deps.client.listTasks({ ...listQuery(model, projectId), cursor: list.nextCursor })
      const latest = model.state().list
      if (current === generation && latest.kind === "ready") model.patch({ list: { kind: "ready", tasks: [...latest.tasks, ...page.items], nextCursor: page.nextCursor ?? null, more: "idle" } })
    } catch (error) {
      console.warn("The next page of tasks did not load", error)
      const latest = model.state().list
      if (current === generation && latest.kind === "ready") model.patch({ list: { ...latest, more: "failed" } })
    }
  }
  const presets = async () => {
    try {
      const loaded = await allPresets(deps.client, false)
      model.patch({ presets: { kind: "ready", presets: loaded } })
    } catch (error) {
      model.patch({ presets: { kind: "failed", message: tasksRefusalOf(error, deps.t).message } })
    }
  }
  return { reload, more, presets }
}

async function imageUrl(client: TasksClient, taskId: string, attachment: TaskAttachment): Promise<AttachmentImage> {
  try {
    const blob = await client.readAttachment(taskId, attachment.id)
    const data = encodeAttachmentData(new Uint8Array(await blob.arrayBuffer()))
    return { kind: "ready", url: `data:${attachment.mime};base64,${data}` }
  } catch (error) {
    console.warn("A task image did not load", { attachment: attachment.id, error })
    return { kind: "failed" }
  }
}

function patchLoadedDetail(model: PageModel, taskId: string, change: (detail: TaskDetail) => TaskDetail) {
  model.patch((state) => (state.detail?.taskId === taskId ? { detail: change(state.detail) } : {}))
}

async function readyLoad(model: PageModel, taskId: string): Promise<DetailLoad> {
  const { client } = model.deps
  const detail = await client.getTask(taskId)
  const task = detail.task
  const children: readonly TaskSummary[] = task.parentTaskId === null ? await allPages((cursor) => client.listChildren(taskId, { cursor })) : []
  const parent = task.parentTaskId === null ? undefined : (await client.getTask(task.parentTaskId)).task
  const previous = model.state().detail
  const images = previous?.taskId === taskId && previous.load.kind === "ready" ? previous.load.images : {}
  return { kind: "ready", detail, children, ...(parent ? { parent } : {}), images }
}

export function createDetailLoads(model: PageModel) {
  const { deps } = model
  let generation = 0
  const loadImages = (taskId: string, load: Extract<DetailLoad, { kind: "ready" }>) => {
    for (const attachment of load.detail.attachments) {
      if (load.images[attachment.id]) continue
      void imageUrl(deps.client, taskId, attachment).then((image) =>
        patchLoadedDetail(model, taskId, (detail) => (detail.load.kind === "ready" ? { ...detail, load: { ...detail.load, images: { ...detail.load.images, [attachment.id]: image } } } : detail)),
      )
    }
  }
  return async (taskId: string) => {
    const current = ++generation
    try {
      const load = await readyLoad(model, taskId)
      if (current !== generation || load.kind !== "ready") return
      const task = load.detail.task
      patchLoadedDetail(model, taskId, (detail) => ({ ...detail, load, revision: task.revision, edit: { title: task.title, description: task.description } }))
      loadImages(taskId, load)
    } catch (error) {
      if (current !== generation) return
      const missing = error instanceof TasksApiError && (error.code === "not_found" || error.code === "forbidden")
      patchLoadedDetail(model, taskId, (detail) => ({ ...detail, load: missing ? { kind: "missing" } : { kind: "failed", message: tasksRefusalOf(error, deps.t).message } }))
    }
  }
}
