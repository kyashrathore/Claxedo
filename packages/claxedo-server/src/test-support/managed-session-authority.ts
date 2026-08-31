import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { PrivateSessionAuthority } from "@claxedo/server-core/platform/auth/private-session-authority"
import type { SessionTurnAuthority } from "@claxedo/server-core/platform/auth/session-turn-authority"

type ManagedTestAuthority = WorkspaceAuthority & PrivateSessionAuthority & SessionTurnAuthority

/**
 * Complete managed-session seam for composition tests that do not exercise a
 * persistence adapter. Tests may override any method they assert against.
 */
export function testManagedSessionAuthority(
  overrides: Partial<ManagedTestAuthority> = {},
): ManagedTestAuthority {
  const reserveSession: PrivateSessionAuthority["reserveSession"] = async (_auth, input) => ({
    ...input,
    changed: true,
    state: "reserved",
  })
  const acquireSessionTurn: SessionTurnAuthority["acquireSessionTurn"] = async (input) => ({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    turnId: input.turnId,
    leaseId: `lease_${input.turnId}`,
    fencingToken: 1,
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  })
  const renewSessionTurn: SessionTurnAuthority["renewSessionTurn"] = async (input) => ({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    turnId: input.turnId,
    leaseId: input.leaseId,
    fencingToken: input.fencingToken,
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  })
  const releaseSessionTurn: SessionTurnAuthority["releaseSessionTurn"] = async (input) => ({
    released: true,
    sessionId: input.sessionId,
    turnId: input.turnId,
    fencingToken: input.fencingToken,
  })
  return {
    reserveSession,
    registerRuntimeSession: async () => ({ registered: true }),
    markSessionRegistrationAmbiguous: async () => ({ changed: true }),
    beginSessionCompensation: async () => ({ changed: true }),
    completeSessionCompensation: async () => ({ changed: true }),
    authorizeRuntimeSession: async () => ({ allowed: true }),
    runtimeAccessTokenActive: async () => ({ active: true }),
    acquireSessionTurn,
    renewSessionTurn,
    releaseSessionTurn,
    ...overrides,
  } as ManagedTestAuthority
}
