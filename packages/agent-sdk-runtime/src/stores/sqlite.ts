import fs from "fs"
import path from "path"
import { createRequire } from "module"
import type { CompatEvent } from "../compat-events"
import type { SessionConfigUpdate } from "../index"
import type { AgentRuntimeStore } from "../runtime"
import { AgentRuntimeStaleTurnError } from "../harnesses/shared/runtime-store"
import type {
  AgentRuntimeAppendEventInput,
  AgentRuntimeSessionBinding,
  AgentRuntimeStoreWithRecovery,
  AgentRuntimeTurnFinishInput,
  AgentRuntimeTurnStartInput,
} from "../harnesses/shared/runtime-store"
import { MemoryRuntimeStore, type MemoryRuntimeStoreSnapshot } from "./memory"
import {
  persistedMessageRow,
  persistedPermissionRow,
  persistedQuestionRow,
  persistedSessionConfig,
  persistedSessionRow,
  persistedSubagentObservation,
  persistedTodoRow,
} from "./persisted-rows"
import {
  DEFAULT_RECOVERY_BUDGETS,
  asRecord,
  isRecord,
  parseRecoveryOperation,
  type AgentSessionStarts,
  type RecoveryOperation,
  type RecoveryTarget,
} from "@claxedo/agent-runtime-contract"
import type { SubagentObservation } from "../subagent-admission"
import { sqliteSessionStarts } from "./session-start"

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

/**
 * How long a settled recovery operation stays listed and stored. Ten
 * reconcile budgets: long enough that a caller which lost its connection can
 * still read its own receipt, short enough that the list is current work.
 */
const RECOVERY_OPERATION_RETENTION_MS = DEFAULT_RECOVERY_BUDGETS.reconcileMs * 10

/**
 * The row a repeated recovery request is compared under. A turn and a session
 * operation share their session's key, so a caller cannot escape its own
 * uniqueness by naming a different turn of the same session.
 */
function recoveryScopeKey(target: RecoveryTarget) {
  if (target.scope === "machine") return `machine:${target.machineId}`
  if (target.scope === "harness") return `harness:${target.workspaceId}:${target.harnessKey}`
  return `session:${target.workspaceId}:${target.sessionId}`
}

function recoveryTargetSessionId(target: RecoveryTarget) {
  return target.scope === "turn" || target.scope === "session" ? target.sessionId : null
}

const SCHEMA_VERSION = 3
/** The one earlier schema this build upgrades in place; anything else is refused. */
const UPGRADABLE_SCHEMA_VERSION = 2
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

/** A driver column the schema declares as TEXT; anything else is a corrupt row. */
function columnText(row: Record<string, unknown>, column: string): string {
  const value = row[column]
  return typeof value === "string" ? value : String(columnNumber(row, column))
}

/** A driver column the schema declares as INTEGER. */
function columnNumber(row: Record<string, unknown>, column: string): number {
  const value = row[column]
  return typeof value === "number" ? value : Number.NaN
}

type SqliteDatabaseConstructor = new (file: string) => SqliteDatabase

/**
 * A driver module is loaded by name at runtime, so callability is all this can
 * check; the constructor's contract is the driver package's, asserted by the
 * name we required. Every driver load in this file goes through here.
 */
function isSqliteDatabaseConstructor(value: unknown): value is SqliteDatabaseConstructor {
  return typeof value === "function"
}

function openDatabase(file: string): SqliteDatabase {
  const driver = process.versions.bun ? "bun:sqlite" : "better-sqlite3"
  const mod: unknown = requireDatabase(driver)
  const exported = asRecord(mod)
  const Database = process.versions.bun ? exported?.Database : exported?.default ?? mod
  if (!isSqliteDatabaseConstructor(Database)) {
    throw new Error(`${driver} export missing; install ${driver} to use @claxedo/agent-sdk-runtime/stores/sqlite`)
  }
  return new Database(file)
}

/**
 * Durable store backed by normalized, incrementally-updated SQLite rows.
 * MemoryRuntimeStore remains the projection reducer; SQLite is authoritative
 * across process lifetimes and is reloaded after any failed transaction.
 */
export class SqliteRuntimeStore implements AgentRuntimeStoreWithRecovery {
  readonly sessionStarts: AgentSessionStarts
  private readonly db: SqliteDatabase
  private memory = new MemoryRuntimeStore()
  private readonly turnLeases = new Map<string, { leaseId: string; acquiredAt: number }>()
  private nextTurnLease = 0

  constructor(options: SqliteRuntimeStoreOptions) {
    fs.mkdirSync(options.root, { recursive: true, mode: 0o755 })
    this.db = openDatabase(path.join(options.root, "agent-runtime.db"))
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = FULL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    try {
      this.initializeSchema()
      this.sessionStarts = sqliteSessionStarts(this.db)
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

  getGoal(id: string) { return this.memory.getGoal(id) }

  setGoal(id: string, goal: Parameters<MemoryRuntimeStore["setGoal"]>[1]) {
    return this.write(() => {
      this.memory.setGoal(id, goal)
      // The Goal rides the session row, so persisting the session persists it.
      this.persistSession(id)
    })
  }

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
  getExecutionBinding(id: string) { return this.memory.getExecutionBinding(id) }
  acquireTurnLease(sessionId: string): string | undefined {
    if (this.turnLeases.has(sessionId)) return undefined
    const leaseId = `${sessionId}:${++this.nextTurnLease}`
    this.turnLeases.set(sessionId, { leaseId, acquiredAt: Date.now() })
    return leaseId
  }
  releaseTurnLease(sessionId: string, leaseId: string) {
    if (this.turnLeases.get(sessionId)?.leaseId === leaseId) this.turnLeases.delete(sessionId)
  }
  /**
   * This store's turn leases live in the process that minted them: there is no
   * lease table, so a restart leaves no holder and the first writer after it
   * acquires one. Only writers inside one process are fenced against each
   * other here.
   */
  readTurnAuthority(sessionId: string) {
    return this.turnLeases.get(sessionId)
  }
  turnEvidence(sessionId: string, turnId: string) { return this.memory.turnEvidence(sessionId, turnId) }

  startTurn(input: AgentRuntimeTurnStartInput) {
    return this.write(() => {
      const result = this.memory.startTurn(input)
      this.persistSession(input.sessionId)
      this.replaceMessages(input.sessionId)
      return result
    })
  }

  finishTurn(input: AgentRuntimeTurnFinishInput) {
    return this.write(() => {
      if (input.leaseId !== undefined && this.turnLeases.get(input.sessionId)?.leaseId !== input.leaseId) {
        throw new AgentRuntimeStaleTurnError(input.sessionId)
      }
      // The lease checked above is this store's. `this.memory` is rebuilt from
      // SQLite after any failed write, which would drop every lease it held,
      // so it is the projection reducer here and never the fence; forwarding
      // the lease id would have it reject against a map it never filled.
      const { leaseId: _fenced, ...projected } = input
      const result = this.memory.finishTurn(projected)
      this.persistSession(input.sessionId)
      if (input.outcome.status === "failed") this.persistMessage(input.sessionId, input.assistantMessageId)
      return result
    })
  }

  appendEvent(input: AgentRuntimeAppendEventInput) {
    return this.write(() => {
      const result = this.memory.appendEvent(input)
      this.persistSession(input.sessionId)
      this.persistEventProjection(input.sessionId, input.payload)
      return result
    })
  }

  getMessages(id: string) { return this.memory.getMessages(id) }
  getLatestUserMessageId(id: string) { return this.memory.getLatestUserMessageId(id) }
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
    const legacy = this.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_store_snapshot'")
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
      CREATE TABLE IF NOT EXISTS runtime_recovery_operations (
        operation_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, caller_id TEXT NOT NULL, request_id TEXT NOT NULL,
        session_id TEXT, state TEXT NOT NULL, cleanup_fact TEXT NOT NULL, persistence_fact TEXT NOT NULL,
        updated_at INTEGER NOT NULL, data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runtime_permissions_session ON runtime_permissions(session_id);
      CREATE INDEX IF NOT EXISTS runtime_questions_session ON runtime_questions(session_id);
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_recovery_operations_request
        ON runtime_recovery_operations(scope_key, caller_id, request_id);
      CREATE INDEX IF NOT EXISTS runtime_recovery_operations_session
        ON runtime_recovery_operations(session_id, updated_at DESC);
    `)
    const schema = this.get("SELECT version FROM runtime_schema LIMIT 1")
    if (!schema) {
      this.run("INSERT INTO runtime_schema(version) VALUES (?)", SCHEMA_VERSION)
      return
    }
    const found = columnNumber(schema, "version")
    if (found === SCHEMA_VERSION) return
    // The statements above already added what version 3 holds; recording the
    // version is the whole upgrade. Any other version is a store this build
    // cannot read, and guessing at its rows would invent history.
    if (found !== UPGRADABLE_SCHEMA_VERSION) throw new UnsupportedRuntimeStoreSchemaError(found)
    this.run("UPDATE runtime_schema SET version = ?", SCHEMA_VERSION)
  }

  /**
   * Claim one request id for one caller. `INSERT OR IGNORE` plus a read-back
   * lets the unique index settle the race between two writers, so a retried
   * delivery joins the operation that won rather than issuing the effect twice.
   */
  recordRecoveryOperation(operation: RecoveryOperation, caller: { callerId: string }) {
    this.pruneRecoveryOperations()
    const scopeKey = recoveryScopeKey(operation.target)
    return this.write(() => {
      this.run(`
        INSERT OR IGNORE INTO runtime_recovery_operations(
          operation_id, scope_key, caller_id, request_id, session_id, state, cleanup_fact, persistence_fact, updated_at, data_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        operation.operationId, scopeKey, caller.callerId, operation.requestId, recoveryTargetSessionId(operation.target),
        operation.state, operation.facts.cleanup.value, operation.facts.persistence.value, operation.updatedAt,
        JSON.stringify(operation),
      )
      const row = this.get(
        "SELECT operation_id, data_json FROM runtime_recovery_operations WHERE scope_key = ? AND caller_id = ? AND request_id = ?",
        scopeKey, caller.callerId, operation.requestId,
      )
      if (!row) throw new Error(`Recovery operation ${operation.operationId} was not recorded`)
      if (columnText(row, "operation_id") === operation.operationId) return { created: true as const }
      return {
        created: false as const,
        existing: parseRecoveryOperation(JSON.parse(columnText(row, "data_json"))),
      }
    })
  }

  updateRecoveryOperation(operation: RecoveryOperation) {
    this.write(() => {
      if (!this.get("SELECT 1 FROM runtime_recovery_operations WHERE operation_id = ?", operation.operationId)) {
        throw new Error(
          `Recovery operation ${operation.operationId} is not recorded in this store; it was never created here, `
            + "or it settled with nothing outstanding and aged out",
        )
      }
      this.run(`
        UPDATE runtime_recovery_operations
        SET state = ?, cleanup_fact = ?, persistence_fact = ?, updated_at = ?, data_json = ?
        WHERE operation_id = ?
      `,
        operation.state, operation.facts.cleanup.value, operation.facts.persistence.value, operation.updatedAt,
        JSON.stringify(operation), operation.operationId,
      )
    })
  }

  readRecoveryOperation(operationId: string) {
    const row = this.get("SELECT data_json FROM runtime_recovery_operations WHERE operation_id = ?", operationId)
    return row ? parseRecoveryOperation(JSON.parse(columnText(row, "data_json"))) : undefined
  }

  listRecoveryOperations(scope: { sessionId?: string } = {}) {
    return this.rows(`
      SELECT data_json FROM runtime_recovery_operations
      WHERE (? IS NULL OR session_id = ?) AND (state NOT IN ('succeeded', 'failed') OR updated_at >= ?)
      ORDER BY updated_at DESC
    `, scope.sessionId ?? null, scope.sessionId ?? null, Date.now() - RECOVERY_OPERATION_RETENTION_MS)
      .map((row) => parseRecoveryOperation(JSON.parse(columnText(row, "data_json"))))
  }

  /**
   * An operation whose facts still say something is owned, unknown or
   * unwritten is kept whatever its age: it is the only record that an
   * obligation was never discharged.
   */
  private pruneRecoveryOperations() {
    this.write(() => {
      this.run(`
        DELETE FROM runtime_recovery_operations
        WHERE state IN ('succeeded', 'failed') AND updated_at < ?
          AND cleanup_fact = 'verified_clear' AND persistence_fact <> 'pending'
      `, Date.now() - RECOVERY_OPERATION_RETENTION_MS)
    })
  }

  private hydrateMemory() {
    const snapshot: MemoryRuntimeStoreSnapshot = {
      sessions: this.jsonRows("runtime_sessions", "id", persistedSessionRow),
      configs: this.rows("SELECT session_id, data_json FROM runtime_configs").map((row) => ({
        sessionId: columnText(row, "session_id"),
        config: this.parse("runtime_configs", columnText(row, "session_id"), columnText(row, "data_json"), persistedSessionConfig),
      })),
      messages: this.groupJsonRows("runtime_messages", "session_id", "message_id", persistedMessageRow)
        .map(({ group, values }) => ({ sessionId: group, messages: values })),
      permissions: this.groupJsonRows("runtime_permissions", "directory", "id", persistedPermissionRow)
        .map(({ group, values }) => ({ directory: group, rows: values })),
      questions: this.groupJsonRows("runtime_questions", "directory", "id", persistedQuestionRow)
        .map(({ group, values }) => ({ directory: group, rows: values })),
      todos: this.groupJsonRows("runtime_todos", "session_id", "ordinal", persistedTodoRow)
        .map(({ group, values }) => ({ sessionId: group, rows: values })),
      recoveryErrors: this.rows("SELECT session_id, message FROM runtime_recovery_errors")
        .map((row) => ({ sessionId: columnText(row, "session_id"), message: columnText(row, "message") })),
      seq: this.rows("SELECT session_id, seq FROM runtime_session_seq")
        .map((row) => ({ sessionId: columnText(row, "session_id"), seq: columnNumber(row, "seq") })),
      subagents: this.rows("SELECT parent_session_id, observation_id, data_json, published FROM runtime_subagents").map((row) => ({
        parentSessionId: columnText(row, "parent_session_id"),
        observation: this.parse(
          "runtime_subagents",
          `${columnText(row, "parent_session_id")}/${columnText(row, "observation_id")}`,
          columnText(row, "data_json"),
          persistedSubagentObservation,
        ),
        published: columnNumber(row, "published") === 1,
      })),
    }
    this.memory = new MemoryRuntimeStore(this.sessionStarts)
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
      this.persistMessage(sessionId, event.properties.info.id)
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
    const directory = session?.directory ?? this.sessionStarts.get(sessionId)?.binding.directory ?? ""
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

  private upsertJson(table: string, keyColumn: string, key: string, value: unknown) {
    if (value === null) {
      this.run(`DELETE FROM ${table} WHERE ${keyColumn} = ?`, key)
      return
    }
    this.run(`
      INSERT INTO ${table}(${keyColumn}, data_json) VALUES (?, ?)
      ON CONFLICT(${keyColumn}) DO UPDATE SET data_json = excluded.data_json
    `, key, JSON.stringify(value))
  }

  private upsertScalar(table: string, keyColumn: string, key: string, valueColumn: string, value: unknown) {
    if (value === null) {
      this.run(`DELETE FROM ${table} WHERE ${keyColumn} = ?`, key)
      return
    }
    this.run(`
      INSERT INTO ${table}(${keyColumn}, ${valueColumn}) VALUES (?, ?)
      ON CONFLICT(${keyColumn}) DO UPDATE SET ${valueColumn} = excluded.${valueColumn}
    `, key, value)
  }

  /** Every stored JSON row of one table, parsed by `read` and keyed for corruption reports. */
  private jsonRows<T>(table: string, keyColumn: string, read: (value: unknown) => T | undefined): T[] {
    return this.rows(`SELECT * FROM ${table}`)
      .map((row) => this.parse(table, columnText(row, keyColumn), columnText(row, "data_json"), read))
  }

  /** The same, grouped by `groupColumn`, in the table's stored order. */
  private groupJsonRows<T>(
    table: string,
    groupColumn: string,
    keyColumn: string,
    read: (value: unknown) => T | undefined,
  ): Array<{ group: string; values: T[] }> {
    const order = table === "runtime_messages" || table === "runtime_todos" ? " ORDER BY ordinal" : ""
    const groups = new Map<string, T[]>()
    for (const row of this.rows(`SELECT * FROM ${table}${order}`)) {
      const group = columnText(row, groupColumn)
      const values = groups.get(group) ?? []
      values.push(this.parse(table, `${group}/${columnText(row, keyColumn)}`, columnText(row, "data_json"), read))
      groups.set(group, values)
    }
    return [...groups].map(([group, values]) => ({ group, values }))
  }

  /** Stored JSON becomes a typed row here or the store reports the row as corrupt. */
  private parse<T>(table: string, key: string, value: string, read: (value: unknown) => T | undefined): T {
    let decoded: unknown
    try {
      decoded = JSON.parse(value)
    } catch (error) {
      throw new RuntimeStoreCorruptionError(table, key, error)
    }
    const row = read(decoded)
    if (row === undefined) throw new RuntimeStoreCorruptionError(table, key, new Error("row does not match its stored shape"))
    return row
  }

  private run(sql: string, ...params: unknown[]) {
    const statement = this.db.prepare(sql)
    try { return statement.run(...params) } finally { statement.finalize() }
  }

  private get(sql: string, ...params: unknown[]): Record<string, unknown> | undefined {
    const statement = this.db.prepare(sql)
    try { return asRecord(statement.get(...params)) } finally { statement.finalize() }
  }

  private rows(sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
    const statement = this.db.prepare(sql)
    try { return statement.all(...params).filter(isRecord) } finally { statement.finalize() }
  }

}

export function createSqliteRuntimeStore(options: SqliteRuntimeStoreOptions): AgentRuntimeStore {
  return new SqliteRuntimeStore(options)
}
