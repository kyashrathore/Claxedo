/**
 * What the control plane knows about a session served by its own Durable
 * Object: the workspace it belongs to and, once the session host has
 * registered it, its row.
 */
export type SessionHostPlacement = {
  workspace: { orgId: string; backing: "cloud-vm" | "local-worktree"; directory: string | null }
  session?: { workspaceId: string; sessionHostRoot: string | null }
}

export type TurnRuntimeAccessTokenRecord = {
  jti: string
  workspaceId: string
  hostId: string
  sessionId: string
  expiresAt: number
}

export type SessionHostAuthority = {
  /** Nothing when the workspace does not exist. */
  readSessionHostPlacement(input: { workspaceId: string; sessionId: string }): Promise<SessionHostPlacement | undefined>
  /** The editor token a session host is minted for one turn, reaching the workspace's machine for that session alone. */
  recordTurnRuntimeAccessToken(actorId: string, token: TurnRuntimeAccessTokenRecord): Promise<unknown>
}

/**
 * Whether `sessionId` may be served by its own Durable Object in this
 * workspace: a cloud workspace, and the id is either not registered yet or
 * registered here as that host's root.
 */
export function sessionHostAdmits(placement: SessionHostPlacement | undefined, input: { workspaceId: string; sessionId: string }): boolean {
  if (placement?.workspace.backing !== "cloud-vm") return false
  const session = placement.session
  return !session || (session.workspaceId === input.workspaceId && session.sessionHostRoot === input.sessionId)
}
