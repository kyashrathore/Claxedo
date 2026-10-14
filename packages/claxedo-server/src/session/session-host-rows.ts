import { decodeJwt } from "jose"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import type { HostSessionRowsPublication, HostSessionRowsPublisher } from "@claxedo/server-core/platform/auth/host-session-rows"
import type { WorkspaceOwnerIdentity } from "@claxedo/server-core/platform/auth/authority"
import { sessionHostAdmits, type SessionHostAuthority } from "../authority/session-hosts"
import { proofHost, turnLeaseVerifier, TURN_LEASE_AUDIENCE } from "./runtime-session-proofs"

/** A session host as its admitted turn lease names it: the one session it serves, in the one workspace the lease's owner holds. */
export type SessionHostRowsPublisher = HostSessionRowsPublisher & Readonly<{ servedBy: "session-host"; sessionId: string }>

export type SessionHostRows = Readonly<{
  /** Whether a bearer names a turn lease, read without verifying: which verifier to run, not whether to trust it. */
  names(token: string): boolean
  /**
   * The publisher a well-signed, unexpired turn lease stands for: the lease
   * was minted for the session's own host, the session is still placed in
   * that host, and its workspace is still owned in the lease's organization.
   * A lease already released still admits, within its expiry: the row a turn
   * ends with is published after the release that ends it.
   */
  admit(token: string, hostId: string, publication: HostSessionRowsPublication): Promise<SessionHostRowsPublisher | undefined>
}>

/**
 * A session served by its own Durable Object publishes its one list row under
 * the turn lease the session authority issued it, the proof every other call
 * it makes of the plane carries. The lease names one session, so a
 * publication naming any other session, or removing one, is refused whole:
 * the host's row is its own and its deletion goes through
 * `/session-host-delete`.
 */
export function createSessionHostRows(input: {
  env: Record<string, string | undefined>
  sessionHosts: Pick<SessionHostAuthority, "readSessionHostPlacement">
  resolveWorkspaceOwner(workspaceId: string): Promise<WorkspaceOwnerIdentity | undefined>
}): SessionHostRows {
  const verify = turnLeaseVerifier(input.env)
  return {
    names: (token) => {
      try {
        return decodeJwt(token).aud === TURN_LEASE_AUDIENCE
      } catch {
        return false
      }
    },
    admit: async (token, hostId, publication) => {
      const claims = await verify(token).catch(() => undefined)
      if (!claims) return undefined
      const { sessionId, workspaceId } = claims
      const host = sessionHostId(sessionId)
      if (proofHost(claims) !== host || hostId !== host) return undefined
      if (publication.removed.length || publication.rows.some((row) => row.sessionId !== sessionId || row.workspaceId !== workspaceId)) return undefined
      const placement = await input.sessionHosts.readSessionHostPlacement({ workspaceId, sessionId })
      if (!placement?.session || !sessionHostAdmits(placement, { workspaceId, sessionId })) return undefined
      const owner = await input.resolveWorkspaceOwner(workspaceId)
      if (!owner || owner.orgId !== claims.orgId) return undefined
      return { hostId: host, ownerUserId: owner.userId, workspaceIds: [workspaceId], servedBy: "session-host", sessionId }
    },
  }
}
