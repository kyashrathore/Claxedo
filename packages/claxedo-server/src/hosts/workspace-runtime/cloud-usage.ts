import { mkdirSync } from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import type { SessionAccessPolicy, WorkspaceRuntimeServerOptions } from "@claxedo/workspace-runtime"
import {
  assertTurnUsageRevision,
  usageRevisionHash,
  type TurnUsageRevision,
  type TurnUsageSettlement,
  type UsageRevisionWriteResult,
} from "@claxedo/server-core/usage/contracts"
import { createTurnMeter } from "@claxedo/server-core/usage/turn-meter"
import {
  cloudWorkspaceUsageContext,
  cloudWorkspaceUsageRevision,
  readUsageReportRevision,
  usageReportRevision,
  USAGE_REPORT_ACTION,
  USAGE_REPORT_RESULT_STATUSES,
  type UsageReportFact,
  type UsageReportResult,
} from "@claxedo/server-core/usage/usage-report"
import { meteringHarnessId } from "@claxedo/server-core/session/harness/index"
import { isJsonRecord, isOneOf } from "@claxedo/server-core/platform/runtime/lib/json"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"

/**
 * The session-authority endpoint refuses a body over 16 KiB; the turn lease
 * and the envelope around the facts take the rest.
 */
const REPORT_BODY_BUDGET_BYTES = 12 * 1024
const REPORT_TIMEOUT_MS = 5_000

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

export type SandboxUsageLedger = {
  /**
   * Records a revision as metered under `turn`, the turn holding its session
   * or that session's nearest ancestor now. A message keeps the turn its
   * first revision was recorded under, so a revision written after that turn
   * ended, or by a restarted runtime, still names it.
   */
  writeRevision(fact: TurnUsageRevision, turn: MeteringTurn | undefined): Promise<UsageRevisionWriteResult>
  current(filter?: { sessionId?: string; messageId?: string; settlement?: TurnUsageSettlement }): Promise<TurnUsageRevision[]>
  /** Files every message recorded under no turn, on a session `belongs` accepts, under `turn`. */
  adoptUnattributed(turn: MeteringTurn, belongs: (sessionId: string) => boolean): void
  /**
   * The latest unanswered revision of each message metered under one of
   * `sessionId`'s turns, whether the message is on that session or on one of
   * its descendants.
   */
  pending(sessionId: string): PendingUsageFact[]
  /** Records the plane's answer for a revision and every earlier one of the same message. */
  settle(sessionId: string, result: ReportResult): void
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
    )
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
  const currentRows = db.prepare<[string | null, string | null, string | null, string | null, string | null, string | null], { session_id: string; fact_json: string }>(`
    select session_id, fact_json from usage_revisions row
    where revision = (
      select max(revision) from usage_revisions message
      where message.session_id = row.session_id and message.message_id = row.message_id
    )
      and (? is null or row.session_id = ?)
      and (? is null or row.message_id = ?)
      and (? is null or row.settlement = ?)
    order by row.rowid
  `)
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
      const sessionId = filter.sessionId ?? null
      const messageId = filter.messageId ?? null
      const settlement = filter.settlement ?? null
      return currentRows.all(sessionId, sessionId, messageId, messageId, settlement, settlement).flatMap((row) => {
        const fact = stored(row.fact_json)
        return fact ? [cloudWorkspaceUsageRevision(fact, { workspaceId: input.workspaceId, sessionId: row.session_id })] : []
      })
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
      settleRows.run(DELIVERY[result.status], sessionId, result.messageId, result.revision)
    },
    close() {
      db.close()
    },
  }
}

function reportResults(value: unknown): ReportResult[] | undefined {
  if (!isJsonRecord(value) || !Array.isArray(value.results)) return undefined
  return value.results.flatMap((item) => {
    if (!isJsonRecord(item)) return []
    const { messageId, revision, status } = item
    return typeof messageId === "string" && typeof revision === "number" && isOneOf(status, USAGE_REPORT_RESULT_STATUSES)
      ? [{ messageId, revision, status }]
      : []
  })
}

type TurnProof = { sessionId: string; turnId: string; leaseId: string; fencingToken: number }

function reportBody(proof: TurnProof, batch: readonly PendingUsageFact[]) {
  return JSON.stringify({ action: USAGE_REPORT_ACTION, ...proof, facts: batch.map((item) => item.fact) })
}

/** `facts` in batches whose report bodies each fit the endpoint's size budget. */
function reportBatches(proof: TurnProof, facts: readonly PendingUsageFact[]) {
  const size = (batch: readonly PendingUsageFact[]) => new TextEncoder().encode(reportBody(proof, batch)).length
  const batches: PendingUsageFact[][] = []
  let batch: PendingUsageFact[] = []
  for (const item of facts) {
    if (batch.length > 0 && size([...batch, item]) > REPORT_BODY_BUDGET_BYTES) {
      batches.push(batch)
      batch = []
    }
    batch.push(item)
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

export type CloudWorkspaceUsage = Required<Pick<
  WorkspaceRuntimeServerOptions,
  "sessionAccessPolicy" | "onCompatEvent" | "onTurnOutcome" | "bindSessionConfig" | "bindSessionParents"
>> & {
  /** Resolves once every metered event is recorded and every started report has answered. */
  idle(): Promise<void>
}

/**
 * Meters a cloud workspace runtime's turns into `ledger` and ships the
 * unanswered revisions of a session's turns to the control plane each time
 * one of its turn leases is released, under that lease. A revision is metered
 * under the turn holding its session or that session's nearest ancestor, so a
 * subagent's child session is metered under the turn that started it. Each
 * revision names that turn, and the plane files it under the turn's producer,
 * so a revision that waits for a later release, whoever's, stays its own
 * turn's. A revision the plane does not answer for stays pending until the
 * next release on the session holding its turn.
 */
export function cloudWorkspaceUsage(input: {
  workspaceId: string
  ledger: SandboxUsageLedger
  authorityUrl: string
  policy: SessionAccessPolicy
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}): CloudWorkspaceUsage {
  const log = Log.create({ service: "claxedo-cloud-usage" })
  const send = input.fetch ?? fetch
  let readSessionConfig: Parameters<NonNullable<WorkspaceRuntimeServerOptions["bindSessionConfig"]>>[0] | undefined
  let parentOf: (sessionId: string) => string | undefined = () => undefined
  const activeTurns = new Map<string, string>()

  /** `sessionId`, then its parent, grandparent and on up to its root. */
  function lineage(sessionId: string) {
    const sessions = [sessionId]
    for (let parent = parentOf(sessionId); parent && !sessions.includes(parent); parent = parentOf(parent)) sessions.push(parent)
    return sessions
  }

  function meteringTurn(sessionId: string): MeteringTurn | undefined {
    for (const session of lineage(sessionId)) {
      const turnId = activeTurns.get(session)
      if (turnId) return { sessionId: session, turnId }
    }
    return undefined
  }

  const meter = createTurnMeter({
    writer: { writeRevision: (fact) => input.ledger.writeRevision(fact, meteringTurn(fact.sessionId)) },
    reader: input.ledger,
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
        log.warn("usage.report_refused", { status: response.status, sessionId: proof.sessionId })
        return
      }
      for (const result of reportResults(await response.json().catch(() => undefined)) ?? []) {
        const reported = batch.find((item) => item.fact.messageId === result.messageId && item.fact.revision === result.revision)
        if (reported) input.ledger.settle(reported.sessionId, { ...result, messageId: reported.messageId })
      }
    }
  }

  let reports: Promise<void> = Promise.resolve()
  const acquire = input.policy.acquireTurn?.bind(input.policy)
  const release = input.policy.releaseTurn?.bind(input.policy)
  return {
    sessionAccessPolicy: acquire && release
      ? {
          ...input.policy,
          async acquireTurn(turn) {
            const decision = await acquire(turn)
            if (decision.allowed) activeTurns.set(turn.sessionId, decision.turnId)
            return decision
          },
          async releaseTurn(turn) {
            // Flushed before the turn ends, so every revision it metered is
            // recorded under it.
            await meter.flush()
            if (activeTurns.get(turn.sessionId) === turn.turnId) activeTurns.delete(turn.sessionId)
            // Usage metered while no turn held its session or any ancestor is
            // still usage: the first turn of that family to end carries it.
            input.ledger.adoptUnattributed(
              { sessionId: turn.sessionId, turnId: turn.turnId },
              (sessionId) => lineage(sessionId).includes(turn.sessionId),
            )
            const facts = input.ledger.pending(turn.sessionId)
            const released = await release(turn)
            const proof = { sessionId: turn.sessionId, turnId: turn.turnId, leaseId: turn.leaseId, fencingToken: turn.fencingToken }
            reports = reports
              .then(() => report(proof, facts))
              .catch((error: unknown) => log.warn("usage.report_failed", { error: String(error), sessionId: proof.sessionId }))
            return released
          },
        }
      : input.policy,
    onCompatEvent: (event) => void meter.consume(event),
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
    async idle() {
      await meter.flush()
      await reports
    },
  }
}
