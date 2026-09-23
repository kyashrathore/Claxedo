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
  type UsageRevisionWriter,
} from "@claxedo/server-core/usage/contracts"
import { createTurnMeter } from "@claxedo/server-core/usage/turn-meter"
import {
  cloudWorkspaceUsageContext,
  cloudWorkspaceUsageRevision,
  readUsageReportFacts,
  usageReportFact,
  USAGE_REPORT_ACTION,
  type UsageReportFact,
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

const DELIVERY = { accepted: "delivered", duplicate: "delivered", stale: "stale", conflict: "conflict" } as const
const REPORT_STATUSES = ["accepted", "duplicate", "stale", "conflict"] as const

type ReportResult = { messageId: string; revision: number; status: UsageRevisionWriteResult["status"] }

export type SandboxUsageLedger = UsageRevisionWriter & {
  current(filter?: { sessionId?: string; messageId?: string; settlement?: TurnUsageSettlement }): Promise<TurnUsageRevision[]>
  /** The latest revision of each of a session's turns the plane has not answered for. */
  pending(sessionId: string): TurnUsageRevision[]
  /** Records the plane's answer for a revision and every earlier one of the same turn. */
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
      payload_hash text not null,
      settlement text not null,
      fact_json text not null,
      delivery text not null default 'pending',
      primary key (session_id, message_id, revision)
    )
  `)
  const latest = db.prepare<[string, string], { revision: number; payload_hash: string }>(
    "select revision, payload_hash from usage_revisions where session_id = ? and message_id = ? order by revision desc limit 1",
  )
  const insert = db.prepare<[string, string, number, string, string, string]>(
    "insert into usage_revisions (session_id, message_id, revision, payload_hash, settlement, fact_json) values (?, ?, ?, ?, ?, ?)",
  )
  const currentRows = db.prepare<[string | null, string | null, string | null, string | null, string | null, string | null], { session_id: string; fact_json: string }>(`
    select session_id, fact_json from usage_revisions row
    where revision = (
      select max(revision) from usage_revisions turn
      where turn.session_id = row.session_id and turn.message_id = row.message_id
    )
      and (? is null or row.session_id = ?)
      and (? is null or row.message_id = ?)
      and (? is null or row.settlement = ?)
    order by row.rowid
  `)
  const pendingRows = db.prepare<[string], { session_id: string; fact_json: string }>(`
    select session_id, fact_json from usage_revisions row
    where session_id = ? and delivery = 'pending' and revision = (
      select max(revision) from usage_revisions turn
      where turn.session_id = row.session_id and turn.message_id = row.message_id and turn.delivery = 'pending'
    )
    order by row.rowid
  `)
  const settleRows = db.prepare<[string, string, string, number]>(
    "update usage_revisions set delivery = ? where session_id = ? and message_id = ? and revision <= ? and delivery = 'pending'",
  )
  const revision = (row: { session_id: string; fact_json: string }) => {
    let stored: unknown
    try {
      stored = JSON.parse(row.fact_json)
    } catch {
      return []
    }
    const fact = readUsageReportFacts([stored])?.[0]
    return fact ? [cloudWorkspaceUsageRevision(fact, { workspaceId: input.workspaceId, sessionId: row.session_id })] : []
  }
  return {
    async writeRevision(item) {
      assertTurnUsageRevision(item)
      const hash = await usageRevisionHash(item)
      const current = latest.get(item.sessionId, item.messageId)
      if (current && item.revision < current.revision) return { status: "stale", currentRevision: current.revision }
      if (current && item.revision === current.revision) {
        return current.payload_hash === hash ? { status: "duplicate" } : { status: "conflict", currentRevision: current.revision }
      }
      insert.run(item.sessionId, item.messageId, item.revision, hash, item.settlement, JSON.stringify(usageReportFact(item)))
      return { status: "accepted" }
    },
    async current(filter = {}) {
      const sessionId = filter.sessionId ?? null
      const messageId = filter.messageId ?? null
      const settlement = filter.settlement ?? null
      return currentRows.all(sessionId, sessionId, messageId, messageId, settlement, settlement).flatMap(revision)
    },
    pending(sessionId) {
      return pendingRows.all(sessionId).flatMap(revision)
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
    return typeof messageId === "string" && typeof revision === "number" && isOneOf(status, REPORT_STATUSES)
      ? [{ messageId, revision, status }]
      : []
  })
}

type TurnProof = { sessionId: string; turnId: string; leaseId: string; fencingToken: number }

/** Report bodies for `facts`, each under the endpoint's size budget. */
function reportBodies(proof: TurnProof, facts: readonly TurnUsageRevision[]) {
  const body = (batch: readonly UsageReportFact[]) => JSON.stringify({ action: USAGE_REPORT_ACTION, ...proof, facts: batch })
  const size = (text: string) => new TextEncoder().encode(text).length
  const bodies: string[] = []
  let batch: UsageReportFact[] = []
  for (const fact of facts.map(usageReportFact)) {
    if (batch.length > 0 && size(body([...batch, fact])) > REPORT_BODY_BUDGET_BYTES) {
      bodies.push(body(batch))
      batch = []
    }
    batch.push(fact)
  }
  if (batch.length > 0) bodies.push(body(batch))
  return bodies
}

export type CloudWorkspaceUsage = Required<Pick<
  WorkspaceRuntimeServerOptions,
  "sessionAccessPolicy" | "onCompatEvent" | "onTurnOutcome" | "bindSessionConfig"
>> & {
  /** Resolves once every metered event is recorded and every started report has answered. */
  idle(): Promise<void>
}

/**
 * Meters a cloud workspace runtime's turns into `ledger` and ships a
 * session's unanswered revisions to the control plane each time one of its
 * turn leases is released, under that lease. The plane files them under its
 * own proof and attributes them to the turn's producer; a revision it does
 * not answer for stays pending until the session's next release.
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
  const meter = createTurnMeter({
    writer: input.ledger,
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

  async function report(proof: TurnProof, facts: readonly TurnUsageRevision[]) {
    for (const body of reportBodies(proof, facts)) {
      const response = await send(input.authorityUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      })
      if (!response.ok) {
        log.warn("usage.report_refused", { status: response.status, sessionId: proof.sessionId })
        return
      }
      for (const result of reportResults(await response.json().catch(() => undefined)) ?? []) {
        input.ledger.settle(proof.sessionId, result)
      }
    }
  }

  let reports: Promise<void> = Promise.resolve()
  const release = input.policy.releaseTurn?.bind(input.policy)
  return {
    sessionAccessPolicy: release
      ? {
          ...input.policy,
          async releaseTurn(turn) {
            // Read before releasing: until the release lands no other turn can
            // hold this session, so nothing another producer meters rides
            // this turn's lease.
            await meter.flush()
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
    async idle() {
      await meter.flush()
      await reports
    },
  }
}
