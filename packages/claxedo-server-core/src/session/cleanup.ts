import { z } from "zod"
import { sessionAttention, type SessionCleanupCandidate, type SessionCleanupIncompleteSource, type SessionCleanupPosition, type SessionCleanupTarget } from "@claxedo/agent-runtime-contract"
import type { SessionListQuery, SessionListResponse, SessionNavigationRow } from "./navigation-list"

const position = {
  sessionId: z.string().trim().min(1),
  generation: z.number().int().nonnegative(),
  activitySequence: z.number().int().nonnegative(),
}

export const sessionCleanupTargetSchema = z.strictObject({
  ...position,
  workspaceId: z.string().trim().min(1),
  readerRevision: z.number().int().nonnegative(),
  descendants: z.array(z.strictObject(position)),
})

export const sessionCleanupDeleteSchema = z.strictObject({
  targets: z.array(sessionCleanupTargetSchema).min(1).max(200),
  cascade: z.boolean(),
})

export interface SessionCleanupPort {
  list(query: SessionListQuery): Promise<SessionListResponse & { incompleteSources?: readonly SessionCleanupIncompleteSource[] }>
  prepare(row: SessionNavigationRow): Promise<{ descendants: readonly SessionCleanupPosition[] } | { unavailable: string }>
  /** Linearizes this command's reader selection; later reader writes do not cancel it. */
  admit(target: SessionCleanupTarget): Promise<void>
  /** Runtime generation/activity must still match under the runtime turn/delete gate. */
  delete(target: SessionCleanupTarget): Promise<{ deletedSessionIds: readonly string[] }>
}

export function sessionCleanupCandidate(row: SessionNavigationRow, descendants: readonly SessionCleanupPosition[]): SessionCleanupCandidate | undefined {
  const facts = row.attention
  if (!facts || !row.workspaceId) return undefined
  const reader = row.reader?.generation === facts.generation ? row.reader : undefined
  const state = sessionAttention(facts, reader)
  return {
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
    generation: facts.generation,
    activitySequence: facts.activitySequence,
    readerRevision: reader?.revision ?? 0,
    descendants,
    title: row.title,
    createdAt: row.createdAt,
    activityAt: facts.activityAt,
    ...(reader?.settledAt === undefined ? {} : { settledAt: reader.settledAt }),
    seen: !state.unseen,
    settled: state.settled,
  }
}
