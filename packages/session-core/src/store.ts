import { SessionAuthoringOwnership } from "./session/authoring-ownership"
import type { TurnOutline, AgentPresentationEvent } from "@claxedo/agent-runtime-contract"
import { readTurnOutline } from "./session/turn-outline"
import { busySessions } from "./session/busy-sessions"
import { readLatestTurnView, type MessageProjectionRow } from "./session/latest-turn-view"
import { isContiguousTurn, readJournaledTurn, readMessageCompleted, readTurnEvidence, readTurnFinished, readTurnId, readTurnPrompts, readTurnReply, readTurnEndOrd, readTurnReplyId, readUpstreamHasTurns } from "./session/turn-evidence"
import type { SessionConfig, SessionConfigUpdate, SessionHandoff, SessionHandoffSource, SubagentObservation } from "@claxedo/agent-runtime-contract"
import { recoveryScopeKey, recoveryTargetSessionId, decodeMessagePageCursor, encodeMessagePageCursor, AgentMessagePageError, type AgentMessagePage, type AgentMessagePageInput } from "@claxedo/agent-runtime-contract"
import { AGENT_MESSAGE_PAGE_LIMIT, projectLatestSurfaceMessages, type AgentTurnCoverage, type AgentTurnCoveragePage } from "@claxedo/agent-runtime-contract"
import { acceptsSessionTitle, boundSessionTitleSource } from "./session/session-title"
import { firstTurnErrorData, normalizeHarnessIdentity, parseStoredSessionModelGroup, sessionModelGroupJson } from "@claxedo/agent-runtime-contract"
import { createMemorySubagentAdmissionStore } from "@claxedo/harness/broker"
import { sqliteSessionStarts } from "./session/session-starts"
import { DeliveryQueue } from "./session/delivery-queue"
import { TurnLeases } from "./session/turn-leases"
import { retractStoredParts } from "./session/part-retraction"
import { sessionHandoff, sessionHandoffJson } from "./session/handoff-column"
import type { AgentMessage, AgentPermission, AgentQuestion, AgentTurnOutcome, PromptFormat, PromptInput, SessionHarness, SessionModelGroup } from "@claxedo/agent-runtime-contract"
import type { AdmittedSubagentObservation } from "@claxedo/harness/broker"
import type { ChildSessionRef, TurnActor } from "@claxedo/harness/contract"
import type { AgentContentPart, AgentSessionTitleSource, AgentExecutionBinding, AgentSessionCommand, AgentSessionStarts } from "@claxedo/agent-runtime-contract"
import {
  effectivePermissionModeId,
  effectiveSessionModel,
  RECOVERY_OPERATION_RETENTION_MS,
  parseRecoveryOperation,
  type RecoveryOperation,
} from "@claxedo/agent-runtime-contract"
import { foldUsageObservations, type RuntimeUsageObservation } from "@claxedo/agent-runtime-contract"
import { type RuntimeGoalSnapshot, type SubagentUpdatedEvent } from "@claxedo/agent-runtime-contract"
import { base64UrlEncode } from "@claxedo/helpers/crypto"
import { asRecord, isRecord, asNumber, asString } from "@claxedo/helpers/guards"
import type { SqliteDatabase } from "./sqlite/database"
import { openRuntimeStoreSchema } from "./store-schema"
import type { SessionTurnOrigin } from "./session-access-policy"
import { actorKind, nullable } from "./stored-columns"
import { listSubagentRows, persistSubagentEvent } from "./subagent-rows"
import { observationStartsNewRun, recordSubagentRun, subagentRunRevision } from "./subagent-status"
import { pendingSubagentWakes, recordSubagentWake, runningHostChildren, subagentWakeParents } from "./subagent-wakes"
import { buildAssistantMessage, buildUserMessage, buildUserPromptParts, messageCompleted, messagePartUpdated, messageUpdated, sessionError, sessionIdle, sessionStatus } from "./projection/presentation-events"

export const SESSION_INTERRUPTED = "The agent runtime restarted. Send a message to continue the interrupted work."

export class AgentRuntimeStaleTurnError extends Error {
  readonly code = "session_turn_fence_stale"

  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} rejected a stale turn generation`)
    this.name = "AgentRuntimeStaleTurnError"
  }
}

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
  owner: TurnActor
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
  model?: Model
  parts: PromptInput["parts"]
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
}

type Control =
  | Bind
  | Turn
  | TurnFinish
  | SessionInterrupted
  | SessionUpdate
  | SessionDelete
  | PermissionStaled
  | QuestionStaled
  | NoticeAcknowledged
  | NoticeCreated
  | ProjectionResetRequested
  | ConfigUpdate
  | { type: "goal.update"; goal: RuntimeGoalSnapshot | null }

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
}

export type RuntimeStoreAppendOutput = {
  sessionId: string
  seq: number
  createdAt: number
  agentSessionId?: string
  payload: AgentPresentationEvent
  source?: RuntimeEventSource
  /** The assistant message a committed `session.usage` folded into, for its publisher to stream after the usage. */
  messageUpdate?: AgentPresentationEvent
}

export type RuntimeStoreTurnStartOutput = {
  sessionId: string
  seq: number
  createdAt: number
  agentSessionId?: string
  events: AgentPresentationEvent[]
}

/**
 * A stored origin, or nothing — which is what refuses the turn.
 *
 * Nothing covers three rows that all mean "nobody can be re-asked about this":
 * one written before provenance was recorded, a relayed one missing either
 * half of its identity, and a local one that nonetheless carries actor fields.
 * The last is the one worth naming. A local admission is written with those
 * columns null, so the combination is not something this store produces; the
 * only way to reach it is a migration that stamped `loopback-direct` onto a
 * row that already had an actor. Reading it as local would answer a question
 * about a verified actor with a turn that takes no lease, so it is refused.
 */
function storedTurnOrigin(row: {
  origin_provenance?: string | null
  origin_actor_id?: string | null
  origin_actor_kind?: string | null
  origin_user_id?: string | null
  origin_authority_json?: string | null
  wake_grant?: string | null
} | null | undefined): SessionTurnOrigin | undefined {
  if (row?.origin_provenance === "loopback-direct") {
    const named = row.origin_actor_id ?? row.origin_actor_kind ?? row.origin_user_id ?? row.origin_authority_json ?? row.wake_grant
    return named ? undefined : { provenance: "loopback-direct" }
  }
  if (row?.origin_provenance !== "relay-replayed") return undefined
  const kind = actorKind(row.origin_actor_kind ?? null)
  if (!row.origin_actor_id || !kind || !row.origin_authority_json) return undefined
  return {
    provenance: "relay-replayed",
    actor: { actorId: row.origin_actor_id, actorKind: kind, ...(row.origin_user_id ? { userId: row.origin_user_id } : {}) },
    authority: JSON.parse(row.origin_authority_json),
    ...(row.wake_grant ? { grant: row.wake_grant } : {}),
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

const SETTLE_DELTAS_MS = 200

type PendingDelta = {
  sessionId: string
  messageId: string
  partId: string
  field: string
  text: string
  seq: number
  ts: number
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
      payload: AgentPresentationEvent
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

type MessageClose = {
  ts: number
}

const MESSAGE_PAGE_CURSOR_PREFIX = "wrmp2:"
const MESSAGE_HYDRATION_BATCH_SIZE = 500

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
 * works in open records, while the builders in `presentation-events` and the engine's
 * own event payloads are closed types. A shallow copy is the whole conversion:
 * no assertion, and the caller's value is never mutated (neither `upsertMessage`
 * nor `upsertPart` writes to what it is given).
 */
function envelopeRecord(value: object): Record<string, unknown> {
  return { ...value }
}

const readColumn = {
  sessionCommands: (json: string): AgentSessionCommand[] => JSON.parse(json),
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
  /** `runtime_journal.payload_json` on a `kind='event'`, `type='session.usage'` row. */
  usagePayload: (json: string): Extract<AgentPresentationEvent, { type: "session.usage" }> => JSON.parse(json),
  /** `pending_permission.patterns_json`. */
  permissionPatterns: (json: string): string[] => JSON.parse(json),
  /** `pending_permission.options_json`: absent is distinct from no offered options. */
  permissionOptions: (json: string): NonNullable<AgentPermission["options"]> => JSON.parse(json),
  /** `pending_permission.metadata_json`. */
  permissionMetadata: (json: string): Record<string, unknown> => JSON.parse(json),
  /**
   * `pending_question.questions_json`, written by the `question.asked` handler
   * straight from the event's own `properties.questions`.
   */
  questions: (json: string): AgentQuestion["questions"] => JSON.parse(json),
}

/**
 * An assistant message's tokens are every usage observation reported for it;
 * the message schema has no unknown, so an unreported category reads as zero.
 */
function assistantMessageTokens(observations: Iterable<RuntimeUsageObservation>) {
  const usage = foldUsageObservations(observations)
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    reasoning: usage.reasoning ?? 0,
    cache: { read: usage.cache.read ?? 0, write: usage.cache.write ?? 0 },
  }
}

/** Keep host-stamped `claxedo.author` when an engine envelope omits it. */
function preserveClaxedoAuthor(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  if (asString(next.role) !== "user") return next
  const nextClaxedo = asRecord(next.claxedo)
  if (nextClaxedo?.author && typeof nextClaxedo.author === "object") return next
  const prevClaxedo = asRecord(previous?.claxedo)
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

function sessionRowConfig(harness: SessionHarness, row: {
  model_provider_id?: string | null
  model_id?: string | null
  variant?: string | null
  agent?: string | null
  permission_mode?: string | null
  permission_mode_label?: string | null
}) {
  const model = effectiveSessionModel(
    harness,
    row.model_provider_id && row.model_id ? { providerID: row.model_provider_id, modelID: row.model_id } : undefined,
  )
  return {
    harness,
    ...(model ? { model } : {}),
    variant: row.variant ?? null,
    agent: row.agent ?? null,
    permissionMode: effectivePermissionModeId(harness, row.permission_mode),
    ...(row.permission_mode && row.permission_mode_label ? { permissionModeLabel: row.permission_mode_label } : {}),
  }
}

function sameRunningSelections(previous: ReturnType<typeof sessionRowConfig> | undefined, next: ReturnType<typeof sessionRowConfig>) {
  return !!previous
    && previous.harness.id === next.harness.id
    && previous.harness.access === next.harness.access
    && previous.model?.providerID === next.model?.providerID
    && previous.model?.modelID === next.model?.modelID
    && previous.variant === next.variant
    && previous.permissionMode === next.permissionMode
}

/**
 * A session whose projection cannot be brought up to its journal. `repairable`
 * separates the two causes, because they need opposite handling: a projection
 * that threw can be retried by replaying the same rows, while a journal row
 * that no longer parses can never be replayed and needs an operator-requested
 * rebuild. Both leave the session gated for writes.
 */
type ProjectionFailure = { seq: number; reason: string; repairable: boolean }

export class RuntimeProjectionBlockedError extends Error {
  readonly code = "runtime_projection_blocked"

  constructor(readonly sessionId: string, readonly seq: number, readonly reason: string) {
    super(`Session ${sessionId} has no usable projection past journal seq ${seq}: ${reason}`)
    this.name = "RuntimeProjectionBlockedError"
  }
}

export type RuntimeStoreDatabase = {
  readonly db: SqliteDatabase
  /** Names the store in the errors that refuse it. */
  readonly location: string
  /** Makes every committed write durable; a host whose commits already are does nothing. */
  flush(): void
}

export class RuntimeStore {
  readonly sessionStarts: AgentSessionStarts
  readonly deliveryQueue: DeliveryQueue
  readonly turnLeases: TurnLeases
  private opened: RuntimeStoreDatabase
  private db: SqliteDatabase
  private subagentAdmission = createMemorySubagentAdmissionStore()
  private authoringOwnership: SessionAuthoringOwnership
  private closed = false
  // A journaled write may outlive its projection. The session stays gated
  // until the projection catches up, so its checkpoint cannot skip the rows
  // that never applied.
  private failedProjections = new Map<string, ProjectionFailure>()
  /**
   * Streamed text waiting to be folded into its `part` row. A harness emits a
   * `message.part.delta` per token chunk; rewriting the growing part JSON and
   * its checkpoint for each one made a 27 KB reply cost 47 MB of WAL. The
   * journal row is still written per delta — it is the durable record and what
   * `replay` re-applies after a crash — but the projection is written once per
   * settle, and the session's checkpoint advances only when it is.
   */
  private pendingDeltas = new Map<string, PendingDelta>()
  private settleTimer: ReturnType<typeof setTimeout> | undefined

  constructor(database: RuntimeStoreDatabase) {
    this.opened = database
    this.db = database.db
    openRuntimeStoreSchema(this.db, database.location)
    this.authoringOwnership = new SessionAuthoringOwnership(this.db)
    this.sessionStarts = sqliteSessionStarts(this.db)
    this.turnLeases = new TurnLeases(this.db)
    this.deliveryQueue = new DeliveryQueue(this.db, (sessionId, actorId) => this.authoringOwnership.record(sessionId, actorId))
    this.hydrateSubagentAdmission()
    this.replay()
    this.reconcileOrphanedSubagents()
  }

  close() {
    if (this.closed) return
    this.settleDeltas()
    this.db.close()
    this.closed = true
  }

  flush() {
    if (this.closed) throw new Error("Runtime store is closed")
    this.settleDeltas()
    this.opened.flush()
  }

  /**
   * Fold every pending delta into its part row and advance the checkpoints,
   * in one transaction. Runs before any other write for a session so the
   * journal's order is the projection's order, before any read of parts, on
   * the settle timer, and on close.
   */
  private settleDeltas(sessionId?: string) {
    if (this.pendingDeltas.size === 0) return
    const selected = [...this.pendingDeltas.values()].filter((item) => !sessionId || item.sessionId === sessionId)
    if (selected.length === 0) return
    for (const item of selected) this.pendingDeltas.delete(item.partId)
    if (this.pendingDeltas.size === 0 && this.settleTimer) {
      clearTimeout(this.settleTimer)
      this.settleTimer = undefined
    }
    // One transaction per session, and the advance goes through `checkpoint`
    // like every other: a session whose projection is behind its journal must
    // keep its deltas in the journal alone, and that refusal must not take
    // another session's settled deltas down with it.
    const bySession = new Map<string, PendingDelta[]>()
    for (const item of selected) bySession.set(item.sessionId, [...(bySession.get(item.sessionId) ?? []), item])
    for (const [session, items] of bySession) {
      let last = { seq: 0, ts: 0 }
      try {
        this.db.transaction(() => {
          for (const item of items) {
            this.delta(item.sessionId, item.messageId, item.partId, item.field, item.text, item.ts)
            if (item.seq > last.seq) last = { seq: item.seq, ts: item.ts }
          }
          this.checkpoint({ sessionId: session, seq: last.seq, ts: last.ts })
        })
      } catch (error) {
        if (!(error instanceof RuntimeProjectionBlockedError)) throw error
      }
    }
  }

  private deferDelta(row: Row & { kind: "event" }) {
    const event = row.payload
    if (event.type !== "message.part.delta") throw new Error("Expected a message.part.delta row")
    const key = event.properties.partID
    const prev = this.pendingDeltas.get(key)
    if (prev && prev.field === event.properties.field) {
      prev.text += event.properties.delta
      prev.seq = row.seq
      prev.ts = row.ts
    } else {
      if (prev) this.settleDeltas(row.sessionId)
      this.pendingDeltas.set(key, {
        sessionId: row.sessionId,
        messageId: event.properties.messageID,
        partId: key,
        field: event.properties.field,
        text: event.properties.delta,
        seq: row.seq,
        ts: row.ts,
      })
    }
    this.settleTimer ??= setTimeout(() => {
      this.settleTimer = undefined
      if (!this.closed) this.settleDeltas()
    }, SETTLE_DELTAS_MS)
    this.settleTimer.unref?.()
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
    child?: ChildSessionRef
  }): AdmittedSubagentObservation {
    const admitted = this.admitObservation(input)
    this.linkChildSession(input.parentSessionId, admitted.event.childSessionId)
    if (input.child) {
      if (admitted.event.childSessionId !== input.child.sessionId) throw new Error("Host child binding does not match admission")
      const existing = this.db.prepare<{ assistant_message_id: string | null }>(`
        SELECT assistant_message_id FROM session_subagent
        WHERE parent_session_id = ? AND subagent_key = ?
      `).get(input.parentSessionId, admitted.event.subagentKey)
      if (existing?.assistant_message_id && existing.assistant_message_id !== input.child.assistantMessageId) {
        throw new Error("Host child assistant message differs from the stored binding")
      }
      this.db.prepare(`UPDATE session_subagent SET assistant_message_id = ?, created_at = ?
        WHERE parent_session_id = ? AND subagent_key = ?`).run(
        input.child.assistantMessageId, input.child.created, input.parentSessionId, admitted.event.subagentKey,
      )
    }
    return admitted
  }

  hasChild(parentSessionId: string, childSessionId: string): boolean {
    return !!this.db.prepare<{ child_session_id: string }>(`
      SELECT child_session_id FROM session_subagent
      WHERE parent_session_id = ? AND child_session_id = ?
    `).get(parentSessionId, childSessionId)
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
    const owner = this.sessionOwner(parentSessionId)
    if (!owner) throw new Error(`Session ${parentSessionId} has no row to own child ${childSessionId}`)
    this.bindSession({
      sessionId: childSessionId,
      directory: child?.directory ?? parent?.directory ?? "",
      agentSessionId: this.getAgentSessionId(childSessionId) ?? childSessionId,
      owner,
      parentSessionId,
    })
  }

  private admitObservation(input: {
    parentSessionId: string
    observation: SubagentObservation
    allocateKey: () => string
    allocateChildSessionId?: () => string
  }): AdmittedSubagentObservation {
    try {
      return this.db.transaction(() => {
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
        if (existing) return { ...admitted, event: JSON.parse(existing.event_json) as SubagentUpdatedEvent, published: !!existing.published }
        const freshKeys = subagentCorrelationKeys(input.observation).filter((correlationKey) => this.db.prepare(`INSERT OR IGNORE
          INTO session_subagent_correlation (parent_session_id, correlation_key, subagent_key) VALUES (?, ?, ?)`)
          .run(input.parentSessionId, correlationKey, admitted.event.subagentKey).changes === 1)
        const startsNewRun = observationStartsNewRun(input.observation, freshKeys)
        const runRevision = startsNewRun ? admitted.event.revision : subagentRunRevision(this.db, input.parentSessionId, admitted.event.subagentKey, input.observation)
        if (runRevision !== undefined) admitted.event.runRevision = runRevision
        const wake = recordSubagentWake(this.db, input.parentSessionId, admitted.event, input.observation)
        if (wake) admitted.event.wake = wake
        persistSubagentEvent(this.db, input.parentSessionId, admitted.event, startsNewRun)
        if (startsNewRun) recordSubagentRun(this.db, input.parentSessionId, admitted.event.subagentKey, freshKeys, admitted.event.revision)
        const { wakeResult: _result, ...replayed } = input.observation
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
            // Persist what hydrate replays: the observation with the child
            // session admission resolved or allocated stamped in, since a raw
            // input may lack it and a replay without it would forget which row
            // owns the child. Its wake result is not replayed; the wake table
            // holds it until delivery.
            JSON.stringify({
              ...replayed,
              ...(admitted.event.childSessionId ? { childSessionId: admitted.event.childSessionId } : {}),
            }),
            JSON.stringify(admitted.event),
            Date.now(),
          )
        return admitted
      })
    } catch (error) {
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
    return listSubagentRows(this.db, parentSessionId)
  }

  listPendingSubagentWakes(parentSessionId: string) {
    return pendingSubagentWakes(this.db, parentSessionId)
  }

  listSubagentWakeParents() {
    return subagentWakeParents(this.db)
  }

  /**
   * Remember who asked for this child, once.
   *
   * The completion turn this child eventually drives on its parent runs long
   * after the request that authorized it is gone, and the authority decides
   * that turn about an actor. A later observation about the same row — a
   * status, an attention count, a wake — arrives from the runtime itself and
   * names nobody, so it must never be able to move the row to a different one.
   *
   * "Once" means every origin column empty, not just the newest of them. A row
   * written before provenance existed already carries an actor, and treating
   * the missing column as an empty origin would let this overwrite that actor
   * with whoever asks next — including with a local admission, which needs no
   * actor at all. Such a row keeps what it has and stays unreadable instead:
   * it proves someone was admitted and no longer proves how.
   */
  recordSubagentOrigin(parentSessionId: string, subagentKey: string, origin: SessionTurnOrigin) {
    const relayed = origin.provenance === "relay-replayed" ? origin : undefined
    const written = this.db
      .prepare(
        `
      UPDATE session_subagent
      SET origin_provenance = ?, origin_actor_id = ?, origin_actor_kind = ?, origin_user_id = ?, origin_authority_json = ?, wake_grant = ?, updated_at = ?
      WHERE parent_session_id = ? AND subagent_key = ?
        AND origin_provenance IS NULL
        AND origin_actor_id IS NULL
        AND origin_actor_kind IS NULL
        AND origin_user_id IS NULL
        AND origin_authority_json IS NULL
        AND wake_grant IS NULL
    `,
      )
      .run(
        origin.provenance,
        relayed?.actor.actorId ?? null,
        relayed?.actor.actorKind ?? null,
        relayed?.actor.userId ?? null,
        relayed ? JSON.stringify(relayed.authority) : null,
        relayed?.grant ?? null,
        Date.now(),
        parentSessionId,
        subagentKey,
      ).changes
    if (written) return
    // Nothing changed either because the row already carries an admission — a
    // retry of the same creation, or one recorded by an older build — or
    // because there is no such row, which would leave a child that can never
    // wake its parent and no sign of why. The caller is still inside the
    // create it can roll back, so it hears about that one there.
    const row = this.db
      .prepare<{ found: number }>(`SELECT 1 AS found FROM session_subagent WHERE parent_session_id = ? AND subagent_key = ?`)
      .get(parentSessionId, subagentKey)
    if (!row) throw new Error(`subagent ${subagentKey} of ${parentSessionId} has no row to record a turn origin on`)
  }

  subagentOrigin(parentSessionId: string, subagentKey: string): SessionTurnOrigin | undefined {
    const row = this.db
      .prepare<{
        origin_provenance: string | null
        origin_actor_id: string | null
        origin_actor_kind: string | null
        origin_user_id: string | null
        origin_authority_json: string | null
        wake_grant: string | null
      }>(
        `
      SELECT origin_provenance, origin_actor_id, origin_actor_kind, origin_user_id, origin_authority_json, wake_grant
      FROM session_subagent
      WHERE parent_session_id = ? AND subagent_key = ?
    `,
      )
      .get(parentSessionId, subagentKey)
    return storedTurnOrigin(row)
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

  /** A host child's run that ended with the previous runtime owes its parent an interrupted result. */
  private interruptHostChildRuns() {
    for (const run of runningHostChildren(this.db)) {
      const observationId = `host:restart:${run.subagentKey}:${run.revision}`
      const result = { status: "interrupted" as const, text: SESSION_INTERRUPTED, ...(run.assistantMessageId ? { assistantMessageId: run.assistantMessageId } : {}) }
      this.admit({
        parentSessionId: run.parentSessionId,
        observation: { observationId, subagentKey: run.subagentKey, status: "interrupted", ...(run.parentArchived ? {} : { wakeResult: result }) },
        allocateKey: () => run.subagentKey,
      })
      this.markPublished(run.parentSessionId, observationId)
    }
  }

  /**
   * Discard everything one session's journal produced. The journal itself and
   * the `deleted_session` tombstone are untouched: they are the facts being
   * replayed, not a projection of them.
   */
  private resetSessionProjection(sessionId: string) {
    for (
      const sql of [
        "DELETE FROM journal_checkpoint WHERE session_id = ?",
        "DELETE FROM pending_question WHERE session_id = ?",
        "DELETE FROM pending_permission WHERE session_id = ?",
        "DELETE FROM todo WHERE session_id = ?",
        "DELETE FROM part WHERE session_id = ?",
        "DELETE FROM message WHERE session_id = ?",
        "DELETE FROM session_execution_binding WHERE session_id = ?",
        "DELETE FROM session_map WHERE session_id = ?",
        "DELETE FROM session WHERE id = ?",
      ]
    ) {
      this.db.prepare(sql).run(sessionId)
    }
  }

  /**
   * Rebuild one session's projection from its own journal, under the reducer
   * that writes it in the first place. It publishes nothing: `apply` only
   * writes projection rows, so the events a subscriber already saw are not
   * replayed at them. The session is still refused afterwards if the row that
   * stopped replay is still unreadable — a rebuild repairs a projection, never
   * the journal.
   */
  rebuildProjection(sessionId: string, reason = "operator requested rebuild") {
    // A held turn lease means a writer still believes it owns this session's
    // turn. Discarding the projection under it would leave that writer
    // committing against rows this rebuild is re-deriving.
    const lease = this.readTurnAuthority(sessionId)
    if (lease) {
      throw new RuntimeProjectionBlockedError(
        sessionId,
        this.projectedPosition(sessionId),
        `turn lease ${lease.leaseId} is still held; release it before rebuilding`,
      )
    }
    this.settleDeltas(sessionId)
    const before = this.failedProjections.get(sessionId)
    this.failedProjections.delete(sessionId)
    const to = this.getSessionMaxSeq(sessionId)
    this.db.transaction(() => {
      const seq = this.next(sessionId)
      this.insertRuntimeJournal(
        { seq, ts: Date.now(), sessionId, kind: "control", control: { type: "projection.reset_requested", reason } },
        seq,
        { insideTransaction: true },
      )
      this.resetSessionProjection(sessionId)
    })
    try {
      this.replaySession(sessionId, 0, to)
    } catch (error) {
      // The projection is discarded and the replay that was meant to re-derive
      // it did not finish. Leave the session refused rather than open for
      // writes against rows that are now missing.
      this.failedProjections.set(sessionId, {
        seq: before?.seq ?? this.projectedPosition(sessionId),
        reason: `rebuild did not finish: ${String(error)}`,
        repairable: false,
      })
      throw error
    }
    const failure = this.failedProjections.get(sessionId)
    if (failure) return { rebuilt: false as const, blocked: { seq: failure.seq, reason: failure.reason } }
    return { rebuilt: true as const, position: this.projectedPosition(sessionId) }
  }

  /**
   * Where this session's projection stands against its journal, and what is
   * holding it back. The only read a recovery caller needs before deciding
   * between waiting and asking for a rebuild.
   */
  replayJournal(sessionId: string) {
    this.replay(sessionId)
    const failure = this.failedProjections.get(sessionId)
    return {
      position: this.projectedPosition(sessionId),
      ...(failure ? { blocked: { seq: failure.seq, reason: failure.reason } } : {}),
    }
  }

  private projectedPosition(sessionId: string) {
    return this.db
      .prepare<{ last_seq: number }>("SELECT last_seq FROM journal_checkpoint WHERE session_id = ?")
      .get(sessionId)?.last_seq ?? 0
  }

  private replay(sessionId?: string) {
    const sessions = this.db
      .prepare<{ session_id: string; last_seq: number; max_seq: number }>(
        `
        SELECT journal.session_id, COALESCE(checkpoint.last_seq, 0) AS last_seq, journal.max_seq
        FROM (
          SELECT session_id, MAX(seq) AS max_seq
          FROM runtime_journal
          WHERE (? IS NULL OR session_id = ?)
          GROUP BY session_id
        ) AS journal
        LEFT JOIN journal_checkpoint AS checkpoint ON checkpoint.session_id = journal.session_id
        WHERE journal.max_seq > COALESCE(checkpoint.last_seq, 0)
        ORDER BY journal.session_id ASC
      `,
      )
      .all(sessionId ?? null, sessionId ?? null)
    for (const session of sessions) this.replaySession(session.session_id, session.last_seq, session.max_seq)
  }

  /**
   * Apply one session's journal from `from` up to `to`. A row that no longer
   * parses stops this session and only this session: skipping it would project
   * every later row against a state it never produced, and checkpoint over the
   * gap so no reader could tell. Other sessions in the same replay are
   * unaffected, because nothing they hold came from this journal.
   */
  private replaySession(sessionId: string, from: number, to: number) {
    // Entering replay IS the retry, so the marker from the last attempt goes
    // now; `project` re-raises it if the same rows fail again.
    this.failedProjections.delete(sessionId)
    let cursor = from
    while (cursor < to) {
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
            WHERE session_id = ? AND seq > ? AND seq <= ?
            ORDER BY seq ASC
            LIMIT 100
          `,
        )
        .all(sessionId, cursor, to)
      if (rows.length === 0) break
      for (const row of rows) {
        const parsed = this.parseJournalRow(row)
        if (!parsed) {
          this.failedProjections.set(sessionId, {
            seq: row.seq,
            reason: `journal row ${row.kind}/${row.type} did not parse`,
            repairable: false,
          })
          return
        }
        cursor = row.seq
        this.project(parsed)
      }
    }
    this.failedProjections.delete(sessionId)
  }

  private finishTools(sessionId: string, ts: number) {
    const error = "Tool execution interrupted"
    const rows = this.db
      .prepare<{ data_json: string }>("SELECT data_json FROM part WHERE session_id = ? ORDER BY updated_at ASC")
      .all(sessionId)
    for (const row of rows) {
      const part = readColumn.partRecord(row.data_json)
      if (part.type !== "tool") continue
      const state = asRecord(part.state)
      const status = asString(state?.status)
      if (status !== "pending" && status !== "running") continue
      const time = asRecord(state?.time)
      part.state = {
        ...state,
        status: "error",
        error,
        time: {
          start: asNumber(time?.start) ?? ts,
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
  private terminalizedPart(part: AgentMessage["parts"][number], close: MessageClose) {
    if (part.type !== "tool") return part
    const state = part.state
    if (state.status !== "pending" && state.status !== "running") return part
    return {
      ...part,
      state: {
        ...state,
        status: "error" as const,
        error: "Tool execution interrupted",
        time: {
          start: state.status === "running" ? state.time.start : close.ts,
          end: close.ts,
        },
      },
    }
  }

  private messageClose(info: AgentMessage["info"]): MessageClose | undefined {
    const infoRecord = info as Record<string, unknown>
    const time = asRecord(info.time)
    if (info.role !== "assistant" || (typeof time?.completed !== "number" && !infoRecord.error)) return undefined
    return {
      ts: asNumber(time?.completed) ?? asNumber(time?.created) ?? Date.now(),
    }
  }

  private interruptPreviousSessions(): string[] {
    const rows = busySessions(this.db)
    for (const row of rows) {
      this.markSessionInterrupted(row.id, SESSION_INTERRUPTED, row.agent_session_id)
    }
    return rows.map((row) => row.id)
  }

  recoverBusySessions(): readonly string[] {
    // Valid only when no turn, delivery or host-child run of the previous
    // runtime can still be active: a crash settles none of their durable rows,
    // so this boot boundary is the one place they are settled.
    this.turnLeases.clear()
    this.deliveryQueue.settleOrphanedDispatches()
    const interrupted = this.interruptPreviousSessions()
    this.interruptHostChildRuns()
    return interrupted
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
        const payload: AgentPresentationEvent = JSON.parse(row.payload_json)
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

  /** The store's SQLite, for the ports that keep their own rows beside the store's: broker requests and launch ownership. */
  database(): SqliteDatabase {
    return this.db
  }

  brokerTransaction<T>(run: () => T): T {
    return this.db.transaction(run)
  }

  brokerAppendInside(sessionId: string, payload: AgentPresentationEvent): void {
    this.commitInside({
      seq: this.next(sessionId), ts: Date.now(), sessionId, kind: "event", payload,
    }, undefined)
  }

  brokerPersistGrantInside(sessionId: string, grantKey: string): void {
    const row = this.db.prepare<{ permission_state_json: string | null }>(
      "SELECT permission_state_json FROM session WHERE id = ?",
    ).get(sessionId)
    if (!row) throw new Error(`Unknown grant session ${sessionId}`)
    const state = row.permission_state_json ? asRecord(JSON.parse(row.permission_state_json)) : {}
    if (!state) throw new Error(`Invalid permission state for ${sessionId}`)
    const storedGrants = state.brokerGrants
    if (storedGrants !== undefined && (!Array.isArray(storedGrants) || !storedGrants.every((item: unknown) => typeof item === "string"))) {
      throw new Error(`Invalid broker grants for ${sessionId}`)
    }
    const grants: string[] = Array.isArray(storedGrants) ? storedGrants.filter((item): item is string => typeof item === "string") : []
    this.commitInside({
      seq: this.next(sessionId), ts: Date.now(), sessionId, kind: "control",
      control: { type: "config.update", patch: {
        permissionState: { ...state, brokerGrants: [...new Set([...grants, grantKey])] },
      } },
    }, undefined)
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
        : row.kind === "event" && row.payload.type === "session.usage"
          ? (row.payload.properties.messageID ?? null)
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
    else this.db.transaction(insert)
    return { ...row, seq }
  }

  private checkpoint(row: Pick<Row, "sessionId" | "seq" | "ts">) {
    const failure = this.failedProjections.get(row.sessionId)
    if (failure) throw new RuntimeProjectionBlockedError(row.sessionId, failure.seq, failure.reason)
    this.db
      .prepare("INSERT OR REPLACE INTO journal_checkpoint (session_id, last_seq, updated_at) VALUES (?, ?, ?)")
      .run(row.sessionId, row.seq, row.ts)
  }

  /**
   * Journal, apply and checkpoint one row inside the caller's transaction, for
   * rows that must land together. `commit` journals its row on its own and
   * gates the session when projection fails; inside a transaction that the caller
   * rolls back, that gate would name a row that no longer exists.
   */
  private commitInside(row: Row, fencingToken: number | undefined) {
    this.assertFencingToken(row.sessionId, fencingToken)
    const journaled = this.insertRuntimeJournal(row, row.seq, { insideTransaction: true })
    this.apply(journaled)
    this.checkpoint(journaled)
    return journaled
  }

  /**
   * Bring a session's projection level with its journal, or refuse the write.
   * A projection that threw is retried here; a journal row that no longer
   * parses cannot be, and the session stays refused until an operator asks for
   * a rebuild. Either way the caller learns the sequence it is stuck behind
   * rather than writing past it.
   */
  private assertProjectionCurrent(sessionId: string) {
    const failure = this.failedProjections.get(sessionId)
    if (!failure) return
    if (failure.repairable) this.replay(sessionId)
    const remaining = this.failedProjections.get(sessionId)
    if (!remaining) return
    throw new RuntimeProjectionBlockedError(sessionId, remaining.seq, remaining.reason)
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
    this.assertProjectionCurrent(row.sessionId)
    if (
      this.deleted(row.sessionId) &&
      !(row.kind === "control" && (row.control.type === "session.bind" || row.control.type === "session.delete"))
    ) {
      throw new Error(`Session ${row.sessionId} was deleted`)
    }
    // A delta is journaled like any row but projected later, in bulk; every
    // other row settles the deltas ahead of it first so projection order is
    // journal order.
    const deferred = row.kind === "event" && row.payload.type === "message.part.delta"
    if (!deferred) this.settleDeltas(row.sessionId)
    if (fence.fencingToken === undefined) {
      const journaled = this.insertRuntimeJournal(row)
      if (deferred && journaled.kind === "event") {
        this.deferDelta(journaled)
        return journaled
      }
      this.project(journaled)
      return journaled
    }
    let journaled!: Row
    this.db.transaction(() => {
      this.assertFencingToken(row.sessionId, fence.fencingToken, fence.advance)
      journaled = this.insertRuntimeJournal(row, this.next(row.sessionId), { insideTransaction: true })
      if (deferred) return
      this.apply(journaled)
      this.checkpoint(journaled)
    })
    if (deferred && journaled.kind === "event") this.deferDelta(journaled)
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

  private partOrd(sessionId: string, messageId: string, partId: string) {
    const row = this.db.prepare<{ ord: number }>("SELECT ord FROM part WHERE id = ?").get(partId)
    if (row) return row.ord
    const max = requireRow(
      this.db
        .prepare<{ ord: number }>(
          "SELECT COALESCE(MAX(ord), -1) AS ord FROM part WHERE session_id = ? AND message_id = ?",
        )
        .get(sessionId, messageId),
      "part max ord",
    )
    return max.ord + 1
  }

  /** A message keeps the place and the turn of the row that first projected it. */
  private upsertMessage(envelope: object, row: Pick<Row, "sessionId" | "seq" | "ts">) {
    const info = envelopeRecord(envelope)
    const sessionId = asString(info.sessionID)
    const id = asString(info.id)
    const role = asString(info.role)
    if (!sessionId || !id || !role) return
    const prev = this.db
      .prepare<{ created_at: number; info_json: string; turn_id: string | null }>("SELECT created_at, info_json, turn_id FROM message WHERE id = ?")
      .get(id)
    const merged = preserveClaxedoAuthor(prev ? readColumn.messageRecord(prev.info_json) : undefined, info)
    const observations = role === "assistant" ? this.messageUsageObservations(sessionId, id) : []
    if (observations.length) merged.tokens = assistantMessageTokens(observations)
    this.db
      .prepare(
        "INSERT OR REPLACE INTO message (id, session_id, role, ord, info_json, created_at, turn_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id, sessionId, role, this.messageOrd(sessionId, id), JSON.stringify(merged), prev?.created_at ?? row.ts,
        prev ? prev.turn_id : readJournaledTurn(this.db, row.sessionId, row.seq),
      )
  }

  /** Usage folds from the journal, not the previous row, so a later rebuild of the message cannot drop it. */
  private messageUsageObservations(sessionId: string, messageId: string): RuntimeUsageObservation[] {
    return this.db
      .prepare<{ payload_json: string }>(`
        SELECT payload_json FROM runtime_journal
        WHERE session_id = ? AND assistant_message_id = ? AND kind = 'event' AND type = 'session.usage'
        ORDER BY seq ASC
      `)
      .all(sessionId, messageId)
      .flatMap((row) => {
        const observation = readColumn.usagePayload(row.payload_json).properties.observation
        return observation ? [observation] : []
      })
  }

  private storedAssistantMessage(sessionId: string, messageId: string) {
    const row = this.db
      .prepare<{ info_json: string }>("SELECT info_json FROM message WHERE id = ? AND session_id = ? AND role = 'assistant'")
      .get(messageId, sessionId)
    return row ? readColumn.messageInfo(row.info_json) : undefined
  }

  private upsertPart(envelope: object, ts: number) {
    const part = envelopeRecord(envelope)
    const sessionId = asString(part.sessionID)
    const messageId = asString(part.messageID)
    const id = asString(part.id)
    if (!sessionId || !messageId || !id) return
    this.db
      .prepare(
        "INSERT OR REPLACE INTO part (id, session_id, message_id, ord, data_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, sessionId, messageId, this.partOrd(sessionId, messageId, id), JSON.stringify(part), ts)
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
    const prev = asString(part[field]) ?? ""
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
     * subagent's completion or a channel message advances it too; this only moves when the
     * reader speaks, which is what the sidebar needs to tell a live session from one
     * the agents are working through on their own.
     */
    lastHumanTurnAt?: number
    status?: string
    recoveryError?: string | null
    parentSessionId?: string
    /** Only a bind carries it, so only a bind creates the row; the first owner written stays. */
    owner?: TurnActor
  }) {
    const prev = this.db
      .prepare<{
      owner_json: string
      created_at: number
      parent_id: string | null
      title: string | null
      title_source?: AgentSessionTitleSource | null
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
          owner_json,
          created_at,
          parent_id,
          title,
          title_source,
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
    const owner = prev?.owner_json ?? (input.owner && JSON.stringify(input.owner))
    if (!owner) return
    this.db
      .prepare(
        `INSERT INTO session (
        id,
        parent_id,
        owner_json,
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        parent_id = COALESCE(excluded.parent_id, session.parent_id),
        directory = excluded.directory,
        title = excluded.title,
        agent_session_id = excluded.agent_session_id,
        process_key = excluded.process_key,
        permission_mode = CASE WHEN session.harness_id = excluded.harness_id AND session.harness_access = excluded.harness_access THEN session.permission_mode ELSE NULL END,
        permission_mode_label = CASE WHEN session.harness_id = excluded.harness_id AND session.harness_access = excluded.harness_access THEN session.permission_mode_label ELSE NULL END,
        permission_state_json = CASE WHEN session.harness_id = excluded.harness_id AND session.harness_access = excluded.harness_access THEN session.permission_state_json ELSE NULL END,
        commands_json = CASE WHEN session.harness_id IS excluded.harness_id AND session.harness_access IS excluded.harness_access THEN session.commands_json ELSE NULL END,
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
        owner,
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
    this.db.prepare("DELETE FROM session_subagent_wake WHERE parent_session_id = ?").run(id)
    this.db.prepare("DELETE FROM session_subagent_correlation WHERE parent_session_id = ?").run(id)
    this.db.prepare("DELETE FROM session_subagent_tool_call WHERE parent_session_id = ?").run(id)
    this.db.prepare("DELETE FROM session_subagent WHERE parent_session_id = ?").run(id)
    this.deliveryQueue.forgetSession(id)
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
      this.db.prepare("UPDATE session SET title = ?, title_source = 'user', updated_at = ? WHERE id = ?").run(updates.title, ts, sessionId)
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
      const previous = this.getSession(row.sessionId)
      const titleSource = boundSessionTitleSource(control.title, previous ?? undefined)
      this.upsertSession({
        id: row.sessionId,
        directory: control.directory,
        title: control.title,
        agentSessionId: control.agentSessionId,
        processKey: control.ownerKey !== undefined ? control.ownerKey : control.processKey,
        owner: control.owner,
        parentSessionId: control.parentSessionId,
        createdAt: control.createdAt ?? existing.created ?? row.ts,
        updatedAt: control.updatedAt ?? existing.updated ?? row.ts,
      })
      this.db.prepare("UPDATE session SET title_source = ? WHERE id = ?").run(titleSource ?? null, row.sessionId)
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
          row,
        )
        // No harness writes the user's prompt parts back, so these rows are the
        // prompt's only record, including when the harness never answers.
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
        row,
      )
      this.upsertSession({
        id: row.sessionId,
        directory,
        createdAt: row.ts,
        updatedAt: row.ts,
        // A subagent's completion or a channel message starts a turn the same way
        // the reader does, so `updated_at` alone cannot tell them apart. `actorKind`
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
      this.applyConfigUpdate(row.sessionId, control.patch, row.ts)
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
    if (control.type === "session.interrupted") {
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
      this.finishTools(row.sessionId, row.ts)
      this.upsertSession({
        id: row.sessionId,
        directory: session.directory,
        createdAt: session.created ?? row.ts,
        updatedAt: session.updated ?? row.ts,
        status: "interrupted",
        recoveryError: control.message,
      })
    }
  }

  private applyEvent(row: Extract<Row, { kind: "event" }>) {
    const event = row.payload
    if (this.deleted(row.sessionId)) return
    switch (event.type) {
      case "message.updated":
        this.upsertMessage(event.properties.info, row)
        return

      case "message.part.updated":
        this.upsertPart(event.properties.part, row.ts)
        return

      case "message.part.retracted":
        return retractStoredParts(this.db, event.properties, (part) => this.upsertPart(part, row.ts))

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
           (id, session_id, tool, patterns_json, metadata_json, always_json, options_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          )
          .run(
            event.properties.id,
            event.properties.sessionID,
            event.properties.permission,
            JSON.stringify(event.properties.patterns),
            JSON.stringify(event.properties.metadata),
            JSON.stringify(event.properties.always),
            event.properties.options === undefined ? null : JSON.stringify(event.properties.options),
            row.ts,
            row.ts,
          )
        return

      case "permission.replied":
      case "permission.expired":
        this.db.prepare("UPDATE pending_permission SET status = 'answered', updated_at = ? WHERE session_id = ? AND id = ?")
          .run(row.ts, event.properties.sessionID, event.properties.requestID)
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
      case "question.expired":
        this.db.prepare("UPDATE pending_question SET status = 'answered', updated_at = ? WHERE session_id = ? AND id = ?")
          .run(row.ts, event.properties.sessionID, event.properties.requestID)
        return

      case "session.usage": {
        const messageId = event.properties.messageID
        const info = messageId ? this.storedAssistantMessage(row.sessionId, messageId) : undefined
        if (info && event.properties.observation) this.upsertMessage(info, row)
        return
      }

      case "message.completed": {
        const rowInfo = this.db
          .prepare<{ info_json: string }>("SELECT info_json FROM message WHERE id = ?")
          .get(event.properties.messageID)
        if (!rowInfo) return
        const info = readColumn.messageRecord(rowInfo.info_json)
        info.time = { ...asRecord(info.time), completed: row.ts }
        this.upsertMessage(info, row)
        return
      }

      case "session.commands": {
        this.db.prepare("UPDATE session SET commands_json = ? WHERE id = ?")
          .run(JSON.stringify(event.properties.commands), event.properties.sessionID)
        return
      }

      case "session.updated": {
        const info = event.properties.info
        const previous = this.getSession(info.id)
        const accepted = info.title !== undefined && acceptsSessionTitle(info.titleSource, previous?.titleSource)
        this.db.prepare(`
          UPDATE session
          SET title = CASE WHEN ? THEN ? ELSE title END,
              title_source = CASE WHEN ? THEN ? ELSE title_source END,
              updated_at = COALESCE(?, updated_at),
              archived_at = COALESCE(?, archived_at)
          WHERE id = ?
        `).run(accepted ? 1 : 0, info.title ?? null, accepted ? 1 : 0, info.titleSource ?? "prompt", info.time?.updated ?? null, info.time?.archived ?? null, info.id)
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
    try {
      this.db.transaction(() => {
        this.apply(row)
        this.checkpoint(row)
      })
    } catch (error) {
      if (!(error instanceof RuntimeProjectionBlockedError)) {
        this.failedProjections.set(row.sessionId, { seq: row.seq, reason: String(error), repairable: true })
      }
      throw error
    }
  }

  bindSession(input: {
    sessionId: string
    workspaceId?: string
    directory: string
    connectionId?: string
    upstreamSessionId?: string
    title?: string
    agentSessionId: string
    /** Required to create the session; a rebind keeps the owner its row already has. */
    owner?: TurnActor
    ownerKey?: string | null
    parentSessionId?: string
    createdAt?: number
    updatedAt?: number
  }) {
    const owner = input.owner ?? this.sessionOwner(input.sessionId)
    if (!owner) throw new Error(`Session ${input.sessionId} cannot be bound without an owner`)
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
        owner,
        ...(input.ownerKey !== undefined ? { ownerKey: input.ownerKey } : {}),
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
        createdAt: ts,
        ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}),
      },
    }
    this.commit(row)
  }

  private turnStartEvents(row: TurnStartRow): AgentPresentationEvent[] {
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
    model?: Model
    parts: PromptInput["parts"]
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
        ...(input.model ? { model: input.model } : {}),
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

  markSessionInterrupted(sessionId: string, message = SESSION_INTERRUPTED, agentSessionId?: string | null) {
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
    payload: AgentPresentationEvent
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
    const usage = committed.payload.type === "session.usage" ? committed.payload.properties : undefined
    const folded = usage?.observation && usage.messageID ? this.storedAssistantMessage(committed.sessionId, usage.messageID) : undefined
    return {
      sessionId: committed.sessionId,
      seq: committed.seq,
      createdAt: committed.ts,
      ...(committed.agentSessionId ? { agentSessionId: committed.agentSessionId } : {}),
      payload: committed.payload,
      ...(committed.source ? { source: committed.source } : {}),
      ...(folded ? { messageUpdate: messageUpdated(folded) } : {}),
    } satisfies RuntimeStoreAppendOutput
  }

  /**
   * End the session's open turn: its terminal events and its `turn.finish`
   * land together or not at all, so no reader can see an idle session whose
   * turn never closed, and no retry has to work out which half survived.
   * The events returned end with the turn's one `session.idle` or
   * `session.error`, whose `lastTurn` is the outcome `turn.finish` records;
   * none are returned when there was no open turn to end.
   *
   * `leaseId` is the durable turn lease the caller believes it still holds,
   * and it is required: the lease row lives in this database, so the check and
   * the writes share one immediate transaction and a replacement owner cannot
   * slip between them. A caller with no lease has nothing this store will
   * accept a terminal from.
   */
  finishTurn(input: {
    sessionId: string
    assistantMessageId?: string
    outcome: AgentTurnOutcome
    fencingToken?: number
    leaseId: string
  }) {
    this.assertProjectionCurrent(input.sessionId)
    this.settleDeltas(input.sessionId)
    if (this.deleted(input.sessionId)) throw new Error(`Session ${input.sessionId} was deleted`)
    return this.db.transaction(() => {
      // The absent case is spelled out: comparing two absent leases would pass
      // a writer holding nothing over a session that has granted nothing, which
      // is exactly the unfenced terminal the required lease removes.
      if (input.leaseId === undefined || this.readTurnAuthority(input.sessionId)?.leaseId !== input.leaseId) {
        throw new AgentRuntimeStaleTurnError(input.sessionId)
      }
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
      if (readTurnFinished(this.db, input.sessionId, active.assistant_message_id)) return { events: [] }
      const segment = this.latestReplySegment(input.sessionId, active.assistant_message_id)
      const agentSession = active.provider_session_id ? { agentSessionId: active.provider_session_id } : {}
      const terminal = (payload: AgentPresentationEvent) =>
        this.commitInside({
          seq: this.next(input.sessionId),
          ts: Date.now(),
          sessionId: input.sessionId,
          ...agentSession,
          kind: "event",
          payload,
        }, input.fencingToken)
      const events: AgentPresentationEvent[] = []
      const lastTurn = { status: input.outcome.status, completedAt: input.outcome.completedAt }

      if (input.outcome.status === "failed") {
        const control = readColumn.turnStart(active.payload_json)
        const session = this.getSession(input.sessionId)
        events.push(
          messageUpdated(
            buildAssistantMessage({
              id: segment?.id ?? active.assistant_message_id,
              sessionID: input.sessionId,
              parentID: segment?.parentID ?? active.user_message_id ?? control.parentMessageId ?? input.sessionId,
              agent: control.agent ?? "build",
              model: control.model,
              directory: session?.directory ?? "",
              created: segment?.time?.created ?? active.created_at,
              completed: input.outcome.completedAt,
              error: { name: "UnknownError", data: { ...firstTurnErrorData(input.outcome.error ?? "turn failed", input.outcome), ...input.outcome.detail } },
              ...(control.variant ? { variant: control.variant } : {}),
            }),
          ),
        )
        events.push(sessionError(input.outcome.error ?? "turn failed", input.sessionId, input.outcome, lastTurn))
      } else {
        if (!readMessageCompleted(this.db, input.sessionId, segment?.id ?? active.assistant_message_id)) {
          events.push(messageCompleted(input.sessionId, segment?.id ?? active.assistant_message_id, input.outcome.status === "cancelled" || undefined))
        }
        events.push(sessionIdle(input.sessionId, lastTurn))
      }
      for (const payload of events) terminal(payload)

      this.commitInside({
        seq: this.next(input.sessionId),
        ts: input.outcome.completedAt,
        sessionId: input.sessionId,
        ...agentSession,
        kind: "control",
        control: {
          type: "turn.finish",
          assistantMessageId: active.assistant_message_id,
          outcome: { ...input.outcome, assistantMessageId: active.assistant_message_id },
        },
      }, input.fencingToken)
      return { events }
    })
  }

  private latestReplySegment(sessionId: string, turnId: string) {
    const reply = readTurnReply(this.db, sessionId, turnId)
    const message = reply ? readColumn.messageInfo(reply.info_json) : undefined
    return message?.role === "assistant" ? message : undefined
  }

  private session(row: {
    id: string
    workspace_id?: string | null
    parent_id?: string | null
    directory: string
    title: string | null
      title_source?: AgentSessionTitleSource | null
    commands_json?: string | null
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
    permission_mode?: string | null
    permission_mode_label?: string | null
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
      ...(row.title_source ? { titleSource: row.title_source } : {}),
      ...(row.commands_json ? { commands: readColumn.sessionCommands(row.commands_json) } : {}),
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
            config: sessionRowConfig(harness, row),
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
      const assistantMessageId = asString(properties?.messageID)
      if (!assistantMessageId) return undefined
      return {
        status: properties?.cancelled === true ? "cancelled" : "completed",
        assistantMessageId,
        completedAt: row.created_at,
      }
    }
    const message = asString(asRecord(asRecord(properties?.error)?.data)?.message)
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
      title_source?: AgentSessionTitleSource | null
      commands_json: string | null
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
        permission_mode: string | null
        permission_mode_label: string | null
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
          title_source,
          commands_json,
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
          permission_mode,
          permission_mode_label,
          created_at,
          updated_at,
          last_human_turn_at,
          status,
          recovery_error,
          archived_at
        FROM session
        LEFT JOIN session_execution_binding binding ON binding.session_id = session.id
        WHERE session.directory = ?
          -- A creation still waiting on its harness, or one that never finished, is nobody's session yet.
          AND NOT EXISTS (
            SELECT 1 FROM session_start start
            WHERE start.session_id = session.id AND json_extract(start.data_json, '$.status') <> 'created'
          )
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

  getSession(id: string) {
    const row = this.db
      .prepare<{
      id: string
      workspace_id: string | null
      parent_id: string | null
      directory: string
      title: string | null
      title_source?: AgentSessionTitleSource | null
      commands_json: string | null
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
      permission_mode: string | null
      permission_mode_label: string | null
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
          title_source,
          commands_json,
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
          permission_mode,
          permission_mode_label,
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

  sessionOwner(sessionId: string): TurnActor | undefined {
    const row = this.db.prepare<{ owner_json: string }>("SELECT owner_json FROM session WHERE id = ?").get(sessionId)
    if (!row) return undefined
    const owner: unknown = JSON.parse(row.owner_json)
    if (!isRecord(owner)) throw new Error(`Session ${sessionId} has an unreadable owner`)
    if (owner.kind === "machine-owner") return { kind: "machine-owner" }
    if (owner.kind === "person" && typeof owner.userId === "string") return { kind: "person", userId: owner.userId }
    throw new Error(`Session ${sessionId} has an unreadable owner`)
  }

  /** The child session and assistant message a routed correlation key names under a parent, once the broker bound it. */
  childRouteBinding(parentSessionId: string, correlationKey: string): { childSessionId: string; assistantMessageId: string } | undefined {
    const child = this.db.prepare<{ child_session_id: string; assistant_message_id: string }>(`
      SELECT subagent.child_session_id, subagent.assistant_message_id FROM session_subagent subagent
      LEFT JOIN session_subagent_correlation correlation
        ON correlation.parent_session_id = subagent.parent_session_id
        AND correlation.subagent_key = subagent.subagent_key
      WHERE subagent.parent_session_id = ? AND (subagent.subagent_key = ? OR subagent.provider_id = ?
        OR correlation.correlation_key = ?)
        AND child_session_id IS NOT NULL AND assistant_message_id IS NOT NULL
    `).get(parentSessionId, correlationKey, correlationKey, `route:${correlationKey}`)
    return child ? { childSessionId: child.child_session_id, assistantMessageId: child.assistant_message_id } : undefined
  }

  getSessionOwnerKey(id: string) {
    const row = this.db.prepare<{
      process_key: string | null
    }>("SELECT process_key FROM session WHERE id = ?").get(id)
    return row?.process_key ?? null
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
      options_json: string | null
    }>(
        `
        SELECT p.id, p.session_id, p.tool, p.patterns_json, p.always_json, p.metadata_json, p.options_json
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
        ...(row.options_json === null ? {} : { options: readColumn.permissionOptions(row.options_json) }),
      }))
  }

  listQuestions(directory: string): AgentQuestion[] {
    return this.db
      .prepare<{ id: string; session_id: string; questions_json: string }>(
        `
        SELECT q.id, q.session_id, q.questions_json
        FROM pending_question q
        LEFT JOIN session s ON s.id = q.session_id
        LEFT JOIN session_start p ON p.session_id = q.session_id
        WHERE COALESCE(s.directory, p.directory) = ? AND q.status = 'pending'
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
      const close = this.messageClose(info)
      const messageParts = partsByMessage.get(msg.id) ?? []
      return {
        info,
        parts: close ? messageParts.map((part) => this.terminalizedPart(part, close)) : messageParts,
        ...(msg.turn_id ? { turnId: msg.turn_id } : {}),
      }
    })
  }

  /**
   * Hydrate the first-paint projection directly from persistence: every text
   * part of the given messages, filtered before the JSON crosses the
   * SQLite/JavaScript boundary.
   */
  private hydrateSurfaceMessages(sessionId: string, msgs: MessageProjectionRow[]): AgentMessage[] {
    if (msgs.length === 0) return []
    const placeholders = msgs.map(() => "?").join(", ")
    const parts = this.db
      .prepare<{ message_id: string; data_json: string }>(
        `
        SELECT p.message_id, p.data_json
        FROM part p
        INNER JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
        WHERE p.session_id = ?
          AND p.message_id IN (${placeholders})
          AND json_extract(p.data_json, '$.type') = 'text'
        ORDER BY m.ord ASC, p.ord ASC
      `,
      )
      .all(sessionId, ...msgs.map((message) => message.id))
    const partsByMessage = new Map<string, AgentMessage["parts"]>()
    for (const part of parts) {
      const current = partsByMessage.get(part.message_id) ?? []
      current.push(readColumn.messagePart(part.data_json))
      partsByMessage.set(part.message_id, current)
    }
    return projectLatestSurfaceMessages(msgs.map((msg) => ({
      info: readColumn.messageInfo(msg.info_json),
      parts: partsByMessage.get(msg.id) ?? [],
      ...(msg.turn_id ? { turnId: msg.turn_id } : {}),
    })))
  }

  getMessages(sessionId: string): AgentMessage[] {
    this.settleDeltas(sessionId)
    const msgs = this.db
      .prepare<MessageProjectionRow>("SELECT id, ord, info_json, turn_id FROM message WHERE session_id = ? ORDER BY ord ASC")
      .all(sessionId)
    return this.hydrateMessages(sessionId, msgs)
  }

  relayedTurnInLineage(sessionId: string, ownerActorId?: string): boolean {
    return this.authoringOwnership.foreignActorInLineage(sessionId, ownerActorId)
  }

  getLatestUserMessageId(sessionId: string) {
    this.settleDeltas(sessionId)
    return this.db.prepare<{ id: string }>(
      "SELECT id FROM message WHERE session_id = ? AND role = 'user' ORDER BY ord DESC LIMIT 1",
    ).get(sessionId)?.id
  }

  messageSessionId(messageId: string) {
    return this.db.prepare<{ session_id: string }>("SELECT session_id FROM message WHERE id = ?").get(messageId)?.session_id
  }

  getPart(sessionId: string, messageId: string, partId: string): AgentContentPart | undefined {
    this.settleDeltas(sessionId)
    const row = this.db
      .prepare<{ info_json: string; data_json: string }>(
        `
        SELECT m.info_json, p.data_json
        FROM part p
        INNER JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
        WHERE p.id = ? AND p.session_id = ? AND p.message_id = ?
      `,
      )
      .get(partId, sessionId, messageId)
    if (!row) return undefined
    const part = readColumn.messagePart(row.data_json)
    const close = this.messageClose(readColumn.messageInfo(row.info_json))
    return close ? this.terminalizedPart(part, close) : part
  }

  turnOutline(sessionId: string): TurnOutline | undefined {
    this.settleDeltas(sessionId)
    if (!this.getSession(sessionId)) return undefined
    return readTurnOutline(this.db, sessionId)
  }

  getMessagePage(sessionId: string, page: AgentMessagePageInput): AgentMessagePage | undefined {
    this.settleDeltas(sessionId)
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
      const endOrd = page.before === undefined ? undefined : decodeMessagePageCursor(MESSAGE_PAGE_CURSOR_PREFIX, sessionId, page.before)
      return readLatestTurnView(this.db, sessionId, page.view, endOrd, {
        hydrate: (rows) => this.hydrateMessages(sessionId, rows),
        hydrateSurface: (rows) => this.hydrateSurfaceMessages(sessionId, rows),
        cursorAt: (ord) => encodeMessagePageCursor(MESSAGE_PAGE_CURSOR_PREFIX, sessionId, ord),
      })
    }
    if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > AGENT_MESSAGE_PAGE_LIMIT) {
      throw new AgentMessagePageError(400, `Message page limit must be between 1 and ${AGENT_MESSAGE_PAGE_LIMIT}`)
    }
    const beforeOrd = page.before === undefined ? undefined : decodeMessagePageCursor(MESSAGE_PAGE_CURSOR_PREFIX, sessionId, page.before)
    const params: unknown[] = [sessionId]
    if (beforeOrd !== undefined) params.push(beforeOrd)
    params.push(page.limit + 1)
    const rows = this.db
      .prepare<MessageProjectionRow>(
        `
        SELECT id, ord, info_json, turn_id
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
      ...(hasMore && selected[0] ? { nextCursor: encodeMessagePageCursor(MESSAGE_PAGE_CURSOR_PREFIX, sessionId, selected[0].ord) } : {}),
    }
  }

  /**
   * How much of one turn this store's projection accounts for, for a reader
   * deciding whether the transcript it already holds for that turn is final.
   *
   * The turn is named by either of its two message ids, the way `turnEvidence`
   * accepts either. Nothing here infers an end from a later turn or from an
   * exhausted page: only a journaled `turn.finish` ends a turn, and the answer
   * is `unavailable` wherever this store cannot establish the extent at all.
   */
  turnCoverage(sessionId: string, turnId: string): AgentTurnCoveragePage {
    this.settleDeltas(sessionId)
    if (!this.getSession(sessionId)) {
      throw new AgentMessagePageError(404, `Session not found: ${sessionId}`)
    }
    const replay = this.replayJournal(sessionId)
    const evidence = this.turnEvidence(sessionId, turnId)
    const ownTurn = readTurnId(this.db, sessionId, turnId)
    const answer = (
      coverage: AgentTurnCoverage,
      detail: { reason?: string; messages?: AgentMessage[] },
    ): AgentTurnCoveragePage => ({
      turnId,
      coverage,
      ...(detail.reason === undefined ? {} : { reason: detail.reason }),
      ...(evidence.finished && evidence.outcome ? { terminal: evidence.outcome } : {}),
      committedSequence: replay.position,
      messages: detail.messages ?? [],
    })

    if (!ownTurn) {
      // A turn this session never ran is not a turn that can never be covered:
      // answering `unavailable` tells a caller to stop asking, and it would
      // then discharge an obligation that another session still owes. Only a
      // turn no session journalled is genuinely unanswerable.
      const elsewhere = this.db
        .prepare<{ session_id: string }>(
          `
          SELECT session_id FROM runtime_journal
          WHERE kind = 'control' AND type = 'turn.start'
            AND (assistant_message_id = ? OR user_message_id = ?)
          LIMIT 1
        `,
        )
        .get(turnId, turnId)
      if (elsewhere) {
        throw new AgentMessagePageError(404, `Turn ${turnId} does not belong to session ${sessionId}`)
      }
      return answer("unavailable", { reason: `The journal records no turn ${turnId} for session ${sessionId}` })
    }
    if (replay.blocked) {
      return answer("unavailable", {
        reason: `The projection for session ${sessionId} is blocked at seq ${replay.blocked.seq}: ${replay.blocked.reason}`,
      })
    }
    const projected = this.db
      .prepare<{ present: number }>("SELECT 1 AS present FROM message WHERE session_id = ? LIMIT 1")
      .get(sessionId)
    if (!projected) {
      return answer("unavailable", { reason: `Session ${sessionId} has no projected transcript in this store` })
    }
    const named = this.db
      .prepare<{ id: string; ord: number; role: string; parent_id: string | null }>(
        `
        SELECT id, ord, role, json_extract(info_json, '$.parentID') AS parent_id
        FROM message
        WHERE session_id = ? AND id = ?
      `,
      )
      .get(sessionId, turnId)
    if (!named) {
      return answer("partial", { reason: `The projection holds no message ${turnId}` })
    }
    const boundary = named.role === "user"
      ? named
      : named.parent_id === null
        ? undefined
        : this.db
          .prepare<{ id: string; ord: number }>("SELECT id, ord FROM message WHERE session_id = ? AND id = ?")
          .get(sessionId, named.parent_id)
    if (!boundary) {
      return answer("partial", { reason: `The projection holds no user message owning ${turnId}` })
    }
    const prompts = new Set([boundary.id, ...readTurnPrompts(this.db, sessionId, ownTurn).map((prompt) => prompt.id)])
    const end = readTurnEndOrd(this.db, sessionId, boundary.ord, prompts)
    const rows = this.db
      .prepare<MessageProjectionRow>(
        `
        SELECT id, ord, info_json, turn_id
        FROM message
        WHERE session_id = ? AND ord >= ? AND (? IS NULL OR ord < ?)
        ORDER BY ord ASC
      `,
      )
      .all(sessionId, boundary.ord, end, end)
    const messages = this.hydrateMessages(sessionId, rows)
    if (!isContiguousTurn(rows, prompts)) {
      return answer("partial", { reason: `Turn ${turnId} is not contiguous in the projection`, messages })
    }
    if (!evidence.finished) {
      return answer("partial", { reason: `The journal records no end for turn ${turnId}`, messages })
    }
    return answer("complete", { messages })
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
    return this.turnLeases.acquire(sessionId)
  }

  releaseTurnLease(sessionId: string, leaseId: string) {
    this.turnLeases.release(sessionId, leaseId)
  }

  /** Who may currently write for this session, as the durable lease row says. */
  readTurnAuthority(sessionId: string) {
    return this.turnLeases.read(sessionId)
  }

  turnEvidence(sessionId: string, turnId: string) {
    return readTurnEvidence(this.db, sessionId, turnId)
  }

  /** The message one turn's outcome belongs to; either of the turn's message ids names it. */
  turnReply(sessionId: string, turnId: string): AgentMessage | undefined {
    this.settleDeltas(sessionId)
    const replyId = readTurnReplyId(this.db, sessionId, turnId)
    if (!replyId) return undefined
    const rows = this.db.prepare<MessageProjectionRow>("SELECT id, ord, info_json, turn_id FROM message WHERE session_id = ? AND id = ?").all(sessionId, replyId)
    return this.hydrateMessages(sessionId, rows)[0]
  }

  upstreamHasTurns(sessionId: string, upstreamSessionId: string) {
    return readUpstreamHasTurns(this.db, sessionId, upstreamSessionId)
  }

  /**
   * Claim one recovery request id for one caller. The unique index decides the
   * race, so two runtimes sharing this store cannot both believe they created
   * the operation; the loser reads back the row that won.
   */
  recordRecoveryOperation(operation: RecoveryOperation, caller: { callerId: string }) {
    this.pruneRecoveryOperations()
    const scopeKey = recoveryScopeKey(operation.target)
    const created = this.db
      .prepare(
        `
        INSERT OR IGNORE INTO recovery_operation (
          operation_id, scope_key, caller_id, request_id, session_id, action, state,
          cleanup_fact, persistence_fact, created_at, updated_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        operation.operationId,
        scopeKey,
        caller.callerId,
        operation.requestId,
        recoveryTargetSessionId(operation.target),
        operation.action,
        operation.state,
        operation.facts.cleanup.value,
        operation.facts.persistence.value,
        operation.createdAt,
        operation.updatedAt,
        JSON.stringify(operation),
      )
    if (created.changes === 1) {
      this.db
        .prepare("INSERT OR IGNORE INTO recovery_operation_caller (operation_id, caller_id) VALUES (?, ?)")
        .run(operation.operationId, caller.callerId)
      return { created: true as const }
    }
    const existing = requireRow(
      this.db
        .prepare<{ payload_json: string }>(
          "SELECT payload_json FROM recovery_operation WHERE scope_key = ? AND caller_id = ? AND request_id = ?",
        )
        .get(scopeKey, caller.callerId, operation.requestId),
      "recovery_operation existing",
    )
    return { created: false as const, existing: parseRecoveryOperation(JSON.parse(existing.payload_json)) }
  }

  /**
   * Takes no caller, unlike the read. An update is the owner writing what it
   * observed about work it is already performing; the read is a caller asking
   * for a receipt that names a turn and its owner generation. Only one of those
   * is a disclosure.
   */
  updateRecoveryOperation(operation: RecoveryOperation) {
    const result = this.db
      .prepare(
        `
        UPDATE recovery_operation
        SET state = ?, cleanup_fact = ?, persistence_fact = ?, updated_at = ?, payload_json = ?
        WHERE operation_id = ?
      `,
      )
      .run(
        operation.state,
        operation.facts.cleanup.value,
        operation.facts.persistence.value,
        operation.updatedAt,
        JSON.stringify(operation),
        operation.operationId,
      )
    if (result.changes === 0) {
      throw new Error(
        `Recovery operation ${operation.operationId} is not recorded in this store; it was never created here, `
          + "or it settled with nothing outstanding and aged out",
      )
    }
  }

  /**
   * Record a caller that coalesced onto an operation someone else created. Its
   * own request id claimed nothing, so without this nothing would say it may
   * read the receipt of the effect being issued on its behalf. An id this
   * store does not hold records nobody: the caller list must not outlive the
   * operation it describes.
   */
  addRecoveryOperationCaller(operationId: string, caller: { callerId: string }) {
    if (!this.db.prepare("SELECT 1 FROM recovery_operation WHERE operation_id = ?").get(operationId)) return
    this.db
      .prepare("INSERT OR IGNORE INTO recovery_operation_caller (operation_id, caller_id) VALUES (?, ?)")
      .run(operationId, caller.callerId)
  }

  readRecoveryOperation(operationId: string, caller: { callerId: string }) {
    const row = this.db
      .prepare<{ payload_json: string }>(
        `
        SELECT op.payload_json FROM recovery_operation AS op
        JOIN recovery_operation_caller AS reader
          ON reader.operation_id = op.operation_id AND reader.caller_id = ?
        WHERE op.operation_id = ?
      `,
      )
      .get(caller.callerId, operationId)
    return row ? parseRecoveryOperation(JSON.parse(row.payload_json)) : undefined
  }

  /**
   * In-flight operations, plus the settled ones a caller could still be
   * holding a receipt for. Older settled rows are omitted rather than
   * presented as current work.
   */
  listRecoveryOperations(scope: { sessionId?: string } = {}) {
    const rows = this.db
      .prepare<{ payload_json: string }>(
        `
        SELECT payload_json FROM recovery_operation
        WHERE (? IS NULL OR session_id = ?)
          AND (
            state NOT IN ('succeeded', 'failed')
            OR updated_at >= ?
            OR cleanup_fact <> 'verified_clear'
            OR persistence_fact = 'pending'
          )
        ORDER BY updated_at DESC
      `,
      )
      .all(scope.sessionId ?? null, scope.sessionId ?? null, Date.now() - RECOVERY_OPERATION_RETENTION_MS)
    return rows.map((row) => parseRecoveryOperation(JSON.parse(row.payload_json)))
  }

  /**
   * Drop settled operations past the retention window. An operation whose
   * facts still say something is owned, unknown or unwritten is kept whatever
   * its age: deleting it would destroy the only record of an obligation
   * nobody has discharged.
   */
  private pruneRecoveryOperations() {
    this.db.transaction(() => {
      const expired = `
        SELECT operation_id FROM recovery_operation
        WHERE state IN ('succeeded', 'failed')
          AND updated_at < ?
          AND cleanup_fact = 'verified_clear'
          AND persistence_fact <> 'pending'
      `
      const cutoff = Date.now() - RECOVERY_OPERATION_RETENTION_MS
      this.db.prepare(`DELETE FROM recovery_operation_caller WHERE operation_id IN (${expired})`).run(cutoff)
      this.db.prepare(`DELETE FROM recovery_operation WHERE operation_id IN (${expired})`).run(cutoff)
    })
  }

  /**
   * A per-store random secret, minted on first read and never rotated, so ids
   * derived from it (idempotent child sessions) stay stable across restarts
   * and differ between runtimes that never shared a store.
   */
  runtimeSecret(name: string) {
    const existing = this.db.prepare<{ value: string }>("SELECT value FROM runtime_secret WHERE name = ?").get(name)
    if (existing) return existing.value
    const value = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
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
      permission_mode_label: string | null
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
          permission_mode_label,
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
      ...(row.permission_mode && row.permission_mode_label ? { permissionModeLabel: row.permission_mode_label } : {}),
      ...(row.permission_state_json ? { permissionState: JSON.parse(row.permission_state_json) } : {}),
    }
  }

  private applyConfigUpdate(id: string, patch: SessionConfigUpdate, ts: number) {
    const prev = this.db
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
      permission_mode_label: string | null
      updated_at: number
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
          permission_mode_label,
          permission_state_json,
          updated_at
        FROM session
        WHERE id = ?
      `,
      )
      .get(id)
    if (!prev) return
    const prevHarness = sessionHarness(prev)
    if (!prevHarness && !patch.harness) return
    const nextHarness = patch.harness ?? prevHarness
    const sameHarness = nextHarness?.id === prevHarness?.id && nextHarness?.access === prevHarness?.access
    if (prevHarness && !sameHarness) {
      this.db.prepare("UPDATE session SET commands_json = NULL WHERE id = ?").run(id)
    }
    const nextProviderId = patch.model === undefined ? prev.model_provider_id : (patch.model?.providerID ?? null)
    const nextModelId = patch.model === undefined ? prev.model_id : (patch.model?.modelID ?? null)
    const nextVariant = patch.variant === undefined ? prev.variant : patch.variant
    const nextPermissionMode = patch.permissionMode === undefined ? (sameHarness ? prev.permission_mode : null) : patch.permissionMode
    const nextPermissionModeLabel = patch.permissionMode === undefined
      ? patch.permissionModeLabel === undefined ? (sameHarness ? prev.permission_mode_label : null) : patch.permissionModeLabel
      : patch.permissionModeLabel ?? null
    const selectionChanged = !nextHarness || !sameRunningSelections(
      prevHarness && sessionRowConfig(prevHarness, prev),
      sessionRowConfig(nextHarness, { model_provider_id: nextProviderId, model_id: nextModelId, variant: nextVariant, permission_mode: nextPermissionMode }),
    )
    // Hydrating a session's config on a visit writes the values it already runs; only a changed selection may reorder the list.
    this.db
      .prepare(
        `
	      UPDATE session
	      SET harness_id = ?, harness_access = ?, harness_binary = ?, harness_transport = ?, harness_url = ?, harness_headers_json = ?, model_provider_id = ?, model_id = ?, variant = ?, agent = ?, instructions = ?, group_json = ?, handoff_json = ?, permission_mode = ?, permission_mode_label = ?, permission_state_json = ?, permission_ceiling = ?, updated_at = ?
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
        nextProviderId,
        nextModelId,
        nextVariant,
        patch.agent === undefined ? (prev?.agent ?? null) : patch.agent,
        patch.instructions === undefined ? (prev?.instructions ?? null) : patch.instructions,
        patch.group === undefined ? (prev?.group_json ?? null) : sessionModelGroupJson(patch.group),
        patch.handoff === undefined ? (prev?.handoff_json ?? null) : sessionHandoffJson(patch.handoff),
        nextPermissionMode,
        nextPermissionMode === null ? null : nextPermissionModeLabel,
        patch.permissionState === undefined
          ? sameHarness ? prev.permission_state_json : null
          : patch.permissionState ? JSON.stringify(patch.permissionState) : null,
        patch.permissionCeiling ?? prev.permission_ceiling,
        selectionChanged ? Math.max(prev.updated_at, ts) : prev.updated_at,
        id,
      )
  }

  getGoal(id: string): RuntimeGoalSnapshot | null {
    const row = this.db.prepare<{ goal_json: string | null }>("SELECT goal_json FROM session WHERE id = ?").get(id)
    return row?.goal_json ? JSON.parse(row.goal_json) : null
  }

  setGoal(id: string, goal: RuntimeGoalSnapshot | null): AgentPresentationEvent[] {
    this.assertProjectionCurrent(id)
    this.settleDeltas(id)
    return this.db.transaction(() => {
      if (!this.getSession(id) || JSON.stringify(this.getGoal(id)) === JSON.stringify(goal)) return []
      const payload: AgentPresentationEvent = goal
        ? { type: "goal.updated", properties: { sessionID: id, goal } }
        : { type: "goal.cleared", properties: { sessionID: id } }
      this.commitInside({
        seq: this.next(id), ts: Date.now(), sessionId: id, kind: "control",
        control: { type: "goal.update", goal },
      }, undefined)
      this.brokerAppendInside(id, payload)
      return [payload]
    })
  }

  updateSessionConfig(id: string, update: SessionConfigUpdate) {
    const row: Row = {
      seq: this.next(id),
      ts: Date.now(),
      sessionId: id,
      kind: "control",
      control: {
        type: "config.update",
        patch: update,
      },
    }
    this.commit(row)
    return this.getSessionConfig(id)
  }
}
