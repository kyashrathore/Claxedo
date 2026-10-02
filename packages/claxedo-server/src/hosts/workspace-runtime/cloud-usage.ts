import { mkdirSync } from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import type { WorkspaceRuntimeServerOptions } from "@claxedo/workspace-runtime"
import type { SessionAccessPolicy } from "@claxedo/session-core"
import {
  assertTurnUsageRevision,
  usageRevisionHash,
  type TurnUsageRevision,
  type TurnUsageSettlement,
  type UsageRevisionWriteResult,
} from "@claxedo/server-core/usage/contracts"
import { createTurnMeter } from "@claxedo/server-core/usage/turn-meter"
import { readTurnMeterState, type TurnMeterStateStore } from "@claxedo/server-core/usage/turn-meter-state"
import {
  cloudWorkspaceUsageContext,
  cloudWorkspaceUsageRevision,
  readUsageReportRevision,
  usageReportRevision,
  USAGE_REPORT_ACTION,
  USAGE_REPORT_MAX_FACTS,
  USAGE_REPORT_RESULT_STATUSES,
  type UsageReportFact,
  type UsageReportResult,
} from "@claxedo/server-core/usage/usage-report"
import { SESSION_TURN_LEASE_TTL_MS } from "@claxedo/workspace-relay-protocol"
import { meteringHarnessId } from "@claxedo/server-core/session/harness/index"
import { isJsonRecord, isOneOf } from "@claxedo/server-core/platform/runtime/lib/json"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"

/**
 * The session-authority endpoint refuses a body over 16 KiB; the turn lease
 * and the envelope around the facts take the rest.
 */
const REPORT_BODY_BUDGET_BYTES = 12 * 1024
const REPORT_TIMEOUT_MS = 5_000
/** Every lease sees at least one flush before it expires. */
const LIVE_FLUSH_INTERVAL_MS = SESSION_TURN_LEASE_TTL_MS / 2

type ReportResult = Pick<UsageReportResult, "messageId" | "revision" | "status">

const DELIVERY = {
  accepted: "delivered",
  duplicate: "delivered",
  stale: "stale",
  conflict: "conflict",
  refused: "refused",
} as const satisfies Record<ReportResult["status"], string>

/** A turn lease's turn: the session holding the lease and the turn it admitted. */
type MeteringTurn = { sessionId: string; turnId: string }

/**
 * A fact to report, and the session and message it was metered on: the plane
 * answers by the fact's reported message id, the ledger settles by these.
 */
export type PendingUsageFact = { sessionId: string; messageId: string; fact: UsageReportFact }

/**
 * The message id a fact is reported under. The plane files every fact under
 * the session whose turn carried it, keyed by message id, and a descendant's
 * message id is unique only within its own session: an ACP agent names its
 * own messages, so a grandchild can reuse its parent's. Qualifying a
 * descendant's id by its session keeps its fact from answering as, or
 * replacing, another fact filed under that turn's session.
 */
function reportedMessageId(input: { sessionId: string; turnSessionId: string; messageId: string }) {
  return input.sessionId === input.turnSessionId ? input.messageId : `${input.sessionId}/${input.messageId}`
}

type CurrentFilter = { sessionId?: string; messageId?: string; settlement?: TurnUsageSettlement }

export type SandboxUsageLedger = {
  /**
   * Records a revision as metered under `turn`. A message keeps the turn its
   * first revision was recorded under, so a revision written after that turn
   * ended, or by a restarted runtime, still names it.
   */
  writeRevision(fact: TurnUsageRevision, turn: MeteringTurn | undefined): Promise<UsageRevisionWriteResult>
  current(filter?: CurrentFilter): Promise<TurnUsageRevision[]>
  /** Remembers `turn` as the latest the plane admitted on its session, across restarts. */
  recordTurn(turn: MeteringTurn): void
  /** The latest turn the plane admitted on `sessionId`, whether or not it still holds the session. */
  latestTurn(sessionId: string): string | undefined
  /** Files every message recorded under no turn, on a session `belongs` accepts, under `turn`. */
  adoptUnattributed(turn: MeteringTurn, belongs: (sessionId: string) => boolean): void
  /**
   * The latest unanswered revision of each message metered under one of
   * `sessionId`'s turns, whether the message is on that session or on one of
   * its descendants.
   */
  pending(sessionId: string): PendingUsageFact[]
  /**
   * Records the plane's answer for a revision and every earlier one of the
   * same message, and drops the answered revisions a later one supersedes.
   */
  settle(sessionId: string, result: ReportResult): void
  /** The meter's per-scope running usage, kept beside the facts and out of their payloads. */
  meterState: TurnMeterStateStore
  close(): void
}

/**
 * A cloud workspace runtime's own record of its turns' usage, and the outbox
 * of what the plane has not yet answered for. It lives in the runtime's store
 * directory, so a restarted runtime still reports what it metered before.
 */
export function createSandboxUsageLedger(input: { path: string; workspaceId: string }): SandboxUsageLedger {
  mkdirSync(path.dirname(input.path), { recursive: true })
  const db = new Database(input.path)
  db.pragma("journal_mode = WAL")
  db.exec(`
    create table if not exists usage_revisions (
      session_id text not null,
      message_id text not null,
      revision integer not null,
      turn_session_id text,
      turn_id text,
      payload_hash text not null,
      settlement text not null,
      fact_json text not null,
      delivery text not null default 'pending',
      primary key (session_id, message_id, revision)
    );
    create index if not exists usage_revisions_unattributed on usage_revisions (session_id, message_id) where turn_id is null;
    create index if not exists usage_revisions_by_turn_session on usage_revisions (turn_session_id, delivery);
    create index if not exists usage_revisions_by_settlement on usage_revisions (settlement);
    create table if not exists usage_session_turns (
      session_id text primary key,
      turn_id text not null
    );
    create table if not exists usage_meter_state (
      session_id text not null,
      message_id text not null,
      streams_json text not null,
      observation_keys_json text not null,
      primary key (session_id, message_id)
    );
  `)
  const latest = db.prepare<
    [string, string],
    { revision: number; payload_hash: string; turn_session_id: string | null; turn_id: string | null }
  >(
    "select revision, payload_hash, turn_session_id, turn_id from usage_revisions where session_id = ? and message_id = ? order by revision desc limit 1",
  )
  const insert = db.prepare<[string, string, number, string | null, string | null, string, string, string]>(`
    insert into usage_revisions (session_id, message_id, revision, turn_session_id, turn_id, payload_hash, settlement, fact_json)
    values (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const currentStatements = new Map<string, Database.Statement<string[], { session_id: string; fact_json: string }>>()
  // One statement per filter shape: SQLite plans a `? is null or column = ?`
  // predicate as a scan of the whole table.
  const currentRows = (filter: CurrentFilter) => {
    const columns = ([
      ["session_id", filter.sessionId],
      ["message_id", filter.messageId],
      ["settlement", filter.settlement],
    ] as const).flatMap(([column, value]) => (value === undefined ? [] : [[column, value] as const]))
    const shape = columns.map(([column]) => column).join(",")
    let statement = currentStatements.get(shape)
    if (!statement) {
      statement = db.prepare<string[], { session_id: string; fact_json: string }>(`
        select session_id, fact_json from usage_revisions row
        where revision = (
          select max(revision) from usage_revisions message
          where message.session_id = row.session_id and message.message_id = row.message_id
        )${columns.map(([column]) => ` and row.${column} = ?`).join("")}
        order by row.rowid
      `)
      currentStatements.set(shape, statement)
    }
    return statement.all(...columns.map(([, value]) => value))
  }
  const saveTurn = db.prepare<[string, string]>(
    "insert into usage_session_turns (session_id, turn_id) values (?, ?) on conflict (session_id) do update set turn_id = excluded.turn_id",
  )
  const loadTurn = db.prepare<[string], { turn_id: string }>("select turn_id from usage_session_turns where session_id = ?")
  const unattributedRows = db.prepare<[], { session_id: string; message_id: string }>(
    "select distinct session_id, message_id from usage_revisions where turn_id is null",
  )
  const attribute = db.prepare<[string, string, string, string]>(
    "update usage_revisions set turn_session_id = ?, turn_id = ? where session_id = ? and message_id = ? and turn_id is null",
  )
  const pendingRows = db.prepare<[string], { session_id: string; message_id: string; turn_id: string; fact_json: string }>(`
    select session_id, message_id, turn_id, fact_json from usage_revisions row
    where turn_session_id = ? and delivery = 'pending' and revision = (
      select max(revision) from usage_revisions message
      where message.session_id = row.session_id and message.message_id = row.message_id and message.delivery = 'pending'
    )
    order by row.rowid
  `)
  const settleRows = db.prepare<[string, string, string, number]>(
    "update usage_revisions set delivery = ? where session_id = ? and message_id = ? and revision <= ? and delivery = 'pending'",
  )
  const pruneAnswered = db.prepare<[string, string, string, string]>(`
    delete from usage_revisions
    where session_id = ? and message_id = ? and delivery <> 'pending' and revision < (
      select max(revision) from usage_revisions where session_id = ? and message_id = ?
    )
  `)
  const loadState = db.prepare<[string, string], { streams_json: string; observation_keys_json: string }>(
    "select streams_json, observation_keys_json from usage_meter_state where session_id = ? and message_id = ?",
  )
  const saveState = db.prepare<[string, string, string, string]>(`
    insert into usage_meter_state (session_id, message_id, streams_json, observation_keys_json) values (?, ?, ?, ?)
    on conflict (session_id, message_id) do update set
      streams_json = excluded.streams_json, observation_keys_json = excluded.observation_keys_json
  `)
  const stored = (factJson: string) => {
    try {
      return readUsageReportRevision(JSON.parse(factJson))
    } catch {
      return undefined
    }
  }
  return {
    async writeRevision(item, turn) {
      assertTurnUsageRevision(item)
      const hash = await usageRevisionHash(item)
      const current = latest.get(item.sessionId, item.messageId)
      if (current && item.revision < current.revision) return { status: "stale", currentRevision: current.revision }
      if (current && item.revision === current.revision) {
        return current.payload_hash === hash ? { status: "duplicate" } : { status: "conflict", currentRevision: current.revision }
      }
      const filedUnder = current
        ? { sessionId: current.turn_session_id, turnId: current.turn_id }
        : { sessionId: turn?.sessionId ?? null, turnId: turn?.turnId ?? null }
      insert.run(
        item.sessionId,
        item.messageId,
        item.revision,
        filedUnder.sessionId,
        filedUnder.turnId,
        hash,
        item.settlement,
        JSON.stringify(usageReportRevision(item)),
      )
      return { status: "accepted" }
    },
    async current(filter = {}) {
      return currentRows(filter).flatMap((row) => {
        const fact = stored(row.fact_json)
        return fact ? [cloudWorkspaceUsageRevision(fact, { workspaceId: input.workspaceId, sessionId: row.session_id })] : []
      })
    },
    recordTurn(turn) {
      saveTurn.run(turn.sessionId, turn.turnId)
    },
    latestTurn(sessionId) {
      return loadTurn.get(sessionId)?.turn_id
    },
    adoptUnattributed(turn, belongs) {
      db.transaction(() => {
        for (const row of unattributedRows.all()) {
          if (belongs(row.session_id)) attribute.run(turn.sessionId, turn.turnId, row.session_id, row.message_id)
        }
      })()
    },
    pending(sessionId) {
      return pendingRows.all(sessionId).flatMap((row) => {
        const fact = stored(row.fact_json)
        if (!fact) return []
        const messageId = reportedMessageId({ sessionId: row.session_id, turnSessionId: sessionId, messageId: row.message_id })
        return [{ sessionId: row.session_id, messageId: row.message_id, fact: { ...fact, messageId, turnId: row.turn_id } }]
      })
    },
    settle(sessionId, result) {
      db.transaction(() => {
        settleRows.run(DELIVERY[result.status], sessionId, result.messageId, result.revision)
        pruneAnswered.run(sessionId, result.messageId, sessionId, result.messageId)
      })()
    },
    meterState: {
      async load({ sessionId, messageId }) {
        const row = loadState.get(sessionId, messageId)
        if (!row) return undefined
        try {
          return readTurnMeterState(JSON.parse(row.streams_json), JSON.parse(row.observation_keys_json))
        } catch {
          return undefined
        }
      },
      async save({ sessionId, messageId, state }) {
        saveState.run(sessionId, messageId, JSON.stringify(state.streams), JSON.stringify(state.lastObservationKeys))
      },
    },
    close() {
      db.close()
    },
  }
}

function reportResults(value: unknown): Array<ReportResult & { code?: string }> | undefined {
  if (!isJsonRecord(value) || !Array.isArray(value.results)) return undefined
  return value.results.flatMap((item) => {
    if (!isJsonRecord(item)) return []
    const { messageId, revision, status, code } = item
    return typeof messageId === "string" && typeof revision === "number" && isOneOf(status, USAGE_REPORT_RESULT_STATUSES)
      ? [{ messageId, revision, status, ...(typeof code === "string" ? { code } : {}) }]
      : []
  })
}

type TurnProof = { sessionId: string; turnId: string; leaseId: string; fencingToken: number }

function reportBody(proof: TurnProof, batch: readonly PendingUsageFact[]) {
  const { sessionId, turnId, leaseId, fencingToken } = proof
  return JSON.stringify({ action: USAGE_REPORT_ACTION, sessionId, turnId, leaseId, fencingToken, facts: batch.map((item) => item.fact) })
}

/** `facts` in batches whose report bodies each fit the endpoint's size and count budgets. */
function reportBatches(proof: TurnProof, facts: readonly PendingUsageFact[]) {
  const size = (batch: readonly PendingUsageFact[]) => new TextEncoder().encode(reportBody(proof, batch)).length
  const batches: PendingUsageFact[][] = []
  let batch: PendingUsageFact[] = []
  for (const item of facts) {
    if (batch.length === USAGE_REPORT_MAX_FACTS || (batch.length > 0 && size([...batch, item]) > REPORT_BODY_BUDGET_BYTES)) {
      batches.push(batch)
      batch = []
    }
    batch.push(item)
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

/**
 * The plane answers a report it cannot read with 400 and one too large with
 * 413: the batch alone is at fault, and the next one may still land. Any
 * other refusal — a proof it no longer accepts, or a plane that cannot
 * answer — would refuse every batch alike.
 */
const BATCH_REFUSALS: ReadonlySet<number> = new Set([400, 413])

export type CloudWorkspaceUsage = Required<Pick<
  WorkspaceRuntimeServerOptions,
  "sessionAccessPolicy" | "onPresentationEvent" | "onTurnOutcome" | "bindSessionConfig" | "bindSessionParents"
>> & {
  /**
   * Stops the periodic flush until the next lease, then resolves once every
   * metered event is recorded and each session's unanswered revisions have
   * been offered under its last unexpired lease: the last delivery before the
   * process exits.
   */
  drain(): Promise<void>
}

/**
 * Meters a cloud workspace runtime's turns into `ledger` and ships each
 * session's unanswered revisions to the control plane under that session's
 * turn lease: when the turn ends, whether its lease was released or lost, and
 * every `flushIntervalMs` while a lease the plane issued for the session has
 * not expired, so a revision written after its turn ended still ships under
 * it. A revision is metered under the turn holding its session or that
 * session's nearest ancestor, else the latest turn admitted on the nearest of
 * them, so a subagent's child session is metered under the turn that started
 * it and usage landing between turns under the turn that left it. Each
 * revision names that turn, and the plane files it under the turn's
 * producer, so a revision that waits for a later lease, whoever's, stays its
 * own turn's. A revision the plane does not answer for stays pending until
 * the next lease on the session holding its turn carries it.
 */
export function cloudWorkspaceUsage(input: {
  workspaceId: string
  ledger: SandboxUsageLedger
  authorityUrl: string
  policy: SessionAccessPolicy
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  flushIntervalMs?: number
  now?: () => number
}): CloudWorkspaceUsage {
  const log = Log.create({ service: "claxedo-cloud-usage" })
  const send = input.fetch ?? fetch
  const now = input.now ?? Date.now
  let readSessionConfig: Parameters<NonNullable<WorkspaceRuntimeServerOptions["bindSessionConfig"]>>[0] | undefined
  let parentOf: (sessionId: string) => string | undefined = () => undefined
  const activeTurns = new Map<string, string>()
  /** Each session's latest lease from the plane, until it expires: what a report on that session is proven by. */
  const leases = new Map<string, TurnProof & { expiresAt: number }>()

  /** `sessionId`, then its parent, grandparent and on up to its root. */
  function lineage(sessionId: string) {
    const sessions = [sessionId]
    for (let parent = parentOf(sessionId); parent && !sessions.includes(parent); parent = parentOf(parent)) sessions.push(parent)
    return sessions
  }

  /**
   * The turn holding `sessionId` or its nearest ancestor now, else the latest
   * turn admitted on the nearest of them: usage that lands after its turn
   * ended, or while a lost lease's harness winds down, is still that turn's.
   */
  function meteringTurn(sessionId: string): MeteringTurn | undefined {
    const sessions = lineage(sessionId)
    for (const session of sessions) {
      const turnId = activeTurns.get(session)
      if (turnId) return { sessionId: session, turnId }
    }
    for (const session of sessions) {
      const turnId = input.ledger.latestTurn(session)
      if (turnId) return { sessionId: session, turnId }
    }
    return undefined
  }

  const meter = createTurnMeter({
    writer: { writeRevision: (fact) => input.ledger.writeRevision(fact, meteringTurn(fact.sessionId)) },
    reader: input.ledger,
    state: input.ledger.meterState,
    reconcileProvisionalOnStart: true,
    resolveContext: async ({ sessionId }) => {
      const config = readSessionConfig?.(sessionId)
      if (!config) throw new Error(`usage metering requires the committed configuration of session ${sessionId}`)
      return {
        ...cloudWorkspaceUsageContext({ workspaceId: input.workspaceId, sessionId }),
        harness: meteringHarnessId(config.harness),
        ...(config.model?.providerID ? { providerId: config.model.providerID } : {}),
        ...(config.model?.modelID ? { modelId: config.model.modelID } : {}),
      }
    },
    onDegraded: (error) => log.warn("usage.metering_degraded", { error: String(error) }),
  })
  void meter.start()

  async function report(proof: TurnProof, facts: readonly PendingUsageFact[]) {
    for (const batch of reportBatches(proof, facts)) {
      const response = await send(input.authorityUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: reportBody(proof, batch),
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      })
      if (!response.ok) {
        log.warn("usage.report_refused", { status: response.status, sessionId: proof.sessionId, facts: batch.length })
        if (BATCH_REFUSALS.has(response.status)) continue
        return
      }
      for (const result of reportResults(await response.json().catch(() => undefined)) ?? []) {
        const reported = batch.find((item) => item.fact.messageId === result.messageId && item.fact.revision === result.revision)
        if (!reported) continue
        if (result.status === "refused") {
          log.warn("usage.fact_refused", { sessionId: reported.sessionId, messageId: reported.messageId, code: result.code })
        }
        input.ledger.settle(reported.sessionId, { ...result, messageId: reported.messageId })
      }
    }
  }

  let reports: Promise<void> = Promise.resolve()
  /** Offers the session's unanswered revisions under `proof`, read when the report goes rather than when it is queued. */
  function queueReport(proof: TurnProof) {
    reports = reports
      .then(async () => {
        const facts = input.ledger.pending(proof.sessionId)
        if (facts.length > 0) await report(proof, facts)
      })
      .catch((error: unknown) => log.warn("usage.report_failed", { error: String(error), sessionId: proof.sessionId }))
  }

  let flushTimer: ReturnType<typeof setInterval> | undefined
  function stopFlushing() {
    if (flushTimer) clearInterval(flushTimer)
    flushTimer = undefined
  }
  function reportLiveLeases() {
    const at = now()
    for (const [sessionId, lease] of leases) {
      if (lease.expiresAt <= at) leases.delete(sessionId)
      else queueReport(lease)
    }
  }
  async function flushLiveLeases() {
    await meter.flush()
    reportLiveLeases()
    if (leases.size === 0) stopFlushing()
    await reports
  }
  function holdLease(lease: TurnProof & { expiresAt: number }) {
    leases.set(lease.sessionId, lease)
    if (flushTimer) return
    flushTimer = setInterval(() => void flushLiveLeases(), input.flushIntervalMs ?? LIVE_FLUSH_INTERVAL_MS)
    flushTimer.unref?.()
  }

  const acquire = input.policy.acquireTurn?.bind(input.policy)
  const renew = input.policy.renewTurn?.bind(input.policy)
  const endTurn = input.policy.endTurn?.bind(input.policy)
  return {
    sessionAccessPolicy: acquire && renew
      ? {
          ...input.policy,
          async acquireTurn(turn) {
            const decision = await acquire(turn)
            if (decision.allowed) {
              activeTurns.set(turn.sessionId, decision.turnId)
              try {
                input.ledger.recordTurn({ sessionId: turn.sessionId, turnId: decision.turnId })
              } catch (error) {
                log.warn("usage.turn_record_failed", { error: String(error), sessionId: turn.sessionId })
              }
              const { turnId, leaseId, fencingToken, expiresAt } = decision
              holdLease({ sessionId: turn.sessionId, turnId, leaseId, fencingToken, expiresAt })
            }
            return decision
          },
          async renewTurn(turn) {
            const decision = await renew(turn)
            if (decision.allowed) {
              const { turnId, leaseId, fencingToken, expiresAt } = decision
              holdLease({ sessionId: turn.sessionId, turnId, leaseId, fencingToken, expiresAt })
            }
            return decision
          },
          async endTurn(turn) {
            const proof = { sessionId: turn.sessionId, turnId: turn.turnId, leaseId: turn.leaseId, fencingToken: turn.fencingToken }
            try {
              await endTurn?.(turn)
              // Flushed before the turn stops holding its session, so every
              // event consumed during it is recorded under it.
              await meter.flush()
              if (activeTurns.get(turn.sessionId) === turn.turnId) activeTurns.delete(turn.sessionId)
              // Usage metered before any turn was admitted on its session or an
              // ancestor is still usage: the first turn of that family to end
              // carries it.
              input.ledger.adoptUnattributed(proof, (sessionId) => lineage(sessionId).includes(turn.sessionId))
            } catch (error) {
              log.warn("usage.turn_end_failed", { error: String(error), sessionId: turn.sessionId })
            }
            queueReport(proof)
          },
        }
      : input.policy,
    onPresentationEvent: (event) => void meter.consume(event),
    onTurnOutcome: ({ sessionId, assistantMessageId, outcome }) => {
      if (outcome.status !== "cancelled" || !assistantMessageId) return
      void meter.settle({
        sessionId,
        messageId: assistantMessageId,
        status: outcome.reason === "steer" ? "interrupted_by_steer" : "stopped",
      })
    },
    bindSessionConfig: (read) => {
      readSessionConfig = read
    },
    bindSessionParents: (read) => {
      parentOf = read
    },
    async drain() {
      stopFlushing()
      await meter.flush()
      reportLiveLeases()
      await reports
    },
  }
}
