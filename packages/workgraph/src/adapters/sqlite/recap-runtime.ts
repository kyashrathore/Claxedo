import { randomUUID } from "node:crypto"
import type BetterSqlite3 from "better-sqlite3"
import type { RecapGenerator, RecapJob, RecapPort } from "../../application/recap-service"
import { createRecapService } from "../../application/recap-service"
import {
  ExecutionProfileDefaultsSchema,
  RecapProfileDefaultsSchema,
  ResolvedExecutionProfileSchema,
  type RecapID,
  type ResolvedExecutionProfile,
  type StreamID,
  type WorkGraphContext,
  type WorkGraphRecordReference,
} from "../../contracts"
import { resolveExecutionProfile } from "../../domain/execution-profile"
import type { ExecutionResult } from "../../ports"
import { assertNoSqliteWorkGraphOwnerDeletion } from "./deletion-barrier"
import { initializeWorkGraphSqliteSchema } from "./schema"

const leaseDurationMs = 5 * 60 * 1000
const retryDelayMs = 60 * 1000

export type RecapSessionGateway = Readonly<{
  admit(input: Readonly<{
    attemptId: string
    sessionId?: string
    directory: string
    title: string
    prompt: string
    profile: ResolvedExecutionProfile
    context: WorkGraphContext
  }>): Promise<string>
  result(sessionId: string): Promise<ExecutionResult>
  classifyAdmissionError?(error: unknown): "unavailable" | "rejected" | "indeterminate"
}>

export function createSqliteRecapRuntime(input: Readonly<{
  database: BetterSqlite3.Database
  clock?: Readonly<{ now(): number }>
  workerId?: string
  sessions?: RecapSessionGateway
  sessionDirectory?: string
}>) {
  const database = initializeWorkGraphSqliteSchema(input.database).raw()
  if (!database) throw new Error("The SQLite Recap runtime requires a real better-sqlite3 database")
  const clock = input.clock ?? { now: Date.now }
  const workerId = input.workerId ?? `recap_worker_${randomUUID()}`
  const port = createSqliteRecapPort(database, clock)
  const service = createRecapService(port, clock)

  return {
    port,
    scheduleDue: service.scheduleDue,
    async runDue(context: WorkGraphContext) {
      const claimed = claimDue(database, context, workerId, clock.now())
      if (!claimed) return { state: "idle" as const }
      try {
        if (!input.sessions) throw new Error("Recap generation requires an ordinary Session gateway")
        const selected = createSqliteSessionRecapGenerator({
              database,
              context,
              jobId: claimed.id,
              sessions: input.sessions,
              directory: input.sessionDirectory ?? process.cwd(),
              leaseEpoch: claimed.leaseEpoch,
              workerId,
            })
        const output = await createRecapService(createClaimedSqliteRecapPort(database, clock, {
          id: claimed.id,
          workerId,
          leaseEpoch: claimed.leaseEpoch,
        }), clock).run(context, claimed.job, selected)
        return { state: "completed" as const, job: claimed.job, output }
      } catch (error) {
        if (error instanceof RecapSessionPendingError) return { state: "running" as const, job: claimed.job }
        const state = failClaim(database, context, claimed.id, claimed.job, workerId, claimed.leaseEpoch, error, clock.now())
        return { state, job: claimed.job, error }
      }
    },
  }
}

export function createSqliteRecapPort(
  databaseInput: BetterSqlite3.Database,
  clock: Readonly<{ now(): number }> = { now: Date.now },
): RecapPort {
  return createClaimedSqliteRecapPort(databaseInput, clock)
}

function createClaimedSqliteRecapPort(
  databaseInput: BetterSqlite3.Database,
  clock: Readonly<{ now(): number }>,
  claim?: Readonly<{ id: string; workerId: string; leaseEpoch: number }>,
): RecapPort {
  const database = initializeWorkGraphSqliteSchema(databaseInput).raw()
  if (!database) throw new Error("The SQLite Recap adapter requires a real better-sqlite3 database")
  return {
    async listCandidates(context) {
      return (database.prepare(`
        SELECT streams.id AS stream_id,
          streams.recap_defaults_json AS stream_recap_defaults,
          graphs.recap_defaults_json AS workgraph_recap_defaults,
          COALESCE(MAX(events.occurred_at), streams.updated_at) AS last_activity_at,
          COALESCE(MAX(events.sequence), 0) AS latest_sequence,
          latest.id AS recap_id,
          latest.activity_end_sequence AS recap_sequence
        FROM wg_v2_streams streams
        JOIN wg_v2_workgraphs graphs
          ON graphs.owner_user_id = streams.owner_user_id AND graphs.id = streams.workgraph_id
        LEFT JOIN wg_v2_events events
          ON events.owner_user_id = streams.owner_user_id AND events.stream_id = streams.id
        LEFT JOIN wg_v2_recaps latest
          ON latest.owner_user_id = streams.owner_user_id AND latest.stream_id = streams.id
          AND latest.activity_end_sequence = (
            SELECT MAX(candidate.activity_end_sequence) FROM wg_v2_recaps candidate
            WHERE candidate.owner_user_id = streams.owner_user_id AND candidate.stream_id = streams.id
          )
        WHERE streams.owner_user_id = ? AND streams.lifecycle <> 'closed'
        GROUP BY streams.id, streams.recap_defaults_json, graphs.recap_defaults_json, latest.id, latest.activity_end_sequence
        ORDER BY last_activity_at, streams.id
      `).all(context.ownerUserId) as CandidateRow[]).map((row) => {
        const workgraph = JSON.parse(row.workgraph_recap_defaults) as { quietHours?: number }
        const stream = JSON.parse(row.stream_recap_defaults) as { quietHours?: number }
        return {
          streamId: row.stream_id as StreamID,
          lastActivityAt: Number(row.last_activity_at),
          latestSequence: Number(row.latest_sequence),
          quietPeriodMs: (stream.quietHours ?? workgraph.quietHours ?? 8) * 60 * 60 * 1000,
          ...(row.recap_id ? { lastRecap: { id: row.recap_id as RecapID, toSequence: Number(row.recap_sequence) } } : {}),
        }
      })
    },
    async enqueue(context, job) {
      return database.transaction(() => {
        assertNoSqliteWorkGraphOwnerDeletion(database, context.ownerUserId)
        const now = clock.now()
        const result = database.prepare(`
          INSERT OR IGNORE INTO wg_v2_due_jobs
            (owner_user_id, id, stream_id, job_type, subject_id, due_at, status, payload_json, created_at, updated_at)
          VALUES (?, ?, ?, 'recap', ?, ?, 'pending', ?, ?, ?)
        `).run(
          context.ownerUserId,
          `recap_job_${randomUUID()}`,
          job.streamId,
          `${job.streamId}:${job.toSequence}`,
          now,
          JSON.stringify(job),
          now,
          now,
        )
        return result.changes === 1 ? "created" : "existing"
      })()
    },
    async complete(context, job, output) {
      const now = clock.now()
      database.transaction(() => {
        assertNoSqliteWorkGraphOwnerDeletion(database, context.ownerUserId)
        const due = (claim
          ? database.prepare(`
              SELECT id, claimed_by, lease_epoch FROM wg_v2_due_jobs
              WHERE owner_user_id = ? AND id = ? AND status = 'running' AND claimed_by = ? AND lease_epoch = ?
            `).get(context.ownerUserId, claim.id, claim.workerId, claim.leaseEpoch)
          : database.prepare(`
              SELECT id, claimed_by, lease_epoch FROM wg_v2_due_jobs
              WHERE owner_user_id = ? AND job_type = 'recap' AND subject_id = ? AND status = 'running'
            `).get(context.ownerUserId, `${job.streamId}:${job.toSequence}`)) as { id: string; claimed_by: string | null; lease_epoch: number } | undefined
        if (!due?.claimed_by) throw new Error("Recap job is not durably claimed")
        const profile = claim
          ? claimedRecapProfile(database, context, due.id)
          : recapProfile(database, context, job.streamId)
        const id = `recap_${randomUUID()}`
        const published = database.prepare(`
          INSERT OR IGNORE INTO wg_v2_recaps
            (owner_user_id, id, stream_id, previous_recap_id, activity_start_sequence,
             activity_end_sequence, quiet_since, summary, actionable_references_json, generation_profile_json,
             provenance_json, generation_result_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.ownerUserId,
          id,
          job.streamId,
          job.previousRecapId ?? null,
          job.fromSequence,
          job.toSequence,
          job.quietSince,
          output.summary,
          JSON.stringify(output.actionableReferences),
          JSON.stringify({
            model: profile.model,
            effort: profile.effort,
          }),
          JSON.stringify({ actor: context.actor }),
          JSON.stringify({ state: "succeeded", generatedAt: now, ...output.generation }),
          now,
        )
        if (published.changes === 1 && output.actionableReferences.length > 0) {
          database.prepare(`
            INSERT INTO wg_v2_notifications
              (owner_user_id, id, notification_kind, state, stream_id, recap_id, created_at, updated_at)
            VALUES (?, ?, 'actionable_recap', 'unread', ?, ?, ?, ?)
          `).run(context.ownerUserId, `notification_${id}`, job.streamId, id, now, now)
        }
        const completed = database.prepare(`
          UPDATE wg_v2_due_jobs SET status = 'completed', claimed_by = NULL, claim_expires_at = NULL,
            last_error = NULL, updated_at = ?, row_version = row_version + 1
          WHERE owner_user_id = ? AND id = ? AND status = 'running' AND claimed_by = ? AND lease_epoch = ?
        `).run(now, context.ownerUserId, due.id, due.claimed_by, due.lease_epoch)
        if (completed.changes !== 1) throw new Error("Recap job lost its durable claim before publication")
      })()
    },
  }
}

function createSqliteSessionRecapGenerator(input: Readonly<{
  database: BetterSqlite3.Database
  context: WorkGraphContext
  jobId: string
  sessions: RecapSessionGateway
  directory: string
  leaseEpoch: number
  workerId: string
}>): RecapGenerator {
  return {
    async generate(job) {
      const source = recapSource(input.database, input.context, job)
      const existing = recapSession(input.database, input.context, input.jobId)
      const profile = existing?.profile ?? recapProfile(input.database, input.context, job.streamId)
      const sessionId = existing?.id ?? `ses_workgraph_${input.jobId}_${input.leaseEpoch}`
      const prompt = recapPrompt(job, source)
      if (!existing) markRecapSession(input.database, input.context, input.jobId, input.workerId, input.leaseEpoch, sessionId, profile, false)
      const admitted = existing?.admitted
        ? sessionId
        : await input.sessions.admit({
            attemptId: input.jobId,
            sessionId,
            directory: input.directory,
            title: `Recap: ${source.title}`,
            prompt,
            profile,
            context: input.context,
          }).then((id) => {
            if (id !== sessionId) throw new Error("Recap Session did not adopt its caller-owned durable identity")
            markRecapSession(input.database, input.context, input.jobId, input.workerId, input.leaseEpoch, id, profile, true)
            return id
          }).catch((error) => {
            const disposition = input.sessions.classifyAdmissionError?.(error) ?? "indeterminate"
            if (disposition === "rejected") throw error
            if (disposition === "indeterminate") throw new RecapSessionPendingError()
            throw error
          })
      const result = await input.sessions.result(admitted)
      if (result.state === "succeeded") {
        return {
          ...recapOutput(result.summary, source.allowedReferences),
          generation: { method: "agent_session", sessionId: admitted },
        }
      }
      if (result.state === "failed") throw new Error(`Recap Session failed: ${result.message}`)
      if (result.state === "cancelled") throw new Error("Recap Session was cancelled")
      throw new RecapSessionPendingError()
    },
  }
}

class RecapSessionPendingError extends Error {}

function recapSession(database: BetterSqlite3.Database, context: WorkGraphContext, jobId: string) {
  const row = database.prepare("SELECT payload_json FROM wg_v2_due_jobs WHERE owner_user_id = ? AND id = ?")
    .get(context.ownerUserId, jobId) as { payload_json: string } | undefined
  const payload = row ? JSON.parse(row.payload_json) as {
    sessionId?: unknown
    generationProfile?: unknown
    sessionAdmissionConfirmed?: unknown
  } : undefined
  if (typeof payload?.sessionId !== "string" || !payload.sessionId) return undefined
  const profile = ResolvedExecutionProfileSchema.safeParse(payload.generationProfile)
  if (!profile.success) throw new Error("Recap Session has no valid durable generation profile")
  return { id: payload.sessionId, admitted: payload.sessionAdmissionConfirmed === true, profile: profile.data }
}

function markRecapSession(
  database: BetterSqlite3.Database,
  context: WorkGraphContext,
  jobId: string,
  workerId: string,
  leaseEpoch: number,
  sessionId: string,
  profile: ResolvedExecutionProfile,
  admitted: boolean,
) {
  const row = database.prepare(`
    SELECT payload_json FROM wg_v2_due_jobs
    WHERE owner_user_id = ? AND id = ? AND status = 'running' AND claimed_by = ? AND lease_epoch = ?
  `).get(context.ownerUserId, jobId, workerId, leaseEpoch) as { payload_json: string } | undefined
  if (!row) throw new Error("Recap Session lost its durable job claim")
  const changed = database.prepare(`
    UPDATE wg_v2_due_jobs SET payload_json = ?
    WHERE owner_user_id = ? AND id = ? AND status = 'running' AND claimed_by = ? AND lease_epoch = ?
  `).run(JSON.stringify({
    ...JSON.parse(row.payload_json),
    sessionId,
    generationProfile: profile,
    sessionAdmissionConfirmed: admitted,
  }), context.ownerUserId, jobId, workerId, leaseEpoch)
  if (changed.changes !== 1) throw new Error("Recap Session lost its durable job claim")
}

function recapSource(database: BetterSqlite3.Database, context: WorkGraphContext, job: RecapJob) {
  const stream = database.prepare("SELECT title FROM wg_v2_streams WHERE owner_user_id = ? AND id = ?")
    .get(context.ownerUserId, job.streamId) as { title: string } | undefined
  if (!stream) throw new Error("Recap Stream was not found")
  const events = database.prepare(`
    SELECT sequence, event_type, payload_json FROM wg_v2_events
    WHERE owner_user_id = ? AND stream_id = ? AND sequence BETWEEN ? AND ?
    ORDER BY sequence
  `).all(context.ownerUserId, job.streamId, job.fromSequence, job.toSequence) as ActivityRow[]
  if (events.length !== job.toSequence - job.fromSequence + 1 || events.some((event, index) => event.sequence !== job.fromSequence + index)) {
    throw new Error("Recap activity range no longer matches its claimed Stream sequence")
  }
  const previous = job.previousRecapId
    ? database.prepare(`
        SELECT id, summary, activity_end_sequence FROM wg_v2_recaps
        WHERE owner_user_id = ? AND stream_id = ? AND id = ?
      `).get(context.ownerUserId, job.streamId, job.previousRecapId) as { id: string; summary: string; activity_end_sequence: number } | undefined
    : undefined
  if (job.previousRecapId && (!previous || previous.activity_end_sequence !== job.fromSequence - 1)) {
    throw new Error("Recap previous revision no longer matches its claimed activity range")
  }
  if (!job.previousRecapId && job.fromSequence !== 1) throw new Error("Incremental Recap is missing its exact previous Recap")
  const allowedReferences = new Set<string>([`stream:${job.streamId}`])
  events.forEach((event) => eventReferences(JSON.parse(event.payload_json)).forEach((reference) => allowedReferences.add(`${reference.type}:${reference.id}`)))
  return { title: stream.title, events, previous, allowedReferences }
}

function recapPrompt(job: RecapJob, source: ReturnType<typeof recapSource>) {
  return [
    "Create a concise Stream recap from the exact activity range below.",
    "Return JSON only with this exact shape: {\"summary\":\"...\",\"actionableReferences\":[{\"type\":\"decision|attempt|work_item|outcome|stream\",\"id\":\"...\"}]}",
    "Include only record references present in the supplied activity that need the owner's attention.",
    `Stream: ${source.title} (${job.streamId})`,
    `Activity range: ${job.fromSequence}-${job.toSequence}; quiet since ${job.quietSince}`,
    `Previous recap: ${source.previous ? JSON.stringify({ id: source.previous.id, toSequence: source.previous.activity_end_sequence, summary: source.previous.summary }) : "none"}`,
    `Changed activity: ${JSON.stringify(source.events.map((event) => ({ sequence: event.sequence, type: event.event_type, payload: JSON.parse(event.payload_json) })))}`,
  ].join("\n")
}

function recapOutput(value: string, allowedReferences: ReadonlySet<string>) {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Recap Session returned invalid JSON")
  const record = parsed as Record<string, unknown>
  if (Object.keys(record).sort().join(",") !== "actionableReferences,summary" || typeof record.summary !== "string" || !record.summary.trim() || !Array.isArray(record.actionableReferences)) {
    throw new Error("Recap Session returned an invalid structured result")
  }
  const seen = new Set<string>()
  const actionableReferences = record.actionableReferences.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Recap Session returned an invalid actionable reference")
    const entry = candidate as Record<string, unknown>
    if (Object.keys(entry).sort().join(",") !== "id,type" || typeof entry.type !== "string" || typeof entry.id !== "string") {
      throw new Error("Recap Session returned an invalid actionable reference")
    }
    const key = `${entry.type}:${entry.id}`
    if (!allowedReferences.has(key)) throw new Error("Recap Session referenced a record outside its claimed activity range")
    if (seen.has(key)) throw new Error("Recap Session returned a duplicate actionable reference")
    seen.add(key)
    return { type: entry.type, id: entry.id } as WorkGraphRecordReference
  })
  return { summary: record.summary.trim(), actionableReferences }
}

function recapProfile(database: BetterSqlite3.Database, context: WorkGraphContext, streamId: StreamID): ResolvedExecutionProfile {
  const stream = database.prepare(`
    SELECT streams.recap_defaults_json,
      streams.execution_defaults_json,
      graphs.recap_defaults_json AS workgraph_recap_defaults_json,
      graphs.defaults_json AS workgraph_execution_defaults_json
    FROM wg_v2_streams streams
    JOIN wg_v2_workgraphs graphs
      ON graphs.owner_user_id = streams.owner_user_id AND graphs.id = streams.workgraph_id
    WHERE streams.owner_user_id = ? AND streams.id = ?
  `).get(context.ownerUserId, streamId) as {
    recap_defaults_json: string
    execution_defaults_json: string
    workgraph_recap_defaults_json: string
    workgraph_execution_defaults_json: string
  } | undefined
  if (!stream) throw new Error("Recap Stream was not found")
  const workgraphExecution = ExecutionProfileDefaultsSchema.parse(JSON.parse(stream.workgraph_execution_defaults_json))
  const streamExecution = ExecutionProfileDefaultsSchema.parse(JSON.parse(stream.execution_defaults_json))
  const workgraphRecap = RecapProfileDefaultsSchema.parse(JSON.parse(stream.workgraph_recap_defaults_json))
  const streamRecap = RecapProfileDefaultsSchema.parse(JSON.parse(stream.recap_defaults_json))
  const resolved = resolveExecutionProfile({
    workgraph: {
      ...workgraphExecution,
      ...streamExecution,
      ...(workgraphRecap.model ? { model: workgraphRecap.model } : {}),
      ...(workgraphRecap.effort ? { effort: workgraphRecap.effort } : {}),
      ...(streamRecap.model ? { model: streamRecap.model } : {}),
      ...(streamRecap.effort ? { effort: streamRecap.effort } : {}),
      tools: [],
      connectionIds: [],
      isolation: "stream",
      cleanup: "retain",
      integration: "manual",
    },
  })
  if (!resolved.ok) {
    throw new Error(`Recap execution profile is incomplete: ${resolved.error.missingFields.join(", ")}`)
  }
  return resolved.profile
}

function claimedRecapProfile(database: BetterSqlite3.Database, context: WorkGraphContext, jobId: string) {
  const row = database.prepare("SELECT payload_json FROM wg_v2_due_jobs WHERE owner_user_id = ? AND id = ?")
    .get(context.ownerUserId, jobId) as { payload_json: string } | undefined
  if (!row) throw new Error("Recap job is unavailable")
  const profile = ResolvedExecutionProfileSchema.safeParse((JSON.parse(row.payload_json) as { generationProfile?: unknown }).generationProfile)
  if (!profile.success) throw new Error("Recap job has no valid durable generation profile")
  return profile.data
}

function claimDue(
  database: BetterSqlite3.Database,
  context: WorkGraphContext,
  workerId: string,
  now: number,
) {
  return database.transaction(() => {
    assertNoSqliteWorkGraphOwnerDeletion(database, context.ownerUserId)
    const row = database.prepare(`
      SELECT id, payload_json, status, claimed_by, lease_epoch, row_version FROM wg_v2_due_jobs
      WHERE owner_user_id = ? AND job_type = 'recap' AND due_at <= ?
        AND (status = 'pending' OR status = 'failed' OR (status = 'running' AND (claimed_by = ? OR claim_expires_at <= ?)))
      ORDER BY due_at, created_at, id LIMIT 1
    `).get(context.ownerUserId, now, workerId, now) as { id: string; payload_json: string; status: string; claimed_by: string | null; lease_epoch: number; row_version: number } | undefined
    if (!row) return undefined
    const resumed = row.status === "running" && row.claimed_by === workerId
    const leaseEpoch = resumed ? row.lease_epoch : row.lease_epoch + 1
    const changed = database.prepare(`
      UPDATE wg_v2_due_jobs SET status = 'running', claimed_by = ?, claim_expires_at = ?,
        lease_epoch = ?, updated_at = ?, row_version = row_version + 1
      WHERE owner_user_id = ? AND id = ? AND row_version = ?
        AND (status = 'pending' OR status = 'failed' OR (status = 'running' AND (claimed_by = ? OR claim_expires_at <= ?)))
    `).run(workerId, now + leaseDurationMs, leaseEpoch, now, context.ownerUserId, row.id, row.row_version, workerId, now)
    if (changed.changes !== 1) return undefined
    return { id: row.id, leaseEpoch, job: JSON.parse(row.payload_json) as RecapJob }
  })()
}

function failClaim(
  database: BetterSqlite3.Database,
  context: WorkGraphContext,
  id: string,
  job: RecapJob,
  workerId: string,
  leaseEpoch: number,
  error: unknown,
  now: number,
) {
  const status = leaseEpoch >= 3 ? "attention" as const : "failed" as const
  const reason = error instanceof Error ? error.message : String(error)
  let committed = false
  database.transaction(() => {
    const changed = database.prepare(`
      UPDATE wg_v2_due_jobs SET status = ?, due_at = ?, payload_json = ?, claimed_by = NULL, claim_expires_at = NULL,
        last_error = ?, updated_at = ?, row_version = row_version + 1
      WHERE owner_user_id = ? AND id = ? AND status = 'running' AND claimed_by = ? AND lease_epoch = ?
    `).run(
      status,
      now + retryDelayMs,
      JSON.stringify({
        ...job,
        sessionId: undefined,
        sessionAdmissionConfirmed: undefined,
        ...(recapConfigurationFailure(reason) ? {
          configurationRequirement: {
            type: "generation",
            purpose: "recap",
            scope: { type: "stream", streamId: job.streamId },
          },
        } : {}),
      }),
      reason,
      now,
      context.ownerUserId,
      id,
      workerId,
      leaseEpoch,
    )
    if (changed.changes !== 1) return
    committed = true
    if (status !== "attention") return
    const row = database.prepare("SELECT memory_card_json FROM wg_v2_streams WHERE owner_user_id = ? AND id = ?")
      .get(context.ownerUserId, job.streamId) as { memory_card_json: string } | undefined
    const memory = row ? JSON.parse(row.memory_card_json) as { summary?: unknown } : undefined
    database.prepare(`
      UPDATE wg_v2_streams SET memory_card_json = ?, updated_at = ?, row_version = row_version + 1
      WHERE owner_user_id = ? AND id = ?
    `).run(JSON.stringify({
      summary: typeof memory?.summary === "string" && memory.summary.trim() ? memory.summary : "Recap generation needs attention",
      updatedAt: now,
      attention: { type: "recap_failed", reason, at: now },
    }), now, context.ownerUserId, job.streamId)
  })()
  return committed ? status : "failed" as const
}

function recapConfigurationFailure(reason: string) {
  return reason.startsWith("Recap execution profile is incomplete:") ||
    reason === "Recap job has no valid durable generation profile"
}

function eventReferences(payload: Record<string, unknown>): WorkGraphRecordReference[] {
  return [
    ...(typeof payload.decisionId === "string" ? [{ type: "decision" as const, id: payload.decisionId as never }] : []),
    ...(typeof payload.attemptId === "string" ? [{ type: "attempt" as const, id: payload.attemptId as never }] : []),
    ...(typeof payload.workItemId === "string" ? [{ type: "work_item" as const, id: payload.workItemId as never }] : []),
    ...(typeof payload.outcomeId === "string" ? [{ type: "outcome" as const, id: payload.outcomeId as never }] : []),
    ...(typeof payload.streamId === "string" ? [{ type: "stream" as const, id: payload.streamId as never }] : []),
  ]
}

type CandidateRow = Readonly<{
  stream_id: string
  stream_recap_defaults: string
  workgraph_recap_defaults: string
  last_activity_at: string | number
  latest_sequence: string | number
  recap_id: string | null
  recap_sequence: string | number | null
}>

type ActivityRow = Readonly<{ sequence: number; event_type: string; payload_json: string }>
