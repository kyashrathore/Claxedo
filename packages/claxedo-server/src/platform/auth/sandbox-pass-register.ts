import type { SandboxPassScope } from "./sandbox-pass"

/** One minted pass as the register holds it: enough to refuse it by `jti` and to find it by workspace. */
export type SandboxPassRecord = Readonly<{
  jti: string
  audience: string
  scope: SandboxPassScope
  issuedAt: number
  expiresAt: number
}>

export type SandboxPassRevocation = Readonly<{
  workspaceId: string
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
  record(pass: SandboxPassRecord): Promise<void>
  revoked(jti: string): Promise<boolean>
  /** Revokes the outstanding passes of one workspace; answers how many it found. */
  revoke(input: SandboxPassRevocation): Promise<number>
  /** The unexpired, unrevoked passes under one organization, one audience. */
  outstanding(input: { orgId: string; audience: string }): Promise<readonly SandboxPassRecord[]>
}>

/**
 * The in-process register: the self-hosted signed node's shape and every
 * test's. The self-hosted node mints no pass — its grants are handles into
 * `tasks/session-grants.ts` — so this holds nothing there; it is the D1
 * register's contract made concrete.
 */
export function memorySandboxPassRegister(options: { now?: () => number } = {}): SandboxPassRegister {
  const now = options.now ?? Date.now
  const passes = new Map<string, SandboxPassRecord & { revokedAt?: number; reason?: string }>()
  const live = (pass: SandboxPassRecord & { revokedAt?: number }) => pass.revokedAt === undefined && pass.expiresAt > now()
  return {
    async record(pass) {
      for (const [jti, held] of passes) {
        if (held.expiresAt <= now()) passes.delete(jti)
      }
      passes.set(pass.jti, { ...pass })
    },
    async revoked(jti) {
      return passes.get(jti)?.revokedAt !== undefined
    },
    async revoke(input) {
      let count = 0
      for (const pass of passes.values()) {
        if (pass.scope.workspaceId !== input.workspaceId) continue
        if (input.audience !== undefined && pass.audience !== input.audience) continue
        if (!live(pass)) continue
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
