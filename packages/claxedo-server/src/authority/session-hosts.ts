export type SessionHostPlacement = {
  workspace: { backing: "cloud-vm" | "local-worktree"; directory: string | null }
  /** `creatorUserId`: the person whose accounts the session spends, whoever sends its turns; null for an agent that names nobody. */
  session?: { workspaceId: string; sessionHostRoot: string | null; deleted: boolean; creatorUserId: string | null }
  reservation?: { workspaceId: string; sessionHostRoot: string | null }
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
  /** The workspace owner's editor token the first-party MCP endpoint reaches the machine with for that session's tools. */
  recordSessionMcpRuntimeAccessToken(actorId: string, token: TurnRuntimeAccessTokenRecord): Promise<unknown>
  /** Whether this lease is still the session's live one: neither released nor expired nor superseded. */
  turnLeaseLive(input: { sessionId: string; turnId: string; leaseId: string; fencingToken: number }): Promise<boolean>
  /** Deletes the live row of a session served by its own host; false when there was none. */
  deleteHostedSession(input: { workspaceId: string; sessionId: string }): Promise<boolean>
}

/** The host a session id is placed in: its row's, else its reservation's; nothing for a session the workspace's runtime serves. */
export function placedSessionHostRoot(placement: SessionHostPlacement | undefined): string | undefined {
  if (placement?.session) return placement.session.sessionHostRoot ?? undefined
  return placement?.reservation?.sessionHostRoot ?? undefined
}

/**
 * Whether `sessionId` is served by its own Durable Object in this workspace:
 * its live row, or before registration its reservation, places it there. A
 * deleted session's host is never admitted again.
 */
export function sessionHostAdmits(placement: SessionHostPlacement | undefined, input: { workspaceId: string; sessionId: string }): boolean {
  if (placement?.workspace.backing !== "cloud-vm") return false
  const placed = placement.session ?? placement.reservation
  if (!placed || placed.workspaceId !== input.workspaceId || placed.sessionHostRoot !== input.sessionId) return false
  return !placement.session?.deleted
}
