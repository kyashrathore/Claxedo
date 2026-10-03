import type { SessionRef, SessionAttentionFacts, SessionAttentionEvent, AgentTurnOutcome } from "@claxedo/agent-runtime-contract"
import type { SessionRowStatus } from "../../session/navigation-list"

export const MAX_HOST_SESSION_ROWS = 100

/**
 * The machine publishing, as its Host Tunnel Token names it. The token already
 * lets its holder serve `workspaceIds` over the relay, so publishing those
 * workspaces' list rows asks for nothing the token does not grant.
 */
export type HostSessionRowsPublisher = {
  hostId: string
  ownerUserId: string
  workspaceIds: readonly string[]
  enrollmentId?: string
  generation?: number
}

/** A session's list entry as its machine holds it. Never a transcript. */
export type HostSessionRow = SessionRef & {
  /** Recovery provenance for the canonical Working entry, never derived from its timestamp. */
  replayed?: boolean
  title?: string
  parentSessionId?: string
  createdAt: number
  updatedAt: number
  lastHumanTurnAt?: number
  archivedAt?: number
  status: SessionRowStatus
  attention?: SessionAttentionFacts
  lastTurn?: AgentTurnOutcome
}

export type HostSessionRowsPublication = {
  rows: readonly HostSessionRow[]
  removed: readonly SessionRef[]
  attention?: readonly SessionAttentionPublication[]
}

export type SessionAttentionPublication = SessionRef & {
  generation: number
  through: number
  events: readonly SessionAttentionEvent[]
}

/**
 * `workspace_not_served`: the workspace is not currently served by this
 * enrollment at this generation. `session_elsewhere`: the session id is
 * registered to another workspace. `session_deleted`: the control plane
 * deleted it, and a machine republishing it does not bring it back.
 */
export type HostSessionRowRefusal = SessionRef & {
  reason: "workspace_not_served" | "session_elsewhere" | "session_deleted"
}

export type HostSessionRowsResult = {
  accepted: number
  refused: HostSessionRowRefusal[]
}

export type HostSessionRowsAuthority = {
  publishHostSessionRows: (
    publisher: HostSessionRowsPublisher,
    publication: HostSessionRowsPublication,
  ) => Promise<HostSessionRowsResult>
}

export type HostSessionRowsPlan<Workspace> = {
  adopt: Array<{ row: HostSessionRow; workspace: Workspace }>
  update: HostSessionRow[]
  remove: SessionRef[]
  attention: SessionAttentionPublication[]
  result: HostSessionRowsResult
}

/**
 * What a publication does against a store, decided once for every adapter:
 * `served` holds the workspaces the enrollment serves now, `existing` every
 * registered session the publication names. A session is adopted before its
 * list fields are written.
 */
export function planHostSessionRows<Workspace>(
  publication: HostSessionRowsPublication,
  served: ReadonlyMap<string, Workspace>,
  existing: ReadonlyMap<string, { workspaceId: string; deleted: boolean }>,
): HostSessionRowsPlan<Workspace> {
  const plan: HostSessionRowsPlan<Workspace> = { adopt: [], update: [], remove: [], attention: [], result: { accepted: 0, refused: [] } }
  const admit = (ref: SessionRef, removal = false) => {
    const workspace = served.get(ref.workspaceId)
    const session = existing.get(ref.sessionId)
    const reason: HostSessionRowRefusal["reason"] | undefined = workspace === undefined
      ? "workspace_not_served"
      : session && session.workspaceId !== ref.workspaceId
        ? "session_elsewhere"
        : session?.deleted && !removal
          ? "session_deleted"
          : undefined
    if (reason) plan.result.refused.push({ workspaceId: ref.workspaceId, sessionId: ref.sessionId, reason })
    else plan.result.accepted++
    return reason || workspace === undefined ? undefined : { workspace, registered: session !== undefined }
  }
  for (const row of publication.rows) {
    const admitted = admit(row)
    if (!admitted) continue
    if (!admitted.registered) plan.adopt.push({ row, workspace: admitted.workspace })
    plan.update.push(row)
  }
  for (const ref of publication.removed) {
    if (admit(ref, true)) plan.remove.push(ref)
  }
  for (const batch of publication.attention ?? []) {
    const same = (ref: SessionRef) => ref.workspaceId === batch.workspaceId && ref.sessionId === batch.sessionId
    if (publication.rows.some(same)) {
      if (plan.update.some(same)) plan.attention.push(batch)
    } else if (!publication.removed.some(same) && admit(batch)) plan.attention.push(batch)
  }
  return plan
}
