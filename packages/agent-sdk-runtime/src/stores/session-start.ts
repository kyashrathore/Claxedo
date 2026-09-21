import { asRecord, type AgentSessionStart, type AgentSessionStartBinding, type AgentSessionStarts } from "@claxedo/agent-runtime-contract"

export interface SessionStartPersistence {
  get(sessionId: string): unknown
  put(record: AgentSessionStart): void
  /** Removes the row only while every binding field still matches. */
  remove(binding: AgentSessionStartBinding): boolean
}

const fields = ["sessionId", "workspaceId", "directory", "connectionId", "operationId"] as const

/** Identity of a creation operation, compared field by field rather than by serialized shape. */
export function sameSessionStartBinding(a: AgentSessionStartBinding, b: AgentSessionStartBinding): boolean {
  return fields.every(field => a[field] === b[field])
}

/** Creation ownership is durable independently of a provider execution binding. */
export class SessionStartStore implements AgentSessionStarts {
  constructor(private readonly persistence: SessionStartPersistence) {}

  get(sessionId: string): AgentSessionStart | undefined {
    const value = this.persistence.get(sessionId)
    if (value === undefined) return undefined
    const record = readSessionStart(value)
    if (record.binding.sessionId !== sessionId) throw new Error("Persisted session creation identity does not match its key")
    return record
  }

  begin(binding: AgentSessionStartBinding): AgentSessionStart {
    const owner = readStartBinding(binding)
    const existing = this.get(owner.sessionId)
    if (existing) {
      if (!sameSessionStartBinding(existing.binding, owner)) throw new Error("Session creation is owned by another operation")
      return existing
    }
    const now = Date.now()
    const record: AgentSessionStart = { binding: owner, status: "starting", createdAt: now, updatedAt: now }
    this.persistence.put(record)
    return structuredClone(record)
  }

  finish(binding: AgentSessionStartBinding, outcome: { status: "created"; upstreamSessionId: string } | { status: "failed"; error: string }): AgentSessionStart {
    const existing = this.get(binding.sessionId)
    if (!existing || !sameSessionStartBinding(existing.binding, binding)) throw new Error("Session creation owner does not match")
    const record = readSessionStart({ binding: existing.binding, createdAt: existing.createdAt, updatedAt: Date.now(), ...outcome })
    if (existing.status !== "starting") {
      const same = existing.status === record.status && (
        existing.status === "created" && record.status === "created" ? existing.upstreamSessionId === record.upstreamSessionId
          : existing.status === "failed" && record.status === "failed" && existing.error === record.error
      )
      if (!same) throw new Error("Session creation already settled")
      return existing
    }
    this.persistence.put(record)
    return structuredClone(record)
  }

  /**
   * Only an authorized deletion that already removed the provider session may
   * call this: a rollback that deletes provider state after a failed create
   * has to leave its failure readable, and dropping the record would hand the
   * id back to a retry while the old creator is still settling it.
   */
  retire(binding: AgentSessionStartBinding): boolean {
    return this.persistence.remove(readStartBinding(binding))
  }
}

function readStartBinding(value: unknown): AgentSessionStartBinding {
  const row = asRecord(value)
  if (!row || fields.some(field => typeof row[field] !== "string" || !row[field].trim()) || "upstreamSessionId" in row) {
    throw new Error("Invalid pending session creation owner")
  }
  return { sessionId: String(row.sessionId), workspaceId: String(row.workspaceId), directory: String(row.directory), connectionId: String(row.connectionId), operationId: String(row.operationId) }
}

export function readSessionStart(value: unknown): AgentSessionStart {
  const row = asRecord(value)
  if (!row || typeof row.createdAt !== "number" || !Number.isFinite(row.createdAt) || typeof row.updatedAt !== "number" || !Number.isFinite(row.updatedAt)) throw new Error("Invalid session creation record")
  const base = { binding: readStartBinding(row.binding), createdAt: row.createdAt, updatedAt: row.updatedAt }
  if (row.status === "starting") return { ...base, status: "starting" }
  if (row.status === "created" && typeof row.upstreamSessionId === "string" && row.upstreamSessionId.trim()) return { ...base, status: "created", upstreamSessionId: row.upstreamSessionId }
  if (row.status === "failed" && typeof row.error === "string" && row.error.trim()) return { ...base, status: "failed", error: row.error }
  throw new Error("Invalid session creation outcome")
}

/** Both durable runtime stores use the same additive table and transition owner. */
export function sqliteSessionStarts(db: {
  exec(sql: string): unknown
  prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): unknown }
}): AgentSessionStarts {
  db.exec("CREATE TABLE IF NOT EXISTS session_start (session_id TEXT PRIMARY KEY, directory TEXT NOT NULL, data_json TEXT NOT NULL)")
  return new SessionStartStore({
    get(id) {
      const row = asRecord(db.prepare("SELECT data_json FROM session_start WHERE session_id = ?").get(id))
      if (!row) return undefined
      if (typeof row.data_json !== "string") throw new Error("Invalid persisted session creation record")
      return JSON.parse(row.data_json)
    },
    put(record) {
      db.prepare("INSERT INTO session_start(session_id, directory, data_json) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET data_json = excluded.data_json")
        .run(record.binding.sessionId, record.binding.directory, JSON.stringify(record))
    },
    // The stored JSON is compared field by field. Matching the serialized
    // record instead would make retirement depend on key order and on which
    // status the creator settled, neither of which is part of the identity.
    remove(binding) {
      const result = db.prepare(`DELETE FROM session_start WHERE session_id = ? AND ${fields.map(field => `json_extract(data_json, '$.binding.${field}') = ?`).join(" AND ")}`)
        .run(binding.sessionId, ...fields.map(field => binding[field]))
      const changes = asRecord(result)?.changes
      return changes === 1 || changes === 1n
    },
  })
}
