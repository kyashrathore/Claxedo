import { Show, createMemo, createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { TaskStatus, TaskSummary } from "@claxedo/tasks"
import {
  TASK_COLLECTION_LABELS,
  TaskBoard,
  TaskList,
  emptyPresetEditorDraft,
  type StartChoice,
  type SubtaskProgress,
  type TaskStartOffer,
} from "@claxedo/tasks/solid"
import { uuid } from "@/lib/uuid"
import { useTasksAppPorts } from "../app-ports"
import { refusalOf, type TaskListFilter } from "../data/tasks-api"
import { morePages, usePresetList, useTaskList, useTasksClient, useTasksInvalidation, type TasksScope } from "../data/queries"
import { useStartTaskCommands } from "../data/start-task"
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
  const startTask = useStartTaskCommands(props.scope)
  const presets = usePresetList(props.scope, () => false)
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

  /**
   * What a row may offer. The default preset is the last one started in this
   * scope, and otherwise the only one saved — never a guess between several,
   * which the caret is for.
   */
  const defaultPresetId = () => {
    const saved = presets.items()
    const last = props.store.state.lastPresetId
    if (last && saved.some((preset) => preset.id === last)) return last
    return saved[0]?.id
  }

  const runStart = async (task: TaskSummary, choice: StartChoice) => {
    const preset = presets.items().find((entry) => entry.id === choice.presetId)
    if (!preset) return
    setBusyTaskId(task.id)
    const outcome = await startTask.startNow(task, {
      presetId: preset.id,
      presetRevision: preset.revision,
      slot: choice.slot,
    })
    setBusyTaskId(undefined)
    if (outcome.ok) props.store.startedWith(task.id, preset.id)
    else props.store.refuseStart(task.id, outcome.message)
  }

  const openSession = async (task: TaskSummary) => {
    setBusyTaskId(task.id)
    const outcome = await startTask.openLatestSession(task.id)
    setBusyTaskId(undefined)
    if (!outcome.ok) props.store.refuseStart(task.id, outcome.message)
  }

  const startOffer = (task: TaskSummary): TaskStartOffer => ({
    presets: presets.items(),
    defaultPresetId: defaultPresetId(),
    blocker: props.store.state.startRefusals[task.id],
    busy: busyTaskId() === task.id,
    onStart: (choice) => void runStart(task, choice),
    // A row knows a session exists from its link count; which one is current
    // is read when Open is pressed, because liveness is not in a list read.
    ...(task.links.count > 0 ? { onOpen: () => void openSession(task) } : {}),
    onCreatePreset: () => props.store.openPresetDraft(emptyPresetEditorDraft()),
  })

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
          <Button variant="primary" size="small" data-testid="tasks-create" onClick={openCreate}>
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
            loading={tasks.pending()}
            grouped={props.store.state.grouped}
            emptyLabel={`Nothing in ${TASK_COLLECTION_LABELS[props.store.state.collection]}.`}
            more={morePages(tasks)}
            selectedTaskId={props.store.state.selectedTaskId}
            parentTitleOf={parentTitleOf}
            subtaskProgress={subtaskProgress}
            startOffer={startOffer}
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
          startOffer={startOffer}
          busyTaskId={busyTaskId()}
          onSelect={(taskId) => props.onOpenTask(taskId)}
          onCreate={openCreate}
          onStatusChange={(input) => void setStatus(input)}
        />
      </Show>
    </div>
  )
}
