import { Show, createMemo } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { TaskCreateStatus, TaskStatus, TaskSummary } from "@claxedo/tasks"
import { TASK_COLLECTION_LABELS, TASK_COLLECTION_STATUSES } from "../view-model"
import { TaskBoard } from "./board/task-board"
import { TaskList } from "./list/task-list"
import { uuid } from "@/lib/uuid"
import { useTasksAppPorts } from "../app-ports"
import { refusalOf, type TaskListFilter } from "../data/tasks-api"
import { morePages, useTaskList, useTasksClient, useTasksInvalidation, type TasksScope } from "../data/queries"
import { useTaskStartOffers } from "../data/start-task"
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
}

export function TasksView(props: TasksViewProps) {
  const ports = useTasksAppPorts()
  const projects = ports.useProjects()
  const dialog = useDialog()
  const client = useTasksClient()
  const invalidate = useTasksInvalidation(props.scope)
  const offers = useTaskStartOffers(props.scope, props.store)

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

  // The store counts every live child; the list only renders what it is told.
  // Folding the page's own rows reported `0/1` for a parent whose open child
  // the Active filter had already excluded.
  const subtaskProgress = (taskId: string) =>
    visible().find((task) => task.id === taskId)?.children

  const startOffer = (task: TaskSummary) =>
    offers.offerFor(task, {
      // A row knows a session exists from its link count; which one is current
      // is read when Open is pressed, because liveness is not in a list read.
      onOpen: task.links.count > 0 ? () => void offers.openLatestSession(task.id) : undefined,
    })

  const setStatus = (input: { taskId: string; revision: number; status: TaskStatus }) =>
    offers.busyWhile(input.taskId, async () => {
      try {
        await client().command({ clientRequestId: uuid(), command: { type: "task.set_status", input } })
        await invalidate.afterCommand(input.taskId)
        props.store.taskSaved(input.taskId)
      } catch (error) {
        props.store.refuseTaskEdit(input.taskId, refusalOf(error))
      }
    })

  const openCreate = (status?: TaskCreateStatus) =>
    void dialog.show(() => (
      <DialogCreateTask
        scope={props.scope}
        projectId={props.projectId()}
        status={status}
        onClose={() => dialog.close()}
        onCreated={(taskId) => props.onOpenTask(taskId)}
      />
    ))

  // The list spans one project, so every key on the page is derived from this
  // name; an any-project read does not exist, which is why no row names it.
  const projectName = () => projects().find((entry) => entry.id === props.projectId())?.label ?? ""

  return (
    <div class="tsk tsk-root" data-testid="tasks-view">
      <TasksHeader
        title="Tasks"
        count={visible().length}
        action={
          <Button variant="primary" size="small" data-testid="tasks-create" onClick={() => openCreate()}>
            New task
          </Button>
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
            projectName={projectName()}
            dateField={props.store.state.dateField}
            loading={tasks.pending()}
            grouped={props.store.state.grouped}
            emptyLabel={`Nothing in ${TASK_COLLECTION_LABELS[props.store.state.collection]}.`}
            more={morePages(tasks)}
            selectedTaskId={props.store.state.selectedTaskId}
            parentTitleOf={parentTitleOf}
            subtaskProgress={subtaskProgress}
            startOffer={startOffer}
            busyTaskId={offers.busyTaskId()}
            onSelect={(taskId) => props.onOpenTask(taskId)}
            onCreate={() => openCreate()}
            onStatusChange={(input) => void setStatus(input)}
          />
        }
      >
        <TaskBoard
          tasks={visible()}
          statuses={TASK_COLLECTION_STATUSES[props.store.state.collection]}
          projectName={projectName()}
          dateField={props.store.state.dateField}
          more={morePages(tasks)}
          selectedTaskId={props.store.state.selectedTaskId}
          subtaskProgress={subtaskProgress}
          startOffer={startOffer}
          busyTaskId={offers.busyTaskId()}
          onSelect={(taskId) => props.onOpenTask(taskId)}
          onCreate={openCreate}
          onStatusChange={(input) => void setStatus(input)}
        />
      </Show>
    </div>
  )
}
