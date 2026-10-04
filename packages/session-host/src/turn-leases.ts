import type { SessionAccessPolicy, SessionAccessPolicyInput, SessionTurnLeaseDecision } from "@claxedo/session-core"

type SqlCursor = { toArray(): Record<string, unknown>[] }
export type SqlStorage = { exec(query: string, ...bindings: unknown[]): SqlCursor }

export type TurnLease = { sessionId: string; turnId: string; leaseId: string; fencingToken: number; expiresAt: number }

export type StoredTurnLease = TurnLease & { access: Pick<SessionAccessPolicyInput, "actor" | "authority"> }

export const turnLeaseKey = (lease: Pick<TurnLease, "turnId" | "fencingToken">) => `${lease.turnId}:${lease.fencingToken}`

/**
 * The latest turn lease this object was issued for each session, as the
 * authority last renewed it, kept in the object's own SQLite so a restarted
 * object can take the lease over. A lease leaves the table when its turn ends.
 */
export class TurnLeases {
  constructor(private readonly sql: SqlStorage, private readonly ended: (lease: TurnLease) => void) {
    sql.exec(`CREATE TABLE IF NOT EXISTS session_host_turn_lease (
      session_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, lease_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL, expires_at INTEGER NOT NULL, access TEXT NOT NULL)`)
  }

  current(sessionId: string): StoredTurnLease | undefined {
    const [row] = this.sql.exec("SELECT * FROM session_host_turn_lease WHERE session_id = ?", sessionId).toArray()
    if (!row) return undefined
    const access: StoredTurnLease["access"] = JSON.parse(String(row.access))
    return { sessionId, turnId: String(row.turn_id), leaseId: String(row.lease_id), fencingToken: Number(row.fencing_token),
      expiresAt: Number(row.expires_at), access }
  }

  end(lease: Pick<TurnLease, "sessionId" | "turnId">): void {
    const current = this.current(lease.sessionId)
    if (current?.turnId !== lease.turnId) return
    this.sql.exec("DELETE FROM session_host_turn_lease WHERE session_id = ?", lease.sessionId)
    this.ended(current)
  }

  /** The policy with every lease it issues or renews recorded, and every ended turn's lease forgotten. */
  observe(policy: SessionAccessPolicy): SessionAccessPolicy {
    const record = (input: SessionAccessPolicyInput & { sessionId: string }, decision: SessionTurnLeaseDecision) => {
      if (decision.allowed) {
        this.sql.exec(`INSERT INTO session_host_turn_lease VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
          turn_id = excluded.turn_id, lease_id = excluded.lease_id, fencing_token = excluded.fencing_token,
          expires_at = excluded.expires_at, access = excluded.access`,
        input.sessionId, decision.turnId, decision.leaseId, decision.fencingToken, decision.expiresAt,
        JSON.stringify({ actor: input.actor, authority: input.authority }))
      }
      return decision
    }
    return {
      ...policy,
      acquireTurn: async (input) => record(input, await policy.acquireTurn!(input)),
      renewTurn: async (input) => record(input, await policy.renewTurn!(input)),
      endTurn: async (input) => {
        this.end(input)
        await policy.endTurn?.(input)
      },
    }
  }
}
