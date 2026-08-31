import fs from "fs"
import path from "path"
import { createRequire } from "module"
import type { CompatEvent } from "../compat-events"
import type { PromptInput, SessionConfigUpdate } from "../index"
import type { AgentRuntimeStore } from "../runtime"
import type {
  AgentRuntimeSessionBinding,
  AgentRuntimeStoreWithRecovery,
  AgentRuntimeTurnFinishInput,
} from "../harnesses/shared/runtime-store"
import { MemoryRuntimeStore, type MemoryRuntimeStoreSnapshot } from "./memory"
import type { SubagentObservation } from "../subagent-admission"

type SqliteStatement = {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  finalize(): void
}

type SqliteDatabase = {
  exec(sql: string): unknown
  prepare(sql: string): SqliteStatement
  close?: () => unknown
}

export type SqliteRuntimeStoreOptions = { root: string }

const SCHEMA_VERSION = 2
const requireDatabase = createRequire(import.meta.url)

export class UnsupportedRuntimeStoreSchemaError extends Error {
  readonly code = "unsupported_runtime_store_schema"

  constructor(readonly found: number | "snapshot", readonly expected = SCHEMA_VERSION) {
    super(`Unsupported agent runtime store schema ${found}; expected ${expected}. Reset or explicitly export the old store before continuing.`)
    this.name = "UnsupportedRuntimeStoreSchemaError"
  }
}

export class RuntimeStoreCorruptionError extends Error {
  readonly code = "runtime_store_corrupt_row"

  constructor(table: string, key: string, cause: unknown) {
    super(`Invalid JSON in agent runtime store table ${table} at ${key}`, { cause })
    this.name = "RuntimeStoreCorruptionError"
  }
}

function openDatabase(file: string): SqliteDatabase {
  if (process.versions.bun) {
    const mod = requireDatabase("bun:sqlite") as { Database: new(file: string) => SqliteDatabase }
    return new mod.Database(file)
  }
  const mod = requireDatabase("better-sqlite3") as
    | { default?: new(file: string) => SqliteDatabase }
    | (new(file: string) => SqliteDatabase)
  const BetterSqlite = typeof mod === "function" ? mod : mod.default
  if (!BetterSqlite) {
    throw new Error("better-sqlite3 export missing; install better-sqlite3 to use @claxedo/agent-sdk-runtime/stores/sqlite outside Bun")
  }
  return new BetterSqlite(file)
}

/**
 * Durable store backed by normalized, incrementally-updated SQLite rows.
 * MemoryRuntimeStore remains the projection reducer; SQLite is authoritative
 * across process lifetimes and is reloaded after any failed transaction.
 */
export class SqliteRuntimeStore implements AgentRuntimeStoreWithRecovery {
  private readonly db: SqliteDatabase
  private memory = new MemoryRuntimeStore()
  private readonly turnLeases = new Map<string, string>()
  private nextTurnLease = 0

  constructor(options: SqliteRuntimeStoreOptions) {
    fs.mkdirSync(options.root, { recursive: true, mode: 0o755 })
    this.db = openDatabase(path.join(options.root, "agent-runtime.db"))
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = FULL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    try {
      this.initializeSchema()
      this.hydrateMemory()
    } catch (error) {
      this.db.close?.()
      throw error
    }
  }

  listSessions(directory: string) { return this.memory.listSessions(directory) }
  getSession(id: string) { return this.memory.getSession(id) }

  bindSession(input: AgentRuntimeSessionBinding) {
    return this.write(() => {
      this.memory.bindSession(input)
      this.persistSession(input.sessionId)
    })
  }

  updateSessionConfig(id: string, update: SessionConfigUpdate) {
    return this.write(() => {
      const result = this.memory.updateSessionConfig(id, update)
      if (result) this.persistSession(id)
      return result
    })
  }

  updateSession(id: string, updates: { title?: string; time?: { archived?: number } }) {
    return this.write(() => {
      const result = this.memory.updateSession(id, updates)
      if (result) {
        this.persistSession(id)
        this.replaceSubagents(id)
      }
      return result
    })
  }

  getSessionConfig(id: string) { return this.memory.getSessionConfig(id) }

  deleteSession(id: string) {
    return this.write(() => {
      const ids = this.descendants(id)
      this.memory.deleteSession(id)
      for (const sessionId of ids) {
        this.turnLeases.delete(sessionId)
        this.deletePersistedSession(sessionId)
      }
    })
  }

  getAgentSessionId(id: string) { return this.memory.getAgentSessionId(id) }
  acquireTurnLease(sessionId: string) {
    if (this.turnLeases.has(sessionId)) return
    const leaseId = `${sessionId}:${++this.nextTurnLease}`
    this.turnLeases.set(sessionId, leaseId)
    return leaseId
  }
  releaseTurnLease(sessionId: string, leaseId: string) {
    if (this.turnLeases.get(sessionId) === leaseId) this.turnLeases.delete(sessionId)
  }

  startTurn(input: {
    sessionId: string
    agentSessionId?: string
    userMessageId?: string
    assistantMessageId: string
    agent: string
    model: { providerID: string; modelID: string }
    parts: unknown[]
    tools?: Record<string, boolean>
    format?: unknown
    system?: string
    variant?: string
    actorId?: string
    actorKind?: "human" | "agent"
    author?: PromptInput["author"]
  }) {
    return this.write(() => {
      const result = this.memory.startTurn(input)
      this.persistSession(input.sessionId)
      this.replaceMessages(input.sessionId)
      return result
    })
  }

  finishTurn(input: AgentRuntimeTurnFinishInput) {
    return this.write(() => {
      const result = this.memory.finishTurn(input)
      this.persistSession(input.sessionId)
      if (input.outcome.status === "failed") this.persistMessage(input.sessionId, input.assistantMessageId)
      return result
    })
  }

  appendEvent(input: { sessionId: string; agentSessionId?: string; payload: CompatEvent; source?: unknown }) {
    return this.write(() => {
      const result = this.memory.appendEvent(input)
      this.persistSession(input.sessionId)
      this.persistEventProjection(input.sessionId, input.payload)
      return result
    })
  }

  getMessages(id: string) { return this.memory.getMessages(id) }
  getTodos(sessionId: string) { return this.memory.getTodos(sessionId) }
  listPermissions(directory: string) { return this.memory.listPermissions(directory) }
  listQuestions(directory: string) { return this.memory.listQuestions(directory) }

  stalePermission(id: string) {
    return this.write(() => {
      this.memory.stalePermission(id)
      this.run("DELETE FROM runtime_permissions WHERE id = ?", id)
    })
  }

  admit(input: { parentSessionId: string; observation: SubagentObservation; allocateKey: () => string }) {
    return this.write(() => {
      const result = this.memory.admit(input)
      this.replaceSubagents(input.parentSessionId)
      return result
    })
  }

  markPublished(parentSessionId: string, observationId: string) {
    return this.write(() => {
      this.memory.markPublished(parentSessionId, observationId)
      this.replaceSubagents(parentSessionId)
    })
  }

  listSubagentEvents(parentSessionId: string) { return this.memory.listSubagentEvents(parentSessionId) }
  listSubagents(parentSessionId: string) { return this.memory.listSubagents(parentSessionId) }

  markRecovering(sessionId: string, message?: string) {
    return this.write(() => {
      this.memory.markRecovering(sessionId, message)
      this.persistSession(sessionId)
    })
  }

  markSessionInterrupted(sessionId: string, message?: string, _agentSessionId?: string | null) {
    return this.write(() => {
      this.memory.markSessionInterrupted(sessionId, message)
      this.persistSession(sessionId)
    })
  }

  consumeRecoveryError(sessionId: string) {
    return this.write(() => {
      const result = this.memory.consumeRecoveryError(sessionId)
      this.persistSession(sessionId)
      return result
    })
  }

  markSessionsInterruptedByOwner(ownerKey: string, message?: string) {
    return this.write(() => {
      const ids = this.memory.listSessionsByOwnerKey(ownerKey)
      this.memory.markSessionsInterruptedByOwner(ownerKey, message)
      for (const id of ids) this.persistSession(id)
    })
  }

  getSessionOwnerKey(id: string) { return this.memory.getSessionOwnerKey(id) }
  listSessionsByOwnerKey(ownerKey: string) { return this.memory.listSessionsByOwnerKey(ownerKey) }
  close() { this.db.close?.() }

  private initializeSchema() {
    const legacy = this.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_store_snapshot'",
    )
    if (legacy) throw new UnsupportedRuntimeStoreSchemaError("snapshot")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_schema (version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_sessions (id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_configs (session_id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_messages (
        session_id TEXT NOT NULL, message_id TEXT NOT NULL, ordinal INTEGER NOT NULL, data_json TEXT NOT NULL,
        PRIMARY KEY (session_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS runtime_permissions (
        directory TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT NOT NULL, data_json TEXT NOT NULL,
        PRIMARY KEY (directory, id)
      );
      CREATE TABLE IF NOT EXISTS runtime_questions (
        directory TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT NOT NULL, data_json TEXT NOT NULL,
        PRIMARY KEY (directory, id)
      );
      CREATE TABLE IF NOT EXISTS runtime_todos (
        session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, data_json TEXT NOT NULL,
        PRIMARY KEY (session_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS runtime_recovery_errors (session_id TEXT PRIMARY KEY, message TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_session_seq (session_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_subagents (
        parent_session_id TEXT NOT NULL, observation_id TEXT NOT NULL, data_json TEXT NOT NULL, published INTEGER NOT NULL,
        PRIMARY KEY (parent_session_id, observation_id)
      );
      CREATE INDEX IF NOT EXISTS runtime_permissions_session ON runtime_permissions(session_id);
      CREATE INDEX IF NOT EXISTS runtime_questions_session ON runtime_questions(session_id);
    `)
    const schema = this.get<{ version: number }>("SELECT version FROM runtime_schema LIMIT 1")
    if (!schema) this.run("INSERT INTO runtime_schema(version) VALUES (?)", SCHEMA_VERSION)
    else if (schema.version !== SCHEMA_VERSION) throw new UnsupportedRuntimeStoreSchemaError(schema.version)
  }

  private hydrateMemory() {
    const snapshot: MemoryRuntimeStoreSnapshot = {
      sessions: this.jsonRows("runtime_sessions", "id"),
      configs: this.rows<{ session_id: string; data_json: string }>("SELECT session_id, data_json FROM runtime_configs")
        .map((row) => ({ sessionId: row.session_id, config: this.parse("runtime_configs", row.session_id, row.data_json) })),
      messages: this.groupJsonRows("runtime_messages", "session_id", "message_id", "messages") as MemoryRuntimeStoreSnapshot["messages"],
      permissions: this.groupJsonRows("runtime_permissions", "directory", "id", "rows") as MemoryRuntimeStoreSnapshot["permissions"],
      questions: this.groupJsonRows("runtime_questions", "directory", "id", "rows") as MemoryRuntimeStoreSnapshot["questions"],
      todos: this.groupJsonRows("runtime_todos", "session_id", "ordinal", "rows") as MemoryRuntimeStoreSnapshot["todos"],
      recoveryErrors: this.rows<{ session_id: string; message: string }>("SELECT session_id, message FROM runtime_recovery_errors")
        .map((row) => ({ sessionId: row.session_id, message: row.message })),
      seq: this.rows<{ session_id: string; seq: number }>("SELECT session_id, seq FROM runtime_session_seq")
        .map((row) => ({ sessionId: row.session_id, seq: row.seq })),
      subagents: this.rows<{ parent_session_id: string; observation_id: string; data_json: string; published: number }>(
        "SELECT parent_session_id, observation_id, data_json, published FROM runtime_subagents",
      ).map((row) => ({
        parentSessionId: row.parent_session_id,
        observation: this.parse("runtime_subagents", `${row.parent_session_id}/${row.observation_id}`, row.data_json),
        published: row.published === 1,
      })),
    }
    this.memory = new MemoryRuntimeStore()
    this.memory.importSnapshot(snapshot)
  }

  private write<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const result = operation()
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      this.hydrateMemory()
      throw error
    }
  }

  private persistSession(sessionId: string) {
    const state = this.memory.readPersistenceState(sessionId)
    this.upsertJson("runtime_sessions", "id", sessionId, state.session)
    this.upsertJson("runtime_configs", "session_id", sessionId, state.config)
    this.upsertScalar("runtime_recovery_errors", "session_id", sessionId, "message", state.recoveryError)
    this.upsertScalar("runtime_session_seq", "session_id", sessionId, "seq", state.seq)
  }

  private persistEventProjection(sessionId: string, event: CompatEvent) {
    if (event.type === "message.updated") {
      this.persistMessage(sessionId, String((event.properties.info as { id?: unknown }).id ?? ""))
    } else if (event.type === "message.part.updated") {
      this.persistMessage(sessionId, event.properties.part.messageID)
    } else if (event.type === "message.part.delta" || event.type === "message.completed") {
      this.persistMessage(sessionId, event.properties.messageID)
    } else if (event.type === "permission.asked") {
      this.persistInteraction("runtime_permissions", sessionId, event.properties.id)
    } else if (event.type === "permission.replied") {
      this.run("DELETE FROM runtime_permissions WHERE id = ?", event.properties.requestID)
    } else if (event.type === "question.asked") {
      this.persistInteraction("runtime_questions", sessionId, event.properties.id)
    } else if (event.type === "question.replied" || event.type === "question.rejected") {
      this.run("DELETE FROM runtime_questions WHERE id = ?", event.properties.requestID)
    } else if (event.type === "todo.updated") {
      this.replaceTodos(sessionId)
    }
  }

  private persistMessage(sessionId: string, messageId: string | undefined) {
    if (!messageId) return
    const messages = this.memory.getMessages(sessionId) as Array<{ info: { id?: unknown }; parts: unknown[] }>
    const ordinal = messages.findIndex((message) => message.info.id === messageId)
    if (ordinal < 0) return
    this.run(`
      INSERT INTO runtime_messages(session_id, message_id, ordinal, data_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, message_id) DO UPDATE SET ordinal = excluded.ordinal, data_json = excluded.data_json
    `, sessionId, messageId, ordinal, JSON.stringify(messages[ordinal]))
  }

  private replaceMessages(sessionId: string) {
    this.run("DELETE FROM runtime_messages WHERE session_id = ?", sessionId)
    const messages = this.memory.getMessages(sessionId) as Array<{ info: { id?: unknown }; parts: unknown[] }>
    messages.forEach((message, ordinal) => {
      this.run(
        "INSERT INTO runtime_messages(session_id, message_id, ordinal, data_json) VALUES (?, ?, ?, ?)",
        sessionId, String(message.info.id), ordinal, JSON.stringify(message),
      )
    })
  }

  private persistInteraction(table: "runtime_permissions" | "runtime_questions", sessionId: string, id: string) {
    const session = this.memory.getSession(sessionId) as { directory?: string } | null
    const directory = session?.directory ?? ""
    const interactions = this.memory.readDirectoryInteractions(directory)
    const rows = table === "runtime_permissions" ? interactions.permissions : interactions.questions
    const row = rows.find((item) => item.id === id)
    if (!row) return
    this.run(`
      INSERT INTO ${table}(directory, id, session_id, data_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(directory, id) DO UPDATE SET session_id = excluded.session_id, data_json = excluded.data_json
    `, directory, id, sessionId, JSON.stringify(row))
  }

  private replaceTodos(sessionId: string) {
    this.run("DELETE FROM runtime_todos WHERE session_id = ?", sessionId)
    this.memory.getTodos(sessionId).forEach((todo, ordinal) => {
      this.run("INSERT INTO runtime_todos(session_id, ordinal, data_json) VALUES (?, ?, ?)", sessionId, ordinal, JSON.stringify(todo))
    })
  }

  private replaceSubagents(parentSessionId: string) {
    this.run("DELETE FROM runtime_subagents WHERE parent_session_id = ?", parentSessionId)
    for (const row of this.memory.readPersistenceState(parentSessionId).subagents) {
      this.run(
        "INSERT INTO runtime_subagents(parent_session_id, observation_id, data_json, published) VALUES (?, ?, ?, ?)",
        parentSessionId, row.observation.observationId, JSON.stringify(row.observation), row.published ? 1 : 0,
      )
    }
  }

  private deletePersistedSession(sessionId: string) {
    for (const [table, column] of [
      ["runtime_sessions", "id"], ["runtime_configs", "session_id"], ["runtime_messages", "session_id"],
      ["runtime_permissions", "session_id"], ["runtime_questions", "session_id"], ["runtime_todos", "session_id"],
      ["runtime_recovery_errors", "session_id"], ["runtime_session_seq", "session_id"],
      ["runtime_subagents", "parent_session_id"],
    ] as const) this.run(`DELETE FROM ${table} WHERE ${column} = ?`, sessionId)
  }

  private descendants(root: string): string[] {
    const result: string[] = []
    const visit = (id: string) => {
      result.push(id)
      for (const child of this.memory.listChildSessionIds(id)) visit(child)
    }
    visit(root)
    return result
  }

  private upsertJson(table: string, keyColumn: string, key: string, value: unknown | null) {
    if (value === null) return void this.run(`DELETE FROM ${table} WHERE ${keyColumn} = ?`, key)
    this.run(`
      INSERT INTO ${table}(${keyColumn}, data_json) VALUES (?, ?)
      ON CONFLICT(${keyColumn}) DO UPDATE SET data_json = excluded.data_json
    `, key, JSON.stringify(value))
  }

  private upsertScalar(table: string, keyColumn: string, key: string, valueColumn: string, value: unknown | null) {
    if (value === null) return void this.run(`DELETE FROM ${table} WHERE ${keyColumn} = ?`, key)
    this.run(`
      INSERT INTO ${table}(${keyColumn}, ${valueColumn}) VALUES (?, ?)
      ON CONFLICT(${keyColumn}) DO UPDATE SET ${valueColumn} = excluded.${valueColumn}
    `, key, value)
  }

  private jsonRows(table: string, keyColumn: string): MemoryRuntimeStoreSnapshot["sessions"] {
    return this.rows<Record<string, unknown> & { data_json: string }>(`SELECT * FROM ${table}`)
      .map((row) => this.parse(table, String(row[keyColumn]), row.data_json))
  }

  private groupJsonRows(table: string, groupColumn: string, keyColumn: string, valueName: "messages" | "rows") {
    const order = table === "runtime_messages" || table === "runtime_todos" ? " ORDER BY ordinal" : ""
    const rows = this.rows<Record<string, unknown> & { data_json: string }>(`SELECT * FROM ${table}${order}`)
    const groups = new Map<string, unknown[]>()
    for (const row of rows) {
      const group = String(row[groupColumn])
      const values = groups.get(group) ?? []
      values.push(this.parse(table, `${group}/${String(row[keyColumn])}`, row.data_json))
      groups.set(group, values)
    }
    const groupName = groupColumn === "directory" ? "directory" : "sessionId"
    return [...groups].map(([group, values]) => ({ [groupName]: group, [valueName]: values }))
  }

  private parse<T>(table: string, key: string, value: string): T {
    try {
      return JSON.parse(value) as T
    } catch (error) {
      throw new RuntimeStoreCorruptionError(table, key, error)
    }
  }

  private run(sql: string, ...params: unknown[]) {
    const statement = this.db.prepare(sql)
    try { return statement.run(...params) } finally { statement.finalize() }
  }

  private get<T>(sql: string, ...params: unknown[]): T | null {
    const statement = this.db.prepare(sql)
    try { return statement.get(...params) as T | null } finally { statement.finalize() }
  }

  private rows<T>(sql: string, ...params: unknown[]): T[] {
    const statement = this.db.prepare(sql)
    try { return statement.all(...params) as T[] } finally { statement.finalize() }
  }
}

export function createSqliteRuntimeStore(options: SqliteRuntimeStoreOptions): AgentRuntimeStore {
  return new SqliteRuntimeStore(options) as unknown as AgentRuntimeStore
}
