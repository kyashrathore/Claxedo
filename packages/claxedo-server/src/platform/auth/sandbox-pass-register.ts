import type { SandboxPassScope } from "./sandbox-pass"

/** One minted pass as the register holds it: enough to refuse it by `jti` and to find it by workspace. */
export type SandboxPassRecord = Readonly<{
  jti: string
  audience: string
  scope: SandboxPassScope
  issuedAt: number
  expiresAt: number
  renewable?: boolean
}>

export type SandboxPassRevocation = Readonly<{
  workspaceId: string
  /** Limit a shared workspace scope to one user's passes when present. */
  userId?: string
  /** Limit a shared workspace scope to one organization's passes when present. */
  orgId?: string
  /** One audience's passes, or every audience's when absent. */
  audience?: string
  reason: string
}>

/**
 * The register of every pass this control plane has minted for a sandbox,
 * and which of them it has taken back.
 *
 * A pass is a signed token in a sandbox the control plane cannot reach, so
 * the only way to end it before its `exp` is to refuse it at the door: the
 * verifier asks {@link revoked} for every well-signed pass. The rows exist so
 * a revocation needs no token in hand — the project's switch and the
 * workspace's deletion name a workspace, not a `jti`. A pass minted before
 * the register existed has no row and is refused only by its own expiry.
 */
export type SandboxPassRegister = Readonly<{
  record(pass: SandboxPassRecord, options?: { renewalOf: string }): Promise<void>
  revoked(jti: string): Promise<boolean>
  /** Expired renewal is admitted only for a retained, known and unrevoked proof. */
  renewable(jti: string): Promise<boolean>
  /** A presented proof was received by its client; retire expired siblings while preserving this retry ticket. */
  acknowledge(jti: string): Promise<void>
  /** Revokes the matching outstanding passes of one workspace; answers how many it found. */
  revoke(input: SandboxPassRevocation): Promise<number>
  /** The unexpired, unrevoked passes under one organization, one audience. */
  outstanding(input: { orgId: string; audience: string }): Promise<readonly SandboxPassRecord[]>
}>

/** The in-process register: the D1 register's contract made concrete, for tests. */
export function memorySandboxPassRegister(options: { now?: () => number } = {}): SandboxPassRegister {
  const now = options.now ?? Date.now
  const passes = new Map<string, SandboxPassRecord & { revokedAt?: number; reason?: string }>()
  const live = (pass: SandboxPassRecord & { revokedAt?: number }) => pass.revokedAt === undefined && pass.expiresAt > now()
  return {
    async record(pass, options) {
      if (options) {
        const previous = passes.get(options.renewalOf)
        if (!previous?.renewable || previous.revokedAt !== undefined || !pass.renewable
          || previous.audience !== pass.audience || previous.scope.userId !== pass.scope.userId
          || previous.scope.orgId !== pass.scope.orgId || previous.scope.workspaceId !== pass.scope.workspaceId
          || previous.scope.projectId !== pass.scope.projectId || previous.scope.sessionId !== pass.scope.sessionId) {
          throw new Error("Sandbox proof renewal ended before registration")
        }
      }
      for (const [jti, held] of passes) {
        if (held.expiresAt <= now() && (!held.renewable || held.revokedAt !== undefined)) passes.delete(jti)
      }
      passes.set(pass.jti, { ...pass })
    },
    async revoked(jti) {
      return passes.get(jti)?.revokedAt !== undefined
    },
    async renewable(jti) {
      const pass = passes.get(jti)
      return pass?.renewable === true && pass.revokedAt === undefined
    },
    async acknowledge(jti) {
      const acknowledged = passes.get(jti)
      if (!acknowledged?.renewable || acknowledged.revokedAt !== undefined) return
      for (const [otherId, held] of passes) {
        if (otherId !== jti && held.renewable && held.expiresAt <= now()
          && held.audience === acknowledged.audience && held.scope.workspaceId === acknowledged.scope.workspaceId
          && held.scope.userId === acknowledged.scope.userId && held.scope.orgId === acknowledged.scope.orgId
          && held.scope.projectId === acknowledged.scope.projectId && held.scope.sessionId === acknowledged.scope.sessionId) {
          passes.delete(otherId)
        }
      }
    },
    async revoke(input) {
      let count = 0
      for (const pass of passes.values()) {
        if (pass.scope.workspaceId !== input.workspaceId) continue
        if (input.userId !== undefined && pass.scope.userId !== input.userId) continue
        if (input.orgId !== undefined && pass.scope.orgId !== input.orgId) continue
        if (input.audience !== undefined && pass.audience !== input.audience) continue
        if (pass.revokedAt !== undefined || (!pass.renewable && pass.expiresAt <= now())) continue
        pass.revokedAt = now()
        pass.reason = input.reason
        count += 1
      }
      return count
    },
    async outstanding(input) {
      return [...passes.values()]
        .filter((pass) => pass.scope.orgId === input.orgId && pass.audience === input.audience && live(pass))
        .map(({ revokedAt: _revokedAt, reason: _reason, ...pass }) => pass)
    },
  }
}
