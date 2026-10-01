import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceOwnerIdentity } from "@claxedo/server-core/platform/auth/authority"
import type { ConnectionTurnCredentials } from "./turn-credentials"

/**
 * A session spends its owner's accounts whoever sends, so a turn's connection
 * credential binds the workspace owner's user-scoped partition, resolved
 * through the authority and never read from the token. Asked before the lease
 * is taken, so a turn no owner answers for is refused rather than left holding
 * the lease.
 */
export async function connectionTurnOwner(
  turnCredentials: ConnectionTurnCredentials | undefined,
  resolveWorkspaceOwner: (workspaceId: string) => Promise<WorkspaceOwnerIdentity | undefined>,
  workspaceId: string,
) {
  if (!turnCredentials) return undefined
  const owner = await resolveWorkspaceOwner(workspaceId)
  if (!owner) throw new ControlPlaneAuthError(403, "session_owner_unresolved", "The session's owner cannot be resolved for its connections")
  return owner.userId
}
