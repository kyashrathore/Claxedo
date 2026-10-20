import type { ConfigurationSlot, Preset, Task, TaskCreateStatus, TaskDetailResponse, TaskSummary } from "../../contracts"
import type { TasksRefusal } from "../refusal"
import type { TaskCollection } from "./model"
import { START_IDLE, type StartProgress } from "./start-run"

export type TaskList =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly tasks: readonly TaskSummary[]; readonly nextCursor: string | null; readonly more: "idle" | "loading" | "failed" }
  | { readonly kind: "failed"; readonly message: string }

export type PresetList = { readonly kind: "loading" } | { readonly kind: "ready"; readonly presets: readonly Preset[] } | { readonly kind: "failed"; readonly message: string }

export type ImageDraft = { readonly key: string; readonly filename: string; readonly mime: string; readonly data: string }

export type CreateForm =
  | { readonly kind: "closed" }
  | {
      readonly kind: "open"
      readonly key: number
      readonly status: TaskCreateStatus
      readonly images: readonly ImageDraft[]
      readonly imageRefusals: readonly string[]
      readonly creating: boolean
      readonly problem?: string
      readonly refusal?: TasksRefusal
    }

export type AttachmentImage = { readonly kind: "loading" } | { readonly kind: "ready"; readonly url: string } | { readonly kind: "failed" }

export type DetailEdit = { readonly title: string; readonly description: string }

export type DetailLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "ready"
      readonly detail: TaskDetailResponse
      readonly children: readonly TaskSummary[]
      readonly parent?: Task
      readonly images: Readonly<Record<string, AttachmentImage>>
    }

export type TaskDetail = {
  readonly taskId: string
  readonly load: DetailLoad
  readonly edit: DetailEdit
  readonly revision?: number
  readonly saving: boolean
  readonly conflictTitle?: string
  readonly error?: string
  readonly slotPresets: Readonly<Partial<Record<ConfigurationSlot, string>>>
}

export type StartRefusal = { readonly taskId: string; readonly title: string; readonly message: string }

export type PageRoute = { readonly kind: "list" } | { readonly kind: "detail"; readonly taskId: string }

export type PageState = {
  readonly route: PageRoute
  readonly chosenProjectId?: string
  readonly collection: TaskCollection
  readonly view: "list" | "board"
  readonly list: TaskList
  readonly presets: PresetList
  readonly startWith?: string
  readonly create: CreateForm
  readonly detail?: TaskDetail
  readonly busyTaskId?: string
  readonly progress: StartProgress
  readonly progressTitle?: string
  readonly startRefusal?: StartRefusal
  readonly listNotice?: string
}

export const INITIAL_PAGE_STATE: PageState = {
  route: { kind: "list" },
  collection: "active",
  view: "list",
  list: { kind: "idle" },
  presets: { kind: "loading" },
  create: { kind: "closed" },
  progress: START_IDLE,
}

export function routeOf(params: Readonly<Record<string, string>>): PageRoute {
  const taskId = params.taskId
  return taskId ? { kind: "detail", taskId } : { kind: "list" }
}

export function emptyDetail(taskId: string): TaskDetail {
  return { taskId, load: { kind: "loading" }, edit: { title: "", description: "" }, saving: false, slotPresets: {} }
}

export function activePresets(state: PageState): readonly Preset[] {
  return state.presets.kind === "ready" ? state.presets.presets.filter((preset) => preset.archivedAt === null) : []
}

export function startWithPreset(state: PageState): Preset | undefined {
  const presets = activePresets(state)
  return presets.find((preset) => preset.id === state.startWith) ?? presets[0]
}
