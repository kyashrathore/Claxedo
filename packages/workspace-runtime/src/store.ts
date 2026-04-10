import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import type { SessionConfig, SessionConfigPatch, SessionRunner } from "./adapters"
import { ACP_RECOVER } from "./adapters/acp-recovery"
import {
  type CompatEvent,
  buildAssistantMessage,
  buildUserMessage,
} from "./compat-events"

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

type Lost = {
  type: "process.lost"
  message: string
}

type ConfigUpdate = {
  type: "config.update"
  patch: SessionConfigPatch
}

type Control = Bind | Turn | Lost | ConfigUpdate

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
  private db: InstanceType<typeof Database>
  private seqs = new Map<string, number>()

  constructor(root = path.join(os.homedir(), ".claxedo", "workspace-runtime")) {
    this.root = root
    this.sessions = path.join(root, "sessions")
    fs.mkdirSync(this.sessions, { recursive: true, mode: 0o755 })
    this.db = new Database(path.join(root, "state.db"))
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = NORMAL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.migrate()
    this.replay()
    this.normalizeRecoveringTools()
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        title TEXT,
        agent_session_id TEXT,
        runner_type TEXT,
        runner_binary TEXT,
        runner_model TEXT,
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
    // Migration: add archived_at column for existing databases
    try {
      this.db.exec("ALTER TABLE session ADD COLUMN archived_at INTEGER")
    } catch {
      // column already exists
    }
    for (const sql of [
      "ALTER TABLE session ADD COLUMN runner_type TEXT",
      "ALTER TABLE session ADD COLUMN runner_binary TEXT",
      "ALTER TABLE session ADD COLUMN runner_model TEXT",
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
  }

  private reset() {
    this.db.exec("DELETE FROM journal_checkpoint")
    this.db.exec("DELETE FROM pending_question")
    this.db.exec("DELETE FROM pending_permission")
    this.db.exec("DELETE FROM todo")
    this.db.exec("DELETE FROM part")
    this.db.exec("DELETE FROM message")
    this.db.exec("DELETE FROM session_map")
    this.db.exec("DELETE FROM session")
  }

  private replay() {
    this.reset()
    this.seqs.clear()
    const names = fs.existsSync(this.sessions)
      ? fs.readdirSync(this.sessions).filter((name) => name.endsWith(".jsonl")).sort()
      : []
    for (const name of names) {
      const sessionId = name.slice(0, -6)
      const text = fs.readFileSync(path.join(this.sessions, name), "utf8")
      const rows = text.split("\n").filter(Boolean)
      let last = 0
      for (const line of rows) {
        const row = parse(line)
        if (!row) continue
        this.apply(row)
        last = row.seq
      }
      this.seqs.set(sessionId, last)
      this.db.prepare(
        "INSERT OR REPLACE INTO journal_checkpoint (session_id, last_seq, updated_at) VALUES (?, ?, ?)",
      ).run(sessionId, last, Date.now())
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

  private normalizeRecoveringTools() {
    const rows = this.db
      .prepare("SELECT id, updated_at, recovery_error FROM session WHERE status = 'recovering'")
      .all() as Array<{ id: string; updated_at: number; recovery_error: string | null }>
    for (const row of rows) {
      this.finishTools(row.id, row.updated_at, row.recovery_error ?? undefined)
    }
  }

  private journal(sessionId: string) {
    return path.join(this.sessions, `${sessionId}.jsonl`)
  }

  private next(sessionId: string) {
    const seq = (this.seqs.get(sessionId) ?? 0) + 1
    this.seqs.set(sessionId, seq)
    return seq
  }

  private write(row: Row) {
    fs.appendFileSync(this.journal(row.sessionId), JSON.stringify(row) + "\n")
    this.db.prepare(
      "INSERT OR REPLACE INTO journal_checkpoint (session_id, last_seq, updated_at) VALUES (?, ?, ?)",
    ).run(row.sessionId, row.seq, row.ts)
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
    runner?: SessionRunner
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
          runner_type,
          runner_binary,
          runner_model,
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
      runner_type: string | null
      runner_binary: string | null
      runner_model: string | null
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
        runner_type,
        runner_binary,
        runner_model,
        model_provider_id,
        model_id,
        variant,
        agent,
        created_at,
        updated_at,
        status,
        recovery_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        input.id,
        input.directory,
        input.title ?? prev?.title ?? null,
        input.agentSessionId ?? prev?.agent_session_id ?? null,
        input.runner?.type ?? prev?.runner_type ?? null,
        input.runner?.binary ?? prev?.runner_binary ?? null,
        input.runner?.model ?? prev?.runner_model ?? null,
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

  private applyControl(row: Extract<Row, { kind: "control" }>) {
    const control = row.control
    if (control.type === "session.bind") {
      this.upsertSession({
        id: row.sessionId,
        directory: control.directory,
        title: control.title,
        agentSessionId: control.agentSessionId,
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
      this.applyConfigUpdate(row.sessionId, control.patch)
      return
    }
    if (control.type === "process.lost") {
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
      case "session.todo":
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

  bindSession(input: {
    sessionId: string
    directory: string
    title?: string
    agentSessionId: string
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
        createdAt: ts,
      },
    }
    this.apply(row)
    this.write(row)
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
    const row: Row = {
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
    this.apply(row)
    this.write(row)
  }

  processLost(directory: string, message = ACP_RECOVER) {
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
      this.processLostSession(row.id, message, row.agent_session_id)
    }
  }

  processLostSession(sessionId: string, message = ACP_RECOVER, agentSessionId?: string | null) {
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
        type: "process.lost",
        message,
      },
    }
    this.apply(item)
    this.write(item)
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
    this.apply(row)
    this.write(row)
  }

  private session(row: {
    id: string
    directory: string
    title: string | null
    runner_type?: string | null
    runner_binary?: string | null
    runner_model?: string | null
    model_provider_id?: string | null
    model_id?: string | null
    variant?: string | null
    agent?: string | null
    created_at: number
    updated_at: number
    archived_at?: number | null
    status?: string | null
    recovery_error?: string | null
    agent_session_id?: string | null
  }) {
    return {
      id: row.id,
      title: row.title,
      directory: row.directory,
      time: {
        created: row.created_at,
        updated: row.updated_at,
        ...(row.archived_at !== undefined && row.archived_at !== null ? { archived: row.archived_at } : {}),
      },
      ...(row.runner_type
        ? {
            config: {
              runner: {
                type: row.runner_type,
                ...(row.runner_binary ? { binary: row.runner_binary } : {}),
                ...(row.runner_model ? { model: row.runner_model } : {}),
              },
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
    }
  }

  listSessions(directory: string) {
    return (this.db
      .prepare(`
        SELECT
          id,
          directory,
          title,
          agent_session_id,
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
      created_at: number
      updated_at: number
      status: string | null
      recovery_error: string | null
      archived_at: number | null
    }>).map((row) => this.session(row))
  }

  stalePermission(id: string) {
    this.db.prepare("UPDATE pending_permission SET status = 'stale', updated_at = ? WHERE id = ?").run(Date.now(), id)
  }

  markRecovering(sessionId: string, message = ACP_RECOVER) {
    const session = this.getSession(sessionId) as { directory?: string } | null
    this.upsertSession({
      id: sessionId,
      directory: session?.directory ?? "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "recovering",
      recoveryError: message,
    })
  }

  getSession(id: string) {
    const row = this.db
      .prepare(`
        SELECT
          id,
          directory,
          title,
          runner_type,
          runner_binary,
          runner_model,
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
      runner_type: string | null
      runner_binary: string | null
      runner_model: string | null
      model_provider_id: string | null
      model_id: string | null
      variant: string | null
      agent: string | null
      created_at: number
      updated_at: number
      status: string | null
      recovery_error: string | null
      archived_at: number | null
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

  getTodos(sessionId: string) {
    return this.db
      .prepare("SELECT content, status, priority FROM todo WHERE session_id = ? ORDER BY position ASC")
      .all(sessionId) as Array<{ content: string; status: string; priority: string }>
  }

  getMessages(sessionId: string) {
    const msgs = this.db
      .prepare("SELECT id, info_json FROM message WHERE session_id = ? ORDER BY ord ASC")
      .all(sessionId) as Array<{ id: string; info_json: string }>
    return msgs.map((msg) => ({
      info: JSON.parse(msg.info_json),
      parts: (this.db
        .prepare("SELECT data_json FROM part WHERE message_id = ? ORDER BY ord ASC")
        .all(msg.id) as Array<{ data_json: string }>).map((part) => JSON.parse(part.data_json)),
    }))
  }

  deleteSession(id: string) {
    this.db.prepare("DELETE FROM journal_checkpoint WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM pending_question WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM pending_permission WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM todo WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM part WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM message WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM session_map WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM session WHERE id = ?").run(id)
    this.seqs.delete(id)
    try {
      fs.rmSync(this.journal(id), { force: true })
    } catch {}
  }

  updateSession(id: string, updates: { title?: string; time?: { archived?: number } }) {
    const prev = this.db
      .prepare("SELECT id, directory, title, created_at, updated_at, archived_at FROM session WHERE id = ?")
      .get(id) as { id: string; directory: string; title: string | null; created_at: number; updated_at: number; archived_at: number | null } | null
    if (!prev) return null
    const now = Date.now()
    if (updates.title !== undefined) {
      this.db.prepare("UPDATE session SET title = ?, updated_at = ? WHERE id = ?").run(updates.title, now, id)
    }
    if (updates.time?.archived !== undefined) {
      this.db.prepare("UPDATE session SET archived_at = ?, updated_at = ? WHERE id = ?").run(updates.time.archived, now, id)
    }
    return this.getSession(id)
  }

  consumeRecoveryError(id: string) {
    const row = this.db
      .prepare("SELECT recovery_error FROM session WHERE id = ?")
      .get(id) as { recovery_error: string | null } | null
    const msg = row?.recovery_error ?? null
    if (msg) {
      this.db.prepare("UPDATE session SET recovery_error = NULL WHERE id = ?").run(id)
    }
    return msg
  }

  getSessionConfig(id: string): SessionConfig | null {
    const row = this.db
      .prepare(`
        SELECT
          runner_type,
          runner_binary,
          runner_model,
          model_provider_id,
          model_id,
          variant,
          agent
        FROM session
        WHERE id = ?
      `)
      .get(id) as {
      runner_type: string | null
      runner_binary: string | null
      runner_model: string | null
      model_provider_id: string | null
      model_id: string | null
      variant: string | null
      agent: string | null
    } | null
    if (!row?.runner_type) return null
    return {
      runner: {
        type: row.runner_type as SessionRunner["type"],
        ...(row.runner_binary ? { binary: row.runner_binary } : {}),
        ...(row.runner_model ? { model: row.runner_model } : {}),
      },
      ...(row.model_provider_id && row.model_id
        ? { model: { providerID: row.model_provider_id, modelID: row.model_id } }
        : {}),
      variant: nullable(row.variant) ?? null,
      agent: nullable(row.agent) ?? null,
    }
  }

  private applyConfigUpdate(id: string, patch: SessionConfigPatch) {
    const prev = this.db
      .prepare(`
        SELECT
          runner_type,
          runner_binary,
          runner_model,
          model_provider_id,
          model_id,
          variant,
          agent
        FROM session
        WHERE id = ?
      `)
      .get(id) as {
      runner_type: string | null
      runner_binary: string | null
      runner_model: string | null
      model_provider_id: string | null
      model_id: string | null
      variant: string | null
      agent: string | null
    } | null
    if (!prev?.runner_type && !patch.runner?.type) return
    this.db.prepare(`
      UPDATE session
      SET runner_type = ?, runner_binary = ?, runner_model = ?, model_provider_id = ?, model_id = ?, variant = ?, agent = ?, updated_at = ?
      WHERE id = ?
    `).run(
      patch.runner?.type ?? prev?.runner_type ?? null,
      patch.runner?.binary ?? prev?.runner_binary ?? null,
      patch.runner?.model ?? prev?.runner_model ?? null,
      patch.model === undefined ? prev?.model_provider_id ?? null : patch.model?.providerID ?? null,
      patch.model === undefined ? prev?.model_id ?? null : patch.model?.modelID ?? null,
      patch.variant === undefined ? prev?.variant ?? null : patch.variant,
      patch.agent === undefined ? prev?.agent ?? null : patch.agent,
      Date.now(),
      id,
    )
  }

  updateSessionConfig(id: string, patch: SessionConfigPatch) {
    const row: Row = {
      seq: this.next(id),
      ts: Date.now(),
      sessionId: id,
      kind: "control",
      control: {
        type: "config.update",
        patch,
      },
    }
    this.apply(row)
    this.write(row)
    return this.getSessionConfig(id)
  }
}
