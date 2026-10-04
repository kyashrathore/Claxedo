import type { AutoLevel, SessionConfig, SessionConfigUpdate } from "@claxedo/agent-runtime-contract"
import { isAutoLevel } from "./session/permission-ceiling"
import { normalizeHarnessIdentity, parseSessionModelGroup, type PromptModel, type SessionHarness, type SessionModelGroup, type SessionModelGroupParse } from "@claxedo/agent-runtime-contract"
import { asRecord, asString } from "@claxedo/helpers/guards"

/**
 * Fixed at create, so a later edit cannot rewrite what an already-running
 * session was told or delegated under. An update naming one is refused rather
 * than dropped: a caller editing it has no other way to learn nothing happened.
 */
export const IMMUTABLE_SESSION_CONFIG_FIELDS = ["instructions", "group"] as const
export type ImmutableSessionConfigField = (typeof IMMUTABLE_SESSION_CONFIG_FIELDS)[number]

/** Config fields accepted from public session create/update requests.
 * Handoff and accepted permission state are runtime-owned; permission changes
 * must go through the permission-mode or permission-reply operation. */
export type SessionConfigRequestUpdate = Omit<
  SessionConfigUpdate,
  "handoff" | "permissionMode" | "permissionModeLabel" | "permissionState" | "permissionCeiling" | ImmutableSessionConfigField
>

/**
 * The `POST /session` body beyond its config fields. `parentID` makes the
 * session a host-owned child of that parent; `clientRequestId` lets a retried
 * create resolve to the same session; `permissionCeiling` caps the session's
 * permission mode at a level, and `permissionMode` names the mode to start in.
 *
 * `instructions` is retained on the session so a caller never re-sends it; how
 * it reaches the harness is the harness's own `instructionChannel`.
 *
 * `group` is retained too, but never reaches the harness: it is the
 * machine-readable form of the model group, read back by whoever later resolves
 * a slot. Both are fixed at create, and `normalizeSessionConfigUpdate` accepts
 * neither, so a PATCH cannot rewrite them.
 */
export type SessionCreateBody = {
  id?: string
  title?: string
  parentID?: string
  role?: string
  clientRequestId?: string
  permissionCeiling?: AutoLevel
  permissionMode?: string
  instructions?: string
  group?: SessionModelGroup
}

export function normalizeSessionCreateBody(input: unknown): SessionCreateBody {
  const row = asRecord(input) ?? {}
  const ceiling = row.permissionCeiling
  return {
    ...(asString(row.id) ? { id: asString(row.id) } : {}),
    ...(asString(row.title) !== undefined ? { title: asString(row.title) } : {}),
    ...(asString(row.parentID) ? { parentID: asString(row.parentID) } : {}),
    ...(asString(row.role) ? { role: asString(row.role) } : {}),
    ...(asString(row.clientRequestId) ? { clientRequestId: asString(row.clientRequestId) } : {}),
    ...(isAutoLevel(ceiling) ? { permissionCeiling: ceiling } : {}),
    ...(asString(row.permissionMode) ? { permissionMode: asString(row.permissionMode) } : {}),
    ...(asString(row.instructions) ? { instructions: asString(row.instructions) } : {}),
  }
}

/**
 * The create body's `group`, or `undefined` when the caller sent none. A
 * malformed group is returned as the failing field rather than dropped: a
 * session whose group silently lost a slot delegates to the wrong model later.
 */
export function sessionCreateGroup(input: unknown): SessionModelGroupParse | undefined {
  const row = asRecord(input) ?? {}
  if (!("group" in row)) return undefined
  return parseSessionModelGroup(row.group)
}

export function normalizeSessionHarness(input: unknown): SessionHarness | undefined {
  const row = asRecord(input)
  if (!row) return undefined
  const identity = normalizeHarnessIdentity(row)
  if (!identity) return undefined
  return {
    id: identity.id,
    access: identity.access,
  }
}

function promptModel(input: unknown): PromptModel | null | undefined {
  if (input === null) return null
  const row = asRecord(input)
  if (!row) return undefined
  const providerID = asString(row.providerID)
  const modelID = asString(row.modelID)
  if (providerID === undefined || modelID === undefined) return undefined
  return { providerID, modelID }
}

export function normalizeSessionConfigUpdate(input: unknown): SessionConfigRequestUpdate {
  const row = asRecord(input) ?? {}
  const harness = normalizeSessionHarness(row.harness)
  const model = "model" in row ? promptModel(row.model) : undefined
  return {
    ...(harness ? { harness } : {}),
    ...(model !== undefined ? { model } : {}),
    ...("variant" in row && (typeof row.variant === "string" || row.variant === null) ? { variant: row.variant } : {}),
    ...("agent" in row && (typeof row.agent === "string" || row.agent === null) ? { agent: row.agent } : {}),
  }
}

export function normalizeSessionCreateConfig(input: unknown): SessionConfigRequestUpdate {
  const row = asRecord(input) ?? {}
  const model = asRecord(row.model)
  return normalizeSessionConfigUpdate({
    ...row,
    ...(typeof model?.providerID === "string" && typeof model.id === "string"
      ? { model: { providerID: model.providerID, modelID: model.id } }
      : {}),
    ...(!("variant" in row) && typeof model?.variant === "string" ? { variant: model.variant } : {}),
  })
}

export function normalizeSessionConfig(input: unknown): SessionConfig | undefined {
  const row = asRecord(input) ?? {}
  const update = normalizeSessionConfigUpdate(input)
  if (!update.harness) return undefined
  return {
    harness: update.harness,
    ...(update.model && update.model !== null ? { model: update.model } : {}),
    variant: "variant" in row && (typeof row.variant === "string" || row.variant === null) ? row.variant : null,
    agent: "agent" in row && (typeof row.agent === "string" || row.agent === null) ? row.agent : null,
  }
}
