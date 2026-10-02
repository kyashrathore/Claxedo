import { asFiniteNumber, nonEmptyString } from "@claxedo/helpers/guards"
import type { AgentSession } from "@claxedo/agent-runtime-contract"
import { sessionId, type PlacementId, type ProjectId, type SessionId } from "../ids"
import type { ListedStatus } from "../status-types"
import type { ModelChoice, SessionLocation, SessionRow, SessionSelections } from "../types"
import { sessionConfigFromWire } from "./harness-state"
import { backgroundWorkFromWire } from "./status"

export type Address = {
  readonly placementFor: (directory: string, workspaceId?: string, sessionId?: string) => { readonly placementId: PlacementId; readonly projectId: ProjectId } | undefined
}

export function sessionLocationFor(address: Address, input: { directory: string; workspaceId?: string; sessionId: string }): SessionLocation | undefined {
  const placed = address.placementFor(input.directory, input.workspaceId, input.sessionId)
  if (!placed) return undefined
  return { projectId: placed.projectId, placementId: placed.placementId, sessionId: sessionId(input.sessionId) }
}

export function sessionRowFromListItem(item: unknown, address: Address): SessionRow | undefined {
  if (!item || typeof item !== "object") return undefined
  const row = item as Record<string, unknown>
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
    ...(parentSessionId ? { parentSessionId: sessionId(parentSessionId) as SessionId } : {}),
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
  const lastHumanTurnAt = asFiniteNumber((info.time as { lastHumanTurn?: unknown } | undefined)?.lastHumanTurn)
  const parent = nonEmptyString(info.parentID)
  return {
    ref,
    title: nonEmptyString(info.title) ?? ref.sessionId,
    createdAt: created,
    updatedAt: updated,
    ...(lastHumanTurnAt !== undefined ? { lastHumanTurnAt } : {}),
    ...(archived ? { archivedAt: archived } : {}),
    ...(parent ? { parentSessionId: sessionId(parent) as SessionId } : {}),
    ...(info.lastTurn ? { lastTurn: info.lastTurn } : {}),
    ...configuredSelection(info),
  }
}

export function sessionRowFromCentral(item: unknown, ref: SessionLocation): SessionRow | undefined {
  if (!item || typeof item !== "object") return undefined
  const row = item as Record<string, unknown>
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
  const status = (item as { status?: unknown } | null)?.status
  if (!status || typeof status !== "object") return undefined
  const { kind, awaitingInput } = status as { kind?: unknown; awaitingInput?: unknown }
  if (kind !== "idle" && kind !== "busy" && kind !== "retry" && kind !== "recovering") return undefined
  return { status: kind === "idle" ? IDLE : WORKING, waitingOnUser: awaitingInput === true, backgroundWork: backgroundWorkFromWire(status) }
}
