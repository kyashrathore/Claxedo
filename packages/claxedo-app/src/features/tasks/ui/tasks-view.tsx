import { For, Show, createMemo, createSignal } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { TASK_STATUSES, isTaskStatus, type ConfigurationSlot, type Task, type TaskStatus } from "@claxedo/tasks"
import {
  TASK_COLLECTIONS,
  TASK_COLLECTION_LABELS,
  TASK_STATUS_LABELS,
  TaskBoard,
  TaskList,
} from "@claxedo/tasks/solid"
import { uuid } from "@/lib/uuid"
import { useTasksAppPorts } from "../app-ports"
import { refusalOf, type TaskListFilter } from "../data/tasks-api"
import { morePages, useTaskList, useTasksClient, useTasksInvalidation, type TasksScope } from "../data/queries"
import type { TasksStore } from "../store/tasks-store"
import { DialogCreateTask } from "./dialogs/create-task-dialog"
import { DialogStartTask } from "./dialogs/start-task-dialog"
import { TaskDetailPanel } from "./task-detail-panel"

export type TasksViewProps = {
  store: TasksStore
  scope: () => TasksScope
  projectId: () => string
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
  const roots = createMemo(() => visible().filter((task) => task.parentTaskId === null))
  const childrenOf = (taskId: string) => visible().filter((task) => task.parentTaskId === taskId)

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
        onCreated={(taskId) => props.store.selectTask(taskId)}
      />
    ))

  const openStart = (input: { task: Task; slot: ConfigurationSlot; attempt: number }) =>
    void dialog.show(() => (
      <DialogStartTask
        store={props.store}
        scope={props.scope}
        task={input.task}
        slot={input.slot}
        attempt={input.attempt}
        onClose={() => dialog.close()}
      />
    ))

  return (
    <div class="tsk tsk-stack" data-testid="tasks-view">
      <div class="tsk-toolbar">
        <For each={TASK_COLLECTIONS}>
          {(collection) => (
            <button
              type="button"
              class="tsk-button"
              data-testid={`tasks-collection-${collection}`}
              data-variant={props.store.state.collection === collection ? "primary" : undefined}
              aria-pressed={props.store.state.collection === collection}
              onClick={() => props.store.setCollection(collection)}
            >
              {TASK_COLLECTION_LABELS[collection]}
            </button>
          )}
        </For>

        <select
          class="tsk-select"
          data-testid="tasks-project"
          aria-label="Project"
          value={props.projectId()}
          onChange={(event) => props.store.setProjectId(event.currentTarget.value)}
        >
          <For each={projects()}>{(project) => <option value={project.id}>{project.label}</option>}</For>
        </select>

        <select
          class="tsk-select"
          data-testid="tasks-status-filter"
          aria-label="Status filter"
          value={props.store.state.statusFilter ?? ""}
          onChange={(event) => {
            const next = event.currentTarget.value
            props.store.setStatusFilter(isTaskStatus(next) ? next : null)
          }}
        >
          <option value="">Any status</option>
          <For each={TASK_STATUSES}>{(status) => <option value={status}>{TASK_STATUS_LABELS[status]}</option>}</For>
        </select>

        <label class="tsk-checkbox">
          <input
            type="checkbox"
            data-testid="tasks-show-children"
            checked={props.store.state.showChildren}
            onChange={(event) => props.store.setShowChildren(event.currentTarget.checked)}
          />
          <span>Show subtasks</span>
        </label>

        <button
          type="button"
          class="tsk-button"
          data-testid="tasks-view-toggle"
          aria-pressed={props.store.state.view === "board"}
          onClick={() => props.store.setView(props.store.state.view === "list" ? "board" : "list")}
        >
          {props.store.state.view === "list" ? "Board" : "List"}
        </button>

        <button type="button" class="tsk-button" data-variant="primary" data-testid="tasks-create" onClick={openCreate}>
          New task
        </button>
      </div>

      <Show when={tasks.error()}>{(error) => <p class="tsk-error" role="alert">{refusalOf(error()).message}</p>}</Show>

      <Show
        when={props.store.state.view === "board"}
        fallback={
          <TaskList
            tasks={roots()}
            loading={tasks.pending()}
            more={morePages(tasks)}
            selectedTaskId={props.store.state.selectedTaskId}
            showChildren={props.store.state.showChildren}
            childrenOf={childrenOf}
            busyTaskId={busyTaskId()}
            onSelect={(taskId) => props.store.selectTask(taskId)}
            onStatusChange={(input) => void setStatus(input)}
          />
        }
      >
        <TaskBoard
          tasks={visible()}
          more={morePages(tasks)}
          selectedTaskId={props.store.state.selectedTaskId}
          busyTaskId={busyTaskId()}
          onSelect={(taskId) => props.store.selectTask(taskId)}
          onStatusChange={(input) => void setStatus(input)}
        />
      </Show>

      <Show when={props.store.state.selectedTaskId}>
        {(taskId) => (
          <TaskDetailPanel
            store={props.store}
            scope={props.scope}
            taskId={taskId()}
            onStart={openStart}
            onOpenTask={(next) => props.store.selectTask(next)}
          />
        )}
      </Show>
    </div>
  )
}
