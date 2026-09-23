import { createStore, produce } from "solid-js/store"
import type { Preset, Task, TaskStatus, TaskSummary } from "@claxedo/tasks"
import type { PresetEditorDraft } from "../preset-editor-model"
import { TASK_COLLECTION_STATUSES, type TaskCollection, type TaskDateField } from "../view-model"
import type { TasksRefusal } from "../data/tasks-api"

export type TasksViewMode = "list" | "board"

export type TaskEditDraft = {
  title: string
  description: string
  /** The revision the next save will claim. A conflict rebases this and nothing else. */
  revision: number
}

type TasksState = {
  collection: TaskCollection
  view: TasksViewMode
  statusFilter: TaskStatus | null
  showChildren: boolean
  /** Presentational only: the list read carries no order, so this groups what was read. */
  grouped: boolean
  /** Which of the task's two timestamps a row and a card show. */
  dateField: TaskDateField
  /** The task page's properties rail folded away; one setting for every task opened. */
  railCollapsed: boolean
  /** Undefined until the user picks one; the surface falls back to the active project. */
  projectId: string | undefined
  selectedTaskId: string | undefined
  selectedPresetId: string | undefined
  taskEdits: Record<string, TaskEditDraft>
  taskConflicts: Record<string, string>
  taskErrors: Record<string, string>
  presetDraft: PresetEditorDraft | undefined
  presetDraftId: string | undefined
  presetRevision: number | undefined
  presetRefusal: TasksRefusal | undefined
  /** The preset the last start in this scope used; what a row's bare Start repeats. */
  lastPresetId: string | undefined
  /** A refused row start, keyed by task, shown in that row's own menu. */
  startRefusals: Record<string, string>
}

export type TasksStore = ReturnType<typeof createTasksStore>

export function createTasksStore() {
  const [state, setState] = createStore<TasksState>({
    collection: "active",
    view: "list",
    statusFilter: null,
    showChildren: true,
    grouped: true,
    dateField: "updated",
    railCollapsed: false,
    projectId: undefined,
    selectedTaskId: undefined,
    selectedPresetId: undefined,
    taskEdits: {},
    taskConflicts: {},
    taskErrors: {},
    presetDraft: undefined,
    presetDraftId: undefined,
    presetRevision: undefined,
    presetRefusal: undefined,
    lastPresetId: undefined,
    startRefusals: {},
  })

  const editDraft = (task: Task): TaskEditDraft =>
    state.taskEdits[task.id] ?? { title: task.title, description: task.description, revision: task.revision }

  return {
    state,
    setCollection: (collection: TaskCollection) => setState("collection", collection),
    setView: (view: TasksViewMode) => setState("view", view),
    setStatusFilter: (status: TaskStatus | null) => setState("statusFilter", status),
    setShowChildren: (value: boolean) => setState("showChildren", value),
    setGrouped: (value: boolean) => setState("grouped", value),
    setDateField: (field: TaskDateField) => setState("dateField", field),
    toggleRail: () => setState("railCollapsed", (collapsed) => !collapsed),
    setProjectId: (projectId: string) =>
      setState(produce((draft) => {
        draft.projectId = projectId
        draft.selectedTaskId = undefined
      })),
    selectTask: (taskId: string | undefined) => setState("selectedTaskId", taskId),
    selectPreset: (presetId: string | undefined) => setState("selectedPresetId", presetId),

    editDraft,
    setEditDraft: (taskId: string, draft: TaskEditDraft) => setState("taskEdits", taskId, draft),
    discardEdit: (taskId: string) =>
      setState(produce((draft) => {
        delete draft.taskEdits[taskId]
        delete draft.taskConflicts[taskId]
        delete draft.taskErrors[taskId]
      })),
    editDirty: (task: Task) => {
      const draft = state.taskEdits[task.id]
      return !!draft && (draft.title !== task.title || draft.description !== task.description)
    },

    /**
     * A refused save. A stale revision rebases the expected revision onto the
     * record the server returned and keeps every character the user typed; the
     * conflict is a message beside the field, never a reload of the form.
     */
    refuseTaskEdit: (taskId: string, refusal: TasksRefusal) =>
      setState(produce((draft) => {
        const current = refusal.stale?.task
        if (current) {
          const existing = draft.taskEdits[taskId]
          draft.taskEdits[taskId] = {
            title: existing?.title ?? current.title,
            description: existing?.description ?? current.description,
            revision: current.revision,
          }
          draft.taskConflicts[taskId] =
            `This task changed elsewhere (now “${current.title}”). Your edits are kept — save again to apply them on top.`
          delete draft.taskErrors[taskId]
          return
        }
        draft.taskErrors[taskId] = refusal.message
      })),
    clearTaskConflict: (taskId: string) =>
      setState(produce((draft) => {
        delete draft.taskConflicts[taskId]
      })),
    taskSaved: (taskId: string) =>
      setState(produce((draft) => {
        delete draft.taskEdits[taskId]
        delete draft.taskConflicts[taskId]
        delete draft.taskErrors[taskId]
      })),

    openPresetDraft: (draft: PresetEditorDraft, preset?: Preset) =>
      setState(produce((next) => {
        next.presetDraft = draft
        next.presetDraftId = preset?.id
        next.presetRevision = preset?.revision
        next.presetRefusal = undefined
      })),
    setPresetDraft: (draft: PresetEditorDraft) => setState("presetDraft", draft),
    closePresetDraft: () =>
      setState(produce((next) => {
        next.presetDraft = undefined
        next.presetDraftId = undefined
        next.presetRevision = undefined
        next.presetRefusal = undefined
      })),
    refusePreset: (refusal: TasksRefusal) =>
      setState(produce((next) => {
        next.presetRefusal = refusal
        const current = refusal.stale?.preset
        if (current) next.presetRevision = current.revision
      })),

    startedWith: (taskId: string, presetId: string) =>
      setState(produce((draft) => {
        draft.lastPresetId = presetId
        delete draft.startRefusals[taskId]
      })),
    refuseStart: (taskId: string, message: string) => setState("startRefusals", taskId, message),

    visibleTasks: (tasks: readonly TaskSummary[]) => tasks.filter((task) => matchesCollection(task, state.collection)),
  }
}

/** All is the only place an archived task can be seen at all. */
function matchesCollection(task: TaskSummary, collection: TaskCollection) {
  if (collection === "all") return true
  if (task.archivedAt !== null) return false
  return TASK_COLLECTION_STATUSES[collection].includes(task.status)
}
