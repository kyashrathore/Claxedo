import { createStore, produce } from "solid-js/store"
import type { Task, TaskStatus, TaskSummary } from "@claxedo/tasks"
import type { TasksRefusal } from "./data/refusal"
import { TASK_COLLECTION_STATUSES, type TaskCollection, type TaskDateField } from "./model"

export type TasksViewMode = "list" | "board"

export type TaskEditDraft = { readonly title: string; readonly description: string; readonly revision: number }

type TasksState = {
  collection: TaskCollection
  view: TasksViewMode
  statusFilter: TaskStatus | null
  showChildren: boolean
  grouped: boolean
  dateField: TaskDateField
  railCollapsed: boolean
  projectId: string | undefined
  selectedTaskId: string | undefined
  taskEdits: Record<string, TaskEditDraft>
  taskConflicts: Record<string, string>
  taskErrors: Record<string, string>
  lastPresetId: string | undefined
  startRefusals: Record<string, string>
}

export type TasksStore = ReturnType<typeof createTasksStore>

function initialState(): TasksState {
  return {
    collection: "active",
    view: "list",
    statusFilter: null,
    showChildren: true,
    grouped: true,
    dateField: "updated",
    railCollapsed: false,
    projectId: undefined,
    selectedTaskId: undefined,
    taskEdits: {},
    taskConflicts: {},
    taskErrors: {},
    lastPresetId: undefined,
    startRefusals: {},
  }
}

function matchesCollection(task: TaskSummary, collection: TaskCollection) {
  if (collection === "all") return true
  if (task.archivedAt !== null) return false
  return TASK_COLLECTION_STATUSES[collection].includes(task.status)
}

function createEditActions(state: TasksState, setState: ReturnType<typeof createStore<TasksState>>[1]) {
  const forget = (taskId: string) =>
    setState(
      produce((draft) => {
        delete draft.taskEdits[taskId]
        delete draft.taskConflicts[taskId]
        delete draft.taskErrors[taskId]
      }),
    )
  return {
    editDraft: (task: Task): TaskEditDraft =>
      state.taskEdits[task.id] ?? { title: task.title, description: task.description, revision: task.revision },
    setEditDraft: (taskId: string, draft: TaskEditDraft) => setState("taskEdits", taskId, draft),
    discardEdit: forget,
    taskSaved: forget,
    editDirty: (task: Task) => {
      const draft = state.taskEdits[task.id]
      return !!draft && (draft.title !== task.title || draft.description !== task.description)
    },
    refuseTaskEdit: (taskId: string, refusal: TasksRefusal) =>
      setState(
        produce((draft) => {
          const current = refusal.stale?.task
          if (!current) return void (draft.taskErrors[taskId] = refusal.message)
          const existing = draft.taskEdits[taskId]
          draft.taskEdits[taskId] = {
            title: existing?.title ?? current.title,
            description: existing?.description ?? current.description,
            revision: current.revision,
          }
          draft.taskConflicts[taskId] = current.title
          delete draft.taskErrors[taskId]
        }),
      ),
  }
}

export function createTasksStore() {
  const [state, setState] = createStore<TasksState>(initialState())
  return {
    state,
    ...createEditActions(state, setState),
    setCollection: (collection: TaskCollection) => setState("collection", collection),
    setView: (view: TasksViewMode) => setState("view", view),
    setStatusFilter: (status: TaskStatus | null) => setState("statusFilter", status),
    setShowChildren: (value: boolean) => setState("showChildren", value),
    setGrouped: (value: boolean) => setState("grouped", value),
    setDateField: (field: TaskDateField) => setState("dateField", field),
    toggleRail: () => setState("railCollapsed", (collapsed) => !collapsed),
    setProjectId: (projectId: string) => setState({ projectId, selectedTaskId: undefined }),
    selectTask: (taskId: string | undefined) => setState("selectedTaskId", taskId),
    startedWith: (taskId: string, presetId: string) =>
      setState(
        produce((draft) => {
          draft.lastPresetId = presetId
          delete draft.startRefusals[taskId]
        }),
      ),
    refuseStart: (taskId: string, message: string) => setState("startRefusals", taskId, message),
    visibleTasks: (tasks: readonly TaskSummary[]) => tasks.filter((task) => matchesCollection(task, state.collection)),
  }
}
