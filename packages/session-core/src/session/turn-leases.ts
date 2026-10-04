import type { SqliteDatabase } from "../sqlite/database"

type Waiter = (leaseId: string | undefined) => void

/**
 * The durable one-writer lease each session's turn holds. A caller that may
 * wait for the holder to finish is handed the lease inside the release that
 * frees it, so no other claim can land in between; the handoff is in-process,
 * and a release by another store instance reaches no waiter here.
 */
export class TurnLeases {
  private readonly waiters = new Map<string, Waiter[]>()

  constructor(private readonly db: SqliteDatabase) {}

  acquire(sessionId: string): string | undefined {
    const leaseId = `${sessionId}:${crypto.randomUUID()}`
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO session_turn_lease (session_id, lease_id, acquired_at)
      VALUES (?, ?, ?)
    `).run(sessionId, leaseId, Date.now())
    return result.changes === 1 ? leaseId : undefined
  }

  release(sessionId: string, leaseId: string): void {
    const released = this.db.prepare(`DELETE FROM session_turn_lease WHERE session_id = ? AND lease_id = ?`).run(sessionId, leaseId)
    if (released.changes === 1) this.handOff(sessionId)
  }

  read(sessionId: string): { leaseId: string; acquiredAt: number } | undefined {
    const row = this.db.prepare<{ lease_id: string; acquired_at: number }>(
      "SELECT lease_id, acquired_at FROM session_turn_lease WHERE session_id = ?",
    ).get(sessionId)
    return row ? { leaseId: row.lease_id, acquiredAt: row.acquired_at } : undefined
  }

  clear(): void {
    this.db.exec("DELETE FROM session_turn_lease")
  }

  /** The lease now, or the moment its holder releases it; `undefined` once `signal` aborts first. */
  acquireOnRelease(sessionId: string, signal: AbortSignal): Promise<string | undefined> {
    const now = this.acquire(sessionId)
    if (now || signal.aborted) return Promise.resolve(now)
    return new Promise((resolve) => {
      const waiter: Waiter = (leaseId) => {
        signal.removeEventListener("abort", abandon)
        resolve(leaseId)
      }
      const abandon = () => {
        const queue = this.waiters.get(sessionId)?.filter((candidate) => candidate !== waiter)
        if (queue?.length) this.waiters.set(sessionId, queue)
        else this.waiters.delete(sessionId)
        resolve(undefined)
      }
      signal.addEventListener("abort", abandon, { once: true })
      this.waiters.set(sessionId, [...this.waiters.get(sessionId) ?? [], waiter])
    })
  }

  private handOff(sessionId: string): void {
    const queue = this.waiters.get(sessionId)
    const next = queue?.shift()
    if (!queue?.length) this.waiters.delete(sessionId)
    next?.(this.acquire(sessionId))
  }
}
