import { normalizeHarnessIdentity, type SessionHarness } from "./harnesses"
import type { PromptModel } from "./sessions"
import { isRecord } from "./values"

/** The slots a Tasks preset resolves. A group names at most one entry per slot. */
export const SESSION_GROUP_SLOTS = ["primary", "planning", "implementation", "review"] as const
export type SessionGroupSlot = (typeof SESSION_GROUP_SLOTS)[number]

export type SessionGroupEntry = {
  harness: SessionHarness
  model: PromptModel
  /** Absent leaves the choice with the model's own default. */
  effort?: string
}

export type SessionModelGroup = Partial<Record<SessionGroupSlot, SessionGroupEntry>>

export type SessionModelGroupParse =
  | { group: SessionModelGroup }
  | { field: string; message: string }

export function isSessionGroupSlot(value: string): value is SessionGroupSlot {
  return (SESSION_GROUP_SLOTS as readonly string[]).includes(value)
}

/**
 * The machine-readable group a session was created under.
 *
 * A malformed slot is refused by name rather than dropped: a group that quietly
 * lost a slot on the way in resolves a later delegation to the wrong model.
 */
export function parseSessionModelGroup(input: unknown): SessionModelGroupParse {
  if (!isRecord(input)) return { field: "group", message: "group must be an object of slot entries" }
  const group: SessionModelGroup = {}
  for (const [slot, value] of Object.entries(input)) {
    if (!isSessionGroupSlot(slot)) {
      return { field: `group.${slot}`, message: `group slot must be one of ${SESSION_GROUP_SLOTS.join(", ")}` }
    }
    const entry = parseEntry(`group.${slot}`, value)
    if ("field" in entry) return entry
    group[slot] = entry.entry
  }
  return { group }
}

/**
 * A slot's effort as a session create body spells it. The runtime's field is
 * `variant` because a harness may accept a thinking level that is not an
 * effort, so every caller resolving a slot translates here instead of by hand.
 */
export function sessionVariantForEffort(effort: string | undefined): { variant?: string } {
  return effort ? { variant: effort } : {}
}

export function sessionModelGroupJson(group: SessionModelGroup | null | undefined): string | null {
  return group && Object.keys(group).length > 0 ? JSON.stringify(group) : null
}

/** A row written by an older build, or corrupted, reads back as no group at all. */
export function parseStoredSessionModelGroup(json: string | null | undefined): SessionModelGroup | undefined {
  if (!json) return undefined
  const parsed: unknown = jsonOrUndefined(json)
  if (parsed === undefined) return undefined
  const result = parseSessionModelGroup(parsed)
  return "group" in result && Object.keys(result.group).length > 0 ? result.group : undefined
}

function jsonOrUndefined(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

function parseEntry(field: string, value: unknown): { entry: SessionGroupEntry } | { field: string; message: string } {
  if (!isRecord(value)) return { field, message: "group slot must be an object" }
  const harness = normalizeHarnessIdentity(value.harness)
  if (!harness) return { field: `${field}.harness`, message: "group slot needs a known harness" }
  const model = parseModel(value.model)
  if (!model) return { field: `${field}.model`, message: "group slot needs a model with providerID and modelID" }
  if (value.effort !== undefined && (typeof value.effort !== "string" || !value.effort)) {
    return { field: `${field}.effort`, message: "group slot effort must be a non-empty string" }
  }
  return {
    entry: {
      harness,
      model,
      ...(typeof value.effort === "string" ? { effort: value.effort } : {}),
    },
  }
}

function parseModel(value: unknown): PromptModel | undefined {
  if (!isRecord(value)) return undefined
  const providerID = value.providerID
  const modelID = value.modelID
  if (typeof providerID !== "string" || !providerID) return undefined
  if (typeof modelID !== "string" || !modelID) return undefined
  return { providerID, modelID }
}
