import type { Task, TasksCommand, TaskStatus, TaskSummary } from "../../contracts"
import { tasksRefusalOf } from "../refusal"
import type { PageModel } from "./page-model"
import type { TaskDetail } from "./state"

export type TaskReloads = {
  readonly list: (quiet?: boolean) => Promise<void>
  readonly detail: (taskId: string) => Promise<void>
}

function patchOpenDetail(model: PageModel, change: (detail: TaskDetail) => Partial<TaskDetail>) {
  model.patch((state) => (state.detail ? { detail: { ...state.detail, ...change(state.detail) } } : {}))
}

export function createTaskCommands(model: PageModel, reloads: TaskReloads) {
  const { deps } = model
  const send = (command: TasksCommand) => deps.client.command({ clientRequestId: deps.requestId(), command })
  const refresh = async () => {
    const detail = model.state().detail
    await Promise.all([reloads.list(true), ...(detail && model.state().route.kind === "detail" ? [reloads.detail(detail.taskId)] : [])])
  }
  const setStatus = async (task: Pick<TaskSummary, "id" | "revision" | "title">, status: TaskStatus): Promise<boolean> => {
    try {
      await send({ type: "task.set_status", input: { taskId: task.id, revision: task.revision, status } })
      await refresh()
      return true
    } catch (error) {
      model.patch({ listNotice: `${deps.t("claxedo-tasks.move.refused", { title: task.title })}: ${tasksRefusalOf(error, deps.t).message}` })
      await refresh()
      return false
    }
  }
  const save = async (task: Task, title: string, description: string) => {
    const revision = model.state().detail?.revision ?? task.revision
    patchOpenDetail(model, () => ({ saving: true, error: undefined }))
    try {
      await send({ type: "task.edit", input: { taskId: task.id, revision, title: title.replace(/[\r\n]+/g, " "), description, workspaceId: task.workspaceId } })
      patchOpenDetail(model, () => ({ saving: false, conflictTitle: undefined, edit: { title, description } }))
      await refresh()
    } catch (error) {
      const refusal = tasksRefusalOf(error, deps.t)
      const current = refusal.stale?.task
      patchOpenDetail(model, () => (current ? { saving: false, revision: current.revision, conflictTitle: current.title, edit: { title, description } } : { saving: false, error: refusal.message, edit: { title, description } }))
    }
  }
  const archive = async (task: Pick<Task, "id" | "title" | "revision">, restore: boolean) => {
    if (!restore) {
      const confirmed = await deps.ui.confirm({ title: deps.t("claxedo-tasks.detail.archiveConfirm", { title: task.title }), description: deps.t("claxedo-tasks.detail.archiveConfirmText"), confirmLabel: deps.t("claxedo-tasks.detail.archive") })
      if (!confirmed) return
    }
    const detail = model.state().detail
    const revision = detail?.taskId === task.id ? (detail.revision ?? task.revision) : task.revision
    try {
      await send({ type: restore ? "task.restore" : "task.archive", input: { taskId: task.id, revision } })
    } catch (error) {
      patchOpenDetail(model, () => ({ error: tasksRefusalOf(error, deps.t).message }))
    }
    await refresh()
  }
  const addSubtask = async (task: Task, title: string) => {
    if (title.trim().length === 0) return
    try {
      await send({ type: "task.create", input: { projectId: task.projectId, title: title.trim(), description: "", workspaceId: task.workspaceId, parentTaskId: task.id } })
      patchOpenDetail(model, () => ({ error: undefined }))
    } catch (error) {
      patchOpenDetail(model, () => ({ error: tasksRefusalOf(error, deps.t).message }))
    }
    await refresh()
  }
  return { setStatus, save, archive, addSubtask, refresh }
}

export type TaskCommands = ReturnType<typeof createTaskCommands>
