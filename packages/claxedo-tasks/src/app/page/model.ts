import { TASK_STATUSES, taskNumber, type ConfigurationSlot, type Preset, type SessionLiveness, type Task, type TaskSessionLinkView, type TaskStatus, type TaskSummary } from "../../contracts"
import { admissibleAttempt } from "../../start"
import type { TasksKey } from "../dictionary"
import type { SurfaceIcon } from "../surface/parts"

export const TASK_COLLECTIONS = ["active", "backlog", "all"] as const
export type TaskCollection = (typeof TASK_COLLECTIONS)[number]

export const COLLECTION_KEYS: Readonly<Record<TaskCollection, TasksKey>> = {
  active: "claxedo-tasks.collection.active",
  backlog: "claxedo-tasks.collection.backlog",
  all: "claxedo-tasks.collection.all",
}

export const COLLECTION_STATUSES: Readonly<Record<TaskCollection, readonly TaskStatus[]>> = {
  active: ["todo", "doing", "needs_you"],
  backlog: ["backlog"],
  all: TASK_STATUSES,
}

export type StatusLook = { readonly key: TasksKey; readonly icon: SurfaceIcon; readonly tone: "neutral" | "accent" | "success" | "warning" }

export const STATUS_LOOKS: Readonly<Record<TaskStatus, StatusLook>> = {
  backlog: { key: "claxedo-tasks.status.backlog", icon: "circleDashed", tone: "neutral" },
  todo: { key: "claxedo-tasks.status.todo", icon: "circle", tone: "neutral" },
  doing: { key: "claxedo-tasks.status.doing", icon: "circleHalf", tone: "accent" },
  needs_you: { key: "claxedo-tasks.status.needs_you", icon: "alertCircle", tone: "warning" },
  done: { key: "claxedo-tasks.status.done", icon: "checkCircle", tone: "success" },
}

export const LIVENESS_KEYS: Readonly<Record<SessionLiveness, TasksKey>> = {
  live: "claxedo-tasks.liveness.live",
  archived: "claxedo-tasks.liveness.archived",
  deleted: "claxedo-tasks.liveness.deleted",
  unavailable: "claxedo-tasks.liveness.unavailable",
}

export const TASK_DATE_FIELDS = ["updated", "created"] as const
export type TaskDateField = (typeof TASK_DATE_FIELDS)[number]

export function inCollection(task: TaskSummary, collection: TaskCollection): boolean {
  if (collection === "all") return true
  return task.archivedAt === null && COLLECTION_STATUSES[collection].includes(task.status)
}

export function projectKey(projectName: string): string {
  const words = projectName.trim().split(/\s+/).filter((word) => word.length > 0)
  const single = words.length === 1 ? words[0] : undefined
  if (single) return single.slice(0, 3).toUpperCase()
  return words.slice(0, 4).map((word) => word.slice(0, 1)).join("").toUpperCase()
}

export function taskKey(projectName: string, task: Pick<Task, "number" | "childNumber">): string {
  const key = projectKey(projectName)
  return key.length === 0 ? `#${taskNumber(task)}` : `${key}-${taskNumber(task)}`
}

export function nextStatus(status: TaskStatus): TaskStatus | undefined {
  return TASK_STATUSES[TASK_STATUSES.indexOf(status) + 1]
}

export function previousStatus(status: TaskStatus): TaskStatus | undefined {
  const index = TASK_STATUSES.indexOf(status)
  return index > 0 ? TASK_STATUSES[index - 1] : undefined
}

export type TaskLinkGroup = {
  readonly slot: ConfigurationSlot
  readonly attempts: readonly TaskSessionLinkView[]
  readonly current: TaskSessionLinkView | undefined
}

export function groupLinksBySlot(links: readonly TaskSessionLinkView[]): readonly TaskLinkGroup[] {
  const bySlot = new Map<ConfigurationSlot, TaskSessionLinkView[]>()
  for (const link of links) bySlot.set(link.slot, [...(bySlot.get(link.slot) ?? []), link])
  return [...bySlot.entries()].map(([slot, attempts]) => {
    const ordered = [...attempts].sort((a, b) => b.attempt - a.attempt)
    return { slot, attempts: ordered, current: ordered[0] }
  })
}

export type SlotAttempt = {
  readonly attempt: number
  readonly current: TaskSessionLinkView | undefined
  readonly open: TaskSessionLinkView | undefined
  readonly again: boolean
}

export function slotAttempt(groups: readonly TaskLinkGroup[], slot: ConfigurationSlot): SlotAttempt {
  const current = groups.find((group) => group.slot === slot)?.current
  if (!current) return { attempt: 1, current: undefined, open: undefined, again: false }
  const live = current.liveness === "live"
  return { attempt: admissibleAttempt(current), current, open: live ? current : undefined, again: !live }
}

export type OpenableSlot = { readonly slot: ConfigurationSlot; readonly current: TaskSessionLinkView; readonly open: TaskSessionLinkView | undefined }

export function openableSlot(groups: readonly TaskLinkGroup[]): OpenableSlot | undefined {
  const chosen = groups.find((group) => group.slot === "primary" && group.current) ?? groups.find((group) => group.current?.liveness === "live") ?? groups.find((group) => group.current)
  const current = chosen?.current
  if (!chosen || !current) return undefined
  return { slot: chosen.slot, current, open: slotAttempt(groups, chosen.slot).open }
}

export function presetsForSlot(presets: readonly Preset[], slot: ConfigurationSlot): readonly Preset[] {
  return presets.filter((preset) => preset.archivedAt === null && preset.configurations[slot])
}
