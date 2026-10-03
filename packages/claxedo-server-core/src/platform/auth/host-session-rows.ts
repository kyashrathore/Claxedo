import type { SessionLastTurn, SessionRef } from "@claxedo/agent-runtime-contract"
import type { SessionRowStatus } from "../../session/navigation-list"
import type { SessionStatusChangedEvent } from "../runtime/lib/bus"

export const MAX_HOST_SESSION_ROWS = 100

/**
 * The host publishing. A machine is named by its Host Tunnel Token, which
 * already lets its holder serve `workspaceIds` over the relay, so publishing
 * those workspaces' list rows asks for nothing the token does not grant. A
 * cloud runtime (`servedBy: "sandbox"`) is named by its session rows pass:
 * one workspace, owned by `ownerUserId`, whose sandbox lease held the pass's
 * epoch when the pass was admitted.
 */
export type HostSessionRowsPublisher = {
  hostId: string
  ownerUserId: string
  workspaceIds: readonly string[]
  enrollmentId?: string
  generation?: number
  servedBy?: "sandbox"
}

/** A session's list entry as its machine holds it. Never a transcript. */
export type HostSessionRow = SessionRef & {
  title?: string
  createdAt: number
  updatedAt: number
  lastHumanTurnAt?: number
  archivedAt?: number
  status: SessionRowStatus
  lastTurn?: SessionLastTurn
}

export type HostSessionRowsPublication = {
  rows: readonly HostSessionRow[]
  removed: readonly SessionRef[]
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

/**
 * What a committed publication answers the machine, and the status notices it
 * owes each reader of a session whose status, wait, background work or last
 * turn the write changed.
 */
export type HostSessionRowsOutcome = HostSessionRowsResult & {
  statusNotices: SessionStatusChangedEvent[]
}

export type HostSessionRowsAuthority = {
  publishHostSessionRows: (
    publisher: HostSessionRowsPublisher,
    publication: HostSessionRowsPublication,
  ) => Promise<HostSessionRowsOutcome>
}

export type HostSessionRowsPlan<Workspace> = {
  adopt: Array<{ row: HostSessionRow; workspace: Workspace }>
  update: HostSessionRow[]
  remove: SessionRef[]
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
  const plan: HostSessionRowsPlan<Workspace> = { adopt: [], update: [], remove: [], result: { accepted: 0, refused: [] } }
  const admit = (ref: SessionRef) => {
    const workspace = served.get(ref.workspaceId)
    const session = existing.get(ref.sessionId)
    const reason: HostSessionRowRefusal["reason"] | undefined = workspace === undefined
      ? "workspace_not_served"
      : session && session.workspaceId !== ref.workspaceId
        ? "session_elsewhere"
        : session?.deleted
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
    if (admit(ref)) plan.remove.push(ref)
  }
  return plan
}
