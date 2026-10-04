import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { PrivateSessionAuthority } from "@claxedo/server-core/platform/auth/private-session-authority"
import { normalizeGrantSessionTurnInput, type SessionTurnAuthority } from "@claxedo/server-core/platform/auth/session-turn-authority"

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
  const grantSessionTurn: SessionTurnAuthority["grantSessionTurn"] = async (input) => {
    // The intent-specific fields — the child's wake turn-id prefix above all —
    // come from the same normalizer the D1 and SQLite adapters write their rows
    // from, so a grant this seam mints is one the real verifier accepts.
    const grant = normalizeGrantSessionTurnInput(input)
    const now = Date.now()
    return {
      grantId: `grant_${input.sessionId}`,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      intent: grant.intent,
      ...(grant.subjectSessionId === undefined ? {} : { subjectSessionId: grant.subjectSessionId }),
      ...(grant.turnId === undefined ? {} : { turnId: grant.turnId }),
      ...(grant.turnIdPrefix === undefined ? {} : { turnIdPrefix: grant.turnIdPrefix }),
      issuedAt: now,
      expiresAt: now + grant.ttlMs,
    }
  }
  const revokeSessionTurnGrants: SessionTurnAuthority["revokeSessionTurnGrants"] = async () => ({ revoked: 0 })
  return {
    reserveSession,
    registerRuntimeSession: async () => ({ registered: true }),
    markSessionRegistrationAmbiguous: async () => ({ changed: true }),
    beginSessionCompensation: async () => ({ changed: true }),
    completeSessionCompensation: async () => ({ changed: true }),
    authorizeRuntimeSessionStartStatus: async () => {},
    authorizeRuntimeSessionStart: async () => {},
    authorizeRuntimeSession: async () => ({ allowed: true }),
    runtimeAccessTokenActive: async () => ({ active: true }),
    acquireSessionTurn,
    renewSessionTurn,
    releaseSessionTurn,
    grantSessionTurn,
    revokeSessionTurnGrants,
    ...overrides,
  } as ManagedTestAuthority
}
