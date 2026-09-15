import { createSignal } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import type { TaskCreateStatus } from "@claxedo/tasks"
import { TaskCreateForm } from "./task-create-form"
import { uuid } from "@/lib/uuid"
import { useTasksAppPorts } from "../../app-ports"
import { refusalOf, type TasksRefusal } from "../../data/tasks-api"
import { useTasksClient, useTasksInvalidation, type TasksScope } from "../../data/queries"

export type DialogCreateTaskProps = {
  scope: () => TasksScope
  projectId: string
  /** Which column the create was started from; To do when it was started from nowhere. */
  status?: TaskCreateStatus
  onClose: () => void
  onCreated?: (taskId: string) => void
}

export function DialogCreateTask(props: DialogCreateTaskProps) {
  const ports = useTasksAppPorts()
  const projects = ports.useProjects()
  const client = useTasksClient()
  const invalidate = useTasksInvalidation(props.scope)
  const [draft, setDraft] = createSignal({
    projectId: props.projectId,
    title: "",
    description: "",
    workspaceId: null,
    parentTaskId: null,
    status: props.status ?? ("todo" as TaskCreateStatus),
    attachments: [],
  })
  const [busy, setBusy] = createSignal(false)
  const [refusal, setRefusal] = createSignal<TasksRefusal | undefined>()

  const submit = async () => {
    setBusy(true)
    setRefusal(undefined)
    try {
      const response = await client().command({ clientRequestId: uuid(), command: { type: "task.create", input: draft() } })
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
    <Dialog title="New task" fit>
      <TaskCreateForm
        draft={draft()}
        projects={projects()}
        proseEditor={ports.ProseEditor}
        busy={busy()}
        error={refusal()?.message}
        fieldErrors={refusal()?.fields}
        onDraftChange={setDraft}
        onSubmit={() => void submit()}
        onCancel={() => props.onClose()}
      />
    </Dialog>
  )
}
