import { Show, createMemo, createSignal } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { TaskStatus, TaskSummary } from "@claxedo/tasks"
import { TASK_COLLECTION_LABELS, TaskBoard, TaskList, type SubtaskProgress } from "@claxedo/tasks/solid"
import { uuid } from "@/lib/uuid"
import { useTasksAppPorts } from "../app-ports"
import { refusalOf, type TaskListFilter } from "../data/tasks-api"
import { morePages, useTaskList, useTasksClient, useTasksInvalidation, type TasksScope } from "../data/queries"
import type { TasksStore } from "../store/tasks-store"
import { DialogCreateTask } from "./dialogs/create-task-dialog"
import { TasksHeader } from "./tasks-header"
import { TasksToolbar } from "./tasks-toolbar"

export type TasksViewProps = {
  store: TasksStore
  scope: () => TasksScope
  projectId: () => string
  /** Opening a task is a navigation, which the surface owns. */
  onOpenTask: (taskId: string) => void
  onOpenPresets: () => void
}

export function TasksView(props: TasksViewProps) {
  const projects = useTasksAppPorts().useProjects()
  const dialog = useDialog()
  const client = useTasksClient()
  const invalidate = useTasksInvalidation(props.scope)
  const [busyTaskId, setBusyTaskId] = createSignal<string | undefined>()

  const filter = createMemo<TaskListFilter | undefined>(() => {
    const projectId = props.projectId()
    if (!projectId) return undefined
    return {
      projectId,
      status: props.store.state.statusFilter,
      parent: props.store.state.showChildren ? "any" : "root",
      includeArchived: props.store.state.collection === "all",
    }
  })
  const tasks = useTaskList(props.scope, filter)
  const visible = createMemo(() => props.store.visibleTasks(tasks.items()))

  const titleById = createMemo(() => new Map(visible().map((task) => [task.id, task.title])))
  const parentTitleOf = (task: TaskSummary) =>
    task.parentTaskId === null ? undefined : titleById().get(task.parentTaskId)

  /**
   * Children the same read already returned, folded per parent. Undefined
   * where none were read — a task with subtasks the list did not ask for and
   * a task with none are different answers, and "0/0" would merge them.
   */
  const progressById = createMemo(() => {
    const progress = new Map<string, SubtaskProgress>()
    if (!props.store.state.showChildren) return progress
    for (const task of visible()) {
      if (task.parentTaskId === null) continue
      const current = progress.get(task.parentTaskId) ?? { done: 0, total: 0 }
      progress.set(task.parentTaskId, {
        done: current.done + (task.status === "done" ? 1 : 0),
        total: current.total + 1,
      })
    }
    return progress
  })
  const subtaskProgress = (taskId: string) => progressById().get(taskId)

  const setStatus = async (input: { taskId: string; revision: number; status: TaskStatus }) => {
    setBusyTaskId(input.taskId)
    try {
      await client().command({ clientRequestId: uuid(), command: { type: "task.set_status", input } })
      await invalidate.everything()
      invalidate.task(input.taskId)
      props.store.taskSaved(input.taskId)
    } catch (error) {
      props.store.refuseTaskEdit(input.taskId, refusalOf(error))
    } finally {
      setBusyTaskId(undefined)
    }
  }

  const openCreate = () =>
    void dialog.show(() => (
      <DialogCreateTask
        scope={props.scope}
        projectId={props.projectId()}
        onClose={() => dialog.close()}
        onCreated={(taskId) => props.onOpenTask(taskId)}
      />
    ))

  return (
    <div class="tsk tsk-root" data-testid="tasks-view">
      <TasksHeader
        active="tasks"
        count={visible().length}
        onOpenTasks={() => {}}
        onOpenPresets={() => props.onOpenPresets()}
        action={
          <button type="button" class="tsk-button" data-variant="primary" data-testid="tasks-create" onClick={openCreate}>
            New task
          </button>
        }
      />

      <TasksToolbar store={props.store} projects={projects()} projectId={props.projectId()} />

      <Show when={tasks.error()}>
        {(error) => (
          <p class="tsk-error tsk-inset" role="alert">
            {refusalOf(error()).message}
          </p>
        )}
      </Show>

      <Show
        when={props.store.state.view === "board"}
        fallback={
          <TaskList
            tasks={visible()}
            loading={tasks.pending()}
            grouped={props.store.state.grouped}
            emptyLabel={`Nothing in ${TASK_COLLECTION_LABELS[props.store.state.collection]}.`}
            more={morePages(tasks)}
            selectedTaskId={props.store.state.selectedTaskId}
            parentTitleOf={parentTitleOf}
            subtaskProgress={subtaskProgress}
            busyTaskId={busyTaskId()}
            onSelect={(taskId) => props.onOpenTask(taskId)}
            onCreate={openCreate}
            onStatusChange={(input) => void setStatus(input)}
          />
        }
      >
        <TaskBoard
          tasks={visible()}
          more={morePages(tasks)}
          selectedTaskId={props.store.state.selectedTaskId}
          subtaskProgress={subtaskProgress}
          busyTaskId={busyTaskId()}
          onSelect={(taskId) => props.onOpenTask(taskId)}
          onCreate={openCreate}
          onStatusChange={(input) => void setStatus(input)}
        />
      </Show>
    </div>
  )
}
