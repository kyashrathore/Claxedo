import {
  isAutoLevel,
  normalizeHarnessIdentity,
  parseSessionModelGroup,
  type AutoLevel,
  type PromptModel,
  type SessionConfig,
  type SessionConfigRequestUpdate,
  type SessionHarness,
  type SessionModelGroup,
  type SessionModelGroupParse,
} from "@claxedo/agent-sdk-runtime"
import { rec as record, str } from "./json-value"

/**
 * The `POST /session` body beyond its config fields. `parentID` makes the
 * session a host-owned child of that parent; `clientRequestId` lets a retried
 * create resolve to the same session; `permissionCeiling` caps the session's
 * permission mode at a level, and `permissionMode` names the mode to start in.
 *
 * `instructions` is retained on the session and reaches the harness through its
 * instruction channel on every turn, so it is never re-sent by a caller and
 * never arrives as user text.
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

/** UTF-8 bytes. The block is stored whole and prepended to every turn. */
export const SESSION_INSTRUCTIONS_MAX_BYTES = 64 * 1024

export function sessionInstructionsByteLength(instructions: string): number {
  return new TextEncoder().encode(instructions).length
}

export function normalizeSessionCreateBody(input: unknown): SessionCreateBody {
  const row = record(input) ?? {}
  const ceiling = row.permissionCeiling
  return {
    ...(str(row.id) ? { id: str(row.id) } : {}),
    ...(str(row.title) !== undefined ? { title: str(row.title) } : {}),
    ...(str(row.parentID) ? { parentID: str(row.parentID) } : {}),
    ...(str(row.role) ? { role: str(row.role) } : {}),
    ...(str(row.clientRequestId) ? { clientRequestId: str(row.clientRequestId) } : {}),
    ...(isAutoLevel(ceiling) ? { permissionCeiling: ceiling } : {}),
    ...(str(row.permissionMode) ? { permissionMode: str(row.permissionMode) } : {}),
    ...(str(row.instructions) ? { instructions: str(row.instructions) } : {}),
  }
}

/**
 * The create body's `group`, or `undefined` when the caller sent none. A
 * malformed group is returned as the failing field rather than dropped: a
 * session whose group silently lost a slot delegates to the wrong model later.
 */
export function sessionCreateGroup(input: unknown): SessionModelGroupParse | undefined {
  const row = record(input) ?? {}
  if (!("group" in row)) return undefined
  return parseSessionModelGroup(row.group)
}

export function normalizeSessionHarness(input: unknown): SessionHarness | undefined {
  const row = record(input)
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
  const row = record(input)
  if (!row) return undefined
  const providerID = str(row.providerID)
  const modelID = str(row.modelID)
  if (providerID === undefined || modelID === undefined) return undefined
  return { providerID, modelID }
}

export function normalizeSessionConfigUpdate(input: unknown): SessionConfigRequestUpdate {
  const row = record(input) ?? {}
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
  const row = record(input) ?? {}
  const model = record(row.model)
  return normalizeSessionConfigUpdate({
    ...row,
    ...(typeof model?.providerID === "string" && typeof model.id === "string"
      ? { model: { providerID: model.providerID, modelID: model.id } }
      : {}),
    ...(!("variant" in row) && typeof model?.variant === "string" ? { variant: model.variant } : {}),
  })
}

export function normalizeSessionConfig(input: unknown): SessionConfig | undefined {
  const row = record(input) ?? {}
  const update = normalizeSessionConfigUpdate(input)
  if (!update.harness) return undefined
  return {
    harness: update.harness,
    ...(update.model && update.model !== null ? { model: update.model } : {}),
    variant: "variant" in row && (typeof row.variant === "string" || row.variant === null) ? row.variant : null,
    agent: "agent" in row && (typeof row.agent === "string" || row.agent === null) ? row.agent : null,
  }
}
