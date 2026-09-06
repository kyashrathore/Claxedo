import Database from "better-sqlite3"
import type { SessionId, Token, TriggerType, Wake, WakeId, WakeState, WorkspaceId } from "./types"
import type { WakeStore } from "./store"

/** A result row as better-sqlite3 hands it back: column name -> SQLite value. */
type Row = Record<string, unknown>

// The store is create-only (see the constructor): a DB file predating a schema
// change is deleted and recreated, never migrated. Reads therefore validate the
// row shape instead of asserting it, so a stale file fails loudly at the read
// rather than silently producing a `Wake` with undefined fields.
function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null
}

function rowOf(value: unknown, what: string): Row {
  if (!isRow(value)) throw new Error(`wakes: expected a ${what} row object, got ${typeof value}`)
  return value
}

function textOrNull(row: Row, column: string): string | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  if (typeof value !== "string") throw new Error(`wakes: column "${column}" holds ${typeof value}, expected TEXT`)
  return value
}

function text(row: Row, column: string): string {
  const value = textOrNull(row, column)
  if (value === null) throw new Error(`wakes: column "${column}" is NULL, expected TEXT NOT NULL`)
  return value
}

function integerOrNull(row: Row, column: string): number | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  if (typeof value !== "number") throw new Error(`wakes: column "${column}" holds ${typeof value}, expected INTEGER`)
  return value
}

function integer(row: Row, column: string): number {
  const value = integerOrNull(row, column)
  if (value === null) throw new Error(`wakes: column "${column}" is NULL, expected INTEGER NOT NULL`)
  return value
}

// `Record<Union, true>` makes the compiler reject a new union member that is not
// listed, so these guards cannot drift from the types they check.
const TRIGGER_TYPES: Record<TriggerType, true> = { at: true, on_event: true, on_approval: true }
const WAKE_STATES: Record<WakeState, true> = {
  pending: true,
  firing: true,
  fired: true,
  expired: true,
  cancelled: true,
}

function isTriggerType(value: string): value is TriggerType {
  return Object.hasOwn(TRIGGER_TYPES, value)
}

function isWakeState(value: string): value is WakeState {
  return Object.hasOwn(WAKE_STATES, value)
}

function triggerType(row: Row, column: string): TriggerType {
  const value = text(row, column)
  if (!isTriggerType(value)) throw new Error(`wakes: unknown trigger_type "${value}"`)
  return value
}

function wakeState(row: Row, column: string): WakeState {
  const value = text(row, column)
  if (!isWakeState(value)) throw new Error(`wakes: unknown state "${value}"`)
  return value
}

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

function rowToWake(value: unknown): Wake {
  const r = rowOf(value, "wakes")
  return {
    id: text(r, "id"),
    sessionId: textOrNull(r, "session_id"),
    workspaceId: text(r, "workspace_id"),
    triggerType: triggerType(r, "trigger_type"),
    kind: textOrNull(r, "kind") ?? "session_turn",
    serialKey: textOrNull(r, "serial_key"),
    intentJson: text(r, "intent_json"),
    resultJson: textOrNull(r, "result_json"),
    state: wakeState(r, "state"),
    expiresAt: integerOrNull(r, "expires_at"),
    depth: integer(r, "depth"),
    createdBy: textOrNull(r, "created_by"),
    createdAt: integer(r, "created_at"),
    firedAt: integerOrNull(r, "fired_at"),
    fireAt: integerOrNull(r, "fire_at"),
    schedule: textOrNull(r, "schedule"),
    eventKey: textOrNull(r, "event_key"),
    token: textOrNull(r, "token"),
    prompt: textOrNull(r, "prompt"),
    resolvedBy: textOrNull(r, "resolved_by"),
    idempotencyKey: textOrNull(r, "idempotency_key"),
    leaseUntil: integerOrNull(r, "lease_until"),
    attempts: integer(r, "attempts"),
  }
}

// One INSERT, built once from the exhaustive `Record<keyof Wake, string>` map so
// a new `Wake` field cannot be added without giving it a column. Values bind by
// name (`@sessionId`), so better-sqlite3 rejects a wake missing any of them.
const INSERT_SQL = (() => {
  const entries = Object.entries(FIELD_TO_COL)
  const columns = entries.map(([, column]) => column).join(", ")
  const parameters = entries.map(([field]) => `@${field}`).join(", ")
  return `INSERT OR IGNORE INTO wakes (${columns}) VALUES (${parameters})`
})()

/** `FIELD_TO_COL` as an O(1) lookup keyed by an arbitrary (patch-supplied) name. */
const COLUMN_BY_FIELD = new Map<string, string>(Object.entries(FIELD_TO_COL))

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
    const res = this.db.prepare(INSERT_SQL).run(wake)
    return { inserted: res.changes > 0 }
  }

  async get(id: WakeId): Promise<Wake | null> {
    const r = this.db.prepare("SELECT * FROM wakes WHERE id = ?").get(id)
    return r === undefined ? null : rowToWake(r)
  }

  async getByToken(token: Token): Promise<Wake | null> {
    const r = this.db.prepare("SELECT * FROM wakes WHERE token = ?").get(token)
    return r === undefined ? null : rowToWake(r)
  }

  async getByIdempotencyKey(workspaceId: WorkspaceId, key: string): Promise<Wake | null> {
    const r = this.db
      .prepare("SELECT * FROM wakes WHERE workspace_id = ? AND idempotency_key = ?")
      .get(workspaceId, key)
    return r === undefined ? null : rowToWake(r)
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
      .all(nowMs + leaseMs, nowMs, ...laneParams, limit)
    return rows.map(rowToWake)
  }

  async cas(id: WakeId, from: WakeState, to: WakeState, patch?: Partial<Wake>): Promise<boolean> {
    const setCols = ["state = ?"]
    const setVals: unknown[] = [to]
    if (patch) {
      for (const [k, v] of Object.entries(patch)) {
        const col = COLUMN_BY_FIELD.get(k)
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
      this.db.prepare("SELECT * FROM wakes WHERE event_key = ? AND state = 'pending'").all(eventKey)
    ).map(rowToWake)
  }

  async findExpirable(nowMs: number): Promise<Wake[]> {
    return (
      this.db
        .prepare("SELECT * FROM wakes WHERE state = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?")
        .all(nowMs)
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
      .all(nowMs + leaseMs, nowMs, ...laneParams)
    return rows.map(rowToWake)
  }

  async listFiring(serialKey?: string | null): Promise<Wake[]> {
    const laneFilter =
      serialKey === undefined ? "" : serialKey === null ? "AND serial_key IS NULL" : "AND serial_key = ?"
    const laneParams = typeof serialKey === "string" ? [serialKey] : []
    return this.db
      .prepare(`SELECT * FROM wakes WHERE state = 'firing' ${laneFilter}`)
      .all(...laneParams)
      .map(rowToWake)
  }

  async listForSession(sessionId: SessionId): Promise<Wake[]> {
    return this.db.prepare("SELECT * FROM wakes WHERE session_id = ?").all(sessionId).map(rowToWake)
  }

  async countLive(workspaceId: WorkspaceId): Promise<number> {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM wakes WHERE workspace_id = ? AND state = 'pending'")
      .get(workspaceId)
    return integer(rowOf(r, "wakes count"), "n")
  }

  async countCreatedSince(workspaceId: WorkspaceId, sinceMs: number): Promise<number> {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM wakes WHERE workspace_id = ? AND created_at >= ?")
      .get(workspaceId, sinceMs)
    return integer(rowOf(r, "wakes count"), "n")
  }

  async getReceipt(key: string): Promise<string | null> {
    const r = this.db.prepare("SELECT result_json FROM effect_receipts WHERE key = ?").get(key)
    return r === undefined ? null : text(rowOf(r, "effect_receipts"), "result_json")
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
