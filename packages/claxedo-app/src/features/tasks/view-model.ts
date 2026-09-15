import { CONFIGURATION_SLOTS, TASK_STATUSES, admissibleAttempt, taskNumber } from "@claxedo/tasks"
import type {
  ConfigurationSlot,
  ModelConfiguration,
  Preset,
  PresetDraft,
  PresetPlacement,
  Task,
  TaskDraft,
  TaskSessionLinkView,
  TaskStatus,
} from "@claxedo/tasks"

export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  backlog: "Backlog",
  todo: "To do",
  doing: "In progress",
  needs_you: "Needs you",
  done: "Done",
}

export const SLOT_LABELS: Readonly<Record<ConfigurationSlot, string>> = {
  primary: "Primary",
  planning: "Planning",
  implementation: "Implementation",
  review: "Review",
}

export const PLACEMENT_LABELS: Readonly<Record<PresetPlacement, string>> = {
  local: "Local",
  cloud: "Cloud",
}

/** The one sentence the Local placement is allowed to make about capabilities. */
export const LOCAL_CAPABILITY_TEXT = "Use local skills and plugins"

/**
 * What each placement guarantees, as the low-level design states it: the
 * selected-only promise covers registered optional capabilities and their
 * credentials. It does not cover the repository, the shell or the network,
 * which the host's own policy governs, and saying otherwise would promise an
 * isolation this does not build.
 */
export const CAPABILITY_GUARANTEE: Readonly<Record<PresetPlacement, string>> = {
  local: "Uses this machine's current skills and plugins. The selection below is not enforced for local sessions.",
  cloud:
    "Only the selected plugins and skills are installed in the isolated cloud workspace, and only their credentials are brokered. The repository, shell and network still follow the host's policy, so this limits registered capabilities, not everything the agent can reach.",
}

/**
 * Which timestamp a row shows. A reader watching work move wants the last
 * touch; one auditing what was asked for wants the first, and no row is wide
 * enough for both.
 */
export const TASK_DATE_FIELDS = ["updated", "created"] as const
export type TaskDateField = (typeof TASK_DATE_FIELDS)[number]

export const TASK_DATE_FIELD_LABELS: Readonly<Record<TaskDateField, string>> = {
  updated: "Updated",
  created: "Created",
}

export const TASK_COLLECTIONS = ["active", "backlog", "all"] as const
export type TaskCollection = (typeof TASK_COLLECTIONS)[number]

export const TASK_COLLECTION_LABELS: Readonly<Record<TaskCollection, string>> = {
  active: "Active",
  backlog: "Backlog",
  all: "All tasks",
}

/**
 * The statuses a collection holds, which are also the board's columns under
 * it. Active is the work in play, so it holds neither the parked nor the
 * finished; a Backlog or Done column on it would count zero forever.
 */
export const TASK_COLLECTION_STATUSES: Readonly<Record<TaskCollection, readonly TaskStatus[]>> = {
  active: ["todo", "doing", "needs_you"],
  backlog: ["backlog"],
  all: TASK_STATUSES,
}

/**
 * One installed plugin or skill as the editor shows it. `available: false` is
 * rendered and refused rather than filtered out, so a preset that names a
 * revoked capability explains itself instead of quietly shrinking.
 */
export type CapabilityOption = {
  /** Stable list key; the host builds it from the reference it owns. */
  key: string
  sourceId: string
  name: string
  label: string
  description?: string
  /** Skills the plugin brings with it, shown before the plugin is selected. */
  bundledSkills?: readonly string[]
  available: boolean
  unavailableReason?: string
}

export type CapabilityCatalog = {
  plugins: readonly CapabilityOption[]
  skills: readonly CapabilityOption[]
  loading: boolean
  error?: string
}

/** A host-supplied reader, so the package never fetches a catalog itself. */
export type CapabilityCatalogReader = () => CapabilityCatalog

export type FieldErrors = Readonly<Record<string, string>>

export type PresetSummaryView = Pick<Preset, "id" | "revision" | "name" | "execution" | "archivedAt"> & {
  configurations: Preset["configurations"]
}

export type TaskLinkGroup = {
  slot: ConfigurationSlot
  /** Highest attempt first; the head is the slot's current link. */
  attempts: readonly TaskSessionLinkView[]
  current: TaskSessionLinkView | undefined
  /** True when the slot has no link at all, or its current session is not live. */
  startable: boolean
}

export type TaskDetailView = {
  task: Task
  /** The task this one is a subtask of, once its own read has answered. */
  parent?: Pick<Task, "id" | "number" | "childNumber" | "title">
  groups: readonly TaskLinkGroup[]
  /** The slots this page draws a Start control for: Primary, plus any slot the task has already run. */
  configuredSlots: readonly ConfigurationSlot[]
}

export type { ModelConfiguration, PresetDraft, TaskDraft }

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/**
 * A timestamp as the width of one table cell: the largest whole unit, no
 * suffix. Past a year it reads as the year, because "83w" carries no more
 * meaning than "2024" and is harder to place.
 *
 * Not the sidebar's `relativeTime`, which counts in seconds and months for a
 * row that updates live: a column of these wants one unit per cell, not the
 * most precise one.
 */
export function shortAge(timestamp: number, now: number = Date.now()): string {
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < MINUTE) return "now"
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}d`
  if (elapsed < 52 * WEEK) return `${Math.floor(elapsed / WEEK)}w`
  return String(new Date(timestamp).getFullYear())
}

/**
 * A project's letters in a task key: the initials of its words, or the first
 * three letters when it has only one — `Demo project` reads `DP`, `Claxedo`
 * reads `CLA`. Four initials at most, because the key sits in a table cell
 * ahead of a title that has to stay readable.
 */
export function projectKey(projectName: string): string {
  const words = projectName.trim().split(/\s+/).filter((word) => word.length > 0)
  const single = words.length === 1 ? words[0] : undefined
  if (single) return single.slice(0, 3).toUpperCase()
  return words
    .slice(0, 4)
    .map((word) => word.slice(0, 1))
    .join("")
    .toUpperCase()
}

/**
 * What a person quotes when they mean this task. A project whose name carries
 * no letters leaves the number to stand alone rather than growing a key made
 * of nothing.
 */
export function taskKey(projectName: string, task: Pick<Task, "number" | "childNumber">): string {
  const key = projectKey(projectName)
  return key.length === 0 ? `#${taskNumber(task)}` : `${key}-${taskNumber(task)}`
}

/** The slots a preset carries a configuration for, in catalog order. */
export function configuredSlotsOf(preset: Pick<Preset, "configurations">): readonly ConfigurationSlot[] {
  return CONFIGURATION_SLOTS.filter((slot) => preset.configurations[slot])
}

/** The timestamp the chosen Display option points at. */
export function taskDate(task: { createdAt: number; updatedAt: number }, field: TaskDateField): number {
  return field === "created" ? task.createdAt : task.updatedAt
}

/**
 * What a slot will accept next, from the links the detail read returned.
 *
 * The service admits exactly one attempt number per slot: the current one
 * while its session is live — the idempotent re-request — and `current + 1`
 * once the owner reports it gone. A caller that always asked for attempt 1 was
 * refused with a conflict by every slot that had ever run.
 *
 * `open` is the session a row may navigate to, and is set only while the host
 * says it is live: a dead session is not somewhere to send someone.
 */
export type SlotAttempt = {
  attempt: number
  current: TaskSessionLinkView | undefined
  open: TaskSessionLinkView | undefined
  /** True once the slot has run and its session is gone: the Start again case. */
  again: boolean
}

export function slotAttempt(groups: readonly TaskLinkGroup[], slot: ConfigurationSlot): SlotAttempt {
  const current = groups.find((group) => group.slot === slot)?.current
  if (!current) return { attempt: 1, current: undefined, open: undefined, again: false }
  const live = current.liveness === "live"
  return {
    attempt: admissibleAttempt(current),
    current,
    open: live ? current : undefined,
    again: !live,
  }
}

/**
 * The slot an Open that names none means, and the session it leads to.
 *
 * A list read carries a link count and no slot, so a task whose only run is on
 * a secondary slot offered Open and then reported having no session at all.
 * Primary wins whenever it has run, because that is the slot a task starts in;
 * otherwise the newest surviving run, and failing that any run, so the refusal
 * can name the slot whose session is gone instead of denying it exists.
 */
export type OpenableSlot = {
  slot: ConfigurationSlot
  current: TaskSessionLinkView
  /** Set only while the host reports the session live. */
  open: TaskSessionLinkView | undefined
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

/**
 * Links folded into one group per slot, highest attempt first.
 *
 * The head of each group is the slot's current link, and `startable` is read
 * from the liveness the host reported for it — never stored, never inferred
 * from the attempt number.
 */
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
