import fs from "fs"
import { createRequire } from "module"
import path from "path"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { ACP_RECOVER } from "@claxedo/agent-sdk-runtime/adapters"
import { firstTurnErrorData, normalizeAgentHarnessTransport, normalizeHarnessIdentity }
  from "@claxedo/agent-sdk-runtime"
import type { AgentMessageRow, HarnessConnection, SessionConfig, SessionConfigUpdate, SessionHarness } from "@claxedo/agent-sdk-runtime"
import {
  type CompatEvent,
  buildAssistantMessage,
  buildUserMessage,
  messageCompleted,
  messagePartUpdated,
  messageUpdated,
  sessionError,
  sessionIdle,
  sessionStatus,
} from "./compat-events"
import { workspaceRuntimeStoreDir } from "./env"

type Model = {
  providerID: string
  modelID: string
}

type SessionModel = SessionConfig["model"]

type Bind = {
  type: "session.bind"
  directory: string
  title?: string
  agentSessionId: string
  ownerKey?: string
  processKey?: string
  createdAt: number
}

type Turn = {
  type: "turn.start"
  userMessageId?: string
  assistantMessageId: string
  agent: string
  model: Model
  parts: unknown[]
  tools?: Record<string, boolean>
  format?: UserMessage["format"]
  system?: string
  variant?: string
}

type SessionInterrupted = {
  type: "session.interrupted"
  message: string
}

type LegacyProcessLost = {
  type: "process.lost"
  message: string
}

type SessionUpdate = {
  type: "session.update"
  updates: {
    title?: string
    time?: {
      archived?: number
    }
  }
}

type SessionDelete = {
  type: "session.delete"
}

type PermissionStaled = {
  type: "permission.staled"
  permissionId: string
}

type QuestionStaled = {
  type: "question.staled"
  questionId: string
}

type SessionRecovering = {
  type: "session.recovering"
  message: string
}

type NoticeAcknowledged = {
  type: "notice.acknowledged"
  notice: "recovery_error"
}

type NoticeCreated = {
  type: "notice.created"
  notice: "recovery_error"
  message: string
}

type ProjectionResetRequested = {
  type: "projection.reset_requested"
  reason?: string
}

type ConfigUpdate = {
  type: "config.update"
  patch: SessionConfigUpdate
  directory?: string
}

type Control =
  | Bind
  | Turn
  | SessionInterrupted
  | LegacyProcessLost
  | SessionUpdate
  | SessionDelete
  | PermissionStaled
  | QuestionStaled
  | SessionRecovering
  | NoticeAcknowledged
  | NoticeCreated
  | ProjectionResetRequested
  | ConfigUpdate

type SqliteStatement = {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

type SqliteDatabase = {
  exec(sql: string): unknown
  prepare(sql: string): SqliteStatement
  close?: () => unknown
}

export type RuntimeStoreAppendOutput = {
  sessionId: string
  seq: number
  createdAt: number
  agentSessionId?: string
  payload: CompatEvent
  source?: {
    dir: "in" | "out"
    method: string
    requestId?: string
    frame?: unknown
  }
}

export type RuntimeStoreTurnStartOutput = {
  sessionId: string
  seq: number
  createdAt: number
  agentSessionId?: string
  events: CompatEvent[]
}

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
  if (!BetterSqlite) throw new Error("better-sqlite3 export missing")
  return new BetterSqlite(file)
}

function tableColumns(db: SqliteDatabase, table: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)
}

function hasColumn(db: SqliteDatabase, table: string, column: string) {
  return tableColumns(db, table).includes(column)
}

type Row =
  | {
      seq: number
      ts: number
      sessionId: string
      agentSessionId?: string
      kind: "control"
      control: Control
    }
  | {
      seq: number
      ts: number
      sessionId: string
      agentSessionId?: string
      kind: "event"
      source?: {
        dir: "in" | "out"
        method: string
        requestId?: string
        frame?: unknown
      }
      payload: CompatEvent
    }

type TurnStartRow = {
  seq: number
  ts: number
  sessionId: string
  agentSessionId?: string
  kind: "control"
  control: Turn
}

type RuntimeJournalRow = {
  session_id: string
  seq: number
  kind: "control" | "event"
  type: string
  created_at: number
  provider_session_id: string | null
  process_key: string | null
  turn_id: string | null
  user_message_id: string | null
  assistant_message_id: string | null
  payload_json: string
  source_json: string | null
}

function rec(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null
}

function str(input: unknown): string | undefined {
  return typeof input === "string" ? input : undefined
}

function num(input: unknown): number | undefined {
  return typeof input === "number" ? input : undefined
}

function nullable(input: unknown): string | null | undefined {
  if (input === null) return null
  return typeof input === "string" ? input : undefined
}

function harnessRemote(harness?: SessionHarness) {
  return harness?.connection?.kind === "remote" ? harness.connection : undefined
}

function harnessProcess(harness?: SessionHarness) {
  return harness?.connection?.kind === "process" ? harness.connection : undefined
}

function harnessHeadersJson(harness?: SessionHarness) {
  return harnessRemote(harness)?.headers ? JSON.stringify(harnessRemote(harness)!.headers) : null
}

function harnessHeaders(input: string | null | undefined) {
  if (!input) return
  try {
    const value = JSON.parse(input) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    const entries = Object.entries(value)
    if (!entries.every(([, item]) => typeof item === "string")) return
    return Object.fromEntries(entries) as Record<string, string>
  } catch {}
}

function sessionConfigPatch(input: SessionConfigUpdate): SessionConfigUpdate {
  const row = input as SessionConfigUpdate & { runner?: unknown }
  const runner = rec(row.runner)
  const legacyHarness = runner ? sessionHarness({
    runner_type: str(runner.type),
    runner_binary: str(runner.binary),
    runner_transport: str(runner.transport),
    runner_url: str(runner.url),
    runner_headers_json: runner.headers && typeof runner.headers === "object" && !Array.isArray(runner.headers)
      ? JSON.stringify(runner.headers)
      : null,
  }) : undefined
  const legacyModel = runner && str(runner.model)
    ? {
        providerID: str(runner.type) ?? legacyHarness?.id ?? "unknown",
        modelID: str(runner.model)!,
      }
    : undefined
  return {
    ...input,
    ...(input.harness ? {} : legacyHarness ? { harness: legacyHarness } : {}),
    ...(input.model !== undefined ? {} : legacyModel ? { model: legacyModel } : {}),
  }
}

function harnessTransport(input: string | null | undefined) {
  return normalizeAgentHarnessTransport(input)
}

function sessionHarness(input: {
  harness_id?: string | null
  harness_access?: string | null
  harness_binary?: string | null
  harness_transport?: string | null
  harness_url?: string | null
  harness_headers_json?: string | null
  runner_type?: string | null
  runner_binary?: string | null
  runner_transport?: string | null
  runner_url?: string | null
  runner_headers_json?: string | null
}): SessionHarness | undefined {
  const identity = normalizeHarnessIdentity(
    input.harness_id && input.harness_access
      ? { id: input.harness_id, access: input.harness_access }
      : input.runner_type,
  )
  if (!identity) return
  const binary = input.harness_binary ?? input.runner_binary ?? undefined
  const transport = harnessTransport(input.harness_transport ?? input.runner_transport)
  const url = input.harness_url ?? input.runner_url ?? undefined
  const headers = harnessHeaders(input.harness_headers_json ?? input.runner_headers_json)
  const connection: HarnessConnection | undefined = url || transport || headers
    ? {
        kind: "remote",
        ...(transport ? { transport } : {}),
        ...(url ? { url } : {}),
        ...(headers ? { headers } : {}),
      }
    : binary
      ? { kind: "process", binary }
      : undefined
  return {
    id: identity.id,
    access: identity.access,
    ...(connection ? { connection } : {}),
  }
}

function parse(line: string): Row | null {
  try {
    const row = JSON.parse(line) as Row
    if (typeof row.seq !== "number" || typeof row.ts !== "number" || typeof row.sessionId !== "string") return null
    if (row.kind !== "control" && row.kind !== "event") return null
    return row
  } catch {
    return null
  }
}

function inputParts(sessionId: string, messageId: string, parts: unknown[]) {
  return parts.map((part, i) => {
    const row = rec(part)
    const id = str(row?.id) ?? `${messageId}-part-${i}`
    if (row?.type === "text") {
      return {
        id,
        sessionID: sessionId,
        messageID: messageId,
        type: "text" as const,
        text: str(row.text) ?? "",
      }
    }
    if (row?.type === "agent") {
      return {
        id,
        sessionID: sessionId,
        messageID: messageId,
        type: "agent" as const,
        name: str(row.name) ?? str(row.agent) ?? "agent",
      }
    }
    return {
      id,
      sessionID: sessionId,
      messageID: messageId,
      type: "text" as const,
      text: JSON.stringify(part),
      synthetic: true,
    }
  })
}

export class RuntimeStore {
  private root: string
  private sessions: string
  private db: SqliteDatabase
  private closed = false

  constructor(root = workspaceRuntimeStoreDir()) {
    this.root = root
    this.sessions = path.join(root, "sessions")
    fs.mkdirSync(this.sessions, { recursive: true, mode: 0o755 })
    this.db = openDatabase(path.join(root, "state.db"))
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = NORMAL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.migrate()
    this.replay()
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.db.close?.()
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_journal (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        provider_session_id TEXT,
        process_key TEXT,
        turn_id TEXT,
        user_message_id TEXT,
        assistant_message_id TEXT,
        payload_json TEXT NOT NULL,
        source_json TEXT,
        PRIMARY KEY (session_id, seq)
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS runtime_journal_session_created_idx
      ON runtime_journal (session_id, created_at, seq)
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        title TEXT,
        agent_session_id TEXT,
        process_key TEXT,
        harness_id TEXT,
        harness_access TEXT,
        harness_binary TEXT,
        harness_transport TEXT,
        harness_url TEXT,
        harness_headers_json TEXT,
        model_provider_id TEXT,
        model_id TEXT,
        variant TEXT,
        agent TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT,
        recovery_error TEXT,
        archived_at INTEGER
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_map (
        session_id TEXT PRIMARY KEY,
        agent_session_id TEXT NOT NULL UNIQUE
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        ord INTEGER NOT NULL,
        info_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS part (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        ord INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS todo (
        session_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, position)
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_permission (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        patterns_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        always_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_question (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        questions_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal_checkpoint (
        session_id TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deleted_session (
        session_id TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL
      )
    `)
    // Migration: add archived_at column for existing databases
    try {
      this.db.exec("ALTER TABLE session ADD COLUMN archived_at INTEGER")
    } catch {
      // column already exists
    }
    for (const sql of [
      "ALTER TABLE session ADD COLUMN harness_id TEXT",
      "ALTER TABLE session ADD COLUMN harness_access TEXT",
      "ALTER TABLE session ADD COLUMN harness_binary TEXT",
      "ALTER TABLE session ADD COLUMN harness_transport TEXT",
      "ALTER TABLE session ADD COLUMN harness_url TEXT",
      "ALTER TABLE session ADD COLUMN harness_headers_json TEXT",
      "ALTER TABLE session ADD COLUMN process_key TEXT",
      "ALTER TABLE session ADD COLUMN model_provider_id TEXT",
      "ALTER TABLE session ADD COLUMN model_id TEXT",
      "ALTER TABLE session ADD COLUMN variant TEXT",
      "ALTER TABLE session ADD COLUMN agent TEXT",
    ]) {
      try {
        this.db.exec(sql)
      } catch {
        // column already exists
      }
    }
    this.migrateLegacyRunnerColumns()
    this.importJsonlJournals()
  }

  private migrateLegacyRunnerColumns() {
    if (!hasColumn(this.db, "session", "runner_type")) return
    for (const column of [
      "runner_binary",
      "runner_model",
      "runner_transport",
      "runner_url",
      "runner_headers_json",
    ]) {
      if (!hasColumn(this.db, "session", column)) this.db.exec(`ALTER TABLE session ADD COLUMN ${column} TEXT`)
    }
    this.db.exec(`
      UPDATE session
      SET
        harness_id = COALESCE(
          harness_id,
          CASE
            WHEN runner_type IN ('claude-acp', 'claude') THEN 'claude'
            WHEN runner_type IN ('codex-app-server', 'codex-acp', 'codex') THEN 'codex'
            WHEN runner_type IN ('cursor-acp', 'cursor') THEN 'cursor'
            WHEN runner_type IN ('opencode-native', 'opencode') THEN 'opencode'
            WHEN runner_type = 'pi' THEN 'pi'
            ELSE NULL
          END
        ),
        harness_access = COALESCE(
          harness_access,
          CASE
            WHEN runner_type IN ('claude-acp', 'codex-acp', 'cursor-acp') THEN 'acp'
            WHEN runner_type IN ('claude', 'codex-app-server', 'codex', 'cursor', 'opencode-native', 'opencode', 'pi') THEN 'native'
            ELSE NULL
          END
        ),
        harness_binary = COALESCE(harness_binary, runner_binary),
        harness_transport = COALESCE(harness_transport, runner_transport),
        harness_url = COALESCE(harness_url, runner_url),
        harness_headers_json = COALESCE(harness_headers_json, runner_headers_json),
        model_provider_id = COALESCE(model_provider_id, runner_type),
        model_id = COALESCE(model_id, runner_model)
    `)
    for (const column of [
      "runner_type",
      "runner_binary",
      "runner_model",
      "runner_transport",
      "runner_url",
      "runner_headers_json",
    ]) {
      if (!hasColumn(this.db, "session", column)) continue
      try {
        this.db.exec(`ALTER TABLE session DROP COLUMN ${column}`)
      } catch {
        // Older SQLite builds may not support DROP COLUMN. Existing rows are already migrated.
      }
    }
  }

  private reset() {
    this.transaction(() => {
      this.db.exec("DELETE FROM journal_checkpoint")
      this.db.exec("DELETE FROM deleted_session")
      this.db.exec("DELETE FROM pending_question")
      this.db.exec("DELETE FROM pending_permission")
      this.db.exec("DELETE FROM todo")
      this.db.exec("DELETE FROM part")
      this.db.exec("DELETE FROM message")
      this.db.exec("DELETE FROM session_map")
      this.db.exec("DELETE FROM session")
    })
  }

  private replay() {
    this.reset()
    const rows = this.db
      .prepare(`
        SELECT
          session_id,
          seq,
          kind,
          type,
          created_at,
          provider_session_id,
          process_key,
          turn_id,
          user_message_id,
          assistant_message_id,
          payload_json,
          source_json
        FROM runtime_journal
        ORDER BY session_id ASC, seq ASC
      `)
      .all() as RuntimeJournalRow[]
    for (const row of rows) {
      const parsed = this.parseJournalRow(row)
      if (!parsed) continue
      this.project(parsed)
    }
  }

  private staleToolError(message?: string) {
    if (message?.includes("ACP process restarted")) return "Tool execution interrupted by ACP restart"
    return "Tool execution interrupted"
  }

  private finishTools(sessionId: string, ts: number, message?: string) {
    const error = this.staleToolError(message)
    const rows = this.db
      .prepare("SELECT data_json FROM part WHERE session_id = ? ORDER BY updated_at ASC")
      .all(sessionId) as Array<{ data_json: string }>
    for (const row of rows) {
      const part = JSON.parse(row.data_json) as Record<string, unknown>
      if (part.type !== "tool") continue
      const state = rec(part.state)
      const status = str(state?.status)
      if (status !== "pending" && status !== "running") continue
      const time = rec(state?.time)
      part.state = {
        ...state,
        status: "error",
        error,
        time: {
          start: num(time?.start) ?? ts,
          end: ts,
        },
      }
      this.upsertPart(part, ts)
    }
  }

  private terminalizedPart(part: Record<string, unknown>, ts: number, message?: string) {
    if (part.type !== "tool") return part
    const state = rec(part.state)
    const status = str(state?.status)
    if (status !== "pending" && status !== "running") return part
    const time = rec(state?.time)
    return {
      ...part,
      state: {
        ...state,
        status: "error",
        error: this.staleToolError(message),
        time: {
          start: num(time?.start) ?? ts,
          end: ts,
        },
      },
    }
  }

  private normalizeRecoveringTools() {
    const rows = this.db
      .prepare("SELECT id, agent_session_id FROM session WHERE status = 'busy'")
      .all() as Array<{ id: string; agent_session_id: string | null }>
    for (const row of rows) {
      this.markSessionInterrupted(row.id, ACP_RECOVER, row.agent_session_id)
    }
  }

  recoverBusySessions() {
    this.normalizeRecoveringTools()
  }

  private importJsonlJournals() {
    const names = fs.existsSync(this.sessions)
      ? fs.readdirSync(this.sessions).filter((name) => name.endsWith(".jsonl")).sort()
      : []
    for (const name of names) {
      const text = fs.readFileSync(path.join(this.sessions, name), "utf8")
      for (const line of text.split("\n").filter(Boolean)) {
        const row = parse(line)
        if (!row) continue
        this.insertRuntimeJournal(row, row.seq, { ignoreDuplicate: true })
      }
    }
  }

  private parseJournalRow(row: RuntimeJournalRow): Row | null {
    try {
      if (row.kind === "control") {
        return {
          seq: row.seq,
          ts: row.created_at,
          sessionId: row.session_id,
          ...(row.provider_session_id ? { agentSessionId: row.provider_session_id } : {}),
          kind: "control",
          control: JSON.parse(row.payload_json) as Control,
        }
      }
      if (row.kind === "event") {
        return {
          seq: row.seq,
          ts: row.created_at,
          sessionId: row.session_id,
          ...(row.provider_session_id ? { agentSessionId: row.provider_session_id } : {}),
          kind: "event",
          payload: JSON.parse(row.payload_json) as CompatEvent,
          ...(row.source_json
            ? {
                source: JSON.parse(row.source_json) as {
                  dir: "in" | "out"
                  method: string
                  requestId?: string
                  frame?: unknown
                },
              }
            : {}),
        }
      }
      return null
    } catch {
      return null
    }
  }

  exportJournalJsonl(sessionId?: string) {
    const rows = this.db
      .prepare(`
        SELECT
          session_id,
          seq,
          kind,
          type,
          created_at,
          provider_session_id,
          process_key,
          turn_id,
          user_message_id,
          assistant_message_id,
          payload_json,
          source_json
        FROM runtime_journal
        ${sessionId ? "WHERE session_id = ?" : ""}
        ORDER BY session_id ASC, seq ASC
      `)
      .all(...(sessionId ? [sessionId] : [])) as RuntimeJournalRow[]
    return rows.flatMap((row) => {
      const parsed = this.parseJournalRow(row)
      return parsed ? [JSON.stringify(parsed)] : []
    }).join("\n") + (rows.length > 0 ? "\n" : "")
  }

  private next(sessionId: string) {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM runtime_journal WHERE session_id = ?")
      .get(sessionId) as { seq: number }
    return row.seq
  }

  private deleted(sessionId: string) {
    return !!this.db
      .prepare("SELECT 1 FROM deleted_session WHERE session_id = ?")
      .get(sessionId)
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN")
    try {
      const result = run()
      this.db.exec("COMMIT")
      return result
    } catch (err) {
      try {
        this.db.exec("ROLLBACK")
      } catch {}
      throw err
    }
  }

  private insertRuntimeJournal(row: Row, seq = this.next(row.sessionId), options: { ignoreDuplicate?: boolean } = {}) {
    const type = row.kind === "control" ? row.control.type : row.payload.type
    const processKey = row.kind === "control" && row.control.type === "session.bind"
      ? row.control.ownerKey ?? row.control.processKey ?? null
      : null
    const turnId = row.kind === "control" && row.control.type === "turn.start"
      ? row.control.assistantMessageId
      : null
    const userMessageId = row.kind === "control" && row.control.type === "turn.start"
      ? row.control.userMessageId ?? null
      : null
    const assistantMessageId = row.kind === "control" && row.control.type === "turn.start"
      ? row.control.assistantMessageId
      : null
    this.transaction(() => {
      this.db.prepare(`
        INSERT ${options.ignoreDuplicate ? "OR IGNORE " : ""}INTO runtime_journal (
          session_id,
          seq,
          kind,
          type,
          created_at,
          provider_session_id,
          process_key,
          turn_id,
          user_message_id,
          assistant_message_id,
          payload_json,
          source_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.sessionId,
        seq,
        row.kind,
        type,
        row.ts,
        row.agentSessionId ?? null,
        processKey,
        turnId,
        userMessageId,
        assistantMessageId,
        JSON.stringify(row.kind === "control" ? row.control : row.payload),
        row.kind === "event" && row.source ? JSON.stringify(row.source) : null,
      )
    })
    return { ...row, seq }
  }

  private checkpoint(row: Row) {
    this.db.prepare(
      "INSERT OR REPLACE INTO journal_checkpoint (session_id, last_seq, updated_at) VALUES (?, ?, ?)",
    ).run(row.sessionId, row.seq, row.ts)
  }

  private commit(row: Row) {
    if (
      this.deleted(row.sessionId) &&
      !(row.kind === "control" && (row.control.type === "session.bind" || row.control.type === "session.delete"))
    ) {
      throw new Error(`Session ${row.sessionId} was deleted`)
    }
    const journaled = this.insertRuntimeJournal(row)
    this.transaction(() => {
      this.apply(journaled)
      this.checkpoint(journaled)
    })
    return journaled
  }

  private messageOrd(sessionId: string, messageId: string) {
    const row = this.db
      .prepare("SELECT ord FROM message WHERE id = ?")
      .get(messageId) as { ord: number } | null
    if (row) return row.ord
    const max = this.db
      .prepare("SELECT COALESCE(MAX(ord), -1) AS ord FROM message WHERE session_id = ?")
      .get(sessionId) as { ord: number }
    return max.ord + 1
  }

  private partOrd(messageId: string, partId: string) {
    const row = this.db
      .prepare("SELECT ord FROM part WHERE id = ?")
      .get(partId) as { ord: number } | null
    if (row) return row.ord
    const max = this.db
      .prepare("SELECT COALESCE(MAX(ord), -1) AS ord FROM part WHERE message_id = ?")
      .get(messageId) as { ord: number }
    return max.ord + 1
  }

  private upsertMessage(info: Record<string, unknown>, ts: number) {
    const sessionId = str(info.sessionID)
    const id = str(info.id)
    const role = str(info.role)
    if (!sessionId || !id || !role) return
    const prev = this.db
      .prepare("SELECT created_at FROM message WHERE id = ?")
      .get(id) as { created_at: number } | null
    this.db.prepare(
      "INSERT OR REPLACE INTO message (id, session_id, role, ord, info_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, sessionId, role, this.messageOrd(sessionId, id), JSON.stringify(info), prev?.created_at ?? ts)
  }

  private upsertPart(part: Record<string, unknown>, ts: number) {
    const sessionId = str(part.sessionID)
    const messageId = str(part.messageID)
    const id = str(part.id)
    if (!sessionId || !messageId || !id) return
    this.db.prepare(
      "INSERT OR REPLACE INTO part (id, session_id, message_id, ord, data_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, sessionId, messageId, this.partOrd(messageId, id), JSON.stringify(part), ts)
  }

  private delta(sessionId: string, messageId: string, partId: string, field: string, delta: string, ts: number) {
    const row = this.db
      .prepare("SELECT data_json FROM part WHERE id = ?")
      .get(partId) as { data_json: string } | null
    const part = row ? JSON.parse(row.data_json) as Record<string, unknown> : {
      id: partId,
      sessionID: sessionId,
      messageID: messageId,
      type: "text",
      text: "",
    }
    const prev = str(part[field]) ?? ""
    part[field] = prev + delta
    this.upsertPart(part, ts)
  }

  private upsertSession(input: {
    id: string
    directory: string
    title?: string
    agentSessionId?: string
    processKey?: string
    harness?: SessionHarness
    model?: SessionModel
    variant?: string | null
    agent?: string | null
    createdAt: number
    updatedAt: number
    status?: string
    recoveryError?: string | null
  }) {
    const prev = this.db
      .prepare(`
        SELECT
          created_at,
          title,
          recovery_error,
          agent_session_id,
          process_key,
          harness_id,
          harness_access,
          harness_binary,
          harness_transport,
          harness_url,
          harness_headers_json,
          model_provider_id,
          model_id,
          variant,
          agent
        FROM session
        WHERE id = ?
      `)
      .get(input.id) as {
      created_at: number
      title: string | null
      recovery_error: string | null
      agent_session_id: string | null
      process_key: string | null
      harness_id: string | null
      harness_access: string | null
      harness_binary: string | null
      harness_transport: string | null
      harness_url: string | null
      harness_headers_json: string | null
      model_provider_id: string | null
      model_id: string | null
      variant: string | null
      agent: string | null
    } | null
    this.db.prepare(
      `INSERT OR REPLACE INTO session (
        id,
        directory,
        title,
        agent_session_id,
        process_key,
        harness_id,
        harness_access,
        harness_binary,
        harness_transport,
        harness_url,
        harness_headers_json,
        model_provider_id,
        model_id,
        variant,
        agent,
        created_at,
        updated_at,
        status,
        recovery_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        input.id,
        input.directory,
        input.title ?? prev?.title ?? null,
        input.agentSessionId ?? prev?.agent_session_id ?? null,
        input.processKey ?? prev?.process_key ?? null,
        input.harness?.id ?? prev?.harness_id ?? null,
        input.harness?.access ?? prev?.harness_access ?? null,
        harnessProcess(input.harness)?.binary ?? prev?.harness_binary ?? null,
        harnessRemote(input.harness)?.transport ?? prev?.harness_transport ?? null,
        harnessRemote(input.harness)?.url ?? prev?.harness_url ?? null,
        input.harness ? harnessHeadersJson(input.harness) : prev?.harness_headers_json ?? null,
        input.model?.providerID ?? prev?.model_provider_id ?? null,
        input.model?.modelID ?? prev?.model_id ?? null,
        input.variant ?? prev?.variant ?? null,
        input.agent ?? prev?.agent ?? null,
        prev?.created_at ?? input.createdAt,
        input.updatedAt,
        input.status ?? null,
        input.recoveryError ?? prev?.recovery_error ?? null,
    )
    if (input.agentSessionId) {
      this.db.prepare(
        "INSERT OR REPLACE INTO session_map (session_id, agent_session_id) VALUES (?, ?)",
      ).run(input.id, input.agentSessionId)
    }
  }

  private deleteSessionProjection(id: string) {
    this.db.prepare("DELETE FROM journal_checkpoint WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM pending_question WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM pending_permission WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM todo WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM part WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM message WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM session_map WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM session WHERE id = ?").run(id)
  }

  private applySessionUpdate(sessionId: string, updates: SessionUpdate["updates"], ts: number) {
    if (updates.title !== undefined) {
      this.db.prepare("UPDATE session SET title = ?, updated_at = ? WHERE id = ?").run(updates.title, ts, sessionId)
    }
    if (updates.time?.archived !== undefined) {
      this.db.prepare("UPDATE session SET archived_at = ?, updated_at = ? WHERE id = ?").run(updates.time.archived, ts, sessionId)
    }
  }

  private applyControl(row: Extract<Row, { kind: "control" }>) {
    const control = row.control
    if (control.type === "session.bind") {
      this.db.prepare("DELETE FROM deleted_session WHERE session_id = ?").run(row.sessionId)
      this.upsertSession({
        id: row.sessionId,
        directory: control.directory,
        title: control.title,
        agentSessionId: control.agentSessionId,
        processKey: control.ownerKey ?? control.processKey,
        createdAt: control.createdAt,
        updatedAt: row.ts,
      })
      return
    }
    if (control.type === "turn.start") {
      const session = this.getSession(row.sessionId) as { directory?: string } | null
      const directory = session?.directory ?? ""
      if (control.userMessageId) {
        this.upsertMessage(
        buildUserMessage({
          id: control.userMessageId,
          sessionID: row.sessionId,
          agent: control.agent,
          model: control.model,
          created: row.ts,
          ...(control.tools ? { tools: control.tools } : {}),
          ...(control.format ? { format: control.format } : {}),
          ...(control.system ? { system: control.system } : {}),
          ...(control.variant ? { variant: control.variant } : {}),
        }) as unknown as Record<string, unknown>,
        row.ts,
      )
        for (const part of inputParts(row.sessionId, control.userMessageId, control.parts)) {
          this.upsertPart(part as unknown as Record<string, unknown>, row.ts)
        }
      }
      this.upsertMessage(
        buildAssistantMessage({
          id: control.assistantMessageId,
          sessionID: row.sessionId,
          parentID: control.userMessageId ?? row.sessionId,
          agent: control.agent,
          model: control.model,
          directory,
          created: row.ts,
        }) as unknown as Record<string, unknown>,
        row.ts,
      )
      this.upsertSession({
        id: row.sessionId,
        directory,
        createdAt: row.ts,
        updatedAt: row.ts,
        status: "busy",
        recoveryError: null,
      })
      return
    }
    if (control.type === "config.update") {
      this.applyConfigUpdate(row.sessionId, control.patch, row.ts, control.directory)
      return
    }
    if (control.type === "session.update") {
      this.applySessionUpdate(row.sessionId, control.updates, row.ts)
      return
    }
    if (control.type === "session.delete") {
      this.deleteSessionProjection(row.sessionId)
      this.db.prepare("INSERT OR REPLACE INTO deleted_session (session_id, deleted_at) VALUES (?, ?)").run(row.sessionId, row.ts)
      return
    }
    if (control.type === "permission.staled") {
      this.db.prepare(
        "UPDATE pending_permission SET status = 'stale', updated_at = ? WHERE id = ? AND status = 'pending'",
      ).run(row.ts, control.permissionId)
      return
    }
    if (control.type === "question.staled") {
      this.db.prepare(
        "UPDATE pending_question SET status = 'stale', updated_at = ? WHERE id = ? AND status = 'pending'",
      ).run(row.ts, control.questionId)
      return
    }
    if (control.type === "session.recovering") {
      const session = this.getSession(row.sessionId) as { directory?: string } | null
      this.finishTools(row.sessionId, row.ts, control.message)
      this.upsertSession({
        id: row.sessionId,
        directory: session?.directory ?? "",
        createdAt: row.ts,
        updatedAt: row.ts,
        status: "recovering",
        recoveryError: control.message,
      })
      return
    }
    if (control.type === "notice.acknowledged") {
      if (control.notice === "recovery_error") {
        this.db.prepare("UPDATE session SET recovery_error = NULL, updated_at = ? WHERE id = ?").run(row.ts, row.sessionId)
      }
      return
    }
    if (control.type === "notice.created") {
      if (control.notice === "recovery_error") {
        const session = this.getSession(row.sessionId) as { directory?: string } | null
        this.upsertSession({
          id: row.sessionId,
          directory: session?.directory ?? "",
          createdAt: row.ts,
          updatedAt: row.ts,
          recoveryError: control.message,
        })
      }
      return
    }
    if (control.type === "projection.reset_requested") {
      return
    }
    if (control.type === "session.interrupted" || control.type === "process.lost") {
      this.db.prepare(
        "UPDATE pending_permission SET status = 'stale', updated_at = ? WHERE session_id = ? AND status = 'pending'",
      ).run(row.ts, row.sessionId)
      this.db.prepare(
        "UPDATE pending_question SET status = 'stale', updated_at = ? WHERE session_id = ? AND status = 'pending'",
      ).run(row.ts, row.sessionId)
      const session = this.getSession(row.sessionId) as { directory?: string } | null
      this.finishTools(row.sessionId, row.ts, control.message)
      this.upsertSession({
        id: row.sessionId,
        directory: session?.directory ?? "",
        createdAt: row.ts,
        updatedAt: row.ts,
        status: "recovering",
        recoveryError: control.message,
      })
    }
  }

  private applyEvent(row: Extract<Row, { kind: "event" }>) {
    const event = row.payload
    if (this.deleted(row.sessionId)) return
    switch (event.type) {
      case "message.updated":
        this.upsertMessage(event.properties.info as unknown as Record<string, unknown>, row.ts)
        return

      case "message.part.updated":
        this.upsertPart(event.properties.part as unknown as Record<string, unknown>, row.ts)
        return

      case "message.part.delta":
        this.delta(
          event.properties.sessionID,
          event.properties.messageID,
          event.properties.partID,
          event.properties.field,
          event.properties.delta,
          row.ts,
        )
        return

      case "todo.updated":
        this.db.prepare("DELETE FROM todo WHERE session_id = ?").run(event.properties.sessionID)
        event.properties.todos.forEach((todo, i) => {
          this.db.prepare(
            "INSERT INTO todo (session_id, position, content, status, priority, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          ).run(event.properties.sessionID, i, todo.content, todo.status, todo.priority, row.ts)
        })
        return

      case "permission.asked":
        this.db.prepare(
          `INSERT OR REPLACE INTO pending_permission
           (id, session_id, tool, patterns_json, metadata_json, always_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        ).run(
            event.properties.id,
            event.properties.sessionID,
            event.properties.permission,
            JSON.stringify(event.properties.patterns),
            JSON.stringify(event.properties.metadata),
            JSON.stringify(event.properties.always),
            row.ts,
            row.ts,
        )
        return

      case "permission.replied":
        this.db.prepare("DELETE FROM pending_permission WHERE id = ?").run(event.properties.requestID)
        return

      case "question.asked":
        this.db.prepare(
          `INSERT OR REPLACE INTO pending_question
           (id, session_id, questions_json, status, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?)`,
        ).run(event.properties.id, event.properties.sessionID, JSON.stringify(event.properties.questions), row.ts, row.ts)
        return

      case "question.replied":
      case "question.rejected":
        this.db.prepare("DELETE FROM pending_question WHERE id = ?").run(event.properties.requestID)
        return

      case "message.completed": {
        const rowInfo = this.db
          .prepare("SELECT info_json FROM message WHERE id = ?")
          .get(event.properties.messageID) as { info_json: string } | null
        if (!rowInfo) return
        const info = JSON.parse(rowInfo.info_json) as Record<string, unknown>
        info.time = { ...(rec(info.time) ?? {}), completed: row.ts }
        this.upsertMessage(info, row.ts)
        return
      }

      case "session.updated": {
        const info = event.properties.info
        this.upsertSession({
          id: info.id,
          directory: info.directory,
          title: info.title,
          createdAt: info.time.created,
          updatedAt: info.time.updated,
        })
        return
      }

      case "session.status":
        this.upsertSession({
          id: event.properties.sessionID,
          directory: (this.getSession(event.properties.sessionID) as { directory?: string } | null)?.directory ?? "",
          createdAt: row.ts,
          updatedAt: row.ts,
          status: event.properties.status.type,
        })
        return

      case "session.idle":
        this.upsertSession({
          id: event.properties.sessionID,
          directory: (this.getSession(event.properties.sessionID) as { directory?: string } | null)?.directory ?? "",
          createdAt: row.ts,
          updatedAt: row.ts,
          status: "idle",
        })
        return

      case "session.error":
        this.upsertSession({
          id: event.properties.sessionID ?? row.sessionId,
          directory: (this.getSession(event.properties.sessionID ?? row.sessionId) as { directory?: string } | null)?.directory ?? "",
          createdAt: row.ts,
          updatedAt: row.ts,
          status: "error",
        })
        return

      default:
        return
    }
  }

  private apply(row: Row) {
    if (row.kind === "control") {
      this.applyControl(row)
      return
    }
    this.applyEvent(row)
  }

  private project(row: Row) {
    this.transaction(() => {
      this.apply(row)
      this.checkpoint(row)
    })
  }

  bindSession(input: {
    sessionId: string
    directory: string
    title?: string
    agentSessionId: string
    ownerKey?: string
    createdAt?: number
  }) {
    const ts = input.createdAt ?? Date.now()
    const row: Row = {
      seq: this.next(input.sessionId),
      ts,
      sessionId: input.sessionId,
      agentSessionId: input.agentSessionId,
      kind: "control",
      control: {
        type: "session.bind",
        directory: input.directory,
        title: input.title,
        agentSessionId: input.agentSessionId,
        ...(input.ownerKey ? { ownerKey: input.ownerKey } : {}),
        createdAt: ts,
      },
    }
    this.commit(row)
  }

  private turnStartEvents(row: TurnStartRow): CompatEvent[] {
    const control = row.control
    const session = this.getSession(row.sessionId) as { directory?: string } | null
    return [
      sessionStatus(row.sessionId, { type: "busy" }),
      ...(control.userMessageId
        ? [
            messageUpdated(buildUserMessage({
              id: control.userMessageId,
              sessionID: row.sessionId,
              agent: control.agent,
              model: control.model,
              created: row.ts,
              ...(control.tools ? { tools: control.tools } : {}),
              ...(control.format ? { format: control.format } : {}),
              ...(control.system ? { system: control.system } : {}),
              ...(control.variant ? { variant: control.variant } : {}),
            })),
            ...inputParts(row.sessionId, control.userMessageId, control.parts).map(messagePartUpdated),
          ]
        : []),
      messageUpdated(buildAssistantMessage({
        id: control.assistantMessageId,
        sessionID: row.sessionId,
        parentID: control.userMessageId ?? row.sessionId,
        agent: control.agent,
        model: control.model,
        directory: session?.directory ?? "",
        created: row.ts,
      })),
    ]
  }

  startTurn(input: {
    sessionId: string
    agentSessionId?: string
    userMessageId?: string
    assistantMessageId: string
    agent: string
    model: Model
    parts: unknown[]
    tools?: Record<string, boolean>
    format?: UserMessage["format"]
    system?: string
    variant?: string
  }) {
    const row: TurnStartRow = {
      seq: this.next(input.sessionId),
      ts: Date.now(),
      sessionId: input.sessionId,
      ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
      kind: "control",
      control: {
        type: "turn.start",
        userMessageId: input.userMessageId,
        assistantMessageId: input.assistantMessageId,
        agent: input.agent,
        model: input.model,
        parts: input.parts,
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.format ? { format: input.format } : {}),
        ...(input.system ? { system: input.system } : {}),
        ...(input.variant ? { variant: input.variant } : {}),
      },
    }
    const committed = this.commit(row)
    return {
      sessionId: committed.sessionId,
      seq: committed.seq,
      createdAt: committed.ts,
      ...(committed.agentSessionId ? { agentSessionId: committed.agentSessionId } : {}),
      events: this.turnStartEvents({
        seq: committed.seq,
        ts: committed.ts,
        sessionId: committed.sessionId,
        ...(committed.agentSessionId ? { agentSessionId: committed.agentSessionId } : {}),
        kind: "control",
        control: row.control,
      }),
    } satisfies RuntimeStoreTurnStartOutput
  }

  markDirectorySessionsInterrupted(directory: string, message = ACP_RECOVER) {
    const rows = this.db
      .prepare(`
        SELECT s.id, s.agent_session_id
        FROM session s
        WHERE s.directory = ?
          AND (
            s.status = 'busy'
            OR EXISTS (
              SELECT 1 FROM pending_permission p
              WHERE p.session_id = s.id AND p.status = 'pending'
            )
            OR EXISTS (
              SELECT 1 FROM pending_question q
              WHERE q.session_id = s.id AND q.status = 'pending'
            )
          )
      `)
      .all(directory) as Array<{ id: string; agent_session_id: string | null }>
    for (const row of rows) {
      this.markSessionInterrupted(row.id, message, row.agent_session_id)
    }
  }

  markSessionsInterruptedByOwner(ownerKey: string, message = ACP_RECOVER) {
    const rows = this.db
      .prepare(`
        SELECT s.id, s.agent_session_id
        FROM session s
        WHERE s.process_key = ?
          AND (
            s.status = 'busy'
            OR EXISTS (
              SELECT 1 FROM pending_permission p
              WHERE p.session_id = s.id AND p.status = 'pending'
            )
            OR EXISTS (
              SELECT 1 FROM pending_question q
              WHERE q.session_id = s.id AND q.status = 'pending'
            )
          )
      `)
      .all(ownerKey) as Array<{ id: string; agent_session_id: string | null }>
    for (const row of rows) {
      this.markSessionInterrupted(row.id, message, row.agent_session_id)
    }
  }

  markSessionInterrupted(sessionId: string, message = ACP_RECOVER, agentSessionId?: string | null) {
    const agent =
      agentSessionId !== undefined
        ? agentSessionId
        : ((this.db
          .prepare("SELECT agent_session_id FROM session WHERE id = ?")
          .get(sessionId) as { agent_session_id: string | null } | null)?.agent_session_id ?? null)
    const item: Row = {
      seq: this.next(sessionId),
      ts: Date.now(),
      sessionId,
      ...(agent ? { agentSessionId: agent } : {}),
      kind: "control",
      control: {
        type: "session.interrupted",
        message,
      },
    }
    this.commit(item)
  }

  appendEvent(input: {
    sessionId: string
    agentSessionId?: string
    payload: CompatEvent
    source?: {
      dir: "in" | "out"
      method: string
      requestId?: string
      frame?: unknown
    }
  }) {
    const row: Row = {
      seq: this.next(input.sessionId),
      ts: Date.now(),
      sessionId: input.sessionId,
      ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
      kind: "event",
      payload: input.payload,
      ...(input.source ? { source: input.source } : {}),
    }
    const committed = this.commit(row)
    if (committed.kind !== "event") throw new Error("Expected event journal row")
    return {
      sessionId: committed.sessionId,
      seq: committed.seq,
      createdAt: committed.ts,
      ...(committed.agentSessionId ? { agentSessionId: committed.agentSessionId } : {}),
      payload: committed.payload,
      ...(committed.source ? { source: committed.source } : {}),
    } satisfies RuntimeStoreAppendOutput
  }

  finishTurn(input: {
    sessionId: string
    assistantMessageId?: string
    outcome: { status: "completed" | "failed" | "cancelled"; completedAt?: number; error?: string; reason?: string }
  }) {
    const active = this.db
      .prepare(`
        SELECT provider_session_id, user_message_id, assistant_message_id, payload_json, created_at
        FROM runtime_journal
        WHERE session_id = ? AND kind = 'control' AND type = 'turn.start'
        ORDER BY seq DESC
        LIMIT 1
      `)
      .get(input.sessionId) as {
        provider_session_id: string | null
        user_message_id: string | null
        assistant_message_id: string | null
        payload_json: string
        created_at: number
      } | null
    if (!active?.assistant_message_id) return
    if (input.assistantMessageId && input.assistantMessageId !== active.assistant_message_id) return

    if (input.outcome.status === "failed") {
      const control = JSON.parse(active.payload_json) as Partial<Turn>
      const session = this.getSession(input.sessionId) as { directory?: string } | null
      this.appendEvent({
        sessionId: input.sessionId,
        ...(active.provider_session_id ? { agentSessionId: active.provider_session_id } : {}),
        payload: messageUpdated(buildAssistantMessage({
          id: active.assistant_message_id,
          sessionID: input.sessionId,
          parentID: active.user_message_id ?? input.sessionId,
          agent: control.agent ?? "build",
          model: control.model ?? { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
          directory: session?.directory ?? "",
          created: active.created_at,
          completed: input.outcome.completedAt ?? Date.now(),
          error: { name: "UnknownError", data: firstTurnErrorData(input.outcome.error ?? "turn failed") },
          ...(control.variant ? { variant: control.variant } : {}),
        })),
      })
      this.appendEvent({
        sessionId: input.sessionId,
        ...(active.provider_session_id ? { agentSessionId: active.provider_session_id } : {}),
        payload: sessionError(input.outcome.error ?? "turn failed", input.sessionId),
      })
      return
    }

    if (this.hasMessageCompleted(input.sessionId, active.assistant_message_id)) return

    this.appendEvent({
      sessionId: input.sessionId,
      ...(active.provider_session_id ? { agentSessionId: active.provider_session_id } : {}),
      payload: messageCompleted(input.sessionId, active.assistant_message_id),
    })
    this.appendEvent({
      sessionId: input.sessionId,
      ...(active.provider_session_id ? { agentSessionId: active.provider_session_id } : {}),
      payload: sessionIdle(input.sessionId),
    })
  }

  private hasMessageCompleted(sessionId: string, messageId: string) {
    return !!this.db
      .prepare(`
        SELECT 1
        FROM runtime_journal
        WHERE session_id = ?
          AND kind = 'event'
          AND type = 'message.completed'
          AND json_extract(payload_json, '$.properties.messageID') = ?
        LIMIT 1
      `)
      .get(sessionId, messageId)
  }

  private session(row: {
    id: string
    directory: string
    title: string | null
    harness_id?: string | null
    harness_access?: string | null
    harness_binary?: string | null
    harness_transport?: string | null
    harness_url?: string | null
    harness_headers_json?: string | null
    model_provider_id?: string | null
    model_id?: string | null
    variant?: string | null
    agent?: string | null
    process_key?: string | null
    created_at: number
    updated_at: number
    archived_at?: number | null
    status?: string | null
    recovery_error?: string | null
    agent_session_id?: string | null
  }) {
    const harness = sessionHarness(row)
    return {
      id: row.id,
      title: row.title,
      directory: row.directory,
      time: {
        created: row.created_at,
        updated: row.updated_at,
        ...(row.archived_at !== undefined && row.archived_at !== null ? { archived: row.archived_at } : {}),
      },
      ...(harness
        ? {
            config: {
              harness,
              ...(row.model_provider_id && row.model_id
                ? { model: { providerID: row.model_provider_id, modelID: row.model_id } }
                : {}),
              variant: row.variant ?? null,
              agent: row.agent ?? null,
            },
          }
        : {}),
      ...(row.status ? { status: row.status } : {}),
      ...(row.recovery_error ? { recovery_error: row.recovery_error } : {}),
      ...(row.agent_session_id ? { agent_session_id: row.agent_session_id } : {}),
      ...(row.process_key ? { process_key: row.process_key } : {}),
      ...(this.lastTurn(row.id) ? { lastTurn: this.lastTurn(row.id) } : {}),
    }
  }

  private lastTurn(sessionId: string) {
    const row = this.db
      .prepare(`
        SELECT seq, type, created_at, payload_json
        FROM runtime_journal
        WHERE session_id = ?
          AND kind = 'event'
          AND type IN ('message.completed', 'session.error')
        ORDER BY seq DESC
        LIMIT 1
      `)
      .get(sessionId) as { seq: number; type: string; created_at: number; payload_json: string } | null
    if (!row) return
    const payload = JSON.parse(row.payload_json) as { properties?: Record<string, unknown> }
    if (row.type === "message.completed") {
      const assistantMessageId = typeof payload.properties?.messageID === "string" ? payload.properties.messageID : undefined
      if (!assistantMessageId) return
      return {
        status: "completed" as const,
        assistantMessageId,
        completedAt: row.created_at,
      }
    }
    const error = payload.properties?.error
    const message = error && typeof error === "object" && "data" in error
      ? (error.data as { message?: unknown }).message
      : undefined
    return {
      status: "failed" as const,
      assistantMessageId: this.lastStartedAssistant(sessionId, row.seq),
      completedAt: row.created_at,
      error: typeof message === "string" ? message : "session error",
    }
  }

  private lastStartedAssistant(sessionId: string, beforeSeq: number) {
    const row = this.db
      .prepare(`
        SELECT assistant_message_id
        FROM runtime_journal
        WHERE session_id = ?
          AND kind = 'control'
          AND type = 'turn.start'
          AND seq < ?
        ORDER BY seq DESC
        LIMIT 1
      `)
      .get(sessionId, beforeSeq) as { assistant_message_id: string | null } | null
    return row?.assistant_message_id ?? undefined
  }

  listSessions(directory: string) {
    return (this.db
      .prepare(`
        SELECT
          id,
          directory,
	          title,
	          agent_session_id,
	          process_key,
	          harness_id,
	          harness_access,
	          harness_binary,
	          harness_transport,
	          harness_url,
	          harness_headers_json,
          model_provider_id,
          model_id,
          variant,
          agent,
          created_at,
          updated_at,
          status,
          recovery_error,
          archived_at
        FROM session
        WHERE directory = ?
        ORDER BY created_at DESC
      `)
      .all(directory) as Array<{
      id: string
      directory: string
      title: string | null
      agent_session_id: string | null
      process_key: string | null
      harness_id: string | null
      harness_access: string | null
      harness_binary: string | null
      harness_transport: string | null
      harness_url: string | null
      harness_headers_json: string | null
      model_provider_id: string | null
      model_id: string | null
      variant: string | null
      agent: string | null
      created_at: number
      updated_at: number
      status: string | null
      recovery_error: string | null
      archived_at: number | null
    }>).map((row) => this.session(row))
  }

  stalePermission(id: string) {
    const row = this.db
      .prepare("SELECT session_id FROM pending_permission WHERE id = ?")
      .get(id) as { session_id: string } | null
    if (!row) return
    this.commit({
      seq: this.next(row.session_id),
      ts: Date.now(),
      sessionId: row.session_id,
      kind: "control",
      control: {
        type: "permission.staled",
        permissionId: id,
      },
    })
  }

  staleQuestion(id: string) {
    const row = this.db
      .prepare("SELECT session_id FROM pending_question WHERE id = ?")
      .get(id) as { session_id: string } | null
    if (!row) return
    this.commit({
      seq: this.next(row.session_id),
      ts: Date.now(),
      sessionId: row.session_id,
      kind: "control",
      control: {
        type: "question.staled",
        questionId: id,
      },
    })
  }

  markRecovering(sessionId: string, message = ACP_RECOVER) {
    this.commit({
      seq: this.next(sessionId),
      ts: Date.now(),
      sessionId,
      kind: "control",
      control: {
        type: "session.recovering",
        message,
      },
    })
  }

  createNotice(sessionId: string, input: { notice: "recovery_error"; message: string }) {
    this.commit({
      seq: this.next(sessionId),
      ts: Date.now(),
      sessionId,
      kind: "control",
      control: {
        type: "notice.created",
        notice: input.notice,
        message: input.message,
      },
    })
  }

  requestProjectionReset(sessionId: string, reason?: string) {
    this.commit({
      seq: this.next(sessionId),
      ts: Date.now(),
      sessionId,
      kind: "control",
      control: {
        type: "projection.reset_requested",
        ...(reason ? { reason } : {}),
      },
    })
  }

  getSession(id: string) {
    const row = this.db
      .prepare(`
        SELECT
          id,
          directory,
	          title,
	          process_key,
	          harness_id,
	          harness_access,
	          harness_binary,
	          harness_transport,
	          harness_url,
	          harness_headers_json,
          model_provider_id,
          model_id,
          variant,
          agent,
          created_at,
          updated_at,
          status,
          recovery_error,
          archived_at,
          agent_session_id
        FROM session
        WHERE id = ?
      `)
      .get(id) as {
      id: string
      directory: string
      title: string | null
      harness_id: string | null
      harness_access: string | null
      harness_binary: string | null
      harness_transport: string | null
      harness_url: string | null
      harness_headers_json: string | null
      model_provider_id: string | null
      model_id: string | null
      variant: string | null
      agent: string | null
      created_at: number
      updated_at: number
      status: string | null
      recovery_error: string | null
      archived_at: number | null
      process_key: string | null
      agent_session_id: string | null
    } | null
    if (!row) return null
    return this.session(row)
  }

  getAgentSessionId(id: string) {
    const row = this.db
      .prepare("SELECT agent_session_id FROM session WHERE id = ?")
      .get(id) as { agent_session_id: string | null } | null
    return row?.agent_session_id ?? null
  }

  getSessionOwnerKey(id: string) {
    const row = this.db
      .prepare("SELECT process_key FROM session WHERE id = ?")
      .get(id) as { process_key: string | null } | null
    return row?.process_key ?? null
  }

  listSessionsByOwnerKey(ownerKey: string) {
    return (this.db
      .prepare("SELECT id FROM session WHERE process_key = ? ORDER BY created_at ASC")
      .all(ownerKey) as Array<{ id: string }>).map((row) => row.id)
  }

  getSessionByAgent(agentSessionId: string) {
    const row = this.db
      .prepare("SELECT session_id FROM session_map WHERE agent_session_id = ?")
      .get(agentSessionId) as { session_id: string } | null
    return row?.session_id ?? null
  }

  listPermissions(directory: string) {
    return this.db
      .prepare(`
        SELECT p.id, p.session_id, p.tool, p.patterns_json
        FROM pending_permission p
        JOIN session s ON s.id = p.session_id
        WHERE s.directory = ? AND p.status = 'pending'
        ORDER BY p.created_at ASC
      `)
      .all(directory)
      .map((row: any) => {
        const item = row as { id: string; session_id: string; tool: string; patterns_json: string }
        return {
          id: item.id,
          sessionID: item.session_id,
          tool: item.tool,
          paths: JSON.parse(item.patterns_json) as string[],
        }
      })
  }

  listQuestions(directory: string) {
    return this.db
      .prepare(`
        SELECT q.id, q.session_id, q.questions_json
        FROM pending_question q
        JOIN session s ON s.id = q.session_id
        WHERE s.directory = ? AND q.status = 'pending'
        ORDER BY q.created_at ASC
      `)
      .all(directory)
      .map((row: any) => {
        const item = row as { id: string; session_id: string; questions_json: string }
        return {
          id: item.id,
          sessionID: item.session_id,
          questions: JSON.parse(item.questions_json) as unknown[],
        }
      })
  }

  getTodos(sessionId: string) {
    return this.db
      .prepare("SELECT content, status, priority FROM todo WHERE session_id = ? ORDER BY position ASC")
      .all(sessionId) as Array<{ content: string; status: string; priority: string }>
  }

  getMessages(sessionId: string): AgentMessageRow[] {
    const msgs = this.db
      .prepare("SELECT id, info_json FROM message WHERE session_id = ? ORDER BY ord ASC")
      .all(sessionId) as Array<{ id: string; info_json: string }>
    return msgs.map((msg) => {
      const info = JSON.parse(msg.info_json) as AgentMessageRow["info"]
      const infoRecord = info as Record<string, unknown>
      const time = rec(info.time)
      const completed = typeof time?.completed === "number"
      const err = rec(infoRecord.error)
      const data = rec(err?.data)
      const message = str(data?.message) ?? str(err?.message)
      const terminal = info.role === "assistant" && (completed || !!infoRecord.error)
      const ts = num(time?.completed) ?? num(time?.created) ?? Date.now()
      const parts = (this.db
        .prepare("SELECT data_json FROM part WHERE message_id = ? ORDER BY ord ASC")
        .all(msg.id) as Array<{ data_json: string }>).map((part) => {
          const parsed = JSON.parse(part.data_json) as Record<string, unknown>
          return terminal ? this.terminalizedPart(parsed, ts, message) : parsed
        })
      return { info, parts }
    })
  }

  getSessionMaxSeq(sessionId: string) {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM runtime_journal WHERE session_id = ?")
      .get(sessionId) as { seq: number }
    return row.seq
  }

  deleteSession(id: string) {
    if (!this.getSession(id)) return
    this.commit({
      seq: this.next(id),
      ts: Date.now(),
      sessionId: id,
      kind: "control",
      control: {
        type: "session.delete",
      },
    })
  }

  updateSession(id: string, updates: { title?: string; time?: { archived?: number } }) {
    if (!this.getSession(id)) return null
    this.commit({
      seq: this.next(id),
      ts: Date.now(),
      sessionId: id,
      kind: "control",
      control: {
        type: "session.update",
        updates,
      },
    })
    return this.getSession(id)
  }

  consumeRecoveryError(id: string) {
    const row = this.db
      .prepare("SELECT recovery_error FROM session WHERE id = ?")
      .get(id) as { recovery_error: string | null } | null
    const msg = row?.recovery_error ?? null
    if (msg) {
      this.commit({
        seq: this.next(id),
        ts: Date.now(),
        sessionId: id,
        kind: "control",
        control: {
          type: "notice.acknowledged",
          notice: "recovery_error",
        },
      })
    }
    return msg
  }

  getSessionConfig(id: string): SessionConfig | null {
    const row = this.db
      .prepare(`
	        SELECT
	          harness_id,
	          harness_access,
	          harness_binary,
	          harness_transport,
	          harness_url,
	          harness_headers_json,
          model_provider_id,
          model_id,
          variant,
          agent
        FROM session
        WHERE id = ?
      `)
	      .get(id) as {
	      harness_id: string | null
	      harness_access: string | null
	      harness_binary: string | null
	      harness_transport: string | null
	      harness_url: string | null
	      harness_headers_json: string | null
      model_provider_id: string | null
      model_id: string | null
      variant: string | null
      agent: string | null
    } | null
	    if (!row) return null
	    const harness = sessionHarness(row)
	    if (!harness) return null
	    return {
	      harness,
      ...(row.model_provider_id && row.model_id
        ? { model: { providerID: row.model_provider_id, modelID: row.model_id } }
        : {}),
      variant: nullable(row.variant) ?? null,
      agent: nullable(row.agent) ?? null,
    }
  }

  private applyConfigUpdate(id: string, update: SessionConfigUpdate, ts = Date.now(), directory?: string) {
    const patch = sessionConfigPatch(update)
    const prev = this.db
      .prepare(`
	        SELECT
	          directory,
	          harness_id,
	          harness_access,
	          harness_binary,
	          harness_transport,
	          harness_url,
	          harness_headers_json,
          model_provider_id,
          model_id,
          variant,
          agent
        FROM session
        WHERE id = ?
      `)
	      .get(id) as {
	      directory: string | null
	      harness_id: string | null
	      harness_access: string | null
	      harness_binary: string | null
	      harness_transport: string | null
	      harness_url: string | null
	      harness_headers_json: string | null
      model_provider_id: string | null
      model_id: string | null
      variant: string | null
      agent: string | null
    } | null
	    const prevHarness = prev ? sessionHarness(prev) : undefined
	    if (!prevHarness && !patch.harness) return
	    if (!prev) {
	      this.upsertSession({
	        id,
	        directory: directory ?? "",
	        harness: patch.harness,
        model: patch.model ?? undefined,
        variant: patch.variant ?? null,
        agent: patch.agent ?? null,
        createdAt: ts,
        updatedAt: ts,
      })
      return
	    }
	    const nextHarness = patch.harness ?? prevHarness
	    const nextModelId = patch.model === undefined ? prev?.model_id ?? null : patch.model?.modelID ?? null
	    this.db.prepare(`
	      UPDATE session
	      SET harness_id = ?, harness_access = ?, harness_binary = ?, harness_transport = ?, harness_url = ?, harness_headers_json = ?, model_provider_id = ?, model_id = ?, variant = ?, agent = ?, updated_at = ?
	      WHERE id = ?
	    `).run(
	      nextHarness?.id ?? null,
	      nextHarness?.access ?? null,
	      harnessProcess(nextHarness)?.binary ?? null,
	      harnessRemote(nextHarness)?.transport ?? null,
	      harnessRemote(nextHarness)?.url ?? null,
	      harnessHeadersJson(nextHarness),
      patch.model === undefined ? prev?.model_provider_id ?? null : patch.model?.providerID ?? null,
      nextModelId,
      patch.variant === undefined ? prev?.variant ?? null : patch.variant,
      patch.agent === undefined ? prev?.agent ?? null : patch.agent,
      ts,
      id,
    )
  }

  updateSessionConfig(id: string, update: SessionConfigUpdate, input: { directory?: string } = {}) {
    const row: Row = {
      seq: this.next(id),
      ts: Date.now(),
      sessionId: id,
      kind: "control",
      control: {
        type: "config.update",
        patch: update,
        ...(input.directory ? { directory: input.directory } : {}),
      },
    }
    this.commit(row)
    return this.getSessionConfig(id)
  }
}
