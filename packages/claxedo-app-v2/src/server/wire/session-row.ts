import type { AgentSession } from "@claxedo/agent-runtime-contract"
import { sessionId, type PlacementId, type ProjectId, type SessionId } from "../ids"
import type { SessionRef, SessionRow } from "../types"

export type Address = {
  readonly placementFor: (directory: string, workspaceId?: string) => { readonly placementId: PlacementId; readonly projectId: ProjectId } | undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function sessionRefFor(address: Address, input: { directory: string; workspaceId?: string; sessionId: string }): SessionRef | undefined {
  const placed = address.placementFor(input.directory, input.workspaceId)
  if (!placed) return undefined
  return { projectId: placed.projectId, placementId: placed.placementId, sessionId: sessionId(input.sessionId) }
}

export function sessionRowFromListItem(item: unknown, address: Address): SessionRow | undefined {
  if (!item || typeof item !== "object") return undefined
  const row = item as Record<string, unknown>
  const id = text(row.sessionId)
  const directory = text(row.directory)
  const createdAt = number(row.createdAt)
  const updatedAt = number(row.updatedAt)
  if (!id || !directory || createdAt === undefined || updatedAt === undefined) return undefined
  const ref = sessionRefFor(address, { directory, workspaceId: text(row.workspaceId), sessionId: id })
  if (!ref) return undefined
  const lastHumanTurnAt = number(row.lastHumanTurnAt)
  const archivedAt = number(row.archivedAt)
  const parentSessionId = text(row.parentSessionId)
  return {
    ref,
    title: text(row.title) ?? id,
    createdAt,
    updatedAt,
    ...(lastHumanTurnAt !== undefined ? { lastHumanTurnAt } : {}),
    ...(archivedAt ? { archivedAt } : {}),
    ...(parentSessionId ? { parentSessionId: sessionId(parentSessionId) as SessionId } : {}),
  }
}

export function sessionRowFromSession(info: AgentSession, ref: SessionRef): SessionRow {
  const created = info.time?.created ?? 0
  const updated = info.time?.updated ?? created
  const archived = info.time?.archived
  const lastHumanTurnAt = number((info.time as { lastHumanTurn?: unknown } | undefined)?.lastHumanTurn)
  const parent = text(info.parentID)
  return {
    ref,
    title: text(info.title) ?? ref.sessionId,
    createdAt: created,
    updatedAt: updated,
    ...(lastHumanTurnAt !== undefined ? { lastHumanTurnAt } : {}),
    ...(archived ? { archivedAt: archived } : {}),
    ...(parent ? { parentSessionId: sessionId(parent) as SessionId } : {}),
    ...(info.lastTurn ? { lastTurn: info.lastTurn } : {}),
  }
}

export function sessionRowFromCentral(item: unknown, ref: SessionRef): SessionRow | undefined {
  if (!item || typeof item !== "object") return undefined
  const row = item as Record<string, unknown>
  if (text(row.session_id) !== ref.sessionId) return undefined
  const createdAt = number(row.created_at)
  if (createdAt === undefined) return undefined
  const lastHumanTurnAt = number(row.last_human_turn_at)
  return {
    ref,
    title: text(row.title) ?? ref.sessionId,
    createdAt,
    updatedAt: number(row.updated_at) ?? createdAt,
    ...(lastHumanTurnAt !== undefined ? { lastHumanTurnAt } : {}),
  }
}
