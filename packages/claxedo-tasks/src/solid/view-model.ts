import type {
  ConfigurationSlot,
  ModelConfiguration,
  PluginReference,
  Preset,
  PresetDraft,
  PresetPlacement,
  SkillReference,
  StartPreview,
  Task,
  TaskDraft,
  TaskSessionLinkView,
  TaskStatus,
  TaskSummary,
} from "../contracts"

export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
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

export const TASK_COLLECTIONS = ["active", "backlog", "all"] as const
export type TaskCollection = (typeof TASK_COLLECTIONS)[number]

export const TASK_COLLECTION_LABELS: Readonly<Record<TaskCollection, string>> = {
  active: "Active",
  backlog: "Backlog",
  all: "All tasks",
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
  children: readonly TaskSummary[]
  groups: readonly TaskLinkGroup[]
  /** Slots the chosen presets actually configure; unconfigured slots are not offered. */
  configuredSlots: readonly ConfigurationSlot[]
}

export type StartDraft = {
  presetId: string | null
  slot: ConfigurationSlot
  handoffText: string
  continueFromPrevious: boolean
}

export type StartPreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; preview: StartPreview }
  | { status: "error"; message: string }

export type { ModelConfiguration, PluginReference, PresetDraft, SkillReference, TaskDraft }

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
