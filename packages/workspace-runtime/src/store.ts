import { randomBytes } from "crypto"
import fs from "fs"
import { createRequire } from "module"
import path from "path"
import { escapeRegExp } from "@claxedo/helpers/string"
import {
  ACP_RECOVER,
  AgentRuntimeStaleTurnError,
  AgentMessagePageError,
  type AgentMessagePage,
  type AgentMessagePageInput,
} from "@claxedo/agent-sdk-runtime/adapters"
import {
  LATEST_SURFACE_MAX_INFO_BYTES,
  LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES,
  LATEST_SURFACE_MAX_PART_BYTES,
  LATEST_SURFACE_MAX_TEXT_PART_BYTES,
  selectLatestSurfaceTextCandidateIndexes,
} from "@claxedo/agent-sdk-runtime/message-page"
import {
  createMemorySubagentAdmissionStore,
  firstTurnErrorData,
  normalizeHarnessIdentity,
  parseStoredSessionModelGroup,
  sessionModelGroupJson,
} from "@claxedo/agent-sdk-runtime"
import type {
  AdmittedSubagentObservation,
  AgentMessage,
  AgentMessageAuthor,
  AgentPermission,
  AgentQuestion,
  AgentTurnOutcome,
  PromptFormat,
  PromptInput,
  SessionConfig,
  SessionConfigUpdate,
  SessionHarness,
  SessionModelGroup,
  SubagentObservation,
} from "@claxedo/agent-sdk-runtime"
import type { AgentExecutionBinding } from "@claxedo/agent-runtime-contract"
import type { RuntimeGoalSnapshot, SubagentUpdatedEvent } from "@claxedo/agent-event-runtime"
import { asRecord } from "@claxedo/helpers/guards"
import {
  type CompatEvent,
  buildAssistantMessage,
  buildUserPromptParts,
  buildUserMessage,
  messageCompleted,
  messagePartUpdated,
  messageUpdated,
  sessionError,
  sessionIdle,
  sessionStatus,
} from "./compat-events"
import { workspaceRuntimeStoreDir } from "./env"
import { isRecord, num, rec, str } from "./json-value"

type Model = {
  providerID: string
  modelID: string
}

type SessionModel = SessionConfig["model"]

type Bind = {
  type: "session.bind"
  workspaceId?: string
  directory: string
  connectionId?: string
  upstreamSessionId?: string
  title?: string
  agentSessionId: string
  ownerKey?: string | null
  parentSessionId?: string
  processKey?: string | null
  createdAt: number
  updatedAt?: number
}

type Turn = {
  type: "turn.start"
  userMessageId?: string
  parentMessageId?: string
  assistantMessageId: string
  agent: string
  model: Model
  parts: unknown[]
  tools?: Record<string, boolean>
  format?: PromptFormat
  system?: string
  variant?: string
  actorId?: string
  actorKind?: "human" | "agent"
  fencingToken?: number
  author?: {
    id: string
    name: string
    avatarUrl?: string
    kind: "human" | "agent"
  }
}

type TurnFinish = {
  type: "turn.finish"
  assistantMessageId: string
  outcome: AgentTurnOutcome
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
  | TurnFinish
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
  | { type: "goal.update"; goal: RuntimeGoalSnapshot | null }

/** What both `bun:sqlite` and `better-sqlite3` return from a write statement. */
type SqliteRunResult = {
  changes?: number
  lastInsertRowid?: number | bigint
}

/**
 * A prepared statement over rows of a single declared shape.
 *
 * `Row` is the column list this store's SQL selects, declared once at
 * `db.prepare<Row>(sql)` instead of re-asserted at every read. `get` widens to
 * `null | undefined` because the two drivers disagree on the empty result:
 * `bun:sqlite` yields `null`, `better-sqlite3` yields `undefined`.
 */
type SqliteStatement<Row> = {
  run(...params: unknown[]): SqliteRunResult
  get(...params: unknown[]): Row | null | undefined
  all(...params: unknown[]): Row[]
  finalize?: () => unknown
}

type SqliteDatabase = {
  exec(sql: string): unknown
  prepare<Row = unknown>(sql: string): SqliteStatement<Row>
  close?: (throwOnError?: boolean) => unknown
}

/** The constructor shape both SQLite drivers expose. */
type SqliteDatabaseConstructor = new (file: string) => SqliteDatabase

/**
 * A row the schema guarantees exists (a `SELECT` on a row this statement just
 * wrote, or on a `PRIMARY KEY` the caller already resolved). A miss is a store
 * bug, so it fails with the query's name rather than a property access on null.
 */
function requireRow<Row>(row: Row | null | undefined, what: string): Row {
  if (row === null || row === undefined) throw new Error(`missing ${what} row`)
  return row
}

/** Where a journaled event came from on the wire, as `source_json` stores it. */
export type RuntimeEventSource = {
  dir: "in" | "out"
  method: string
  requestId?: string
  frame?: unknown
}

export type RuntimeStoreAppendOutput = {
  sessionId: string
  seq: number
  createdAt: number
  agentSessionId?: string
  payload: CompatEvent
  source?: RuntimeEventSource
}

export type RuntimeStoreTurnStartOutput = {
  sessionId: string
  seq: number
  createdAt: number
  agentSessionId?: string
  events: CompatEvent[]
}

/**
 * A prompt admitted for a session that was already running a turn, waiting for
 * that turn to end.
 *
 * The waiting itself happens in the request that submitted the prompt, so this
 * row is the only thing that carries it across a restart. `seq` orders the
 * prompts one session is holding, and the requester travels with the payload
 * because the recovered turn has to run as whoever sent it.
 */
export type QueuedPromptRecord = {
  sessionId: string
  seq: number
  messageId?: string
  parts: PromptInput["parts"]
  agent?: string
  model?: { providerID?: string; modelID?: string }
  tools?: Record<string, boolean>
  format?: PromptFormat
  system?: string
  variant?: string
  permissionMode?: string
  delivery: "steer" | "queue"
  actor?: { actorId: string; actorKind: "human" | "agent" }
  author?: AgentMessageAuthor
  queuedAt: number
}

type QueuedPromptRow = {
  session_id: string
  seq: number
  message_id: string | null
  parts_json: string
  agent: string | null
  model_provider_id: string | null
  model_id: string | null
  tools_json: string | null
  format_json: string | null
  system: string | null
  variant: string | null
  permission_mode: string | null
  delivery: string
  actor_id: string | null
  actor_kind: string | null
  author_id: string | null
  author_name: string | null
  author_avatar_url: string | null
  author_kind: string | null
  queued_at: number
}

function actorKind(input: string | null): "human" | "agent" | undefined {
  return input === "human" || input === "agent" ? input : undefined
}

function queuedPrompt(row: QueuedPromptRow): QueuedPromptRecord {
  const parts: QueuedPromptRecord["parts"] = JSON.parse(row.parts_json)
  const tools: Record<string, boolean> | undefined = row.tools_json === null ? undefined : JSON.parse(row.tools_json)
  const format: PromptFormat | undefined = row.format_json === null ? undefined : JSON.parse(row.format_json)
  const kind = actorKind(row.actor_kind)
  const authorKind = actorKind(row.author_kind)
  return {
    sessionId: row.session_id,
    seq: row.seq,
    ...(row.message_id === null ? {} : { messageId: row.message_id }),
    parts,
    ...(row.agent === null ? {} : { agent: row.agent }),
    ...(row.model_provider_id === null && row.model_id === null ? {} : {
      model: {
        ...(row.model_provider_id === null ? {} : { providerID: row.model_provider_id }),
        ...(row.model_id === null ? {} : { modelID: row.model_id }),
      },
    }),
    ...(tools === undefined ? {} : { tools }),
    ...(format === undefined ? {} : { format }),
    ...(row.system === null ? {} : { system: row.system }),
    ...(row.variant === null ? {} : { variant: row.variant }),
    ...(row.permission_mode === null ? {} : { permissionMode: row.permission_mode }),
    delivery: row.delivery === "steer" ? "steer" : "queue",
    ...(row.actor_id === null || kind === undefined ? {} : { actor: { actorId: row.actor_id, actorKind: kind } }),
    ...(row.author_id === null || row.author_name === null || authorKind === undefined ? {} : {
      author: {
        id: row.author_id,
        name: row.author_name,
        ...(row.author_avatar_url === null ? {} : { avatarUrl: row.author_avatar_url }),
        kind: authorKind,
      },
    }),
    queuedAt: row.queued_at,
  }
}

export type WorkspaceWorktreeRecord = {
  workspaceId: string
  sessionId: string
  branch: string
  baseCommit: string
  path: string
  state: "creating" | "active" | "repairing" | "failed"
  createdAt: number
  updatedAt: number
  lastActivityAt: number
}

const requireDatabase = createRequire(import.meta.url)

function managedDatabase(db: SqliteDatabase): SqliteDatabase {
  return {
    exec: (sql) => db.exec(sql),
    prepare<Row>(sql: string): SqliteStatement<Row> {
      const statement = db.prepare<Row>(sql)
      const finalize = () => statement.finalize?.()
      return {
        run(...params) {
          try {
            return statement.run(...params)
          } finally {
            finalize()
          }
        },
        get(...params) {
          try {
            return statement.get(...params)
          } finally {
            finalize()
          }
        },
        all(...params) {
          try {
            return statement.all(...params)
          } finally {
            finalize()
          }
        },
      }
    },
    close: (throwOnError) => db.close?.(throwOnError),
  }
}

/**
 * Both drivers are loaded through `createRequire` (never bundled), so their
 * exports arrive untyped. This is the one place that decides a value is a
 * database constructor, and it decides it by looking, not by asserting.
 */
function isSqliteDatabaseConstructor(value: unknown): value is SqliteDatabaseConstructor {
  return typeof value === "function"
}

function sqliteConstructor(mod: unknown, exportName: string): SqliteDatabaseConstructor {
  if (isSqliteDatabaseConstructor(mod)) return mod
  if (isRecord(mod)) {
    const named = mod[exportName]
    if (isSqliteDatabaseConstructor(named)) return named
    const fallback = mod.default
    if (isSqliteDatabaseConstructor(fallback)) return fallback
  }
  throw new Error(`sqlite driver export ${exportName} missing`)
}

function openDatabase(file: string): SqliteDatabase {
  const driver = process.versions.bun
    ? sqliteConstructor(requireDatabase("bun:sqlite"), "Database")
    : sqliteConstructor(requireDatabase("better-sqlite3"), "default")
  return managedDatabase(new driver(file))
}

function tableColumns(db: SqliteDatabase, table: string) {
  return db
    .prepare<{ name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name)
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
      source?: RuntimeEventSource
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

type MessageProjectionRow = {
  id: string
  ord: number
  info_json: string
}

type SurfaceTurnRow = {
  id: string
  ord: number
  role: string
  info_id: string | null
  parent_id: string | null
}

const MESSAGE_PAGE_CURSOR_PREFIX = "wrmp1:"
const MAX_MESSAGE_PAGE_LIMIT = 500
const MESSAGE_HYDRATION_BATCH_SIZE = 500

function encodeMessagePageCursor(sessionId: string, ord: number) {
  return `${MESSAGE_PAGE_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ sessionId, ord })).toString("base64url")}`
}

function decodeMessagePageCursor(sessionId: string, input: string) {
  try {
    if (!input.startsWith(MESSAGE_PAGE_CURSOR_PREFIX)) throw new Error("unexpected cursor version")
    const encoded = input.slice(MESSAGE_PAGE_CURSOR_PREFIX.length)
    if (!encoded) throw new Error("missing cursor payload")
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown
    const value = asRecord(decoded)
    if (
      value?.sessionId !== sessionId ||
      typeof value.ord !== "number" ||
      !Number.isSafeInteger(value.ord) ||
      value.ord < 0
    )
      throw new Error("invalid cursor payload")
    return value.ord
  } catch {
    throw new AgentMessagePageError(400, "Invalid message page cursor")
  }
}

/**
 * The read half of this store's JSON columns.
 *
 * Every one of these columns was written by a `JSON.stringify` in this file, so
 * a read is the other end of that round trip, not a parse of foreign input.
 * Declaring each column view here — once — keeps the contract greppable and
 * stops it being re-stated at every read site.
 *
 * `message.info_json` and `part.data_json` each have two views: the typed
 * `AgentMessage` view the projection returns, and the untyped record view the
 * merge/patch paths mutate before writing the column back.
 */
/**
 * Widen a typed message/part envelope to the open record the projection stores.
 *
 * The projection round-trips envelopes through `info_json`/`data_json`, so it
 * works in open records, while the builders in `compat-events` and the engine's
 * own event payloads are closed types. A shallow copy is the whole conversion:
 * no assertion, and the caller's value is never mutated (neither `upsertMessage`
 * nor `upsertPart` writes to what it is given).
 */
function envelopeRecord(value: object): Record<string, unknown> {
  return { ...value }
}

const readColumn = {
  messageInfo: (json: string): AgentMessage["info"] => JSON.parse(json),
  messageRecord: (json: string): Record<string, unknown> => JSON.parse(json),
  messagePart: (json: string): AgentMessage["parts"][number] => JSON.parse(json),
  partRecord: (json: string): Record<string, unknown> => JSON.parse(json),
  /** `runtime_journal.payload_json` on a `kind='control'`, `type='turn.start'` row. */
  turnStart: (json: string): Turn => JSON.parse(json),
  /** `runtime_journal.payload_json` on a `kind='control'`, `type='turn.finish'` row. */
  turnFinish: (json: string): TurnFinish => JSON.parse(json),
  /** `runtime_journal.payload_json` on a `kind='event'` row: an engine envelope. */
  eventPayload: (json: string): { properties?: Record<string, unknown> } => JSON.parse(json),
  /** `pending_permission.patterns_json`. */
  permissionPatterns: (json: string): string[] => JSON.parse(json),
  /** `pending_permission.metadata_json`. */
  permissionMetadata: (json: string): Record<string, unknown> => JSON.parse(json),
  /**
   * `pending_question.questions_json`, written by the `question.asked` handler
   * straight from the event's own `properties.questions`.
   */
  questions: (json: string): AgentQuestion["questions"] => JSON.parse(json),
}

/** Keep host-stamped `claxedo.author` when an engine envelope omits it. */
function preserveClaxedoAuthor(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  if (str(next.role) !== "user") return next
  const nextClaxedo = rec(next.claxedo)
  if (nextClaxedo?.author && typeof nextClaxedo.author === "object") return next
  const prevClaxedo = rec(previous?.claxedo)
  if (!prevClaxedo?.author || typeof prevClaxedo.author !== "object") return next
  return {
    ...next,
    claxedo: {
      ...nextClaxedo,
      author: prevClaxedo.author,
    },
  }
}

function subagentCorrelationKeys(observation: SubagentObservation) {
  return [
    observation.providerId && observation.providerKind
      ? `provider:${observation.providerKind}:${observation.providerId}`
      : undefined,
    observation.stableCorrelationId
      ? `stable:${observation.harnessExecutionId ?? ""}:${observation.stableCorrelationId}`
      : undefined,
    observation.toolCallId ? `tool:${observation.harnessExecutionId ?? ""}:${observation.toolCallId}` : undefined,
  ].filter((key): key is string => !!key)
}

function terminalSubagentStatus(status: string | undefined) {
  return status === "completed" || status === "failed" || status === "killed" || status === "interrupted"
}

function nullable(input: unknown): string | null | undefined {
  if (input === null) return null
  return typeof input === "string" ? input : undefined
}

function sessionHandoff(input: string | null | undefined): SessionConfig["handoff"] | undefined {
  if (!input) return undefined
  try {
    const value: SessionConfig["handoff"] = JSON.parse(input)
    if (!value || !value.pending || !value.from?.id || typeof value.transcript !== "string") return undefined
    const from = normalizeHarnessIdentity(value.from)
    if (!from) return undefined
    return { from, pending: true, transcript: value.transcript }
  } catch {
    return undefined
  }
}

function sessionHandoffJson(input: SessionConfig["handoff"] | undefined) {
  return input ? JSON.stringify(input) : null
}

function sessionHarness(input: {
  harness_id?: string | null
  harness_access?: string | null
}): SessionHarness | undefined {
  const identity = normalizeHarnessIdentity(
    input.harness_id && input.harness_access
      ? { id: input.harness_id, access: input.harness_access }
      : undefined,
  )
  return identity ?? undefined
}

/**
 * Is this part id one a provisional writer derived from the message id?
 *
 * Matches the canonical synthetic convention `${messageId}-part-N` from
 * `inputParts` below. It is recognisable from the message id alone.
 *
 * Deliberately anchored and message-bound. An id that merely CONTAINS the
 * message id, or that merely looks like the shape, is not matched: a false
 * positive here deletes a real part, so the predicate errs toward keeping.
 */
export function isProvisionalPartId(messageId: string, partId: string) {
  if (!messageId || !partId) return false
  return new RegExp(`^${escapeRegExp(messageId)}-part-\\d+$`).test(partId)
}

/**
 * How many parts the user's prompt actually had, read off the provisionals.
 *
 * Each provisional writer records the WHOLE prompt under its own convention,
 * so the two conventions are copies of one another, not additive: a two-part
 * prompt seen by both writers leaves four rows describing two parts. The width
 * is therefore the larger convention's count, never the sum — summing would
 * demand twice as many canonical parts as the engine will ever write, and the
 * provisionals would never be retired at all.
 */
function provisionalPromptWidth(messageId: string, provisionalIds: readonly string[]) {
  let fromStore = 0
  let fromAdapter = 0
  const store = new RegExp(`^${escapeRegExp(messageId)}-part-\\d+$`)
  for (const id of provisionalIds) {
    if (store.test(id)) fromStore += 1
    else fromAdapter += 1
  }
  return Math.max(fromStore, fromAdapter)
}

export class RuntimeStore {
  private root: string
  private db: SqliteDatabase
  private subagentAdmission = createMemorySubagentAdmissionStore()
  private closed = false

  constructor(root = workspaceRuntimeStoreDir()) {
    this.root = root
    fs.mkdirSync(root, { recursive: true, mode: 0o755 })
    this.db = openDatabase(path.join(root, "state.db"))
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = NORMAL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.migrate()
    this.hydrateSubagentAdmission()
    this.replay()
    this.reconcileOrphanedSubagents()
  }

  close() {
    if (this.closed) return
    // Bun's SQLite binding defaults `throwOnError` to false. When SQLite
    // refuses to close, that default silently leaves the database handle open
    // and Windows keeps the workspace directory locked. A store close is the
    // authoritative end of this handle's lifetime, so surface a failed close
    // instead of reporting the store closed while retaining the resource.
    this.db.close?.(true)
    this.closed = true
  }

  flush() {
    if (this.closed) throw new Error("Runtime store is closed")
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
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
        part_id TEXT,
        payload_json TEXT NOT NULL,
        source_json TEXT,
        PRIMARY KEY (session_id, seq)
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS runtime_journal_session_created_idx
      ON runtime_journal (session_id, created_at, seq)
    `)
    try {
      this.db.exec("ALTER TABLE runtime_journal ADD COLUMN part_id TEXT")
    } catch {
      // column already exists
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS runtime_journal_part_snapshot_idx
      ON runtime_journal (session_id, part_id, seq)
      WHERE kind = 'event' AND type = 'message.part.updated' AND part_id IS NOT NULL
    `)
    // `lastTurn` projects a session's outcome from its newest terminal journal
    // row. Without this partial index the query walks the session's whole
    // journal backwards through the primary key (tens of thousands of
    // `message.part.updated` rows for a long session) on every session read
    // and every session listing; with it the walk touches only terminal rows.
    // The predicate must stay textually identical to the one in `lastTurn` so
    // the planner can prove the index covers the query.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS runtime_journal_turn_outcome_idx
      ON runtime_journal (session_id, seq)
      WHERE (kind = 'control' AND type = 'turn.finish')
        OR (kind = 'event' AND type IN ('message.completed', 'session.error'))
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
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
        instructions TEXT,
        group_json TEXT,
        handoff_json TEXT,
        goal_json TEXT,
        permission_mode TEXT,
        permission_ceiling TEXT,
        permission_state_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_human_turn_at INTEGER,
        status TEXT,
        recovery_error TEXT,
        archived_at INTEGER
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_turn_lease (
        session_id TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL,
        acquired_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queued_prompt (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        message_id TEXT,
        parts_json TEXT NOT NULL,
        agent TEXT,
        model_provider_id TEXT,
        model_id TEXT,
        tools_json TEXT,
        format_json TEXT,
        system TEXT,
        variant TEXT,
        permission_mode TEXT,
        delivery TEXT NOT NULL,
        actor_id TEXT,
        actor_kind TEXT,
        author_id TEXT,
        author_name TEXT,
        author_avatar_url TEXT,
        author_kind TEXT,
        queued_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_secret (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
    if (!hasColumn(this.db, "session", "parent_id")) {
      try {
        this.db.exec("ALTER TABLE session ADD COLUMN parent_id TEXT")
      } catch (error) {
        if (!hasColumn(this.db, "session", "parent_id")) throw error
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS session_parent_idx
      ON session (parent_id, created_at)
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_subagent (
        parent_session_id TEXT NOT NULL,
        subagent_key TEXT NOT NULL,
        child_session_id TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        mode TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        label TEXT,
        subagent_type TEXT,
        description TEXT,
        provider_kind TEXT,
        provider_id TEXT,
        transcript_kind TEXT NOT NULL DEFAULT 'none',
        transcript_ref TEXT,
        mode_revision INTEGER NOT NULL DEFAULT 0,
        status_revision INTEGER NOT NULL DEFAULT 0,
        label_revision INTEGER NOT NULL DEFAULT 0,
        subagent_type_revision INTEGER NOT NULL DEFAULT 0,
        description_revision INTEGER NOT NULL DEFAULT 0,
        provider_kind_revision INTEGER NOT NULL DEFAULT 0,
        provider_id_revision INTEGER NOT NULL DEFAULT 0,
        child_session_id_revision INTEGER NOT NULL DEFAULT 0,
        transcript_revision INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (parent_session_id, subagent_key)
      )
    `)
    for (const [column, type] of [
      ["attention", "INTEGER"],
      ["attention_revision", "INTEGER NOT NULL DEFAULT 0"],
      ["wake", "TEXT"],
      ["wake_revision", "INTEGER NOT NULL DEFAULT 0"],
    ] as const) {
      if (!hasColumn(this.db, "session_subagent", column)) {
        this.db.exec(`ALTER TABLE session_subagent ADD COLUMN ${column} ${type}`)
      }
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS session_subagent_child_idx
      ON session_subagent (child_session_id)
      WHERE child_session_id IS NOT NULL
    `)
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS session_subagent_provider_idx
      ON session_subagent (parent_session_id, provider_kind, provider_id)
      WHERE provider_id IS NOT NULL
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_subagent_tool_call (
        parent_session_id TEXT NOT NULL,
        subagent_key TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('spawn', 'interaction')),
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (parent_session_id, subagent_key, tool_call_id)
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS session_subagent_tool_call_lookup_idx
      ON session_subagent_tool_call (parent_session_id, tool_call_id)
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_subagent_observation (
        parent_session_id TEXT NOT NULL,
        observation_id TEXT NOT NULL,
        subagent_key TEXT NOT NULL,
        revision INTEGER NOT NULL,
        observation_json TEXT NOT NULL,
        event_json TEXT NOT NULL,
        published INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (parent_session_id, observation_id)
      )
    `)
    if (!hasColumn(this.db, "session_subagent_observation", "observation_json")) {
      this.db.exec("ALTER TABLE session_subagent_observation ADD COLUMN observation_json TEXT NOT NULL DEFAULT '{}'")
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_subagent_correlation (
        parent_session_id TEXT NOT NULL,
        correlation_key TEXT NOT NULL,
        subagent_key TEXT NOT NULL,
        PRIMARY KEY (parent_session_id, correlation_key, subagent_key)
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_map (
        session_id TEXT PRIMARY KEY,
        agent_session_id TEXT NOT NULL UNIQUE
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_execution_binding (
        session_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        directory TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        upstream_session_id TEXT NOT NULL
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
      CREATE INDEX IF NOT EXISTS message_session_ord_idx
      ON message (session_id, ord DESC)
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
      CREATE INDEX IF NOT EXISTS part_session_message_ord_idx
      ON part (session_id, message_id, ord)
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS todo (
        session_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        task_id TEXT,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, position)
      )
    `)
    if (!hasColumn(this.db, "todo", "task_id")) {
      this.db.exec("ALTER TABLE todo ADD COLUMN task_id TEXT")
    }
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_worktree (
        session_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        path TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS workspace_worktree_workspace_activity_idx
      ON workspace_worktree (workspace_id, last_activity_at DESC)
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
      "ALTER TABLE session ADD COLUMN instructions TEXT",
      "ALTER TABLE session ADD COLUMN group_json TEXT",
      "ALTER TABLE session ADD COLUMN handoff_json TEXT",
      "ALTER TABLE session ADD COLUMN goal_json TEXT",
      "ALTER TABLE session ADD COLUMN permission_mode TEXT",
      "ALTER TABLE session ADD COLUMN permission_ceiling TEXT",
      "ALTER TABLE session ADD COLUMN permission_state_json TEXT",
      // Existing rows stay null: a session whose last human turn predates this column
      // reads as "not recently spoken to", which is what a long-dormant session is.
      "ALTER TABLE session ADD COLUMN last_human_turn_at INTEGER",
    ]) {
      try {
        this.db.exec(sql)
      } catch {
        // column already exists
      }
    }
  }

  private hydrateSubagentAdmission() {
    this.subagentAdmission = createMemorySubagentAdmissionStore()
    const rows = this.db
      .prepare<{
      parent_session_id: string
      observation_id: string
      subagent_key: string
      revision: number
      observation_json: string
      published: number
    }>(
        `
      SELECT parent_session_id, observation_id, subagent_key, revision, observation_json, published
      FROM session_subagent_observation
      ORDER BY parent_session_id, subagent_key, revision
    `,
      )
      .all()
    for (const row of rows) {
      const stored: SubagentObservation = JSON.parse(row.observation_json)
      const observation = {
        ...stored,
        observationId: row.observation_id,
        subagentKey: row.subagent_key,
      }
      const admitted = this.subagentAdmission.admit({
        parentSessionId: row.parent_session_id,
        observation,
        allocateKey: () => row.subagent_key,
      })
      if (admitted.event.revision !== row.revision) {
        throw new Error(`subagent revision replay mismatch for ${row.parent_session_id}/${row.subagent_key}`)
      }
      if (row.published) this.subagentAdmission.markPublished(row.parent_session_id, row.observation_id)
    }
  }

  admit(input: {
    parentSessionId: string
    observation: SubagentObservation
    allocateKey: () => string
    allocateChildSessionId?: () => string
  }): AdmittedSubagentObservation {
    const admitted = this.admitObservation(input)
    this.linkChildSession(input.parentSessionId, admitted.event.childSessionId)
    return admitted
  }

  /**
   * Record the parent a delegation's child session belongs to.
   *
   * Admission is where this store learns the association, and the session row
   * is the only place a later `GET /session/:id` can read it back from — an
   * adapter that owns its sessions upstream is never consulted for a session
   * this store already has a row for. Without this the child of an OpenCode
   * `task` call answered as a root session, so the app rendered its transcript
   * without the child heading or the parent it belongs to.
   *
   * Written through `bindSession` like every other session write, so it is
   * journaled and survives a rehydrate. The bind upserts and the projection
   * COALESCEs the parent, so re-admitting the same observation changes nothing.
   */
  private linkChildSession(parentSessionId: string, childSessionId?: string) {
    if (!childSessionId || childSessionId === parentSessionId) return
    const child = this.getSession(childSessionId) as { directory?: string; parentID?: string } | null
    if (child?.parentID === parentSessionId) return
    const parent = this.getSession(parentSessionId) as { directory?: string } | null
    this.bindSession({
      sessionId: childSessionId,
      directory: child?.directory ?? parent?.directory ?? "",
      agentSessionId: this.getAgentSessionId(childSessionId) ?? childSessionId,
      parentSessionId,
    })
  }

  private admitObservation(input: {
    parentSessionId: string
    observation: SubagentObservation
    allocateKey: () => string
    allocateChildSessionId?: () => string
  }): AdmittedSubagentObservation {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      // Another host instance may have admitted an observation since this
      // process last touched its in-memory index. Refresh only after taking
      // SQLite's write lock so key association and revision assignment share
      // the same serialization point as the durable insert.
      this.hydrateSubagentAdmission()
      const admitted = this.subagentAdmission.admit(input)
      const existing = this.db
        .prepare<{
        event_json: string
        published: number
      }>(
          `
        SELECT event_json, published
        FROM session_subagent_observation
        WHERE parent_session_id = ? AND observation_id = ?
      `,
        )
        .get(input.parentSessionId, input.observation.observationId)
      if (existing) {
        this.db.exec("COMMIT")
        return { ...admitted, published: !!existing.published }
      }
      this.persistSubagentEvent(input.parentSessionId, admitted.event)
      for (const correlationKey of subagentCorrelationKeys(input.observation)) {
        this.db
          .prepare(
            `
          INSERT OR IGNORE INTO session_subagent_correlation (
            parent_session_id, correlation_key, subagent_key
          ) VALUES (?, ?, ?)
        `,
          )
          .run(input.parentSessionId, correlationKey, admitted.event.subagentKey)
      }
      this.db
        .prepare(
          `
        INSERT INTO session_subagent_observation (
          parent_session_id, observation_id, subagent_key, revision,
          observation_json, event_json, published, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      `,
        )
        .run(
          input.parentSessionId,
          input.observation.observationId,
          admitted.event.subagentKey,
          admitted.event.revision,
          // Persist the EFFECTIVE observation — with the child session the
          // admission layer resolved or allocated stamped in — so hydrate's
          // replay rebuilds the same child binding this admit produced. The
          // raw input may lack the child (admission allocated it), and a
          // replay without it would forget which row owns the child session.
          JSON.stringify({
            ...input.observation,
            ...(admitted.event.childSessionId ? { childSessionId: admitted.event.childSessionId } : {}),
          }),
          JSON.stringify(admitted.event),
          Date.now(),
        )
      this.db.exec("COMMIT")
      return admitted
    } catch (error) {
      try {
        this.db.exec("ROLLBACK")
      } catch {}
      this.hydrateSubagentAdmission()
      throw error
    }
  }

  markPublished(parentSessionId: string, observationId: string) {
    const result = this.db
      .prepare(
        `
      UPDATE session_subagent_observation
      SET published = 1
      WHERE parent_session_id = ? AND observation_id = ?
    `,
      )
      .run(parentSessionId, observationId)
    if (result.changes === 0) throw new Error(`unknown subagent observation ${observationId}`)
    this.subagentAdmission.markPublished(parentSessionId, observationId)
  }

  listSubagents(parentSessionId: string) {
    const rows = this.db
      .prepare<Record<string, string | number | null>>(
        `
      SELECT *
      FROM session_subagent
      WHERE parent_session_id = ?
      ORDER BY created_at, subagent_key
    `,
      )
      .all(parentSessionId)
    const edges = this.db
      .prepare<{
      subagent_key: string
      tool_call_id: string
      role: "spawn" | "interaction"
      revision: number
    }>(
        `
      SELECT subagent_key, tool_call_id, role, revision
      FROM session_subagent_tool_call
      WHERE parent_session_id = ?
      ORDER BY created_at, tool_call_id
    `,
      )
      .all(parentSessionId)
    return rows.map((row) => ({
      parentSessionId,
      subagentKey: String(row.subagent_key),
      revision: Number(row.revision),
      ...(row.mode ? { mode: String(row.mode) } : {}),
      ...(row.status ? { status: String(row.status) } : {}),
      ...(row.label ? { label: String(row.label) } : {}),
      ...(row.subagent_type ? { subagentType: String(row.subagent_type) } : {}),
      ...(row.description ? { description: String(row.description) } : {}),
      ...(row.provider_kind ? { providerKind: String(row.provider_kind) } : {}),
      ...(row.provider_id ? { providerId: String(row.provider_id) } : {}),
      ...(row.child_session_id ? { childSessionId: String(row.child_session_id) } : {}),
      ...(typeof row.attention === "number" ? { attention: row.attention } : {}),
      ...(row.wake ? { wake: String(row.wake) } : {}),
      transcript: {
        kind: String(row.transcript_kind),
        ...(row.transcript_ref ? { ref: String(row.transcript_ref) } : {}),
      },
      toolCallEdges: edges
        .filter((edge) => edge.subagent_key === row.subagent_key)
        .map((edge) => ({ toolCallId: edge.tool_call_id, role: edge.role, revision: edge.revision })),
    }))
  }

  listPendingSubagentWakes() {
    return this.db
      .prepare<{ parent_session_id: string; subagent_key: string; child_session_id: string; directory: string }>(
        `
      SELECT subagent.parent_session_id, subagent.subagent_key, subagent.child_session_id, parent.directory
      FROM session_subagent subagent
      JOIN session parent ON parent.id = subagent.parent_session_id
      WHERE subagent.wake = 'pending' AND subagent.child_session_id IS NOT NULL
      ORDER BY subagent.updated_at, subagent.subagent_key
    `,
      )
      .all()
      .map((row) => ({
        parentSessionId: row.parent_session_id,
        subagentKey: row.subagent_key,
        childSessionId: row.child_session_id,
        directory: row.directory,
      }))
  }

  private reconcileOrphanedSubagents() {
    const parents = this.db
      .prepare<{ parent_session_id: string }>(
        `
      SELECT DISTINCT child.parent_session_id
      FROM session_subagent child
      LEFT JOIN session parent ON parent.id = child.parent_session_id
      WHERE child.mode != 'background'
        AND child.status IN ('pending', 'running', 'paused')
        AND COALESCE(parent.status, 'idle') != 'busy'
    `,
      )
      .all()
    for (const parent of parents) this.interruptSubagents(parent.parent_session_id, "orphan")
  }

  private interruptSubagents(parentSessionId: string, reason: "archive" | "orphan", occurrence = Date.now()) {
    for (const child of this.listSubagents(parentSessionId)) {
      if (!["pending", "running", "paused"].includes(child.status ?? "")) continue
      if (reason === "orphan" && child.mode === "background") continue
      const observationId = `host:${reason}:${occurrence}:${child.subagentKey}:${child.revision}`
      this.admit({
        parentSessionId,
        observation: {
          observationId,
          subagentKey: child.subagentKey,
          status: "interrupted",
        },
        allocateKey: () => child.subagentKey,
      })
      this.markPublished(parentSessionId, observationId)
    }
  }

  private persistSubagentEvent(parentSessionId: string, event: SubagentUpdatedEvent) {
    const now = Date.now()
    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO session_subagent (
        parent_session_id, subagent_key, revision, status, transcript_kind, created_at, updated_at
      ) VALUES (?, ?, 0, 'pending', 'none', ?, ?)
    `,
      )
      .run(parentSessionId, event.subagentKey, now, now)
    this.db
      .prepare(
        `
      UPDATE session_subagent
      SET revision = MAX(revision, ?), updated_at = ?
      WHERE parent_session_id = ? AND subagent_key = ?
    `,
      )
      .run(event.revision, now, parentSessionId, event.subagentKey)
    for (const [field, column] of [
      ["mode", "mode"],
      ["label", "label"],
      ["subagentType", "subagent_type"],
      ["description", "description"],
      ["attention", "attention"],
      ["wake", "wake"],
    ] as const) {
      const value = event[field]
      if (value === undefined) continue
      this.db
        .prepare(
          `
        UPDATE session_subagent
        SET ${column} = ?, ${column}_revision = ?
        WHERE parent_session_id = ? AND subagent_key = ? AND ${column}_revision < ?
      `,
        )
        .run(value, event.revision, parentSessionId, event.subagentKey, event.revision)
    }
    if (event.status !== undefined) {
      const current = requireRow(
        this.db
          .prepare<{ status: string; status_revision: number }>(
            `
        SELECT status, status_revision
        FROM session_subagent
        WHERE parent_session_id = ? AND subagent_key = ?
      `,
          )
          .get(parentSessionId, event.subagentKey),
        "session_subagent",
      )
      const currentTerminal = terminalSubagentStatus(current.status)
      const incomingTerminal = terminalSubagentStatus(event.status)
      if (
        (!currentTerminal && incomingTerminal) ||
        (currentTerminal === incomingTerminal && event.revision > current.status_revision)
      ) {
        this.db
          .prepare(
            `
          UPDATE session_subagent
          SET status = ?, status_revision = MAX(status_revision, ?)
          WHERE parent_session_id = ? AND subagent_key = ?
        `,
          )
          .run(event.status, event.revision, parentSessionId, event.subagentKey)
      }
      if (event.revision > current.status_revision) {
        this.db
          .prepare(
            `
          UPDATE session_subagent
          SET status_revision = ?
          WHERE parent_session_id = ? AND subagent_key = ?
        `,
          )
          .run(event.revision, parentSessionId, event.subagentKey)
      }
    }
    for (const [field, column] of [
      ["providerKind", "provider_kind"],
      ["providerId", "provider_id"],
      ["childSessionId", "child_session_id"],
    ] as const) {
      const value = event[field]
      if (value === undefined) continue
      this.db
        .prepare(
          `
        UPDATE session_subagent
        SET ${column} = ?, ${column}_revision = ?
        WHERE parent_session_id = ? AND subagent_key = ? AND ${column} IS NULL
      `,
        )
        .run(value, event.revision, parentSessionId, event.subagentKey)
    }
    if (event.transcript) {
      this.db
        .prepare(
          `
        UPDATE session_subagent
        SET transcript_kind = ?, transcript_ref = ?, transcript_revision = ?
        WHERE parent_session_id = ? AND subagent_key = ? AND transcript_revision < ?
      `,
        )
        .run(
          event.transcript.kind,
          event.transcript.ref ?? null,
          event.revision,
          parentSessionId,
          event.subagentKey,
          event.revision,
        )
    }
    if (event.toolCallId && event.toolCallRole) {
      this.db
        .prepare(
          `
        INSERT OR IGNORE INTO session_subagent_tool_call (
          parent_session_id, subagent_key, tool_call_id, role, revision, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
        )
        .run(parentSessionId, event.subagentKey, event.toolCallId, event.toolCallRole, event.revision, now)
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
      this.db.exec("DELETE FROM session_execution_binding")
      this.db.exec("DELETE FROM session_map")
      this.db.exec("DELETE FROM session")
    })
  }

  private replay() {
    const sessions = this.db
      .prepare<{ session_id: string; last_seq: number; max_seq: number }>(
        `
        SELECT journal.session_id, COALESCE(checkpoint.last_seq, 0) AS last_seq, journal.max_seq
        FROM (
          SELECT session_id, MAX(seq) AS max_seq
          FROM runtime_journal
          GROUP BY session_id
        ) AS journal
        LEFT JOIN journal_checkpoint AS checkpoint ON checkpoint.session_id = journal.session_id
        WHERE journal.max_seq > COALESCE(checkpoint.last_seq, 0)
        ORDER BY journal.session_id ASC
      `,
      )
      .all()
    for (const session of sessions) {
      let cursor = session.last_seq
      while (cursor < session.max_seq) {
        const rows = this.db
          .prepare<RuntimeJournalRow>(
            `
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
            WHERE session_id = ? AND seq > ?
            ORDER BY seq ASC
            LIMIT 100
          `,
          )
          .all(session.session_id, cursor)
        if (rows.length === 0) break
        for (const row of rows) {
          cursor = row.seq
          const parsed = this.parseJournalRow(row)
          if (!parsed) continue
          this.project(parsed)
        }
      }
    }
  }

  private staleToolError(message?: string) {
    if (message?.includes("ACP process restarted")) return "Tool execution interrupted by ACP restart"
    return "Tool execution interrupted"
  }

  private finishTools(sessionId: string, ts: number, message?: string) {
    const error = this.staleToolError(message)
    const rows = this.db
      .prepare<{ data_json: string }>("SELECT data_json FROM part WHERE session_id = ? ORDER BY updated_at ASC")
      .all(sessionId)
    for (const row of rows) {
      const part = readColumn.partRecord(row.data_json)
      if (part.type !== "tool") continue
      const state = asRecord(part.state)
      const status = str(state?.status)
      if (status !== "pending" && status !== "running") continue
      const time = asRecord(state?.time)
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

  /**
   * Close a tool part that is still pending or running on a message the
   * projection already considers terminal: it can never progress again, so it
   * is reported as errored rather than left spinning in every transcript.
   */
  private terminalizedPart(part: AgentMessage["parts"][number], ts: number, message?: string) {
    if (part.type !== "tool") return part
    const state = part.state
    if (state.status !== "pending" && state.status !== "running") return part
    return {
      ...part,
      state: {
        ...state,
        status: "error" as const,
        error: this.staleToolError(message),
        time: {
          start: state.status === "running" ? state.time.start : ts,
          end: ts,
        },
      },
    }
  }

  private normalizeRecoveringTools() {
    const rows = this.db.prepare<{
      id: string
      agent_session_id: string | null
    }>("SELECT id, agent_session_id FROM session WHERE status = 'busy'").all()
    for (const row of rows) {
      this.markSessionInterrupted(row.id, ACP_RECOVER, row.agent_session_id)
    }
  }

  recoverBusySessions() {
    // Adapter-store recovery runs only when no turn from the previous runtime
    // can still be active. A crash cannot release its durable lease, so clear
    // those stale ownership rows at the same boundary that interrupts busy
    // sessions and their pending tools.
    this.db.exec("DELETE FROM session_turn_lease")
    this.normalizeRecoveringTools()
  }

  /**
   * Persist a prompt waiting for this session's running turn to end.
   *
   * The lease and busy-session recovery above deliberately do not touch these
   * rows: a turn from the previous runtime cannot be resumed, but a prompt that
   * never reached one still has to run.
   */
  queuePrompt(input: Omit<QueuedPromptRecord, "seq" | "queuedAt">): QueuedPromptRecord {
    const seq = requireRow(
      this.db
        .prepare<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM queued_prompt WHERE session_id = ?")
        .get(input.sessionId),
      "queued prompt seq",
    ).seq
    const record: QueuedPromptRecord = { ...input, seq, queuedAt: Date.now() }
    this.db
      .prepare(
        `
      INSERT INTO queued_prompt (
        session_id,
        seq,
        message_id,
        parts_json,
        agent,
        model_provider_id,
        model_id,
        tools_json,
        format_json,
        system,
        variant,
        permission_mode,
        delivery,
        actor_id,
        actor_kind,
        author_id,
        author_name,
        author_avatar_url,
        author_kind,
        queued_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        record.sessionId,
        record.seq,
        record.messageId ?? null,
        JSON.stringify(record.parts),
        record.agent ?? null,
        record.model?.providerID ?? null,
        record.model?.modelID ?? null,
        record.tools === undefined ? null : JSON.stringify(record.tools),
        record.format === undefined ? null : JSON.stringify(record.format),
        record.system ?? null,
        record.variant ?? null,
        record.permissionMode ?? null,
        record.delivery,
        record.actor?.actorId ?? null,
        record.actor?.actorKind ?? null,
        record.author?.id ?? null,
        record.author?.name ?? null,
        record.author?.avatarUrl ?? null,
        record.author?.kind ?? null,
        record.queuedAt,
      )
    return record
  }

  deleteQueuedPrompt(sessionId: string, seq: number) {
    this.db.prepare("DELETE FROM queued_prompt WHERE session_id = ? AND seq = ?").run(sessionId, seq)
  }

  listQueuedPrompts(): QueuedPromptRecord[] {
    return this.db
      .prepare<QueuedPromptRow>(`
      SELECT
        session_id,
        seq,
        message_id,
        parts_json,
        agent,
        model_provider_id,
        model_id,
        tools_json,
        format_json,
        system,
        variant,
        permission_mode,
        delivery,
        actor_id,
        actor_kind,
        author_id,
        author_name,
        author_avatar_url,
        author_kind,
        queued_at
      FROM queued_prompt
      ORDER BY queued_at, session_id, seq
    `)
      .all()
      .map(queuedPrompt)
  }

  putWorktree(record: WorkspaceWorktreeRecord) {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO workspace_worktree (
        session_id,
        workspace_id,
        branch,
        base_commit,
        path,
        state,
        created_at,
        updated_at,
        last_activity_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        record.sessionId,
        record.workspaceId,
        record.branch,
        record.baseCommit,
        record.path,
        record.state,
        record.createdAt,
        record.updatedAt,
        record.lastActivityAt,
      )
  }

  getWorktree(workspaceId: string, sessionId: string): WorkspaceWorktreeRecord | undefined {
    const row = this.db.prepare<{
      workspace_id: string
      session_id: string
      branch: string
      base_commit: string
      path: string
      state: WorkspaceWorktreeRecord["state"]
      created_at: number
      updated_at: number
      last_activity_at: number
    }>(`
      SELECT
        workspace_id,
        session_id,
        branch,
        base_commit,
        path,
        state,
        created_at,
        updated_at,
        last_activity_at
      FROM workspace_worktree
      WHERE workspace_id = ? AND session_id = ?
    `).get(workspaceId, sessionId)
    if (!row) return undefined
    return {
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      branch: row.branch,
      baseCommit: row.base_commit,
      path: row.path,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastActivityAt: row.last_activity_at,
    }
  }

  listWorktrees(workspaceId: string): WorkspaceWorktreeRecord[] {
    return (
      this.db
        .prepare<{ session_id: string }>(
          `
      SELECT session_id
      FROM workspace_worktree
      WHERE workspace_id = ?
      ORDER BY last_activity_at DESC, session_id ASC
    `).all(workspaceId))
      .map((row) => this.getWorktree(workspaceId, row.session_id)!)
  }

  private parseJournalRow(row: RuntimeJournalRow): Row | null {
    try {
      if (row.kind === "control") {
        const control: Control = JSON.parse(row.payload_json)
        return {
          seq: row.seq,
          ts: row.created_at,
          sessionId: row.session_id,
          ...(row.provider_session_id ? { agentSessionId: row.provider_session_id } : {}),
          kind: "control",
          control,
        }
      }
      if (row.kind === "event") {
        const payload: CompatEvent = JSON.parse(row.payload_json)
        const source: RuntimeEventSource | undefined = row.source_json ? JSON.parse(row.source_json) : undefined
        return {
          seq: row.seq,
          ts: row.created_at,
          sessionId: row.session_id,
          ...(row.provider_session_id ? { agentSessionId: row.provider_session_id } : {}),
          kind: "event",
          payload,
          ...(source ? { source } : {}),
        }
      }
      return null
    } catch {
      return null
    }
  }

  exportJournalJsonl(sessionId?: string) {
    const rows = this.db
      .prepare<RuntimeJournalRow>(
        `
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
      `,
      )
      .all(...(sessionId ? [sessionId] : []))
    return (
      rows
        .flatMap((row) => {
          const parsed = this.parseJournalRow(row)
          return parsed ? [JSON.stringify(parsed)] : []
        })
        .join("\n") + (rows.length > 0 ? "\n" : "")
    )
  }

  private next(sessionId: string) {
    const row = requireRow(
      this.db
        .prepare<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM runtime_journal WHERE session_id = ?")
        .get(sessionId),
      "runtime_journal next seq",
    )
    return row.seq
  }

  private deleted(sessionId: string) {
    return !!this.db.prepare("SELECT 1 FROM deleted_session WHERE session_id = ?").get(sessionId)
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

  private insertRuntimeJournal(
    row: Row,
    seq = this.next(row.sessionId),
    options: { ignoreDuplicate?: boolean; insideTransaction?: boolean } = {},
  ) {
    const type = row.kind === "control" ? row.control.type : row.payload.type
    const partId =
      row.kind === "event" && row.payload.type === "message.part.updated" ? row.payload.properties.part.id : null
    const processKey =
      row.kind === "control" && row.control.type === "session.bind"
        ? (row.control.ownerKey ?? row.control.processKey ?? null)
        : null
    const turnId =
      row.kind === "control" && (row.control.type === "turn.start" || row.control.type === "turn.finish")
        ? row.control.assistantMessageId
        : null
    const userMessageId =
      row.kind === "control" && row.control.type === "turn.start" ? (row.control.userMessageId ?? null) : null
    const assistantMessageId =
      row.kind === "control" && (row.control.type === "turn.start" || row.control.type === "turn.finish")
        ? row.control.assistantMessageId
        : null
    const insert = () => {
      if (partId && !options.ignoreDuplicate) {
        this.db
          .prepare(
            `
          DELETE FROM runtime_journal
          WHERE session_id = ?
            AND kind = 'event'
            AND type = 'message.part.updated'
            AND part_id = ?
            AND seq < ?
        `,
          )
          .run(row.sessionId, partId, seq)
      }
      this.db
        .prepare(
          `
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
          part_id,
          payload_json,
          source_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
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
          partId,
          JSON.stringify(row.kind === "control" ? row.control : row.payload),
          row.kind === "event" && row.source ? JSON.stringify(row.source) : null,
        )
    }
    if (options.insideTransaction) insert()
    else this.transaction(insert)
    return { ...row, seq }
  }

  private checkpoint(row: Row) {
    this.db
      .prepare("INSERT OR REPLACE INTO journal_checkpoint (session_id, last_seq, updated_at) VALUES (?, ?, ?)")
      .run(row.sessionId, row.seq, row.ts)
  }

  private latestFencingToken(sessionId: string) {
    const row = this.db.prepare<{ fencing_token: number }>(`
      SELECT CAST(json_extract(payload_json, '$.fencingToken') AS INTEGER) AS fencing_token
      FROM runtime_journal
      WHERE session_id = ? AND kind = 'control' AND type = 'turn.start'
        AND json_type(payload_json, '$.fencingToken') = 'integer'
      ORDER BY seq DESC
      LIMIT 1
    `).get(sessionId)
    return row?.fencing_token
  }

  private assertFencingToken(sessionId: string, fencingToken: number | undefined, advance = false) {
    if (fencingToken === undefined) return
    if (!Number.isSafeInteger(fencingToken) || fencingToken <= 0) throw new AgentRuntimeStaleTurnError(sessionId)
    const current = this.latestFencingToken(sessionId)
    if (current === undefined) {
      if (advance) return
      throw new AgentRuntimeStaleTurnError(sessionId)
    }
    if (advance ? fencingToken < current : fencingToken !== current) {
      throw new AgentRuntimeStaleTurnError(sessionId)
    }
  }

  private commit(row: Row, fence: { fencingToken?: number; advance?: boolean } = {}) {
    if (
      this.deleted(row.sessionId) &&
      !(row.kind === "control" && (row.control.type === "session.bind" || row.control.type === "session.delete"))
    ) {
      throw new Error(`Session ${row.sessionId} was deleted`)
    }
    if (fence.fencingToken === undefined) {
      const journaled = this.insertRuntimeJournal(row)
      this.transaction(() => {
        this.apply(journaled)
        this.checkpoint(journaled)
      })
      return journaled
    }
    let journaled!: Row
    this.transaction(() => {
      this.assertFencingToken(row.sessionId, fence.fencingToken, fence.advance)
      journaled = this.insertRuntimeJournal(row, this.next(row.sessionId), { insideTransaction: true })
      this.apply(journaled)
      this.checkpoint(journaled)
    })
    return journaled
  }

  private messageOrd(sessionId: string, messageId: string) {
    const row = this.db.prepare<{ ord: number }>("SELECT ord FROM message WHERE id = ?").get(messageId)
    if (row) return row.ord
    const max = requireRow(
      this.db
        .prepare<{ ord: number }>("SELECT COALESCE(MAX(ord), -1) AS ord FROM message WHERE session_id = ?")
        .get(sessionId),
      "message max ord",
    )
    return max.ord + 1
  }

  private partOrd(messageId: string, partId: string) {
    const row = this.db.prepare<{ ord: number }>("SELECT ord FROM part WHERE id = ?").get(partId)
    if (row) return row.ord
    const max = requireRow(
      this.db
        .prepare<{ ord: number }>("SELECT COALESCE(MAX(ord), -1) AS ord FROM part WHERE message_id = ?")
        .get(messageId),
      "part max ord",
    )
    return max.ord + 1
  }

  private upsertMessage(envelope: object, ts: number) {
    const info = envelopeRecord(envelope)
    const sessionId = str(info.sessionID)
    const id = str(info.id)
    const role = str(info.role)
    if (!sessionId || !id || !role) return
    const prev = this.db
      .prepare<{ created_at: number; info_json: string }>("SELECT created_at, info_json FROM message WHERE id = ?")
      .get(id)
    const merged = preserveClaxedoAuthor(prev ? readColumn.messageRecord(prev.info_json) : undefined, info)
    this.db
      .prepare(
        "INSERT OR REPLACE INTO message (id, session_id, role, ord, info_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, sessionId, role, this.messageOrd(sessionId, id), JSON.stringify(merged), prev?.created_at ?? ts)
  }

  private upsertPart(envelope: object, ts: number) {
    const part = envelopeRecord(envelope)
    const sessionId = str(part.sessionID)
    const messageId = str(part.messageID)
    const id = str(part.id)
    if (!sessionId || !messageId || !id) return
    this.db
      .prepare(
        "INSERT OR REPLACE INTO part (id, session_id, message_id, ord, data_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, sessionId, messageId, this.partOrd(messageId, id), JSON.stringify(part), ts)
    this.supersedeProvisionalParts(messageId)
  }

  /**
   * Drops a user message's PROVISIONAL parts once a canonical one has landed.
   *
   * Two layers can record a user prompt, and each mints its own id:
   *   `${messageId}-part-N`       — this store (`inputParts`)
   *   provider part id             — the connected runtime's persisted part
   * Both describe the SAME text, so one send rendered the prompt twice in the
   * transcript. The provider request always carried exactly one
   * part, so this was transcript fidelity — never model input, never tokens.
   *
   * The first is provisional BY CONSTRUCTION: its id is derived from the
   * message id, which makes it identifiable without comparing
   * text (a user may legitimately send the same text twice; identical text is
   * not evidence of duplication). They are written eagerly for durability —
   * each survives if the layer below it never responds — so they are retired
   * here rather than never written. Removing a writer instead would risk an
   * empty user message on exactly the partial-failure paths they cover;
   * consolidating ownership to one writer is the right long-term fix and is
   * deliberately deferred.
   *
   * Same asymmetry as the app store's `reconcileStoredParts`: canonical parts
   * SUPERSEDE provisionals, but their absence never deletes anything. Nothing
   * is dropped without its replacement already in hand.
   *
   * That last clause is why this counts. The engine mints its own ids, so a
   * canonical part carries NOTHING linking it to the provisional it replaces —
   * there is no per-part correspondence to check. A two-part prompt (text plus
   * an attachment) whose first part alone had been persisted would lose its
   * second part outright if one canonical part retired every provisional. So
   * provisionals are retired only once the canonical parts cover them all;
   * until then the message renders a little long, which is the safe direction.
   *
   * Runs after EVERY part write, not only canonical ones: a provisional that
   * arrives after the canonical parts are already complete must be retired on
   * its own arrival, or the duplicate persists until the engine happens to
   * rewrite a part — and if it never does, the prompt stays doubled.
   *
   * Scoped to this message twice over — the query and the predicate both bind
   * to `messageId` — so a canonical part on one message can never retire
   * another's. Either guard alone would do; both are cheap.
   */
  private supersedeProvisionalParts(messageId: string) {
    const rows = this.db.prepare<{ id: string }>("SELECT id FROM part WHERE message_id = ?").all(messageId)
    const stale: string[] = []
    let canonical = 0
    for (const row of rows) {
      if (isProvisionalPartId(messageId, row.id)) stale.push(row.id)
      else canonical += 1
    }
    if (stale.length === 0 || canonical < provisionalPromptWidth(messageId, stale)) return
    for (const id of stale) this.db.prepare("DELETE FROM part WHERE id = ?").run(id)
  }

  private delta(sessionId: string, messageId: string, partId: string, field: string, delta: string, ts: number) {
    const row = this.db.prepare<{ data_json: string }>("SELECT data_json FROM part WHERE id = ?").get(partId)
    const part = row
      ? readColumn.partRecord(row.data_json)
      : {
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
    processKey?: string | null
    harness?: SessionHarness
    model?: SessionModel
    variant?: string | null
    agent?: string | null
    instructions?: string | null
    group?: SessionModelGroup | null
    handoff?: SessionConfig["handoff"]
    createdAt: number
    updatedAt: number
    /**
     * When a *human* last started a turn here. `updated_at` moves for any turn, so a
     * wake, a subagent or a channel message advances it too; this only moves when the
     * reader speaks, which is what the sidebar needs to tell a live session from one
     * the agents are working through on their own.
     */
    lastHumanTurnAt?: number
    status?: string
    recoveryError?: string | null
    parentSessionId?: string
  }) {
    const prev = this.db
      .prepare<{
      created_at: number
      parent_id: string | null
      title: string | null
      recovery_error: string | null
      last_human_turn_at: number | null
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
      instructions: string | null
      group_json: string | null
      handoff_json: string | null
    }>(
        `
        SELECT
          created_at,
          parent_id,
          title,
          recovery_error,
          last_human_turn_at,
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
          instructions,
          group_json,
          handoff_json
        FROM session
        WHERE id = ?
      `,
      )
      .get(input.id)
    this.db
      .prepare(
        `INSERT INTO session (
        id,
        parent_id,
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
        instructions,
        group_json,
        handoff_json,
        created_at,
        updated_at,
        last_human_turn_at,
        status,
        recovery_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        parent_id = COALESCE(excluded.parent_id, session.parent_id),
        directory = excluded.directory,
        title = excluded.title,
        agent_session_id = excluded.agent_session_id,
        process_key = excluded.process_key,
        permission_mode = CASE WHEN session.harness_id = excluded.harness_id AND session.harness_access = excluded.harness_access THEN session.permission_mode ELSE NULL END,
        permission_state_json = CASE WHEN session.harness_id = excluded.harness_id AND session.harness_access = excluded.harness_access THEN session.permission_state_json ELSE NULL END,
        harness_id = excluded.harness_id,
        harness_access = excluded.harness_access,
        harness_binary = excluded.harness_binary,
        harness_transport = excluded.harness_transport,
        harness_url = excluded.harness_url,
        harness_headers_json = excluded.harness_headers_json,
        model_provider_id = excluded.model_provider_id,
        model_id = excluded.model_id,
        variant = excluded.variant,
        agent = excluded.agent,
        instructions = excluded.instructions,
        group_json = excluded.group_json,
        handoff_json = excluded.handoff_json,
        updated_at = excluded.updated_at,
        last_human_turn_at = excluded.last_human_turn_at,
        status = COALESCE(excluded.status, session.status),
        recovery_error = excluded.recovery_error`,
      )
      .run(
        input.id,
        input.parentSessionId ?? prev?.parent_id ?? null,
        input.directory,
        input.title ?? prev?.title ?? null,
        input.agentSessionId ?? prev?.agent_session_id ?? null,
        input.processKey === undefined ? prev?.process_key ?? null : input.processKey,
        input.harness?.id ?? prev?.harness_id ?? null,
        input.harness?.access ?? prev?.harness_access ?? null,
        null,
        null,
        null,
        null,
        input.model?.providerID ?? prev?.model_provider_id ?? null,
        input.model?.modelID ?? prev?.model_id ?? null,
        input.variant ?? prev?.variant ?? null,
        input.agent ?? prev?.agent ?? null,
        input.instructions ?? prev?.instructions ?? null,
        input.group === undefined ? (prev?.group_json ?? null) : sessionModelGroupJson(input.group),
        input.handoff === undefined ? (prev?.handoff_json ?? null) : sessionHandoffJson(input.handoff),
        prev?.created_at ?? input.createdAt,
        input.updatedAt,
        input.lastHumanTurnAt ?? prev?.last_human_turn_at ?? null,
        input.status ?? null,
        input.recoveryError ?? prev?.recovery_error ?? null,
      )
    if (input.agentSessionId) {
      this.db
        .prepare("INSERT OR REPLACE INTO session_map (session_id, agent_session_id) VALUES (?, ?)")
        .run(input.id, input.agentSessionId)
    }
  }

  private deleteSessionProjection(id: string) {
    this.db.prepare("DELETE FROM session_subagent_observation WHERE parent_session_id = ?").run(id)
    this.db.prepare("DELETE FROM session_subagent_correlation WHERE parent_session_id = ?").run(id)
    this.db.prepare("DELETE FROM session_subagent_tool_call WHERE parent_session_id = ?").run(id)
    this.db.prepare("DELETE FROM session_subagent WHERE parent_session_id = ?").run(id)
    this.db.prepare("DELETE FROM queued_prompt WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM journal_checkpoint WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM pending_question WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM pending_permission WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM todo WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM part WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM message WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM session_execution_binding WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM session_map WHERE session_id = ?").run(id)
    this.db.prepare("DELETE FROM session WHERE id = ?").run(id)
  }

  private applySessionUpdate(sessionId: string, updates: SessionUpdate["updates"], ts: number) {
    if (updates.title !== undefined) {
      this.db.prepare("UPDATE session SET title = ?, updated_at = ? WHERE id = ?").run(updates.title, ts, sessionId)
    }
    if (updates.time?.archived !== undefined) {
      this.db
        .prepare("UPDATE session SET archived_at = ?, updated_at = ? WHERE id = ?")
        .run(updates.time.archived, ts, sessionId)
    }
  }

  /**
   * The stamps and directory `upsertSession` has to be handed back, because it
   * replaces every column it is given: any handler that writes a session row for
   * a reason other than the reader speaking to it must pass the existing
   * `updatedAt` through, or a runtime restart, a recovery or a rediscovery
   * restamps the row and the session list reorders under a reader who did
   * nothing. `getSession`'s return is the wire session shape, narrowed here to
   * what every such handler reads.
   */
  private sessionTimes(id: string) {
    const session = this.getSession(id) as
      | { directory?: string; time?: { created?: number; updated?: number } }
      | null
    return {
      directory: session?.directory ?? "",
      created: session?.time?.created,
      updated: session?.time?.updated,
    }
  }

  private applyControl(row: Extract<Row, { kind: "control" }>) {
    const control = row.control
    if (control.type === "session.bind") {
      this.db.prepare("DELETE FROM deleted_session WHERE session_id = ?").run(row.sessionId)
      const existing = this.sessionTimes(row.sessionId)
      this.upsertSession({
        id: row.sessionId,
        directory: control.directory,
        title: control.title,
        agentSessionId: control.agentSessionId,
        processKey: control.ownerKey !== undefined ? control.ownerKey : control.processKey,
        parentSessionId: control.parentSessionId,
        createdAt: control.createdAt ?? existing.created ?? row.ts,
        updatedAt: control.updatedAt ?? existing.updated ?? row.ts,
      })
      if (control.workspaceId && control.connectionId && control.upstreamSessionId) {
        this.db
          .prepare(
            `
            INSERT INTO session_execution_binding (
              session_id, workspace_id, directory, connection_id, upstream_session_id
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              workspace_id = excluded.workspace_id,
              directory = excluded.directory,
              connection_id = excluded.connection_id,
              upstream_session_id = excluded.upstream_session_id
          `,
          )
          .run(
            row.sessionId,
            control.workspaceId,
            control.directory,
            control.connectionId,
            control.upstreamSessionId,
          )
      }
      return
    }
    if (control.type === "turn.start") {
      const directory = this.sessionTimes(row.sessionId).directory
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
            ...(control.author ? { author: control.author } : {}),
          }),
          row.ts,
        )
        for (const part of buildUserPromptParts(row.sessionId, control.userMessageId, control.parts)) {
          this.upsertPart(part, row.ts)
        }
      }
      this.upsertMessage(
        buildAssistantMessage({
          id: control.assistantMessageId,
          sessionID: row.sessionId,
          parentID: control.userMessageId ?? control.parentMessageId ?? row.sessionId,
          agent: control.agent,
          model: control.model,
          directory,
          created: row.ts,
        }),
        row.ts,
      )
      this.upsertSession({
        id: row.sessionId,
        directory,
        createdAt: row.ts,
        updatedAt: row.ts,
        // A wake, a subagent or a channel message starts a turn the same way the
        // reader does, so `updated_at` alone cannot tell them apart. `actorKind`
        // comes from the request's auth claims and a client cannot forge it.
        ...(control.actorKind === "human" ? { lastHumanTurnAt: row.ts } : {}),
        status: "busy",
        recoveryError: null,
      })
      return
    }
    if (control.type === "turn.finish") return
    if (control.type === "goal.update") {
      this.db.prepare("UPDATE session SET goal_json = ? WHERE id = ?")
        .run(control.goal ? JSON.stringify(control.goal) : null, row.sessionId)
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
      this.db
        .prepare("INSERT OR REPLACE INTO deleted_session (session_id, deleted_at) VALUES (?, ?)")
        .run(row.sessionId, row.ts)
      return
    }
    if (control.type === "permission.staled") {
      this.db
        .prepare("UPDATE pending_permission SET status = 'stale', updated_at = ? WHERE id = ? AND status = 'pending'")
        .run(row.ts, control.permissionId)
      return
    }
    if (control.type === "question.staled") {
      this.db
        .prepare("UPDATE pending_question SET status = 'stale', updated_at = ? WHERE id = ? AND status = 'pending'")
        .run(row.ts, control.questionId)
      return
    }
    if (control.type === "session.recovering") {
      const session = this.sessionTimes(row.sessionId)
      this.finishTools(row.sessionId, row.ts, control.message)
      this.upsertSession({
        id: row.sessionId,
        directory: session.directory,
        createdAt: session.created ?? row.ts,
        updatedAt: session.updated ?? row.ts,
        status: "recovering",
        recoveryError: control.message,
      })
      return
    }
    if (control.type === "notice.acknowledged") {
      if (control.notice === "recovery_error") {
        this.db
          .prepare("UPDATE session SET recovery_error = NULL, updated_at = ? WHERE id = ?")
          .run(row.ts, row.sessionId)
      }
      return
    }
    if (control.type === "notice.created") {
      if (control.notice === "recovery_error") {
        const session = this.sessionTimes(row.sessionId)
        this.upsertSession({
          id: row.sessionId,
          directory: session.directory,
          createdAt: session.created ?? row.ts,
          updatedAt: session.updated ?? row.ts,
          recoveryError: control.message,
        })
      }
      return
    }
    if (control.type === "projection.reset_requested") {
      return
    }
    if (control.type === "session.interrupted" || control.type === "process.lost") {
      this.db
        .prepare(
          "UPDATE pending_permission SET status = 'stale', updated_at = ? WHERE session_id = ? AND status = 'pending'",
        )
        .run(row.ts, row.sessionId)
      this.db
        .prepare(
          "UPDATE pending_question SET status = 'stale', updated_at = ? WHERE session_id = ? AND status = 'pending'",
        )
        .run(row.ts, row.sessionId)
      const session = this.sessionTimes(row.sessionId)
      this.finishTools(row.sessionId, row.ts, control.message)
      this.upsertSession({
        id: row.sessionId,
        directory: session.directory,
        createdAt: session.created ?? row.ts,
        updatedAt: session.updated ?? row.ts,
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
        this.upsertMessage(event.properties.info, row.ts)
        return

      case "message.part.updated":
        this.upsertPart(event.properties.part, row.ts)
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
          this.db
            .prepare(
              "INSERT INTO todo (session_id, position, task_id, content, status, priority, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .run(event.properties.sessionID, i, todo.id ?? null, todo.content, todo.status, todo.priority, row.ts)
        })
        return

      case "permission.asked":
        this.db
          .prepare(
            `INSERT OR REPLACE INTO pending_permission
           (id, session_id, tool, patterns_json, metadata_json, always_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          )
          .run(
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
        this.db
          .prepare(
            `INSERT OR REPLACE INTO pending_question
           (id, session_id, questions_json, status, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?)`,
          )
          .run(
            event.properties.id,
            event.properties.sessionID,
            JSON.stringify(event.properties.questions),
            row.ts,
            row.ts,
          )
        return

      case "question.replied":
      case "question.rejected":
        this.db.prepare("DELETE FROM pending_question WHERE id = ?").run(event.properties.requestID)
        return

      case "message.completed": {
        const rowInfo = this.db
          .prepare<{ info_json: string }>("SELECT info_json FROM message WHERE id = ?")
          .get(event.properties.messageID)
        if (!rowInfo) return
        const info = readColumn.messageRecord(rowInfo.info_json)
        info.time = { ...rec(info.time), completed: row.ts }
        this.upsertMessage(info, row.ts)
        return
      }

      case "session.updated": {
        const info = event.properties.info
        this.db.prepare(`
          UPDATE session
          SET title = COALESCE(?, title),
              updated_at = COALESCE(?, updated_at),
              archived_at = COALESCE(?, archived_at)
          WHERE id = ?
        `).run(info.title ?? null, info.time?.updated ?? null, info.time?.archived ?? null, info.id)
        return
      }

      case "session.status": {
        const current = this.getSession(event.properties.sessionID) as
          | { directory?: string; time?: { created?: number; updated?: number } }
          | null
        this.upsertSession({
          id: event.properties.sessionID,
          directory: current?.directory ?? "",
          createdAt: current?.time?.created ?? row.ts,
          // Status polls / visit must not reshuffle the session list.
          updatedAt: current?.time?.updated ?? row.ts,
          status: event.properties.status.type,
        })
        return
      }

      case "session.idle": {
        const current = this.getSession(event.properties.sessionID) as
          | { directory?: string; time?: { created?: number; updated?: number } }
          | null
        this.upsertSession({
          id: event.properties.sessionID,
          directory: current?.directory ?? "",
          createdAt: current?.time?.created ?? row.ts,
          updatedAt: current?.time?.updated ?? row.ts,
          status: "idle",
        })
        return
      }

      case "session.error": {
        const current = this.getSession(event.properties.sessionID ?? row.sessionId) as
          | { directory?: string; time?: { created?: number; updated?: number } }
          | null
        this.upsertSession({
          id: event.properties.sessionID ?? row.sessionId,
          directory: current?.directory ?? "",
          createdAt: current?.time?.created ?? row.ts,
          updatedAt: current?.time?.updated ?? row.ts,
          status: "error",
        })
        return
      }

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
    workspaceId?: string
    directory: string
    connectionId?: string
    upstreamSessionId?: string
    title?: string
    agentSessionId: string
    ownerKey?: string | null
    parentSessionId?: string
    createdAt?: number
    updatedAt?: number
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
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        directory: input.directory,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        ...(input.upstreamSessionId ? { upstreamSessionId: input.upstreamSessionId } : {}),
        title: input.title,
        agentSessionId: input.agentSessionId,
        ...(input.ownerKey !== undefined ? { ownerKey: input.ownerKey } : {}),
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
        createdAt: ts,
        ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}),
      },
    }
    this.commit(row)
  }

  private turnStartEvents(row: TurnStartRow): CompatEvent[] {
    const control = row.control
    const directory = this.sessionTimes(row.sessionId).directory
    return [
      sessionStatus(row.sessionId, { type: "busy" }),
      ...(control.userMessageId
        ? [
            messageUpdated(
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
                ...(control.author ? { author: control.author } : {}),
              }),
            ),
            ...buildUserPromptParts(row.sessionId, control.userMessageId, control.parts).map(messagePartUpdated),
          ]
        : []),
      messageUpdated(
        buildAssistantMessage({
          id: control.assistantMessageId,
          sessionID: row.sessionId,
          parentID: control.userMessageId ?? control.parentMessageId ?? row.sessionId,
          agent: control.agent,
          model: control.model,
          directory,
          created: row.ts,
        }),
      ),
    ]
  }

  startTurn(input: {
    sessionId: string
    agentSessionId?: string
    userMessageId?: string
    parentMessageId?: string
    assistantMessageId: string
    agent: string
    model: Model
    parts: unknown[]
    tools?: Record<string, boolean>
    format?: PromptFormat
    system?: string
    variant?: string
    actorId?: string
    actorKind?: "human" | "agent"
    author?: Turn["author"]
    fencingToken?: number
  }) {
    const active = this.db
      .prepare<{
      seq: number
      created_at: number
      provider_session_id: string | null
    }>(
        `
        SELECT start.seq, start.created_at, start.provider_session_id
        FROM runtime_journal start
        WHERE start.session_id = ?
          AND start.kind = 'control'
          AND start.type = 'turn.start'
          AND start.assistant_message_id = ?
          AND NOT EXISTS (
            SELECT 1
            FROM runtime_journal finish
            WHERE finish.session_id = start.session_id
              AND finish.kind = 'control'
              AND finish.type = 'turn.finish'
              AND finish.assistant_message_id = start.assistant_message_id
          )
        ORDER BY start.seq DESC
        LIMIT 1
      `,
      )
      .get(input.sessionId, input.assistantMessageId)
    if (active) {
      const activeStart = requireRow(
        this.db
          .prepare<{ payload_json: string }>(
            `
        SELECT payload_json FROM runtime_journal
        WHERE session_id = ? AND kind = 'control' AND type = 'turn.start' AND assistant_message_id = ?
        ORDER BY seq DESC LIMIT 1
      `,
          )
          .get(input.sessionId, input.assistantMessageId),
        "runtime_journal turn.start",
      )
      const activeControl = readColumn.turnStart(activeStart.payload_json)
      if (input.fencingToken !== activeControl.fencingToken) throw new AgentRuntimeStaleTurnError(input.sessionId)
      return {
        sessionId: input.sessionId,
        seq: active.seq,
        createdAt: active.created_at,
        ...(active.provider_session_id ? { agentSessionId: active.provider_session_id } : {}),
        events: [],
      } satisfies RuntimeStoreTurnStartOutput
    }
    const row: TurnStartRow = {
      seq: this.next(input.sessionId),
      ts: Date.now(),
      sessionId: input.sessionId,
      ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
      kind: "control",
      control: {
        type: "turn.start",
        userMessageId: input.userMessageId,
        parentMessageId: input.parentMessageId,
        assistantMessageId: input.assistantMessageId,
        agent: input.agent,
        model: input.model,
        parts: input.parts,
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.format ? { format: input.format } : {}),
        ...(input.system ? { system: input.system } : {}),
        ...(input.variant ? { variant: input.variant } : {}),
        ...(input.actorId && input.actorKind ? { actorId: input.actorId, actorKind: input.actorKind } : {}),
        ...(input.fencingToken !== undefined ? { fencingToken: input.fencingToken } : {}),
        ...(input.author ? { author: input.author } : {}),
      },
    }
    const committed = this.commit(row, (input.fencingToken !== undefined ? { fencingToken: input.fencingToken, advance: true } : {}))
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
      .prepare<{ id: string; agent_session_id: string | null }>(
        `
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
      `,
      )
      .all(directory)
    for (const row of rows) {
      this.markSessionInterrupted(row.id, message, row.agent_session_id)
    }
  }

  markSessionsInterruptedByOwner(ownerKey: string, message = ACP_RECOVER) {
    const rows = this.db
      .prepare<{ id: string; agent_session_id: string | null }>(
        `
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
      `,
      )
      .all(ownerKey)
    for (const row of rows) {
      this.markSessionInterrupted(row.id, message, row.agent_session_id)
    }
  }

  markSessionInterrupted(sessionId: string, message = ACP_RECOVER, agentSessionId?: string | null) {
    const agent =
      agentSessionId !== undefined
        ? agentSessionId
        : ((
            this.db.prepare<{
              agent_session_id: string | null
            }>("SELECT agent_session_id FROM session WHERE id = ?").get(sessionId)
          )?.agent_session_id ?? null)
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
    source?: RuntimeEventSource
    fencingToken?: number
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
    const committed = this.commit(row, (input.fencingToken !== undefined ? { fencingToken: input.fencingToken } : {}))
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
    outcome: AgentTurnOutcome
    fencingToken?: number
  }) {
    this.assertFencingToken(input.sessionId, input.fencingToken)
    const active = this.db
      .prepare<{
      provider_session_id: string | null
      user_message_id: string | null
      assistant_message_id: string | null
      payload_json: string
      created_at: number
    }>(
        `
        SELECT provider_session_id, user_message_id, assistant_message_id, payload_json, created_at
        FROM runtime_journal
        WHERE session_id = ? AND kind = 'control' AND type = 'turn.start'
        ORDER BY seq DESC
        LIMIT 1
      `,
      )
      .get(input.sessionId)
    if (!active?.assistant_message_id) return { events: [] }
    if (input.assistantMessageId && input.assistantMessageId !== active.assistant_message_id) return { events: [] }
    if (this.hasTurnFinished(input.sessionId, active.assistant_message_id)) return { events: [] }
    const events: CompatEvent[] = []

    if (input.outcome.status === "failed") {
      const control = readColumn.turnStart(active.payload_json)
      const session = this.getSession(input.sessionId)
      events.push(this.appendEvent({
        sessionId: input.sessionId,
        ...(active.provider_session_id ? { agentSessionId: active.provider_session_id } : {}),
        payload: messageUpdated(
          buildAssistantMessage({
            id: active.assistant_message_id,
            sessionID: input.sessionId,
            parentID: active.user_message_id ?? control.parentMessageId ?? input.sessionId,
            agent: control.agent ?? "build",
            model: control.model,
            directory: session?.directory ?? "",
            created: active.created_at,
            completed: input.outcome.completedAt,
            error: { name: "UnknownError", data: firstTurnErrorData(input.outcome.error ?? "turn failed") },
            ...(control.variant ? { variant: control.variant } : {}),
          }),
        ),
        ...(input.fencingToken !== undefined ? { fencingToken: input.fencingToken } : {}),
      }).payload)
      events.push(this.appendEvent({
        sessionId: input.sessionId,
        ...(active.provider_session_id ? { agentSessionId: active.provider_session_id } : {}),
        payload: sessionError(input.outcome.error ?? "turn failed", input.sessionId),
        ...(input.fencingToken !== undefined ? { fencingToken: input.fencingToken } : {}),
      }).payload)
    } else if (!this.hasMessageCompleted(input.sessionId, active.assistant_message_id)) {
      this.appendEvent({
        sessionId: input.sessionId,
        ...(active.provider_session_id ? { agentSessionId: active.provider_session_id } : {}),
        payload: messageCompleted(input.sessionId, active.assistant_message_id),
        ...(input.fencingToken !== undefined ? { fencingToken: input.fencingToken } : {}),
      })
      this.appendEvent({
        sessionId: input.sessionId,
        ...(active.provider_session_id ? { agentSessionId: active.provider_session_id } : {}),
        payload: sessionIdle(input.sessionId),
        ...(input.fencingToken !== undefined ? { fencingToken: input.fencingToken } : {}),
      })
    }

    this.commit({
      seq: this.next(input.sessionId),
      ts: input.outcome.completedAt,
      sessionId: input.sessionId,
      ...(active.provider_session_id ? { agentSessionId: active.provider_session_id } : {}),
      kind: "control",
      control: {
        type: "turn.finish",
        assistantMessageId: active.assistant_message_id,
        outcome: { ...input.outcome, assistantMessageId: active.assistant_message_id },
      },
    }, (input.fencingToken !== undefined ? { fencingToken: input.fencingToken } : {}))
    return { events }
  }

  private hasMessageCompleted(sessionId: string, messageId: string) {
    return !!this.db
      .prepare(
        `
        SELECT 1
        FROM runtime_journal
        WHERE session_id = ?
          AND kind = 'event'
          AND type = 'message.completed'
          AND json_extract(payload_json, '$.properties.messageID') = ?
        LIMIT 1
      `,
      )
      .get(sessionId, messageId)
  }

  private hasTurnFinished(sessionId: string, messageId: string) {
    return !!this.db
      .prepare(
        `
        SELECT 1
        FROM runtime_journal
        WHERE session_id = ?
          AND kind = 'control'
          AND type = 'turn.finish'
          AND assistant_message_id = ?
        LIMIT 1
      `,
      )
      .get(sessionId, messageId)
  }

  private session(row: {
    id: string
    workspace_id?: string | null
    parent_id?: string | null
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
    last_human_turn_at?: number | null
    archived_at?: number | null
    status?: string | null
    recovery_error?: string | null
    agent_session_id?: string | null
  }) {
    const harness = sessionHarness(row)
    const lastTurn = this.lastTurn(row.id)
    return {
      id: row.id,
      ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
      title: row.title,
      directory: row.directory,
      time: {
        created: row.created_at,
        updated: row.updated_at,
        /* Null on every session that predates the column, and on one only agents have
           ever driven — both read as "the reader has not been here", which is true. */
        ...(row.last_human_turn_at !== undefined && row.last_human_turn_at !== null
          ? { lastHumanTurn: row.last_human_turn_at }
          : {}),
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
      ...(row.parent_id ? { parentID: row.parent_id } : {}),
      ...(row.process_key ? { process_key: row.process_key } : {}),
      ...(lastTurn ? { lastTurn } : {}),
    }
  }

  private lastTurn(sessionId: string): AgentTurnOutcome | undefined {
    const row = this.db
      .prepare<{ seq: number; type: string; created_at: number; payload_json: string }>(
        `
        SELECT seq, type, created_at, payload_json
        FROM runtime_journal
        WHERE session_id = ?
          AND (
            (kind = 'control' AND type = 'turn.finish')
            OR (kind = 'event' AND type IN ('message.completed', 'session.error'))
          )
        ORDER BY seq DESC
        LIMIT 1
      `,
      )
      .get(sessionId)
    if (!row) return undefined
    if (row.type === "turn.finish") return readColumn.turnFinish(row.payload_json).outcome
    const properties = readColumn.eventPayload(row.payload_json).properties
    if (row.type === "message.completed") {
      const assistantMessageId = str(properties?.messageID)
      if (!assistantMessageId) return undefined
      return {
        status: "completed",
        assistantMessageId,
        completedAt: row.created_at,
      }
    }
    const message = str(rec(rec(properties?.error)?.data)?.message)
    return {
      status: "failed",
      assistantMessageId: this.lastStartedAssistant(sessionId, row.seq),
      completedAt: row.created_at,
      error: message ?? "session error",
    }
  }

  private lastStartedAssistant(sessionId: string, beforeSeq: number) {
    const row = this.db
      .prepare<{ assistant_message_id: string | null }>(
        `
        SELECT assistant_message_id
        FROM runtime_journal
        WHERE session_id = ?
          AND kind = 'control'
          AND type = 'turn.start'
          AND seq < ?
        ORDER BY seq DESC
        LIMIT 1
      `,
      )
      .get(sessionId, beforeSeq)
    return row?.assistant_message_id ?? undefined
  }

  listSessions(directory: string) {
    return (
      this.db
        .prepare<{
        id: string
        workspace_id: string | null
        parent_id: string | null
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
      }>(
          `
        SELECT
          session.id,
          binding.workspace_id,
          parent_id,
	          session.directory,
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
          last_human_turn_at,
          status,
          recovery_error,
          archived_at
        FROM session
        LEFT JOIN session_execution_binding binding ON binding.session_id = session.id
        WHERE session.directory = ?
        ORDER BY created_at DESC
      `,
        )
        .all(directory)
    ).map((row) => this.session(row))
  }

  stalePermission(id: string) {
    const row = this.db.prepare<{
      session_id: string
    }>("SELECT session_id FROM pending_permission WHERE id = ?").get(id)
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
    const row = this.db.prepare<{
      session_id: string
    }>("SELECT session_id FROM pending_question WHERE id = ?").get(id)
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
      .prepare<{
      id: string
      workspace_id: string | null
      parent_id: string | null
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
    }>(
        `
        SELECT
          session.id,
          binding.workspace_id,
          parent_id,
	          session.directory,
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
          last_human_turn_at,
          status,
          recovery_error,
          archived_at,
          agent_session_id
        FROM session
        LEFT JOIN session_execution_binding binding ON binding.session_id = session.id
        WHERE session.id = ?
      `,
      )
      .get(id)
    if (!row) return null
    return this.session(row)
  }

  getAgentSessionId(id: string) {
    const row = this.db.prepare<{
      agent_session_id: string | null
    }>("SELECT agent_session_id FROM session WHERE id = ?").get(id)
    return row?.agent_session_id ?? null
  }

  getExecutionBinding(sessionId: string): AgentExecutionBinding | null {
    const row = this.db
      .prepare<{
      session_id: string
      workspace_id: string
      directory: string
      connection_id: string
      upstream_session_id: string
    }>(
        `
        SELECT session_id, workspace_id, directory, connection_id, upstream_session_id
        FROM session_execution_binding
        WHERE session_id = ?
      `,
      )
      .get(sessionId)
    if (!row) return null
    return {
      sessionId: row.session_id,
      workspaceId: row.workspace_id,
      directory: row.directory,
      connectionId: row.connection_id,
      upstreamSessionId: row.upstream_session_id,
    }
  }

  getSessionOwnerKey(id: string) {
    const row = this.db.prepare<{
      process_key: string | null
    }>("SELECT process_key FROM session WHERE id = ?").get(id)
    return row?.process_key ?? null
  }

  listSessionsByOwnerKey(ownerKey: string) {
    return (
      this.db.prepare<{
        id: string
      }>("SELECT id FROM session WHERE process_key = ? ORDER BY created_at ASC").all(ownerKey)
    ).map((row) => row.id)
  }

  getSessionByAgent(agentSessionId: string) {
    const row = this.db
      .prepare<{ session_id: string }>("SELECT session_id FROM session_map WHERE agent_session_id = ?")
      .get(agentSessionId)
    return row?.session_id ?? null
  }

  /**
   * Pending permissions for a directory, as `AgentPermission`.
   *
   * The projection used to emit `{ id, sessionID, tool, paths }` — none of
   * which are contract fields — and reach the declared `AgentPermission[]`
   * through an `any`-typed row callback. It now returns what it promises:
   * `always_json` and `metadata_json` were already written by the
   * `permission.asked` handler and simply never read back.
   */
  listPermissions(directory: string): AgentPermission[] {
    return this.db
      .prepare<{
      id: string
      session_id: string
      tool: string
      patterns_json: string
      always_json: string
      metadata_json: string
    }>(
        `
        SELECT p.id, p.session_id, p.tool, p.patterns_json, p.always_json, p.metadata_json
        FROM pending_permission p
        JOIN session s ON s.id = p.session_id
        WHERE s.directory = ? AND p.status = 'pending'
        ORDER BY p.created_at ASC
      `,
      )
      .all(directory)
      .map((row) => ({
        id: row.id,
        sessionID: row.session_id,
        // The `tool` COLUMN stores `properties.permission` (see the
        // `permission.asked` writer above); the contract names it `permission`.
        permission: row.tool,
        patterns: readColumn.permissionPatterns(row.patterns_json),
        always: readColumn.permissionPatterns(row.always_json),
        metadata: readColumn.permissionMetadata(row.metadata_json),
      }))
  }

  listQuestions(directory: string): AgentQuestion[] {
    return this.db
      .prepare<{ id: string; session_id: string; questions_json: string }>(
        `
        SELECT q.id, q.session_id, q.questions_json
        FROM pending_question q
        JOIN session s ON s.id = q.session_id
        WHERE s.directory = ? AND q.status = 'pending'
        ORDER BY q.created_at ASC
      `,
      )
      .all(directory)
      .map((row) => ({
        id: row.id,
        sessionID: row.session_id,
        questions: readColumn.questions(row.questions_json),
      }))
  }

  getTodos(sessionId: string) {
    return this.db
      .prepare<{ id: string | null; content: string; status: string; priority: string }>("SELECT task_id AS id, content, status, priority FROM todo WHERE session_id = ? ORDER BY position ASC")
      .all(sessionId)
      .map(({ id, ...todo }) => ({ ...todo, ...(id === null ? {} : { id }) }))
  }

  private hydrateMessages(sessionId: string, msgs: MessageProjectionRow[]): AgentMessage[] {
    if (msgs.length === 0) return []
    const partsByMessage = new Map<string, AgentMessage["parts"]>()
    for (let offset = 0; offset < msgs.length; offset += MESSAGE_HYDRATION_BATCH_SIZE) {
      const batch = msgs.slice(offset, offset + MESSAGE_HYDRATION_BATCH_SIZE)
      const placeholders = batch.map(() => "?").join(", ")
      const parts = this.db
        .prepare<{ message_id: string; data_json: string }>(
          `
          SELECT message_id, data_json
          FROM part
          WHERE session_id = ? AND message_id IN (${placeholders})
          ORDER BY message_id ASC, ord ASC
        `,
        )
        .all(sessionId, ...batch.map((message) => message.id))
      for (const part of parts) {
        const current = partsByMessage.get(part.message_id) ?? []
        current.push(readColumn.messagePart(part.data_json))
        partsByMessage.set(part.message_id, current)
      }
    }

    return msgs.map((msg) => {
      const info = readColumn.messageInfo(msg.info_json)
      const infoRecord = info as Record<string, unknown>
      const time = asRecord(info.time)
      const completed = typeof time?.completed === "number"
      const err = asRecord(infoRecord.error)
      const data = asRecord(err?.data)
      const message = str(data?.message) ?? str(err?.message)
      const terminal = info.role === "assistant" && (completed || !!infoRecord.error)
      const ts = num(time?.completed) ?? num(time?.created) ?? Date.now()
      const messageParts = partsByMessage.get(msg.id) ?? []
      return {
        info,
        parts: terminal ? messageParts.map((part) => this.terminalizedPart(part, ts, message)) : messageParts,
      }
    })
  }

  /**
   * Hydrate the canonical first-paint projection directly from persistence.
   * The callers supply already-projected message envelopes, and the part query
   * excludes non-text JSON before it crosses the SQLite/JavaScript boundary.
   */
  private hydrateSurfaceMessages(sessionId: string, msgs: MessageProjectionRow[]): AgentMessage[] {
    if (msgs.length === 0) return []
    const placeholders = msgs.map(() => "?").join(", ")
    const candidates = this.db
      .prepare<{
        part_id: string
        message_id: string
        part_ord: number
        message_ord: number
        text_bytes: number
        part_bytes: number
      }>(
        `
        SELECT
          p.id AS part_id,
          p.message_id,
          p.ord AS part_ord,
          m.ord AS message_ord,
          length(CAST(json_extract(p.data_json, '$.text') AS BLOB)) AS text_bytes,
          length(CAST(p.data_json AS BLOB)) AS part_bytes
        FROM part p
        INNER JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
        WHERE p.session_id = ?
          AND p.message_id IN (${placeholders})
          AND json_extract(p.data_json, '$.type') = 'text'
          AND typeof(json_extract(p.data_json, '$.text')) = 'text'
          AND length(CAST(json_extract(p.data_json, '$.text') AS BLOB)) <= ?
          AND length(CAST(p.data_json AS BLOB)) <= ?
        ORDER BY m.ord DESC, p.ord DESC
      `,
      )
      .all(
        sessionId,
        ...msgs.map((message) => message.id),
        LATEST_SURFACE_MAX_TEXT_PART_BYTES,
        LATEST_SURFACE_MAX_PART_BYTES,
      )
    const selectedIndexes = selectLatestSurfaceTextCandidateIndexes(
      candidates.map((candidate) => ({ textBytes: candidate.text_bytes, partBytes: candidate.part_bytes })),
    )
    const selectedIds = selectedIndexes.map((index) => candidates[index].part_id)
    if (selectedIds.length === 0) {
      return msgs.map((msg) => ({
        info: readColumn.messageInfo(msg.info_json),
        parts: [],
      }))
    }
    const selectedPlaceholders = selectedIds.map(() => "?").join(", ")
    const parts = this.db
      .prepare<{ message_id: string; data_json: string }>(
        `
        SELECT p.message_id, p.data_json
        FROM part p
        INNER JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
        WHERE p.session_id = ? AND p.id IN (${selectedPlaceholders})
        ORDER BY m.ord ASC, p.ord ASC
      `,
      )
      .all(sessionId, ...selectedIds)
    const partsByMessage = new Map<string, AgentMessage["parts"]>()
    for (const part of parts) {
      const current = partsByMessage.get(part.message_id) ?? []
      current.push(readColumn.messagePart(part.data_json))
      partsByMessage.set(part.message_id, current)
    }
    return msgs.map((msg) => ({
      info: readColumn.messageInfo(msg.info_json),
      parts: partsByMessage.get(msg.id) ?? [],
    }))
  }

  getMessages(sessionId: string): AgentMessage[] {
    const msgs = this.db
      .prepare<MessageProjectionRow>("SELECT id, ord, info_json FROM message WHERE session_id = ? ORDER BY ord ASC")
      .all(sessionId)
    return this.hydrateMessages(sessionId, msgs)
  }

  getLatestUserMessageId(sessionId: string) {
    return this.db.prepare<{ id: string }>(
      "SELECT id FROM message WHERE session_id = ? AND role = 'user' ORDER BY ord DESC LIMIT 1",
    ).get(sessionId)?.id
  }

  getMessagePage(sessionId: string, page: AgentMessagePageInput): AgentMessagePage | undefined {
    if (!this.getSession(sessionId)) {
      throw new AgentMessagePageError(404, `Session not found: ${sessionId}`)
    }
    const projection = this.db
      .prepare<{ present: number }>("SELECT 1 AS present FROM message WHERE session_id = ? LIMIT 1")
      .get(sessionId)
    // Undefined distinguishes a missing projection from an exhausted page.
    // The workspace host uses the owning adapter's paging capability to decide
    // whether this means engine-owned history or an authoritative empty store.
    if (!projection) return undefined
    if ("view" in page && page.view !== undefined) {
      const boundary = this.db
        .prepare<Pick<MessageProjectionRow, "id" | "ord">>(
          `
          SELECT id, ord
          FROM message
          WHERE session_id = ? AND role = 'user'
          ORDER BY ord DESC
          LIMIT 1
        `,
        )
        .get(sessionId)
      if (!boundary) {
        throw new AgentMessagePageError(409, `Latest turn boundary is unavailable for session: ${sessionId}`)
      }
      if (page.view === "latest-surface") {
        const boundaryInfo = this.db
          .prepare<Pick<SurfaceTurnRow, "info_id">>(
            `
            SELECT json_extract(info_json, '$.id') AS info_id
            FROM message
            WHERE session_id = ? AND ord = ?
          `,
          )
          .get(sessionId, boundary.ord)
        if (boundaryInfo?.info_id !== boundary.id) {
          throw new AgentMessagePageError(409, `Latest turn projection is not contiguous for session: ${sessionId}`)
        }
        const final = this.db
          .prepare<SurfaceTurnRow>(
            `
            SELECT
              id,
              ord,
              role,
              json_extract(info_json, '$.id') AS info_id,
              json_extract(info_json, '$.parentID') AS parent_id
            FROM message
            WHERE session_id = ? AND ord >= ?
            ORDER BY ord DESC
            LIMIT 1
          `,
          )
          .get(sessionId, boundary.ord)
        const invalidAssistant = this.db
          .prepare<{ present: number }>(
            `
            SELECT 1 AS present
            FROM message
            WHERE session_id = ?
              AND ord > ?
              AND (
                role IS NOT 'assistant'
                OR json_extract(info_json, '$.id') IS NOT id
                OR json_extract(info_json, '$.parentID') IS NOT ?
              )
            LIMIT 1
          `,
          )
          .get(sessionId, boundary.ord, boundary.id)
        if (!final || invalidAssistant) {
          throw new AgentMessagePageError(409, `Latest turn projection is not contiguous for session: ${sessionId}`)
        }
        const selectedIds = final.id === boundary.id ? [boundary.id] : [boundary.id, final.id]
        const placeholders = selectedIds.map(() => "?").join(", ")
        const selected = this.db
          .prepare<MessageProjectionRow>(
            `
            WITH projected AS (
            SELECT
              id,
              ord,
              CASE
                WHEN role = 'user' THEN json_remove(info_json, '$.summary', '$.system', '$.tools')
                WHEN role = 'assistant'
                  AND length(CAST(json_extract(info_json, '$.error') AS BLOB)) > ?
                THEN json_remove(info_json, '$.error')
                ELSE info_json
              END AS info_json
            FROM message
            WHERE session_id = ? AND id IN (${placeholders})
            )
            SELECT id, ord, info_json
            FROM projected
            WHERE length(CAST(info_json AS BLOB)) <= ?
            ORDER BY ord ASC
          `,
          )
          .all(
            LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES,
            sessionId,
            ...selectedIds,
            LATEST_SURFACE_MAX_INFO_BYTES,
          )
        const older = this.db
          .prepare<{ present: number }>("SELECT 1 AS present FROM message WHERE session_id = ? AND ord < ? LIMIT 1")
          .get(sessionId, boundary.ord)
        const intermediate = this.db
          .prepare<{ present: number }>("SELECT 1 AS present FROM message WHERE session_id = ? AND ord > ? AND ord < ? LIMIT 1")
          .get(sessionId, boundary.ord, final.ord)
        return {
          messages: selected.length === selectedIds.length ? this.hydrateSurfaceMessages(sessionId, selected) : [],
          ...(older || intermediate ? { nextCursor: encodeMessagePageCursor(sessionId, final.ord) } : {}),
        }
      }
      const turn = this.db
        .prepare<MessageProjectionRow>(
          `
          SELECT id, ord, info_json
          FROM message
          WHERE session_id = ? AND ord >= ?
          ORDER BY ord ASC
        `,
        )
        .all(sessionId, boundary.ord)
      const user = readColumn.messageInfo(turn[0].info_json)
      const contiguous =
        turn.length > 0 &&
        turn.every((row, index) => {
          const message = readColumn.messageInfo(row.info_json)
          if (index === 0) return message.role === "user" && message.id === user.id
          return message.role === "assistant" && message.parentID === user.id
        })
      if (!contiguous) {
        throw new AgentMessagePageError(409, `Latest turn projection is not contiguous for session: ${sessionId}`)
      }
      const older = this.db
        .prepare<{ present: number }>("SELECT 1 AS present FROM message WHERE session_id = ? AND ord < ? LIMIT 1")
        .get(sessionId, boundary.ord)
      return {
        messages: this.hydrateMessages(sessionId, turn),
        ...(older ? { nextCursor: encodeMessagePageCursor(sessionId, boundary.ord) } : {}),
      }
    }
    if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > MAX_MESSAGE_PAGE_LIMIT) {
      throw new AgentMessagePageError(400, `Message page limit must be between 1 and ${MAX_MESSAGE_PAGE_LIMIT}`)
    }
    const beforeOrd = page.before === undefined ? undefined : decodeMessagePageCursor(sessionId, page.before)
    const params: unknown[] = [sessionId]
    if (beforeOrd !== undefined) params.push(beforeOrd)
    params.push(page.limit + 1)
    const rows = this.db
      .prepare<MessageProjectionRow>(
        `
        SELECT id, ord, info_json
        FROM message
        WHERE session_id = ?${beforeOrd === undefined ? "" : " AND ord < ?"}
        ORDER BY ord DESC
        LIMIT ?
      `,
      )
      .all(...params)
    const hasMore = rows.length > page.limit
    const selected = rows.slice(0, page.limit).reverse()
    return {
      messages: this.hydrateMessages(sessionId, selected),
      ...(hasMore && selected[0] ? { nextCursor: encodeMessagePageCursor(sessionId, selected[0].ord) } : {}),
    }
  }

  getSessionMaxSeq(sessionId: string) {
    const row = requireRow(
      this.db
        .prepare<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM runtime_journal WHERE session_id = ?")
        .get(sessionId),
      "runtime_journal max seq",
    )
    return row.seq
  }

  getSessionFencingToken(sessionId: string) {
    return this.latestFencingToken(sessionId)
  }

  acquireTurnLease(sessionId: string) {
    const leaseId = `${sessionId}:${crypto.randomUUID()}`
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO session_turn_lease (session_id, lease_id, acquired_at)
      VALUES (?, ?, ?)
    `).run(sessionId, leaseId, Date.now())
    return result.changes === 1 ? leaseId : undefined
  }

  releaseTurnLease(sessionId: string, leaseId: string) {
    this.db.prepare(`DELETE FROM session_turn_lease WHERE session_id = ? AND lease_id = ?`).run(sessionId, leaseId)
  }

  /**
   * A per-store random secret, minted on first read and never rotated, so ids
   * derived from it (idempotent child sessions) stay stable across restarts
   * and differ between runtimes that never shared a store.
   */
  runtimeSecret(name: string) {
    const existing = this.db.prepare<{ value: string }>("SELECT value FROM runtime_secret WHERE name = ?").get(name)
    if (existing) return existing.value
    const value = randomBytes(32).toString("hex")
    this.db.prepare("INSERT INTO runtime_secret(name, value, created_at) VALUES (?, ?, ?)").run(name, value, Date.now())
    return value
  }

  deleteSession(id: string) {
    if (!this.getSession(id)) return
    const children = (
      this.db.prepare<{
        id: string
      }>("SELECT id FROM session WHERE parent_id = ? ORDER BY created_at ASC").all(id)
    ).map((row) => row.id)
    for (const child of children) this.deleteSession(child)
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
    if (updates.time?.archived !== undefined) {
      this.interruptSubagents(id, "archive", updates.time.archived)
    }
    return this.getSession(id)
  }

  consumeRecoveryError(id: string) {
    const row = this.db.prepare<{
      recovery_error: string | null
    }>("SELECT recovery_error FROM session WHERE id = ?").get(id)
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
      .prepare<{
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
      instructions: string | null
      group_json: string | null
      handoff_json: string | null
      permission_state_json: string | null
      permission_ceiling: SessionConfig["permissionCeiling"] | null
      permission_mode: string | null
    }>(
        `
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
          agent,
          instructions,
          group_json,
          handoff_json,
          permission_ceiling,
          permission_mode,
          permission_state_json
        FROM session
        WHERE id = ?
      `,
      )
      .get(id)
    if (!row) return null
    const harness = sessionHarness(row)
    if (!harness) return null
    const handoff = sessionHandoff(row.handoff_json)
    const group = parseStoredSessionModelGroup(row.group_json)
    return {
      harness,
      ...(row.model_provider_id && row.model_id
        ? { model: { providerID: row.model_provider_id, modelID: row.model_id } }
        : {}),
      variant: nullable(row.variant) ?? null,
      agent: nullable(row.agent) ?? null,
      ...(nullable(row.instructions) ? { instructions: row.instructions } : {}),
      ...(group ? { group } : {}),
      ...(handoff ? { handoff } : {}),
      ...(row.permission_ceiling ? { permissionCeiling: row.permission_ceiling } : {}),
      ...(row.permission_mode ? { permissionMode: row.permission_mode } : {}),
      ...(row.permission_state_json ? { permissionState: JSON.parse(row.permission_state_json) } : {}),
    }
  }

  private applyConfigUpdate(id: string, patch: SessionConfigUpdate, ts = Date.now(), directory?: string) {
    const prev = this.db
      .prepare<{
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
      instructions: string | null
      group_json: string | null
      handoff_json: string | null
      permission_state_json: string | null
      permission_ceiling: SessionConfig["permissionCeiling"] | null
      permission_mode: string | null
      updated_at: number
    }>(
        `
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
          agent,
          instructions,
          group_json,
          handoff_json,
          permission_ceiling,
          permission_mode,
          permission_state_json,
          updated_at
        FROM session
        WHERE id = ?
      `,
      )
      .get(id)
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
        instructions: patch.instructions ?? null,
        group: patch.group ?? null,
        handoff: patch.handoff,
        createdAt: ts,
        updatedAt: ts,
      })
      if (patch.permissionCeiling !== undefined || patch.permissionMode !== undefined || patch.permissionState !== undefined) {
        this.applyConfigUpdate(id, { permissionCeiling: patch.permissionCeiling, permissionMode: patch.permissionMode, permissionState: patch.permissionState }, ts, directory)
      }
      return
    }
    const nextHarness = patch.harness ?? prevHarness
    const nextModelId = patch.model === undefined ? (prev?.model_id ?? null) : (patch.model?.modelID ?? null)
    // Config hydrate / visit must not bump the session list's updated_at.
    this.db
      .prepare(
        `
	      UPDATE session
	      SET harness_id = ?, harness_access = ?, harness_binary = ?, harness_transport = ?, harness_url = ?, harness_headers_json = ?, model_provider_id = ?, model_id = ?, variant = ?, agent = ?, instructions = ?, group_json = ?, handoff_json = ?, permission_mode = ?, permission_state_json = ?, permission_ceiling = ?, updated_at = ?
	      WHERE id = ?
	    `,
      )
      .run(
        nextHarness?.id ?? null,
        nextHarness?.access ?? null,
        null,
        null,
        null,
        null,
        patch.model === undefined ? (prev?.model_provider_id ?? null) : (patch.model?.providerID ?? null),
        nextModelId,
        patch.variant === undefined ? (prev?.variant ?? null) : patch.variant,
        patch.agent === undefined ? (prev?.agent ?? null) : patch.agent,
        patch.instructions === undefined ? (prev?.instructions ?? null) : patch.instructions,
        patch.group === undefined ? (prev?.group_json ?? null) : sessionModelGroupJson(patch.group),
        patch.handoff === undefined ? (prev?.handoff_json ?? null) : sessionHandoffJson(patch.handoff),
        patch.permissionMode === undefined
          ? nextHarness?.id === prevHarness?.id && nextHarness?.access === prevHarness?.access ? prev.permission_mode : null
          : patch.permissionMode,
        patch.permissionState === undefined
          ? nextHarness?.id === prevHarness?.id && nextHarness?.access === prevHarness?.access ? prev.permission_state_json : null
          : patch.permissionState ? JSON.stringify(patch.permissionState) : null,
        patch.permissionCeiling ?? prev.permission_ceiling,
        prev.updated_at,
        id,
      )
  }

  getGoal(id: string): RuntimeGoalSnapshot | null {
    const row = this.db.prepare<{ goal_json: string | null }>("SELECT goal_json FROM session WHERE id = ?").get(id)
    return row?.goal_json ? JSON.parse(row.goal_json) : null
  }

  setGoal(id: string, goal: RuntimeGoalSnapshot | null) {
    if (!this.getSession(id)) return
    this.commit({
      seq: this.next(id), ts: Date.now(), sessionId: id, kind: "control",
      control: { type: "goal.update", goal },
    })
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
