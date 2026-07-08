import Database from "better-sqlite3"
import type { SessionId, Token, Wake, WakeId, WakeState, WorkspaceId } from "./types"
import type { WakeStore } from "./store"

type Row = Record<string, unknown>

const FIELD_TO_COL: Record<keyof Wake, string> = {
  id: "id",
  sessionId: "session_id",
  workspaceId: "workspace_id",
  triggerType: "trigger_type",
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
CREATE TABLE IF NOT EXISTS effect_receipts (
  key TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`

export type SqliteWakeStoreOptions = { path?: string; db?: Database.Database }

/** better-sqlite3-backed WakeStore. Pass `:memory:` (default) or a file path. */
export class SqliteWakeStore implements WakeStore {
  readonly db: Database.Database

  constructor(opts: SqliteWakeStoreOptions = {}) {
    this.db = opts.db ?? new Database(opts.path ?? ":memory:")
    this.db.pragma("journal_mode = WAL")
    this.db.pragma("busy_timeout = 5000")
    this.db.exec(SCHEMA)
  }

  insert(wake: Wake): { inserted: boolean } {
    const cols = (Object.keys(FIELD_TO_COL) as (keyof Wake)[]).map((f) => FIELD_TO_COL[f])
    const placeholders = cols.map(() => "?").join(", ")
    const values = (Object.keys(FIELD_TO_COL) as (keyof Wake)[]).map((f) => wake[f] ?? null)
    const res = this.db
      .prepare(`INSERT OR IGNORE INTO wakes (${cols.join(", ")}) VALUES (${placeholders})`)
      .run(...values)
    return { inserted: res.changes > 0 }
  }

  get(id: WakeId): Wake | null {
    const r = this.db.prepare("SELECT * FROM wakes WHERE id = ?").get(id) as Row | undefined
    return r ? rowToWake(r) : null
  }

  getByToken(token: Token): Wake | null {
    const r = this.db.prepare("SELECT * FROM wakes WHERE token = ?").get(token) as Row | undefined
    return r ? rowToWake(r) : null
  }

  getByIdempotencyKey(workspaceId: WorkspaceId, key: string): Wake | null {
    const r = this.db
      .prepare("SELECT * FROM wakes WHERE workspace_id = ? AND idempotency_key = ?")
      .get(workspaceId, key) as Row | undefined
    return r ? rowToWake(r) : null
  }

  claimDue(nowMs: number, leaseMs: number, limit: number): Wake[] {
    const rows = this.db
      .prepare(
        `UPDATE wakes SET state = 'firing', lease_until = ?, attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM wakes
           WHERE trigger_type = 'at' AND state = 'pending' AND fire_at IS NOT NULL AND fire_at <= ?
           ORDER BY fire_at ASC LIMIT ?
         )
         RETURNING *`,
      )
      .all(nowMs + leaseMs, nowMs, limit) as Row[]
    return rows.map(rowToWake)
  }

  cas(id: WakeId, from: WakeState, to: WakeState, patch?: Partial<Wake>): boolean {
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

  findPendingByEventKey(eventKey: string): Wake[] {
    return (
      this.db.prepare("SELECT * FROM wakes WHERE event_key = ? AND state = 'pending'").all(eventKey) as Row[]
    ).map(rowToWake)
  }

  findExpirable(nowMs: number): Wake[] {
    return (
      this.db
        .prepare("SELECT * FROM wakes WHERE state = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?")
        .all(nowMs) as Row[]
    ).map(rowToWake)
  }

  findReclaimable(nowMs: number): Wake[] {
    return (
      this.db
        .prepare("SELECT * FROM wakes WHERE state = 'firing' AND lease_until IS NOT NULL AND lease_until <= ?")
        .all(nowMs) as Row[]
    ).map(rowToWake)
  }

  listFiring(): Wake[] {
    return (this.db.prepare("SELECT * FROM wakes WHERE state = 'firing'").all() as Row[]).map(rowToWake)
  }

  listForSession(sessionId: SessionId): Wake[] {
    return (this.db.prepare("SELECT * FROM wakes WHERE session_id = ?").all(sessionId) as Row[]).map(rowToWake)
  }

  countLive(workspaceId: WorkspaceId): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM wakes WHERE workspace_id = ? AND state = 'pending'")
      .get(workspaceId) as { n: number }
    return r.n
  }

  countCreatedSince(workspaceId: WorkspaceId, sinceMs: number): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM wakes WHERE workspace_id = ? AND created_at >= ?")
      .get(workspaceId, sinceMs) as { n: number }
    return r.n
  }

  getReceipt(key: string): string | null {
    const r = this.db.prepare("SELECT result_json FROM effect_receipts WHERE key = ?").get(key) as
      | { result_json: string }
      | undefined
    return r ? r.result_json : null
  }

  putReceipt(key: string, resultJson: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO effect_receipts (key, result_json, created_at) VALUES (?, ?, ?)")
      .run(key, resultJson, Date.now())
  }

  gc(beforeMs: number): number {
    const res = this.db
      .prepare("DELETE FROM wakes WHERE state IN ('fired', 'expired', 'cancelled') AND created_at < ?")
      .run(beforeMs)
    return res.changes
  }

  close(): void {
    this.db.close()
  }
}
