import { randomUUID } from "node:crypto"
import type BetterSqlite3 from "better-sqlite3"
import {
  AdmissionAgentPlanSchema,
  ExecutionProfileDefaultsSchema,
  ResolvedExecutionProfileSchema,
  type AdmissionAgentPlan,
  type ResolvedExecutionProfile,
  type WorkGraphContext,
  type WorkSourceRevisionRef,
} from "../../contracts"
import { resolveExecutionProfile } from "../../domain/execution-profile"
import type { ExecutionResult } from "../../ports"
import { initializeWorkGraphSqliteSchema } from "./schema"

const leaseDurationMs = 5 * 60 * 1000
const retryDelayMs = 60 * 1000

export type SourcePlanningSessionGateway = Readonly<{
  classifyAdmissionError?(error: unknown): "unavailable" | "rejected" | "indeterminate"
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
}>

export function createSqliteSourcePlanningRuntime(input: Readonly<{
  database: BetterSqlite3.Database
  sessions?: SourcePlanningSessionGateway
  sessionDirectory?: string
  clock?: Readonly<{ now(): number }>
  workerId?: string
}>) {
  const database = initializeWorkGraphSqliteSchema(input.database).raw()
  if (!database) throw new Error("The SQLite source planning runtime requires a real better-sqlite3 database")
  const clock = input.clock ?? { now: Date.now }
  const workerId = input.workerId ?? `source_planner_${randomUUID()}`
  return {
    async runDue(context: WorkGraphContext) {
      const claimed = claimDue(database, context, workerId, clock.now())
      if (!claimed) return { state: "idle" as const }
      const source = planningSource(database, context, claimed.job)
      if (!source) {
        cancelClaim(database, context, claimed.id, workerId, claimed.leaseEpoch, "Source revision or proposal is no longer current", clock.now())
        return { state: "stale" as const, job: claimed.job }
      }
      if (!input.sessions) {
        const failure = failClaim(database, context, claimed.id, workerId, claimed.leaseEpoch, "Session V2 source planning is unavailable", clock.now())
        return { state: "failed" as const, job: claimed.job, retryScheduled: failure.retryScheduled, error: new Error("Session V2 source planning is unavailable") }
      }
      try {
        const existing = sourcePlanningSession(database, context, claimed.id)
        const profile = existing?.profile ?? sourcePlanningProfile(database, context)
        const requestedSessionId = existing?.id ?? `ses_workgraph_${claimed.id}_${claimed.leaseEpoch}`
        if (!existing) markSession(database, context, claimed.id, workerId, claimed.leaseEpoch, requestedSessionId, profile, false, clock.now())
        const admitted = existing?.admitted ? requestedSessionId : await input.sessions.admit({
          attemptId: claimed.id,
          sessionId: requestedSessionId,
          directory: input.sessionDirectory ?? process.cwd(),
          title: `Plan: ${source.title}`,
          prompt: sourcePlanningPrompt(claimed.job, source),
          profile,
          context,
        }).then((id) => {
          if (id !== requestedSessionId) throw new Error("Source planning Session did not adopt its caller-owned durable identity")
          markSession(database, context, claimed.id, workerId, claimed.leaseEpoch, id, profile, true, clock.now())
          return id
        }).catch((error) => {
          const disposition = input.sessions!.classifyAdmissionError?.(error) ?? "indeterminate"
          if (disposition === "indeterminate") return undefined
          if (disposition === "unavailable") throw error
          throw error
        })
        if (admitted === undefined) return { state: "running" as const, job: claimed.job, sessionId: requestedSessionId }
        const sessionId = admitted
        const result = await input.sessions.result(sessionId)
        if (result.state === "pending" || result.state === "running") return { state: "running" as const, job: claimed.job, sessionId }
        if (result.state === "failed") throw new Error(result.message)
        if (result.state !== "succeeded") throw new Error("Source planning Session was cancelled")
        const plan = validatePlan(database, context, claimed.job, source, result.summary)
        const published = publishPlan(database, context, claimed.id, workerId, claimed.leaseEpoch, sessionId, plan, clock.now())
        return published ? { state: "completed" as const, job: claimed.job, sessionId } : { state: "stale" as const, job: claimed.job }
      } catch (error) {
        const failure = failClaim(database, context, claimed.id, workerId, claimed.leaseEpoch, error instanceof Error ? error.message : String(error), clock.now())
        return { state: "failed" as const, job: claimed.job, retryScheduled: failure.retryScheduled, error }
      }
    },
  }
}

type SourcePlanJob = Readonly<{
  proposalId: string
  source: WorkSourceRevisionRef
  sessionId?: string
}>

type PlanningEvidence = Readonly<{
  targetStreamId?: string
  placementMatches?: unknown[]
  duplicateMatches?: unknown[]
}>

function claimDue(database: BetterSqlite3.Database, context: WorkGraphContext, workerId: string, now: number) {
  return database.transaction(() => {
    const row = database.prepare(`
      SELECT id, payload_json, status, claimed_by, lease_epoch, row_version FROM wg_v2_due_jobs
      WHERE owner_user_id = ? AND job_type = 'source_plan' AND due_at <= ?
        AND (status IN ('pending', 'failed') OR (status = 'running' AND (claimed_by = ? OR claim_expires_at <= ?)))
      ORDER BY due_at, created_at, id LIMIT 1
    `).get(context.ownerUserId, now, workerId, now) as {
      id: string; payload_json: string; status: string; claimed_by: string | null; lease_epoch: number; row_version: number
    } | undefined
    if (!row) return undefined
    const resumed = row.status === "running" && row.claimed_by === workerId
    const leaseEpoch = resumed ? row.lease_epoch : row.lease_epoch + 1
    const payload = JSON.parse(row.payload_json) as SourcePlanJob & { automaticFailureCount?: number }
    const changed = database.prepare(`
      UPDATE wg_v2_due_jobs SET status = 'running', claimed_by = ?, claim_expires_at = ?, lease_epoch = ?,
        payload_json = ?, updated_at = ?, row_version = row_version + 1
      WHERE owner_user_id = ? AND id = ? AND row_version = ?
        AND (status IN ('pending', 'failed') OR (status = 'running' AND (claimed_by = ? OR claim_expires_at <= ?)))
    `).run(workerId, now + leaseDurationMs, leaseEpoch, JSON.stringify(row.status === "running" ? payload : {
      proposalId: payload.proposalId,
      source: payload.source,
      automaticFailureCount: payload.automaticFailureCount ?? 0,
    }), now,
      context.ownerUserId, row.id, row.row_version, workerId, now)
    if (changed.changes !== 1) return undefined
    if (row.status === "failed") markPlanningQueued(database, context, payload.proposalId, now)
    return { id: row.id, leaseEpoch, job: { proposalId: payload.proposalId, source: payload.source } as SourcePlanJob }
  })()
}

function planningSource(database: BetterSqlite3.Database, context: WorkGraphContext, job: SourcePlanJob) {
  const row = database.prepare(`
    SELECT sources.title, sources.latest_revision_number, revisions.revision_number, revisions.content,
      revisions.content_hash, proposals.lifecycle, proposals.source_revision_id, proposals.proposed_work_json
    FROM wg_v2_admission_proposals proposals
    JOIN wg_v2_work_source_revisions revisions
      ON revisions.owner_user_id = proposals.owner_user_id AND revisions.id = proposals.source_revision_id
    JOIN wg_v2_work_sources sources
      ON sources.owner_user_id = revisions.owner_user_id AND sources.id = revisions.work_source_id
    WHERE proposals.owner_user_id = ? AND proposals.id = ? AND revisions.work_source_id = ?
  `).get(context.ownerUserId, job.proposalId, job.source.workSourceId) as {
    title: string; latest_revision_number: number; revision_number: number; content: string; content_hash: string
    lifecycle: string; source_revision_id: string; proposed_work_json: string
  } | undefined
  if (!row || row.lifecycle !== "planning" || row.source_revision_id !== job.source.revisionId ||
    row.content_hash !== job.source.contentHash || row.revision_number !== row.latest_revision_number) return undefined
  const planning = JSON.parse(row.proposed_work_json) as { planningEvidence?: PlanningEvidence }
  return { title: row.title, content: row.content, evidence: planning.planningEvidence ?? {} }
}

function sourcePlanningPrompt(job: SourcePlanJob, source: NonNullable<ReturnType<typeof planningSource>>) {
  return [
    "Analyze this exact immutable Work Source revision and propose a personal WorkGraph plan.",
    "Return JSON only. Use exactly these top-level keys: source, suggestedPlacement, placementMatches, proposedOutcomes, proposedWorkItems, duplicateMatches.",
    "Echo source exactly. Preserve only supplied Stream/Outcome/Work Item IDs. Every Outcome needs successCriteria and execution. Every Work Item needs dependencyKeys, a version-1 completionContract, and execution.",
    `Source reference: ${JSON.stringify(job.source)}`,
    `Source title: ${source.title}`,
    `Source content: ${source.content}`,
    `Bounded current placement and duplicate evidence: ${JSON.stringify(source.evidence)}`,
  ].join("\n")
}

function validatePlan(
  database: BetterSqlite3.Database,
  context: WorkGraphContext,
  job: SourcePlanJob,
  source: NonNullable<ReturnType<typeof planningSource>>,
  output: string,
) {
  const plan = AdmissionAgentPlanSchema.parse(JSON.parse(output))
  if (JSON.stringify(plan.source) !== JSON.stringify(job.source)) throw new Error("Source planning result did not echo the exact immutable source revision")
  const outcomeKeys = plan.proposedOutcomes.map((outcome) => outcome.key)
  const itemKeys = plan.proposedWorkItems.map((item) => item.key)
  if (new Set(outcomeKeys).size !== outcomeKeys.length || new Set(itemKeys).size !== itemKeys.length)
    throw new Error("Source planning result contains duplicate proposal keys")
  if (plan.proposedWorkItems.some((item) =>
    (item.outcomeKey && !outcomeKeys.includes(item.outcomeKey)) ||
    item.dependencyKeys.some((key) => !itemKeys.includes(key) || key === item.key)))
    throw new Error("Source planning result contains an unknown proposal reference")
  if (hasDependencyCycle(plan.proposedWorkItems.map((item) => ({ key: item.key, dependencies: item.dependencyKeys }))))
    throw new Error("Source planning result contains a dependency cycle")
  const streamIds = [...new Set([
    ...(plan.suggestedPlacement.mode === "existing" ? [plan.suggestedPlacement.streamId] : []),
    ...plan.placementMatches.map((match) => match.streamId),
    ...plan.duplicateMatches.map((match) => match.streamId),
  ])]
  const allowedStreamIds = new Set<string>([
    ...(typeof source.evidence.targetStreamId === "string" ? [source.evidence.targetStreamId] : []),
    ...(Array.isArray(source.evidence.placementMatches)
      ? source.evidence.placementMatches.flatMap((match: unknown) =>
          match && typeof match === "object" && "streamId" in match && typeof match.streamId === "string" ? [match.streamId] : [])
      : []),
  ])
  if (streamIds.some((id) => !allowedStreamIds.has(id))) throw new Error("Source planning result referenced a Stream outside its bounded evidence package")
  if (streamIds.some((id) => !database.prepare("SELECT 1 FROM wg_v2_streams WHERE owner_user_id = ? AND id = ?").get(context.ownerUserId, id)))
    throw new Error("Source planning result referenced an unavailable Stream")
  const allowedDuplicates = new Set<string>((Array.isArray(source.evidence.duplicateMatches) ? source.evidence.duplicateMatches : []).flatMap((match: unknown) => {
    if (!match || typeof match !== "object" || !("subject" in match) || !match.subject || typeof match.subject !== "object") return []
    const subject = match.subject as Record<string, unknown>
    if (subject.type === "outcome" && typeof subject.outcomeId === "string") return [`outcome:${subject.outcomeId}`]
    if (subject.type === "work_item" && typeof subject.workItemId === "string") return [`work_item:${subject.workItemId}`]
    return []
  }))
  if (plan.duplicateMatches.some((match) => {
    const table = match.subject.type === "outcome" ? "wg_v2_outcomes" : "wg_v2_work_items"
    const id = match.subject.type === "outcome" ? match.subject.outcomeId : match.subject.workItemId
    return !allowedDuplicates.has(`${match.subject.type}:${id}`) ||
      !database.prepare(`SELECT 1 FROM ${table} WHERE owner_user_id = ? AND id = ? AND stream_id = ?`).get(context.ownerUserId, id, match.streamId)
  })) throw new Error("Source planning result contained unsupported duplicate evidence")
  return plan
}

function hasDependencyCycle(items: ReadonlyArray<Readonly<{ key: string; dependencies: readonly string[] }>>) {
  const dependencies = new Map(items.map((item) => [item.key, item.dependencies]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true
    if (visited.has(key)) return false
    visiting.add(key)
    const cyclic = (dependencies.get(key) ?? []).some(visit)
    visiting.delete(key)
    visited.add(key)
    return cyclic
  }
  return items.some((item) => visit(item.key))
}

function publishPlan(
  database: BetterSqlite3.Database,
  context: WorkGraphContext,
  jobId: string,
  workerId: string,
  leaseEpoch: number,
  sessionId: string,
  plan: AdmissionAgentPlan,
  now: number,
) {
  return database.transaction(() => {
    const due = database.prepare(`
      SELECT payload_json FROM wg_v2_due_jobs WHERE owner_user_id = ? AND id = ? AND job_type = 'source_plan'
        AND status = 'running' AND claimed_by = ? AND lease_epoch = ?
    `).get(context.ownerUserId, jobId, workerId, leaseEpoch) as { payload_json: string } | undefined
    const job = due ? JSON.parse(due.payload_json) as SourcePlanJob : undefined
    if (!job || job.sessionId !== sessionId || !planningSource(database, context, job)) return false
    const targetStreamId = plan.suggestedPlacement.mode === "existing" ? plan.suggestedPlacement.streamId : undefined
    const changed = database.prepare(`
      UPDATE wg_v2_admission_proposals SET lifecycle = 'proposed', proposed_work_json = ?, duplicate_matches_json = ?,
        row_version = row_version + 1, updated_at = ?
      WHERE owner_user_id = ? AND id = ? AND lifecycle = 'planning' AND source_revision_id = ?
    `).run(JSON.stringify({
      source: plan.source,
      suggestedPlacement: plan.suggestedPlacement,
      ...(targetStreamId ? { targetStreamId } : {}),
      generation: { method: "agent_session", sessionId, generatedAt: now },
      placementMatches: plan.placementMatches,
      outcomes: plan.proposedOutcomes.map((outcome) => ({ ...outcome, proposalKey: outcome.key })),
      workItems: plan.proposedWorkItems.map((item) => ({
        ...item,
        proposalKey: item.key,
        ...(item.outcomeKey ? { outcomeProposalKey: item.outcomeKey } : {}),
        dependencyProposalKeys: item.dependencyKeys,
      })),
      duplicateMatches: plan.duplicateMatches,
    }), JSON.stringify(plan.duplicateMatches), now, context.ownerUserId, job.proposalId, job.source.revisionId)
    if (changed.changes !== 1) return false
    const version = (database.prepare("SELECT row_version FROM wg_v2_admission_proposals WHERE owner_user_id = ? AND id = ?")
      .get(context.ownerUserId, job.proposalId) as { row_version: number }).row_version
    appendProposalPublication(database, context, {
      proposalId: job.proposalId,
      workSourceId: job.source.workSourceId,
      version,
      generation: { method: "agent_session", sessionId },
      now,
    })
    const completed = database.prepare(`
      UPDATE wg_v2_due_jobs SET status = 'completed', claimed_by = NULL, claim_expires_at = NULL, last_error = NULL,
        row_version = row_version + 1, updated_at = ?
      WHERE owner_user_id = ? AND id = ? AND status = 'running' AND claimed_by = ? AND lease_epoch = ?
    `).run(now, context.ownerUserId, jobId, workerId, leaseEpoch)
    if (completed.changes !== 1) throw new Error("Source planning job lost its durable claim before publication")
    return true
  })()
}

function sourcePlanningProfile(database: BetterSqlite3.Database, context: WorkGraphContext): ResolvedExecutionProfile {
  const row = database.prepare("SELECT defaults_json FROM wg_v2_workgraphs WHERE owner_user_id = ? AND id = 'workgraph_default'")
    .get(context.ownerUserId) as { defaults_json: string } | undefined
  if (!row) throw new Error("Source planning requires configured WorkGraph execution defaults")
  const defaults = ExecutionProfileDefaultsSchema.parse(JSON.parse(row.defaults_json))
  const resolved = resolveExecutionProfile({
    workgraph: {
      ...defaults,
      tools: [],
      connectionIds: [],
      isolation: "stream",
      cleanup: "retain",
      integration: "manual",
    },
  })
  if (!resolved.ok) {
    throw new Error(`Source planning execution profile is incomplete: ${resolved.error.missingFields.join(", ")}`)
  }
  return resolved.profile
}

function sourcePlanningSession(database: BetterSqlite3.Database, context: WorkGraphContext, jobId: string) {
  const row = database.prepare("SELECT payload_json FROM wg_v2_due_jobs WHERE owner_user_id = ? AND id = ?")
    .get(context.ownerUserId, jobId) as { payload_json: string } | undefined
  const payload = row ? JSON.parse(row.payload_json) as SourcePlanJob & {
    generationProfile?: unknown
    sessionAdmissionConfirmed?: boolean
  } : undefined
  if (!payload?.sessionId) return undefined
  const profile = ResolvedExecutionProfileSchema.safeParse(payload.generationProfile)
  if (!profile.success) throw new Error("Source planning Session has no valid durable generation profile")
  return { id: payload.sessionId, admitted: payload.sessionAdmissionConfirmed === true, profile: profile.data }
}

function markSession(
  database: BetterSqlite3.Database,
  context: WorkGraphContext,
  jobId: string,
  workerId: string,
  leaseEpoch: number,
  sessionId: string,
  profile: ResolvedExecutionProfile,
  admitted: boolean,
  now: number,
) {
  return database.transaction(() => {
    const row = database.prepare(`SELECT payload_json FROM wg_v2_due_jobs WHERE owner_user_id = ? AND id = ? AND status = 'running' AND claimed_by = ? AND lease_epoch = ?`)
      .get(context.ownerUserId, jobId, workerId, leaseEpoch) as { payload_json: string } | undefined
    if (!row) throw new Error("Source planning Session lost its durable job claim")
    const changed = database.prepare(`UPDATE wg_v2_due_jobs SET payload_json = ? WHERE owner_user_id = ? AND id = ? AND status = 'running' AND claimed_by = ? AND lease_epoch = ?`)
      .run(JSON.stringify({
        ...JSON.parse(row.payload_json),
        sessionId,
        generationProfile: profile,
        sessionAdmissionConfirmed: admitted,
      }), context.ownerUserId, jobId, workerId, leaseEpoch)
    if (changed.changes !== 1) throw new Error("Source planning Session lost its durable job claim")
    if (!admitted) markPlanningStarted(database, context, jobId, sessionId, now)
  })()
}

function markPlanningQueued(database: BetterSqlite3.Database, context: WorkGraphContext, proposalId: string, now: number) {
  const row = database.prepare(`
    SELECT proposed_work_json, row_version FROM wg_v2_admission_proposals
    WHERE owner_user_id = ? AND id = ? AND lifecycle = 'planning_failed'
  `).get(context.ownerUserId, proposalId) as { proposed_work_json: string; row_version: number } | undefined
  if (!row) return
  const failed = JSON.parse(row.proposed_work_json) as {
    source: WorkSourceRevisionRef
    planningEvidence?: PlanningEvidence
    generation?: { attempt?: number }
  }
  const generation = { method: "planning" as const, attempt: failed.generation?.attempt ?? 0, queuedAt: now }
  const changed = database.prepare(`
    UPDATE wg_v2_admission_proposals SET lifecycle = 'planning', proposed_work_json = ?,
      row_version = row_version + 1, updated_at = ?
    WHERE owner_user_id = ? AND id = ? AND lifecycle = 'planning_failed' AND row_version = ?
  `).run(JSON.stringify({ source: failed.source, planningEvidence: failed.planningEvidence ?? {}, generation }), now,
    context.ownerUserId, proposalId, row.row_version)
  if (changed.changes !== 1) return
  appendProposalPublication(database, context, {
    proposalId,
    workSourceId: failed.source.workSourceId,
    version: row.row_version + 1,
    generation,
    now,
  })
}

function markPlanningStarted(
  database: BetterSqlite3.Database,
  context: WorkGraphContext,
  jobId: string,
  sessionId: string,
  now: number,
) {
  const due = database.prepare("SELECT payload_json FROM wg_v2_due_jobs WHERE owner_user_id = ? AND id = ? AND status = 'running'")
    .get(context.ownerUserId, jobId) as { payload_json: string } | undefined
  const job = due ? JSON.parse(due.payload_json) as SourcePlanJob : undefined
  if (!job) throw new Error("Source planning Session lost its durable job")
  const row = database.prepare(`
    SELECT proposed_work_json, row_version FROM wg_v2_admission_proposals
    WHERE owner_user_id = ? AND id = ? AND lifecycle = 'planning'
  `).get(context.ownerUserId, job.proposalId) as { proposed_work_json: string; row_version: number } | undefined
  if (!row) throw new Error("Source planning proposal is unavailable")
  const planning = JSON.parse(row.proposed_work_json) as {
    source: WorkSourceRevisionRef
    planningEvidence?: PlanningEvidence
    generation?: { attempt?: number; queuedAt?: number }
  }
  const generation = {
    method: "planning" as const,
    attempt: (planning.generation?.attempt ?? 0) + 1,
    queuedAt: planning.generation?.queuedAt ?? now,
    startedAt: now,
  }
  const changed = database.prepare(`
    UPDATE wg_v2_admission_proposals SET proposed_work_json = ?, row_version = row_version + 1, updated_at = ?
    WHERE owner_user_id = ? AND id = ? AND lifecycle = 'planning' AND row_version = ?
  `).run(JSON.stringify({ source: planning.source, planningEvidence: planning.planningEvidence ?? {}, generation }), now,
    context.ownerUserId, job.proposalId, row.row_version)
  if (changed.changes !== 1) throw new Error("Source planning proposal changed before Session admission")
  appendProposalPublication(database, context, {
    proposalId: job.proposalId,
    workSourceId: job.source.workSourceId,
    version: row.row_version + 1,
    generation,
    now,
  })
}

function settlePlanningFailure(
  database: BetterSqlite3.Database,
  context: WorkGraphContext,
  jobId: string,
  workerId: string,
  leaseEpoch: number,
  reason: string,
  retryable: boolean,
  status: "failed" | "cancelled",
  dueAt: number,
  now: number,
) {
  return database.transaction(() => {
    const due = database.prepare(`
      SELECT payload_json FROM wg_v2_due_jobs WHERE owner_user_id = ? AND id = ?
        AND status = 'running' AND claimed_by = ? AND lease_epoch = ?
    `).get(context.ownerUserId, jobId, workerId, leaseEpoch) as { payload_json: string } | undefined
    if (!due) return { retryScheduled: false }
    const job = JSON.parse(due.payload_json) as SourcePlanJob & { automaticFailureCount?: number }
    const row = database.prepare(`
      SELECT proposed_work_json, row_version FROM wg_v2_admission_proposals
      WHERE owner_user_id = ? AND id = ? AND lifecycle = 'planning'
    `).get(context.ownerUserId, job.proposalId) as { proposed_work_json: string; row_version: number } | undefined
    if (row) {
      const planning = JSON.parse(row.proposed_work_json) as {
        source: WorkSourceRevisionRef
        planningEvidence?: PlanningEvidence
        generation?: { attempt?: number }
      }
      const generation = {
        method: "planning_failed" as const,
        attempt: planning.generation?.attempt ?? 0,
        reason,
        failedAt: now,
        retryable,
      }
      const changed = database.prepare(`
        UPDATE wg_v2_admission_proposals SET lifecycle = 'planning_failed', proposed_work_json = ?,
          row_version = row_version + 1, updated_at = ?
        WHERE owner_user_id = ? AND id = ? AND lifecycle = 'planning' AND row_version = ?
      `).run(JSON.stringify({ source: planning.source, planningEvidence: planning.planningEvidence ?? {}, generation }), now,
        context.ownerUserId, job.proposalId, row.row_version)
      if (changed.changes === 1) appendProposalPublication(database, context, {
        proposalId: job.proposalId,
        workSourceId: job.source.workSourceId,
        version: row.row_version + 1,
        generation,
        now,
      })
    }
    const automaticFailureCount = (job.automaticFailureCount ?? 0) + 1
    const retryScheduled = retryable && automaticFailureCount < 3
    database.prepare(`
      UPDATE wg_v2_due_jobs SET status = ?, due_at = ?, payload_json = ?, claimed_by = NULL, claim_expires_at = NULL,
        last_error = ?, updated_at = ?, row_version = row_version + 1
      WHERE owner_user_id = ? AND id = ? AND status = 'running' AND claimed_by = ? AND lease_epoch = ?
    `).run(retryScheduled ? status : retryable ? "failed_terminal" : status, dueAt, JSON.stringify({
      proposalId: job.proposalId,
      source: job.source,
      automaticFailureCount,
      ...(sourcePlanningConfigurationFailure(reason) ? {
        configurationRequirement: {
          type: "generation",
          purpose: "source_planning",
          scope: { type: "workgraph" },
        },
      } : {}),
    }), reason, now, context.ownerUserId, jobId, workerId, leaseEpoch)
    return { retryScheduled }
  })()
}

function sourcePlanningConfigurationFailure(reason: string) {
  return reason.startsWith("Source planning execution profile is incomplete:") ||
    reason === "Source planning Session has no valid durable generation profile"
}

function appendProposalPublication(
  database: BetterSqlite3.Database,
  context: WorkGraphContext,
  input: Readonly<{
    proposalId: string
    workSourceId: string
    version: number
    generation: Readonly<
      | { method: "planning"; attempt: number }
      | { method: "planning_failed"; attempt: number; reason: string; retryable: boolean }
      | { method: "agent_session"; sessionId: string }
    >
    now: number
  }>,
) {
  const operationId = `source_plan_publish_${input.proposalId}_${input.version}`
  database.prepare(`
    INSERT INTO wg_v2_operation_results
      (owner_user_id, id, command_type, request_hash, result_status, result_json, created_at)
    VALUES (?, ?, 'source_plan_publication', ?, 200, '{}', ?)
  `).run(context.ownerUserId, operationId, operationId, input.now)
  database.prepare(`
    INSERT OR IGNORE INTO wg_v2_change_cursors (owner_user_id, next_cursor, created_at, updated_at)
    VALUES (?, 1, ?, ?)
  `).run(context.ownerUserId, input.now, input.now)
  const cursor = (database.prepare("SELECT next_cursor FROM wg_v2_change_cursors WHERE owner_user_id = ?")
    .get(context.ownerUserId) as { next_cursor: number }).next_cursor
  database.prepare(`
    UPDATE wg_v2_change_cursors SET next_cursor = next_cursor + 1, row_version = row_version + 1, updated_at = ?
    WHERE owner_user_id = ?
  `).run(input.now, context.ownerUserId)
  const sequenceScope = "__workgraph_owner_events__"
  database.prepare(`
    INSERT OR IGNORE INTO wg_v2_stream_sequences (owner_user_id, stream_id, next_sequence, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)
  `).run(context.ownerUserId, sequenceScope, input.now, input.now)
  const sequence = (database.prepare("SELECT next_sequence FROM wg_v2_stream_sequences WHERE owner_user_id = ? AND stream_id = ?")
    .get(context.ownerUserId, sequenceScope) as { next_sequence: number }).next_sequence
  database.prepare(`
    UPDATE wg_v2_stream_sequences SET next_sequence = next_sequence + 1, row_version = row_version + 1, updated_at = ?
    WHERE owner_user_id = ? AND stream_id = ?
  `).run(input.now, context.ownerUserId, sequenceScope)
  const payload = JSON.stringify({
    proposalId: input.proposalId,
    workSourceId: input.workSourceId,
    version: input.version,
    generation: input.generation,
  })
  database.prepare(`
    INSERT INTO wg_v2_events
      (owner_user_id, id, stream_id, sequence, schema_version, operation_id, event_type, actor_type, actor_id, request_id, payload_json, occurred_at)
    VALUES (?, ?, NULL, ?, 1, ?, 'admission_proposal_updated', 'system', 'source_planner', ?, ?, ?)
  `).run(context.ownerUserId, `event_${operationId}`, sequence, operationId, operationId, payload, input.now)
  database.prepare(`
    INSERT INTO wg_v2_changes
      (owner_user_id, cursor, id, stream_id, operation_id, resource_type, resource_id, change_type, payload_json, created_at)
    VALUES (?, ?, ?, NULL, ?, 'admission_proposal', ?, 'admission_proposal_updated', ?, ?)
  `).run(context.ownerUserId, cursor, `change_${operationId}`, operationId, input.proposalId, payload, input.now)
  database.prepare("UPDATE wg_v2_operation_results SET change_cursor = ? WHERE owner_user_id = ? AND id = ?")
    .run(cursor, context.ownerUserId, operationId)
}

function failClaim(database: BetterSqlite3.Database, context: WorkGraphContext, id: string, workerId: string, leaseEpoch: number, reason: string, now: number) {
  return settlePlanningFailure(database, context, id, workerId, leaseEpoch, reason, true, "failed", now + retryDelayMs, now)
}

function cancelClaim(database: BetterSqlite3.Database, context: WorkGraphContext, id: string, workerId: string, leaseEpoch: number, reason: string, now: number) {
  return settlePlanningFailure(database, context, id, workerId, leaseEpoch, reason, false, "cancelled", now, now)
}
