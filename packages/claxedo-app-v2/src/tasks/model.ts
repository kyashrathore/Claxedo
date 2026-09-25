import { CONFIGURATION_SLOTS, TASK_STATUSES, admissibleAttempt, taskNumber } from "@claxedo/tasks"
import type { ConfigurationSlot, Preset, Task, TaskSessionLinkView, TaskStatus } from "@claxedo/tasks"
import type { TasksKey } from "./i18n"

export const TASK_STATUS_KEYS: Readonly<Record<TaskStatus, TasksKey>> = {
  backlog: "tasks.status.backlog",
  todo: "tasks.status.todo",
  doing: "tasks.status.doing",
  needs_you: "tasks.status.needsYou",
  done: "tasks.status.done",
}

export const SLOT_KEYS: Readonly<Record<ConfigurationSlot, TasksKey>> = {
  primary: "tasks.slot.primary",
  planning: "tasks.slot.planning",
  implementation: "tasks.slot.implementation",
  review: "tasks.slot.review",
}

export const TASK_DATE_FIELDS = ["updated", "created"] as const
export type TaskDateField = (typeof TASK_DATE_FIELDS)[number]

export const TASK_DATE_FIELD_KEYS: Readonly<Record<TaskDateField, TasksKey>> = {
  updated: "tasks.date.updated",
  created: "tasks.date.created",
}

export const TASK_COLLECTIONS = ["active", "backlog", "all"] as const
export type TaskCollection = (typeof TASK_COLLECTIONS)[number]

export const TASK_COLLECTION_KEYS: Readonly<Record<TaskCollection, TasksKey>> = {
  active: "tasks.collection.active",
  backlog: "tasks.collection.backlog",
  all: "tasks.collection.all",
}

export const TASK_COLLECTION_STATUSES: Readonly<Record<TaskCollection, readonly TaskStatus[]>> = {
  active: ["todo", "doing", "needs_you"],
  backlog: ["backlog"],
  all: TASK_STATUSES,
}

export type TaskLinkGroup = {
  readonly slot: ConfigurationSlot
  readonly attempts: readonly TaskSessionLinkView[]
  readonly current: TaskSessionLinkView | undefined
  readonly startable: boolean
}

export type TaskDetailView = {
  readonly task: Task
  readonly parent?: Pick<Task, "id" | "number" | "childNumber" | "title">
  readonly groups: readonly TaskLinkGroup[]
  readonly configuredSlots: readonly ConfigurationSlot[]
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

export function shortAge(
  timestamp: number,
  now: number = Date.now(),
): { readonly key: TasksKey; readonly count: number } {
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < MINUTE) return { key: "tasks.age.now", count: 0 }
  if (elapsed < HOUR) return { key: "tasks.age.minutes", count: Math.floor(elapsed / MINUTE) }
  if (elapsed < DAY) return { key: "tasks.age.hours", count: Math.floor(elapsed / HOUR) }
  if (elapsed < WEEK) return { key: "tasks.age.days", count: Math.floor(elapsed / DAY) }
  if (elapsed < 52 * WEEK) return { key: "tasks.age.weeks", count: Math.floor(elapsed / WEEK) }
  return { key: "tasks.age.year", count: new Date(timestamp).getFullYear() }
}

export function projectKey(projectName: string): string {
  const words = projectName
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
  const single = words.length === 1 ? words[0] : undefined
  if (single) return single.slice(0, 3).toUpperCase()
  return words
    .slice(0, 4)
    .map((word) => word.slice(0, 1))
    .join("")
    .toUpperCase()
}

export function taskKey(projectName: string, task: Pick<Task, "number" | "childNumber">): string {
  const key = projectKey(projectName)
  return key.length === 0 ? `#${taskNumber(task)}` : `${key}-${taskNumber(task)}`
}

export function configuredSlotsOf(preset: Pick<Preset, "configurations">): readonly ConfigurationSlot[] {
  return CONFIGURATION_SLOTS.filter((slot) => preset.configurations[slot])
}

export function taskDate(
  task: { readonly createdAt: number; readonly updatedAt: number },
  field: TaskDateField,
): number {
  return field === "created" ? task.createdAt : task.updatedAt
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

export type OpenableSlot = {
  readonly slot: ConfigurationSlot
  readonly current: TaskSessionLinkView
  readonly open: TaskSessionLinkView | undefined
}

export function openableSlot(groups: readonly TaskLinkGroup[]): OpenableSlot | undefined {
  const chosen =
    groups.find((group) => group.slot === "primary" && group.current) ??
    groups.find((group) => group.current?.liveness === "live") ??
    groups.find((group) => group.current)
  const current = chosen?.current
  if (!chosen || !current) return undefined
  return { slot: chosen.slot, current, open: slotAttempt(groups, chosen.slot).open }
}

export function groupLinksBySlot(links: readonly TaskSessionLinkView[]): readonly TaskLinkGroup[] {
  const bySlot = new Map<ConfigurationSlot, TaskSessionLinkView[]>()
  for (const link of links) {
    const existing = bySlot.get(link.slot)
    if (existing) existing.push(link)
    else bySlot.set(link.slot, [link])
  }
  return [...bySlot.entries()].map(([slot, attempts]) => {
    const ordered = [...attempts].sort((a, b) => b.attempt - a.attempt)
    const current = ordered[0]
    return { slot, attempts: ordered, current, startable: !current || current.liveness !== "live" }
  })
}
