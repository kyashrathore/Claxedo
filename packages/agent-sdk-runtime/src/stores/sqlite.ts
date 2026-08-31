import fs from "fs"
import path from "path"
import { createRequire } from "module"
import type { CompatEvent } from "../compat-events"
import type { AgentRuntimeStore } from "../runtime"
import type { AgentRuntimeSessionBinding, AgentRuntimeTurnFinishInput } from "../harnesses/shared/runtime-store"
import type { SessionConfigUpdate } from "../index"
import type { SubagentObservation } from "../subagent-admission"
import { MemoryRuntimeStore, type MemoryRuntimeStoreSnapshot } from "./memory"

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

const requireDatabase = createRequire(import.meta.url)

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

function eventMessageId(event: CompatEvent) {
  if (event.type === "message.updated") return event.properties.info.id
  if (event.type === "message.part.updated") return event.properties.part.messageID
  if (event.type === "message.part.delta") return event.properties.messageID
}

/** @internal */
export class SqliteRuntimeStore extends MemoryRuntimeStore {
  private readonly db: SqliteDatabase

  constructor(options: SqliteRuntimeStoreOptions) {
    super()
    fs.mkdirSync(options.root, { recursive: true, mode: 0o755 })
    this.db = openDatabase(path.join(options.root, "agent-runtime.db"))
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = FULL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.createSchema()
    this.hydrate()
  }

  override bindSession(input: AgentRuntimeSessionBinding) {
    super.bindSession(input)
    this.commit(() => this.persistSession(input.sessionId))
  }

  override updateSessionConfig(id: string, update: SessionConfigUpdate) {
    const result = super.updateSessionConfig(id, update)
    if (result) this.commit(() => {
      this.persistConfig(id)
      this.persistSession(id)
    })
    return result
  }

  override updateSession(id: string, updates: { title?: string; time?: { archived?: number } }) {
    const result = super.updateSession(id, updates)
    if (result) this.commit(() => this.persistSession(id))
    return result
  }

  override setGoal(id: string, goal: Parameters<MemoryRuntimeStore["setGoal"]>[1]) {
    super.setGoal(id, goal)
    this.commit(() => this.persistSession(id))
  }

  override deleteSession(id: string) {
    super.deleteSession(id)
    this.commit(() => {
      for (const table of ["runtime_sessions", "runtime_configs", "runtime_messages", "runtime_todos", "runtime_recovery_errors", "runtime_sequences"]) {
        this.run(`DELETE FROM ${table} WHERE ${table === "runtime_sessions" ? "id" : "session_id"} = ?`, id)
      }
      this.run("DELETE FROM runtime_subagent_observations WHERE parent_session_id = ?", id)
      this.persistInteractions()
    })
  }

  override startTurn(input: Parameters<MemoryRuntimeStore["startTurn"]>[0]) {
    const result = super.startTurn(input)
    this.commit(() => {
      this.persistSession(input.sessionId)
      this.persistSequence(input.sessionId)
      if (input.userMessageId) this.persistMessage(input.sessionId, input.userMessageId)
      this.persistMessage(input.sessionId, input.assistantMessageId)
    })
    return result
  }

  override finishTurn(input: AgentRuntimeTurnFinishInput) {
    const result = super.finishTurn(input)
    this.commit(() => {
      this.persistSession(input.sessionId)
      this.persistRecoveryError(input.sessionId)
      const messageId = input.assistantMessageId ?? this.sessions.get(input.sessionId)?.lastTurn?.assistantMessageId
      if (messageId) this.persistMessage(input.sessionId, messageId)
    })
    return result
  }

  override appendEvent(input: Parameters<MemoryRuntimeStore["appendEvent"]>[0]) {
    const result = super.appendEvent(input)
    this.commit(() => {
      this.persistSequence(input.sessionId)
      this.persistSession(input.sessionId)
      const messageId = eventMessageId(input.payload)
      if (messageId) this.persistMessage(input.sessionId, messageId)
      if (input.payload.type === "permission.asked" || input.payload.type === "permission.replied" ||
        input.payload.type === "question.asked" || input.payload.type === "question.replied" ||
        input.payload.type === "question.rejected") {
        this.persistInteractions()
      }
      if (input.payload.type === "todo.updated") this.persistTodos(input.sessionId)
    })
    return result
  }

  override stalePermission(id: string) {
    super.stalePermission(id)
    this.commit(() => this.run("DELETE FROM runtime_permissions WHERE id = ?", id))
  }

  override admit(input: { parentSessionId: string; observation: SubagentObservation; allocateKey: () => string }) {
    const result = super.admit(input)
    this.commit(() => this.persistSubagent(input.parentSessionId, input.observation.observationId))
    return result
  }

  override markPublished(parentSessionId: string, observationId: string) {
    super.markPublished(parentSessionId, observationId)
    this.commit(() => this.persistSubagent(parentSessionId, observationId))
  }

  override markRecovering(sessionId: string, message?: string) {
    super.markRecovering(sessionId, message)
    this.commit(() => {
      this.persistSession(sessionId)
      this.persistRecoveryError(sessionId)
    })
  }

  override consumeRecoveryError(sessionId: string) {
    const result = super.consumeRecoveryError(sessionId)
    this.commit(() => this.persistRecoveryError(sessionId))
    return result
  }

  override close() {
    this.db.close?.()
  }

  protected override afterChange() {}

  private createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_sessions (id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_configs (session_id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_messages (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (session_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS runtime_permissions (
        directory TEXT NOT NULL,
        id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (directory, id)
      );
      CREATE TABLE IF NOT EXISTS runtime_questions (
        directory TEXT NOT NULL,
        id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (directory, id)
      );
      CREATE TABLE IF NOT EXISTS runtime_todos (
        session_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (session_id, position)
      );
      CREATE TABLE IF NOT EXISTS runtime_recovery_errors (session_id TEXT PRIMARY KEY, message TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_sequences (session_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_subagent_observations (
        parent_session_id TEXT NOT NULL,
        observation_id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        published INTEGER NOT NULL,
        PRIMARY KEY (parent_session_id, observation_id)
      );
    `)
  }

  private hydrate() {
    const sessions = this.all<{ data_json: string }>("SELECT data_json FROM runtime_sessions").map((row) => JSON.parse(row.data_json))
    const configs = this.all<{ session_id: string; data_json: string }>("SELECT session_id, data_json FROM runtime_configs")
      .map((row) => ({ sessionId: row.session_id, config: JSON.parse(row.data_json) }))
    const messagesBySession = new Map<string, unknown[]>()
    for (const row of this.all<{ session_id: string; data_json: string }>(
      "SELECT session_id, data_json FROM runtime_messages ORDER BY session_id, position",
    )) {
      const messages = messagesBySession.get(row.session_id) ?? []
      messages.push(JSON.parse(row.data_json))
      messagesBySession.set(row.session_id, messages)
    }
    const permissionRows = this.all<{ directory: string; data_json: string }>(
      "SELECT directory, data_json FROM runtime_permissions ORDER BY directory, id",
    )
    const questionRows = this.all<{ directory: string; data_json: string }>(
      "SELECT directory, data_json FROM runtime_questions ORDER BY directory, id",
    )
    const todosBySession = new Map<string, unknown[]>()
    for (const row of this.all<{ session_id: string; data_json: string }>(
      "SELECT session_id, data_json FROM runtime_todos ORDER BY session_id, position",
    )) {
      const todos = todosBySession.get(row.session_id) ?? []
      todos.push(JSON.parse(row.data_json))
      todosBySession.set(row.session_id, todos)
    }
    const snapshot: MemoryRuntimeStoreSnapshot = {
      sessions,
      configs,
      messages: [...messagesBySession].map(([sessionId, messages]) => ({ sessionId, messages })) as MemoryRuntimeStoreSnapshot["messages"],
      permissions: groupRows(permissionRows) as MemoryRuntimeStoreSnapshot["permissions"],
      questions: groupRows(questionRows) as MemoryRuntimeStoreSnapshot["questions"],
      todos: [...todosBySession].map(([sessionId, rows]) => ({ sessionId, rows })) as MemoryRuntimeStoreSnapshot["todos"],
      recoveryErrors: this.all<{ session_id: string; message: string }>("SELECT session_id, message FROM runtime_recovery_errors")
        .map((row) => ({ sessionId: row.session_id, message: row.message })),
      seq: this.all<{ session_id: string; seq: number }>("SELECT session_id, seq FROM runtime_sequences")
        .map((row) => ({ sessionId: row.session_id, seq: row.seq })),
      subagents: this.all<{ parent_session_id: string; data_json: string; published: number }>(
        "SELECT parent_session_id, data_json, published FROM runtime_subagent_observations ORDER BY parent_session_id, rowid",
      ).map((row) => ({
        parentSessionId: row.parent_session_id,
        observation: JSON.parse(row.data_json),
        published: row.published === 1,
      })),
    }
    this.importSnapshot(snapshot)
  }

  private commit(write: () => void) {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      write()
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      this.hydrate()
      throw error
    }
  }

  private persistSession(id: string) {
    const session = this.sessions.get(id)
    if (!session) {
      this.run("DELETE FROM runtime_sessions WHERE id = ?", id)
      return
    }
    this.run(
      "INSERT INTO runtime_sessions (id, data_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json",
      id,
      JSON.stringify(session),
    )
  }

  private persistConfig(sessionId: string) {
    const config = this.configs.get(sessionId)
    if (!config) {
      this.run("DELETE FROM runtime_configs WHERE session_id = ?", sessionId)
      return
    }
    this.run(
      "INSERT INTO runtime_configs (session_id, data_json) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET data_json = excluded.data_json",
      sessionId,
      JSON.stringify(config),
    )
  }

  private persistMessage(sessionId: string, messageId: string) {
    const rows = this.messages.get(sessionId) ?? []
    const position = rows.findIndex((row) => row.info.id === messageId)
    if (position < 0) {
      this.run("DELETE FROM runtime_messages WHERE session_id = ? AND message_id = ?", sessionId, messageId)
      return
    }
    this.run(
      `INSERT INTO runtime_messages (session_id, message_id, position, data_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, message_id) DO UPDATE SET position = excluded.position, data_json = excluded.data_json`,
      sessionId,
      messageId,
      position,
      JSON.stringify(rows[position]),
    )
  }

  private persistInteractions() {
    this.db.exec("DELETE FROM runtime_permissions; DELETE FROM runtime_questions")
    for (const [directory, rows] of this.permissions) {
      for (const [id, row] of rows) {
        this.run("INSERT INTO runtime_permissions (directory, id, data_json) VALUES (?, ?, ?)", directory, id, JSON.stringify(row))
      }
    }
    for (const [directory, rows] of this.questions) {
      for (const [id, row] of rows) {
        this.run("INSERT INTO runtime_questions (directory, id, data_json) VALUES (?, ?, ?)", directory, id, JSON.stringify(row))
      }
    }
  }

  private persistTodos(sessionId: string) {
    this.run("DELETE FROM runtime_todos WHERE session_id = ?", sessionId)
    for (const [position, row] of (this.todos.get(sessionId) ?? []).entries()) {
      this.run("INSERT INTO runtime_todos (session_id, position, data_json) VALUES (?, ?, ?)", sessionId, position, JSON.stringify(row))
    }
  }

  private persistRecoveryError(sessionId: string) {
    const message = this.recoveryErrors.get(sessionId)
    if (!message) {
      this.run("DELETE FROM runtime_recovery_errors WHERE session_id = ?", sessionId)
      return
    }
    this.run(
      "INSERT INTO runtime_recovery_errors (session_id, message) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET message = excluded.message",
      sessionId,
      message,
    )
  }

  private persistSequence(sessionId: string) {
    const sequence = this.seq.get(sessionId)
    if (sequence === undefined) return
    this.run(
      "INSERT INTO runtime_sequences (session_id, seq) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET seq = excluded.seq",
      sessionId,
      sequence,
    )
  }

  private persistSubagent(parentSessionId: string, observationId: string) {
    const row = this.subagents.find((item) => item.parentSessionId === parentSessionId && item.observation.observationId === observationId)
    if (!row) {
      this.run("DELETE FROM runtime_subagent_observations WHERE parent_session_id = ? AND observation_id = ?", parentSessionId, observationId)
      return
    }
    this.run(
      `INSERT INTO runtime_subagent_observations (parent_session_id, observation_id, data_json, published)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(parent_session_id, observation_id) DO UPDATE SET data_json = excluded.data_json, published = excluded.published`,
      parentSessionId,
      observationId,
      JSON.stringify(row.observation),
      row.published ? 1 : 0,
    )
  }

  private run(sql: string, ...params: unknown[]) {
    const statement = this.db.prepare(sql)
    try {
      statement.run(...params)
    } finally {
      statement.finalize()
    }
  }

  private all<T>(sql: string, ...params: unknown[]) {
    const statement = this.db.prepare(sql)
    try {
      return statement.all(...params) as T[]
    } finally {
      statement.finalize()
    }
  }
}

function groupRows(rows: Array<{ directory: string; data_json: string }>) {
  const grouped = new Map<string, unknown[]>()
  for (const row of rows) {
    const values = grouped.get(row.directory) ?? []
    values.push(JSON.parse(row.data_json))
    grouped.set(row.directory, values)
  }
  return [...grouped].map(([directory, values]) => ({ directory, rows: values }))
}

export function createSqliteRuntimeStore(options: SqliteRuntimeStoreOptions): AgentRuntimeStore {
  return new SqliteRuntimeStore(options) as unknown as AgentRuntimeStore
}
