import type { AgentEventEnvelope, AgentTurnOutcome, SessionConfig } from "@claxedo/agent-runtime-contract"
import { withDeadlineSignal } from "@claxedo/helpers/deadline"
import type { SessionAccessPolicy } from "@claxedo/session-core"
import { SESSION_TURN_LEASE_TTL_MS } from "@claxedo/workspace-relay-protocol"
import { isJsonRecord, isOneOf } from "../platform/runtime/lib/json"
import { meteringHarnessId } from "./metering-harness"
import type { MeteringTurn, PendingUsageFact, ReportResult, RuntimeUsageLedger } from "./runtime-usage-ledger"
import { createTurnMeter } from "./turn-meter"
import {
  cloudWorkspaceUsageContext,
  USAGE_REPORT_ACTION,
  USAGE_REPORT_MAX_FACTS,
  USAGE_REPORT_RESULT_STATUSES,
} from "./usage-report"

/**
 * The session-authority endpoint refuses a body over 16 KiB; the turn lease
 * and the envelope around the facts take the rest.
 */
const REPORT_BODY_BUDGET_BYTES = 12 * 1024
const REPORT_TIMEOUT_MS = 5_000
/** Every lease sees at least one flush before it expires. */
const LIVE_FLUSH_INTERVAL_MS = SESSION_TURN_LEASE_TTL_MS / 2

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

export type TurnOutcomeReport = { workspaceId: string; sessionId: string; assistantMessageId?: string; outcome: AgentTurnOutcome }

export type CloudTurnUsage = {
  /** The runtime's policy with each admitted turn metered and, when it ends, reported. */
  sessionAccessPolicy: SessionAccessPolicy
  onPresentationEvent: (event: AgentEventEnvelope) => void
  onTurnOutcome: (input: TurnOutcomeReport) => void
  /** Receives the runtime's reader of a session's committed configuration once its store exists. */
  bindSessionConfig: (read: (sessionId: string) => SessionConfig | undefined) => void
  /** Receives the runtime's reader of a session's parent, for a runtime whose sessions have children. */
  bindSessionParents: (read: (sessionId: string) => string | undefined) => void
  /**
   * Stops the periodic flush until the next lease, then resolves once every
   * metered event is recorded and each session's unanswered revisions have
   * been offered under its last unexpired lease: the last delivery before the
   * runtime goes away.
   */
  drain(): Promise<void>
}

export type CloudTurnUsageLog = { warn(message: string, fields?: Record<string, unknown>): void }

/**
 * Meters a cloud runtime's turns into `ledger` and ships each session's
 * unanswered revisions to the control plane under that session's turn lease:
 * when the turn ends, whether its lease was released or lost, and every
 * `flushIntervalMs` while a lease the plane issued for the session has not
 * expired, so a revision written after its turn ended still ships under it.
 * A revision is metered under the turn holding its session or that session's
 * nearest ancestor, else the latest turn admitted on the nearest of them, so
 * a subagent's child session is metered under the turn that started it and
 * usage landing between turns under the turn that left it. Each revision
 * names that turn, and the plane files it under the turn's producer, so a
 * revision that waits for a later lease, whoever's, stays its own turn's. A
 * revision the plane does not answer for stays pending until the next lease
 * on the session holding its turn carries it.
 */
export function cloudTurnUsage(input: {
  workspaceId: string
  ledger: RuntimeUsageLedger
  authorityUrl: string
  policy: SessionAccessPolicy
  log: CloudTurnUsageLog
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  flushIntervalMs?: number
  now?: () => number
}): CloudTurnUsage {
  const { log } = input
  const send = input.fetch ?? fetch
  const now = input.now ?? Date.now
  let readSessionConfig: ((sessionId: string) => SessionConfig | undefined) | undefined
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
      const answered = await withDeadlineSignal(REPORT_TIMEOUT_MS, async (signal) => {
        const response = await send(input.authorityUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: reportBody(proof, batch),
          signal,
        })
        if (!response.ok) {
          log.warn("usage.report_refused", { status: response.status, sessionId: proof.sessionId, facts: batch.length })
          return BATCH_REFUSALS.has(response.status) ? "next" : "stop"
        }
        return reportResults(await response.json().catch(() => undefined)) ?? []
      })
      if (answered === "stop") return
      if (answered === "next") continue
      for (const result of answered) {
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
