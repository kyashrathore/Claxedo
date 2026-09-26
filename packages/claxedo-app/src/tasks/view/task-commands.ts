import { createSignal } from "solid-js"
import type { Task, TaskSessionLinkView, TaskStatus, TasksCommand } from "@claxedo/tasks"
import { uuid } from "@/lib/uuid"
import { useTasksApi, useTasksInvalidation } from "../data/queries"
import { refusalOf } from "../data/refusal"
import type { TasksStore } from "../store"

type BusyWhile = <T>(taskId: string, run: () => Promise<T>) => Promise<T>

function editInput(store: TasksStore, task: Task) {
  const draft = store.editDraft(task)
  return {
    taskId: task.id,
    revision: draft.revision,
    title: draft.title,
    description: draft.description,
    workspaceId: task.workspaceId,
  }
}

function subtaskInput(task: Task, title: string) {
  return { projectId: task.projectId, title, description: "", workspaceId: task.workspaceId, parentTaskId: task.id }
}

export function createTaskCommands(store: TasksStore, busyWhile: BusyWhile) {
  const api = useTasksApi()
  const invalidate = useTasksInvalidation()
  const run = (command: TasksCommand, taskId: string) =>
    busyWhile(taskId, async () => {
      try {
        await api.client.command({ clientRequestId: uuid(), command })
        await invalidate.afterCommand(taskId)
        store.taskSaved(taskId)
      } catch (error) {
        store.refuseTaskEdit(taskId, refusalOf(error))
      }
    })
  const revisionOf = (task: Task) => store.editDraft(task).revision
  return {
    setStatus: (input: { taskId: string; revision: number; status: TaskStatus }) =>
      void run({ type: "task.set_status", input }, input.taskId),
    save: (task: Task) => void run({ type: "task.edit", input: editInput(store, task) }, task.id),
    archive: (task: Task) =>
      void run({ type: "task.archive", input: { taskId: task.id, revision: revisionOf(task) } }, task.id),
    restore: (task: Task) =>
      void run({ type: "task.restore", input: { taskId: task.id, revision: revisionOf(task) } }, task.id),
    addSubtask: (task: Task, title: string) =>
      void run({ type: "task.create", input: subtaskInput(task, title) }, task.id),
  }
}

export function createSendTask(busyWhile: BusyWhile) {
  const api = useTasksApi()
  const invalidate = useTasksInvalidation()
  const [error, setError] = createSignal<string | undefined>()
  const send = (task: Task, link: TaskSessionLinkView) =>
    busyWhile(task.id, async () => {
      const request = {
        taskRevision: task.revision,
        presetId: link.presetId,
        presetRevision: link.presetRevision,
        slot: link.slot,
        attempt: link.attempt,
        continueFromPrevious: false,
      }
      setError(undefined)
      try {
        const previewed = await api.client.startPreview(task.id, request)
        await api.client.start(task.id, {
          ...request,
          clientRequestId: uuid(),
          previewDigest: previewed.preview.digest,
          handoffText: null,
        })
      } catch (cause) {
        setError(refusalOf(cause).message)
      } finally {
        await invalidate.afterCommand(task.id)
      }
    })
  return { error, send }
}
