import { randomBytes } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"

export const CONNECTION_TURN_HEADER = "x-claxedo-connection-turn"

type TurnRecord = {
  sessionId: string
  subject?: string
  // Tenant the turn belongs to (hosted org partition): token resolution
  // derives the team partition from THIS org,
  // never from the deployment-wide null partition, so a turn credential can
  // never unlock another org's team rows — even if a subject id collides.
  orgId?: string
  expiresAt: number
}

export type ConnectionTurnCredentials = {
  mint(input: {
    sessionId: string
    subject?: string
    orgId?: string
    /** The authority lease this credential is bound to; `extendLease`/`revokeLease` track it by this id. */
    leaseId?: string
    /** The lease deadline: the credential dies with the turn it was admitted for. */
    expiresAt?: number
  }): string
  resolve(credential: string | undefined): { sessionId: string; subject?: string; orgId?: string } | undefined
  /**
   * Extends the credential held for `leaseId` to the renewed lease's deadline
   * and re-keys it when the authority rotated the lease id. Answers the
   * credential so a renewal can hand the same value back to its holder;
   * `undefined` when the lease was never minted or already revoked.
   */
  extendLease(leaseId: string, renewed: { leaseId: string; expiresAt: number }): string | undefined
  /** Ends the credential minted for `leaseId` — release, loss, or expiry of the turn. */
  revokeLease(leaseId: string): void
  current(): string | undefined
  run<T>(credential: string, fn: () => T): T
  dispose(): void
}

export function createConnectionTurnCredentials(input: {
  now?: () => number
  ttlMs?: number
  random?: () => string
} = {}): ConnectionTurnCredentials {
  const now = input.now ?? Date.now
  const ttlMs = input.ttlMs ?? 10 * 60_000
  const random = input.random ?? (() => randomBytes(32).toString("base64url"))
  const records = new Map<string, TurnRecord>()
  const leases = new Map<string, string>()
  const context = new AsyncLocalStorage<string>()

  const sweep = () => {
    const timestamp = now()
    for (const [credential, record] of records) {
      if (record.expiresAt <= timestamp) records.delete(credential)
    }
    for (const [leaseId, credential] of leases) {
      if (!records.has(credential)) leases.delete(leaseId)
    }
  }

  const resolve = (credential: string | undefined) => {
    if (!credential) return undefined
    const record = records.get(credential)
    if (!record) return undefined
    if (record.expiresAt > now()) {
      return {
        sessionId: record.sessionId,
        ...(record.subject ? { subject: record.subject } : {}),
        ...(record.orgId ? { orgId: record.orgId } : {}),
      }
    }
    records.delete(credential)
    return undefined
  }

  return {
    mint(turn) {
      sweep()
      // A lease-bound mint supersedes every credential the session still
      // holds: fencing admits at most one live turn per session, so a record
      // surviving a later lease is one a released or lost turn left behind.
      if (turn.leaseId) {
        for (const [credential, record] of records) {
          if (record.sessionId === turn.sessionId) {
            records.delete(credential)
            for (const [leaseId, held] of leases) if (held === credential) leases.delete(leaseId)
          }
        }
      }
      const credential = random()
      records.set(credential, {
        sessionId: turn.sessionId,
        ...(turn.subject ? { subject: turn.subject } : {}),
        ...(turn.orgId ? { orgId: turn.orgId } : {}),
        expiresAt: turn.expiresAt ?? now() + ttlMs,
      })
      if (turn.leaseId) leases.set(turn.leaseId, credential)
      return credential
    },
    resolve,
    extendLease(leaseId, renewed) {
      const credential = leases.get(leaseId)
      if (!credential) return undefined
      const record = records.get(credential)
      if (!record) {
        leases.delete(leaseId)
        return undefined
      }
      record.expiresAt = renewed.expiresAt
      if (renewed.leaseId !== leaseId) {
        leases.delete(leaseId)
        leases.set(renewed.leaseId, credential)
      }
      return credential
    },
    revokeLease(leaseId) {
      const credential = leases.get(leaseId)
      if (!credential) return
      leases.delete(leaseId)
      records.delete(credential)
    },
    current() {
      const credential = context.getStore()
      return resolve(credential) ? credential : undefined
    },
    run(credential, fn) {
      return context.run(credential, fn)
    },
    dispose() {
      records.clear()
      leases.clear()
      context.disable()
    },
  }
}
