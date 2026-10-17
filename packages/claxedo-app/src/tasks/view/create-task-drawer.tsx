import { createSignal, type JSX } from "solid-js"
import type { TaskCreateStatus, TaskDraft } from "@claxedo/tasks"
import { useTranslator } from "@/i18n"
import { uuid } from "@/lib/uuid"
import { FormDrawer } from "@/ui"
import { useTasksApi, useTasksInvalidation } from "../data/queries"
import { refusalOf, type TasksRefusal } from "../data/refusal"
import { tasksDictionary } from "../i18n"
import { useTaskProjects } from "../links"
import { createImageQueue } from "./image-queue"
import { TaskCreateFields } from "./task-create-fields"

function createTaskDraft(projectId: string, status: TaskCreateStatus | undefined) {
  const [draft, setDraft] = createSignal<TaskDraft>({
    projectId,
    title: "",
    description: "",
    workspaceId: null,
    parentTaskId: null,
    status: status ?? "todo",
    attachments: [],
  })
  const queue = createImageQueue({
    images: () => draft().attachments ?? [],
    setImages: (attachments) => setDraft((current) => ({ ...current, attachments: [...attachments] })),
  })
  const complete = () => queue.reading() === 0 && draft().title.trim().length > 0 && draft().projectId.length > 0
  return { draft, setDraft, queue, complete }
}

export function DrawerCreateTask(props: {
  readonly projectId: string
  readonly status?: TaskCreateStatus
  readonly onClose: () => void
  readonly onCreated?: (taskId: string) => void
}): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const api = useTasksApi()
  const projects = useTaskProjects()
  const invalidate = useTasksInvalidation()
  const task = createTaskDraft(props.projectId, props.status)
  const [busy, setBusy] = createSignal(false)
  const [refusal, setRefusal] = createSignal<TasksRefusal | undefined>()
  const submit = async () => {
    setBusy(true)
    setRefusal(undefined)
    try {
      await task.queue.drained()
      const response = await api.command({ clientRequestId: uuid(), command: { type: "task.create", input: task.draft() } })
      await invalidate.everything()
      if (response.result.type === "task.create") props.onCreated?.(response.result.task.id)
      props.onClose()
    } catch (error) {
      setRefusal(refusalOf(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <FormDrawer
      title={t("tasks.newTask")}
      submitLabel={t("tasks.create.create")}
      busyLabel={t("tasks.create.creating")}
      cancelLabel={t("tasks.cancel")}
      busy={busy()}
      canSubmit={task.complete()}
      error={refusal()?.message}
      onSubmit={() => void submit()}
      onCancel={() => props.onClose()}
    >
      <TaskCreateFields draft={task.draft()} projects={projects()} queue={task.queue} fieldErrors={refusal()?.fields} onDraftChange={task.setDraft} />
    </FormDrawer>
  )
}
