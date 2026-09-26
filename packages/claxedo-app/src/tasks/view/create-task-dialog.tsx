import { createSignal, type JSX } from "solid-js"
import type { TaskCreateStatus, TaskDraft } from "@claxedo/tasks"
import { useTranslator } from "@/i18n"
import { uuid } from "@/lib/uuid"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@/ui"
import { useTasksApi, useTasksInvalidation } from "../data/queries"
import { refusalOf, type TasksRefusal } from "../data/refusal"
import { tasksDictionary } from "../i18n"
import { useTaskProjects } from "../links"
import { TaskCreateForm } from "./task-create-form"

export function DialogCreateTask(props: {
  readonly projectId: string
  readonly status?: TaskCreateStatus
  readonly onClose: () => void
  readonly onCreated?: (taskId: string) => void
}): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const api = useTasksApi()
  const projects = useTaskProjects()
  const invalidate = useTasksInvalidation()
  const [draft, setDraft] = createSignal<TaskDraft>({
    projectId: props.projectId,
    title: "",
    description: "",
    workspaceId: null,
    parentTaskId: null,
    status: props.status ?? "todo",
    attachments: [],
  })
  const [busy, setBusy] = createSignal(false)
  const [refusal, setRefusal] = createSignal<TasksRefusal | undefined>()
  const submit = async () => {
    setBusy(true)
    setRefusal(undefined)
    try {
      const response = await api.client.command({
        clientRequestId: uuid(),
        command: { type: "task.create", input: draft() },
      })
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
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{t("tasks.newTask")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="px-4 pb-4">
      <TaskCreateForm
        draft={draft()}
        projects={projects()}
        busy={busy()}
        error={refusal()?.message}
        fieldErrors={refusal()?.fields}
        onDraftChange={setDraft}
        onSubmit={() => void submit()}
        onCancel={() => props.onClose()}
      />
      </DialogBody>
    </Dialog>
  )
}
