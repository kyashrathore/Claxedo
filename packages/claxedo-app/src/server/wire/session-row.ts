import { asFiniteNumber, isRecord, nonEmptyString } from "@claxedo/helpers/guards"
import { readField, readFiniteNumber } from "@claxedo/helpers/readers"
import type { AgentSession } from "@claxedo/agent-runtime-contract"
import { contractMismatch } from "../errors"
import { sessionId, type PlacementId, type ProjectId } from "../ids"
import type { ListedStatus } from "../status-types"
import type { ModelChoice, SessionLocation, SessionRow, SessionSelections } from "../types"
import { sessionConfigFromWire } from "./harness-state"
import { backgroundWorkFromWire } from "./status"

export type Address = {
  readonly placementFor: (directory: string, workspaceId?: string, sessionId?: string) => { readonly placementId: PlacementId; readonly projectId: ProjectId } | undefined
}

export function isSessionWire(value: unknown): value is AgentSession {
  return isRecord(value) && typeof value.id === "string"
}

export function sessionFromWire(value: unknown): AgentSession {
  if (!isSessionWire(value)) throw contractMismatch("session")
  return value
}

export function sessionLocationFor(address: Address, input: { directory: string; workspaceId?: string; sessionId: string }): SessionLocation | undefined {
  const placed = address.placementFor(input.directory, input.workspaceId, input.sessionId)
  if (!placed) return undefined
  return { projectId: placed.projectId, placementId: placed.placementId, sessionId: sessionId(input.sessionId) }
}

export function sessionRowFromListItem(row: unknown, address: Address): SessionRow | undefined {
  if (!isRecord(row)) return undefined
  const id = nonEmptyString(row.sessionId)
  const directory = nonEmptyString(row.directory)
  const createdAt = asFiniteNumber(row.createdAt)
  const updatedAt = asFiniteNumber(row.updatedAt)
  if (!id || !directory || createdAt === undefined || updatedAt === undefined) return undefined
  const ref = sessionLocationFor(address, { directory, workspaceId: nonEmptyString(row.workspaceId), sessionId: id })
  if (!ref) return undefined
  const lastHumanTurnAt = asFiniteNumber(row.lastHumanTurnAt)
  const archivedAt = asFiniteNumber(row.archivedAt)
  const parentSessionId = nonEmptyString(row.parentSessionId)
  return {
    ref,
    title: nonEmptyString(row.title) ?? id,
    createdAt,
    updatedAt,
    ...(lastHumanTurnAt !== undefined ? { lastHumanTurnAt } : {}),
    ...(archivedAt ? { archivedAt } : {}),
    ...(parentSessionId ? { parentSessionId: sessionId(parentSessionId) } : {}),
  }
}

function configuredSelection(info: AgentSession & { readonly config?: unknown }): SessionSelections {
  const config = sessionConfigFromWire(info.config)
  const harness = config?.harness?.type
  const { modelId, providerId } = config?.model ?? {}
  const model: ModelChoice | undefined = modelId && providerId ? { providerId, modelId, ...(config?.variant ? { variant: config.variant } : {}) } : undefined
  const permissionMode = config?.permissionMode
  const permissionModeLabel = permissionMode ? config?.permissionModeLabel : undefined
  return { ...(harness ? { harness } : {}), ...(model ? { model } : {}), ...(permissionMode ? { permissionMode } : {}), ...(permissionModeLabel ? { permissionModeLabel } : {}) }
}

export function sessionRowFromSession(info: AgentSession, ref: SessionLocation): SessionRow {
  const created = info.time?.created ?? 0
  const updated = info.time?.updated ?? created
  const archived = info.time?.archived
  const lastHumanTurnAt = readFiniteNumber(info.time, "lastHumanTurn")
  const parent = nonEmptyString(info.parentID)
  return {
    ref,
    title: nonEmptyString(info.title) ?? ref.sessionId,
    createdAt: created,
    updatedAt: updated,
    ...(lastHumanTurnAt !== undefined ? { lastHumanTurnAt } : {}),
    ...(archived ? { archivedAt: archived } : {}),
    ...(parent ? { parentSessionId: sessionId(parent) } : {}),
    ...(info.lastTurn ? { lastTurn: info.lastTurn } : {}),
    ...configuredSelection(info),
  }
}

export function sessionRowFromCentral(row: unknown, ref: SessionLocation): SessionRow | undefined {
  if (!isRecord(row)) return undefined
  if (nonEmptyString(row.session_id) !== ref.sessionId) return undefined
  const createdAt = asFiniteNumber(row.created_at)
  if (createdAt === undefined) return undefined
  const lastHumanTurnAt = asFiniteNumber(row.last_human_turn_at)
  return {
    ref,
    title: nonEmptyString(row.title) ?? ref.sessionId,
    createdAt,
    updatedAt: asFiniteNumber(row.updated_at) ?? createdAt,
    ...(lastHumanTurnAt !== undefined ? { lastHumanTurnAt } : {}),
  }
}

const WORKING: ListedStatus["status"] = { kind: "working" }
const IDLE: ListedStatus["status"] = { kind: "idle" }

export function listedStatusFromListItem(item: unknown): ListedStatus | undefined {
  const status = readField(item, "status")
  if (!isRecord(status)) return undefined
  const { kind, awaitingInput } = status
  if (kind !== "idle" && kind !== "busy" && kind !== "retry" && kind !== "recovering") return undefined
  return { status: kind === "idle" ? IDLE : WORKING, waitingOnUser: awaitingInput === true, backgroundWork: backgroundWorkFromWire(status) }
}
