import Database from "better-sqlite3"
import type { SessionId, Token, Wake, WakeId, WakeState, WorkspaceId } from "./types"
import type { WakeStore } from "./store"

type Row = Record<string, unknown>

const FIELD_TO_COL: Record<keyof Wake, string> = {
  id: "id",
  sessionId: "session_id",
  workspaceId: "workspace_id",
  triggerType: "trigger_type",
  kind: "kind",
  serialKey: "serial_key",
  intentJson: "intent_json",
  resultJson: "result_json",
  state: "state",
  expiresAt: "expires_at",
  depth: "depth",
  createdBy: "created_by",
  createdAt: "created_at",
  firedAt: "fired_at",
  fireAt: "fire_at",
  schedule: "schedule",
  eventKey: "event_key",
  token: "token",
  prompt: "prompt",
  resolvedBy: "resolved_by",
  idempotencyKey: "idempotency_key",
  leaseUntil: "lease_until",
  attempts: "attempts",
}

function rowToWake(r: Row): Wake {
  return {
    id: r.id as string,
    sessionId: (r.session_id as string) ?? null,
    workspaceId: r.workspace_id as string,
    triggerType: r.trigger_type as Wake["triggerType"],
    kind: (r.kind as string) ?? "session_turn",
    serialKey: (r.serial_key as string) ?? null,
    intentJson: r.intent_json as string,
    resultJson: (r.result_json as string) ?? null,
    state: r.state as WakeState,
    expiresAt: (r.expires_at as number) ?? null,
    depth: r.depth as number,
    createdBy: (r.created_by as string) ?? null,
    createdAt: r.created_at as number,
    firedAt: (r.fired_at as number) ?? null,
    fireAt: (r.fire_at as number) ?? null,
    schedule: (r.schedule as string) ?? null,
    eventKey: (r.event_key as string) ?? null,
    token: (r.token as string) ?? null,
    prompt: (r.prompt as string) ?? null,
    resolvedBy: (r.resolved_by as string) ?? null,
    idempotencyKey: (r.idempotency_key as string) ?? null,
    leaseUntil: (r.lease_until as number) ?? null,
    attempts: r.attempts as number,
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wakes (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  workspace_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'session_turn',
  serial_key TEXT,
  intent_json TEXT NOT NULL,
  result_json TEXT,
  state TEXT NOT NULL,
  expires_at INTEGER,
  depth INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  fired_at INTEGER,
  fire_at INTEGER,
  schedule TEXT,
  event_key TEXT,
  token TEXT,
  prompt TEXT,
  resolved_by TEXT,
  idempotency_key TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS wakes_idem ON wakes(workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS wakes_due ON wakes(trigger_type, state, fire_at);
CREATE INDEX IF NOT EXISTS wakes_event ON wakes(event_key, state);
CREATE INDEX IF NOT EXISTS wakes_token ON wakes(token);
CREATE INDEX IF NOT EXISTS wakes_ws_state ON wakes(workspace_id, state);
CREATE INDEX IF NOT EXISTS wakes_session ON wakes(session_id);
CREATE INDEX IF NOT EXISTS wakes_expiry ON wakes(state, expires_at);
CREATE INDEX IF NOT EXISTS wakes_lane ON wakes(serial_key, state) WHERE serial_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS effect_receipts (
  key TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`

export type SqliteWakeStoreOptions = { path?: string; db?: Database.Database }

/**
 * better-sqlite3-backed WakeStore. Pass `:memory:` (default) or a file path.
 * Internals are synchronous; the async signatures satisfy the port.
 */
export class SqliteWakeStore implements WakeStore {
  readonly db: Database.Database

  // Create-only: no ALTER upgrades. A wake DB file
  // predating a schema change is deleted and recreated, never migrated.
  constructor(opts: SqliteWakeStoreOptions = {}) {
    this.db = opts.db ?? new Database(opts.path ?? ":memory:")
    this.db.pragma("journal_mode = WAL")
    this.db.pragma("busy_timeout = 5000")
    this.db.exec(SCHEMA)
  }

  async insert(wake: Wake): Promise<{ inserted: boolean }> {
    const cols = (Object.keys(FIELD_TO_COL) as (keyof Wake)[]).map((f) => FIELD_TO_COL[f])
    const placeholders = cols.map(() => "?").join(", ")
    const values = (Object.keys(FIELD_TO_COL) as (keyof Wake)[]).map((f) => wake[f] ?? null)
    const res = this.db
      .prepare(`INSERT OR IGNORE INTO wakes (${cols.join(", ")}) VALUES (${placeholders})`)
      .run(...values)
    return { inserted: res.changes > 0 }
  }

  async get(id: WakeId): Promise<Wake | null> {
    const r = this.db.prepare("SELECT * FROM wakes WHERE id = ?").get(id) as Row | undefined
    return r ? rowToWake(r) : null
  }

  async getByToken(token: Token): Promise<Wake | null> {
    const r = this.db.prepare("SELECT * FROM wakes WHERE token = ?").get(token) as Row | undefined
    return r ? rowToWake(r) : null
  }

  async getByIdempotencyKey(workspaceId: WorkspaceId, key: string): Promise<Wake | null> {
    const r = this.db
      .prepare("SELECT * FROM wakes WHERE workspace_id = ? AND idempotency_key = ?")
      .get(workspaceId, key) as Row | undefined
    return r ? rowToWake(r) : null
  }

  async claimDue(nowMs: number, leaseMs: number, limit: number, serialKey?: string | null): Promise<Wake[]> {
    // Lane rule: a serial-keyed wake is claimable only when no other wake of
    // its key is already `firing`, and one claim batch takes at most one wake
    // per key (earliest first). Null-key wakes have no lane (own partition
    // via COALESCE to their unique id). `serialKey` scopes the claim:
    // undefined = all lanes, null = only null-key wakes, string = that lane.
    const laneFilter =
      serialKey === undefined ? "" : serialKey === null ? "AND serial_key IS NULL" : "AND serial_key = ?"
    const laneParams = typeof serialKey === "string" ? [serialKey] : []
    const rows = this.db
      .prepare(
        `UPDATE wakes SET state = 'firing', lease_until = ?, attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM (
             SELECT id, fire_at,
                    ROW_NUMBER() OVER (PARTITION BY COALESCE(serial_key, id) ORDER BY fire_at ASC, id ASC) AS lane_rank
             FROM wakes
             WHERE trigger_type = 'at' AND state = 'pending' AND fire_at IS NOT NULL AND fire_at <= ?
               ${laneFilter}
               AND (serial_key IS NULL OR serial_key NOT IN (
                 SELECT serial_key FROM wakes WHERE state = 'firing' AND serial_key IS NOT NULL
               ))
           )
           WHERE lane_rank = 1
           ORDER BY fire_at ASC LIMIT ?
         )
         RETURNING *`,
      )
      .all(nowMs + leaseMs, nowMs, ...laneParams, limit) as Row[]
    return rows.map(rowToWake)
  }

  async cas(id: WakeId, from: WakeState, to: WakeState, patch?: Partial<Wake>): Promise<boolean> {
    const setCols = ["state = ?"]
    const setVals: unknown[] = [to]
    if (patch) {
      for (const [k, v] of Object.entries(patch)) {
        const col = FIELD_TO_COL[k as keyof Wake]
        if (!col || col === "state" || col === "id") continue
        setCols.push(`${col} = ?`)
        setVals.push(v ?? null)
      }
    }
    const res = this.db
      .prepare(`UPDATE wakes SET ${setCols.join(", ")} WHERE id = ? AND state = ?`)
      .run(...setVals, id, from)
    return res.changes > 0
  }

  async findPendingByEventKey(eventKey: string): Promise<Wake[]> {
    return (
      this.db.prepare("SELECT * FROM wakes WHERE event_key = ? AND state = 'pending'").all(eventKey) as Row[]
    ).map(rowToWake)
  }

  async findExpirable(nowMs: number): Promise<Wake[]> {
    return (
      this.db
        .prepare("SELECT * FROM wakes WHERE state = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?")
        .all(nowMs) as Row[]
    ).map(rowToWake)
  }

  async reclaimFiring(nowMs: number, leaseMs: number, serialKey?: string | null): Promise<Wake[]> {
    // Atomic re-claim: one UPDATE ... RETURNING re-stamps the lease past `nowMs`
    // and returns only the rows this statement changed. A concurrent reclaimer
    // then finds the row's `lease_until` beyond its horizon and matches nothing,
    // so the returned rows are exclusively this caller's to drive.
    const laneFilter =
      serialKey === undefined ? "" : serialKey === null ? "AND serial_key IS NULL" : "AND serial_key = ?"
    const laneParams = typeof serialKey === "string" ? [serialKey] : []
    const rows = this.db
      .prepare(
        `UPDATE wakes SET lease_until = ?
         WHERE state = 'firing' AND lease_until IS NOT NULL AND lease_until <= ? ${laneFilter}
         RETURNING *`,
      )
      .all(nowMs + leaseMs, nowMs, ...laneParams) as Row[]
    return rows.map(rowToWake)
  }

  async listFiring(serialKey?: string | null): Promise<Wake[]> {
    const laneFilter =
      serialKey === undefined ? "" : serialKey === null ? "AND serial_key IS NULL" : "AND serial_key = ?"
    const laneParams = typeof serialKey === "string" ? [serialKey] : []
    return (this.db.prepare(`SELECT * FROM wakes WHERE state = 'firing' ${laneFilter}`).all(...laneParams) as Row[])
      .map(rowToWake)
  }

  async listForSession(sessionId: SessionId): Promise<Wake[]> {
    return (this.db.prepare("SELECT * FROM wakes WHERE session_id = ?").all(sessionId) as Row[]).map(rowToWake)
  }

  async countLive(workspaceId: WorkspaceId): Promise<number> {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM wakes WHERE workspace_id = ? AND state = 'pending'")
      .get(workspaceId) as { n: number }
    return r.n
  }

  async countCreatedSince(workspaceId: WorkspaceId, sinceMs: number): Promise<number> {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM wakes WHERE workspace_id = ? AND created_at >= ?")
      .get(workspaceId, sinceMs) as { n: number }
    return r.n
  }

  async getReceipt(key: string): Promise<string | null> {
    const r = this.db.prepare("SELECT result_json FROM effect_receipts WHERE key = ?").get(key) as
      | { result_json: string }
      | undefined
    return r ? r.result_json : null
  }

  async putReceipt(key: string, resultJson: string): Promise<void> {
    this.db
      .prepare("INSERT OR IGNORE INTO effect_receipts (key, result_json, created_at) VALUES (?, ?, ?)")
      .run(key, resultJson, Date.now())
  }

  async gc(beforeMs: number): Promise<number> {
    const res = this.db
      .prepare("DELETE FROM wakes WHERE state IN ('fired', 'expired', 'cancelled') AND created_at < ?")
      .run(beforeMs)
    return res.changes
  }

  close(): void {
    this.db.close()
  }
}
