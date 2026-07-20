import type BetterSqlite3 from "better-sqlite3"
import { createHash } from "node:crypto"
import {
  DEFAULT_STREAM_CHARTER_HINTS,
  masterAttemptId,
  masterSessionId,
  nextDailyMasterRun,
  ResolvedExecutionProfileSchema,
  WorkGraphMasterLandingToolName,
  WorkGraphMasterToolNames,
  type CommandResult,
  type WorkGraphCommandRequest,
  type WorkGraphContext,
} from "@claxedo/workgraph/contracts"
import type { WorkGraphSessionBindingPort } from "@claxedo/workgraph/ports"
import { buildMasterPrompt, charterClause, type WorkspaceExecutionPort } from "@claxedo/workgraph"
import type { WorkGraphSessionGateway } from "./local-execution"

type Database = BetterSqlite3.Database

type MasterWakeRow = Readonly<{
  id: string
  stream_id: string
  row_version: number
  payload_json: string
  status: "pending" | "running"
}>

type MasterStreamRow = Readonly<{
  id: string
  title: string
  charter_json: string | null
  execution_defaults_json: string
  lifecycle: string
  row_version: number
}>

type MasterMailboxRow = Readonly<{
  id: string
  message: string
  provenance_json: string
  created_at: string | number
}>

type MasterAttemptRow = Readonly<{
  id: string
  work_item_id: string
  lifecycle: string
  terminal_result_json: string | null
  resolved_execution_profile_json: string
  updated_at: string | number
}>

export function createLocalWorkGraphMasterRuntime(input: Readonly<{
  database: Database
  sessions: WorkGraphSessionGateway
  workspace: Pick<WorkspaceExecutionPort, "provisionOrAdopt">
  sessionBindings: WorkGraphSessionBindingPort
  execute(context: WorkGraphContext, request: WorkGraphCommandRequest): Promise<CommandResult>
  directory(context: WorkGraphContext, streamId: string): string
  now?: () => number
}>) {
  const now = input.now ?? Date.now
  return {
    runDue: async (context: WorkGraphContext) => {
      const rows = input.database.prepare(`
        SELECT id, stream_id, row_version, payload_json, status FROM wg_v2_due_jobs
        WHERE organization_id = ? AND owner_user_id = ? AND job_type = 'master_wake'
          AND (status = 'running' OR (status = 'pending' AND CAST(due_at AS INTEGER) <= ?))
        ORDER BY CAST(due_at AS INTEGER), id LIMIT 25
      `).all(context.organizationId, context.ownerUserId, now()) as MasterWakeRow[]
      return Promise.all(rows.map((row) => runTurn(input, context, row, now)))
    },
  }
}

async function runTurn(
  input: Readonly<{
    database: Database
    sessions: WorkGraphSessionGateway
    workspace: Pick<WorkspaceExecutionPort, "provisionOrAdopt">
    sessionBindings: WorkGraphSessionBindingPort
    execute(context: WorkGraphContext, request: WorkGraphCommandRequest): Promise<CommandResult>
    directory(context: WorkGraphContext, streamId: string): string
  }>,
  context: WorkGraphContext,
  wake: MasterWakeRow,
  now: () => number,
) {
  const claimed = input.database.transaction(() => {
    if (wake.status === "pending") {
      const changed = input.database.prepare(`
        UPDATE wg_v2_due_jobs SET status = 'running', claimed_by = ?, claim_expires_at = ?,
          lease_epoch = lease_epoch + 1, row_version = row_version + 1, updated_at = ?
        WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND status = 'pending' AND row_version = ?
      `).run(
        `master:${process.pid}`,
        now() + 300_000,
        now(),
        context.organizationId,
        context.ownerUserId,
        wake.id,
        wake.row_version,
      )
      if (changed.changes !== 1) return
    }
    const stream = input.database.prepare(`
      SELECT id, title, charter_json, execution_defaults_json, lifecycle, row_version FROM wg_v2_streams
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `).get(context.organizationId, context.ownerUserId, wake.stream_id) as MasterStreamRow | undefined
    // A missing or closed Stream cancels its master wake outright — closed
    // Streams must never launch master sessions, and schedule wakes must not
    // re-arm for them.
    if (!stream || stream.lifecycle === "closed") return { retired: true as const, mailbox: [], attempts: [] }
    if (wake.status === "pending") {
      // The master and task Attempts share the Stream envelope worktree. A
      // master turn never starts while an Attempt is live in the workspace —
      // the wake defers and the lane re-fires after the Attempt settles.
      const liveAttempt = input.database.prepare(`
        SELECT 1 FROM wg_v2_attempts
        WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
          AND lifecycle IN ('admitted', 'placing', 'running') LIMIT 1
      `).get(context.organizationId, context.ownerUserId, wake.stream_id)
      if (liveAttempt) {
        input.database.prepare(`
          UPDATE wg_v2_due_jobs SET status = 'pending', claimed_by = NULL, claim_expires_at = NULL,
            due_at = ?, lease_epoch = lease_epoch - 1, updated_at = ?
          WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `).run(now() + 30_000, now(), context.organizationId, context.ownerUserId, wake.id)
        return { deferred: true as const, mailbox: [], attempts: [] }
      }
      setMasterStatus(input.database, context, stream.id, {
        state: "acting",
        sessionId: masterSessionId(stream.id),
        message: "Master turn in progress",
        updatedAt: now(),
      })
    }
    const mailbox = input.database.prepare(`
      SELECT id, message, provenance_json, created_at FROM wg_v2_master_mailbox
      WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ? AND status = ?
      ORDER BY CAST(created_at AS INTEGER), id LIMIT 100
    `).all(context.organizationId, context.ownerUserId, wake.stream_id, wake.status === "pending" ? "pending" : "claimed") as MasterMailboxRow[]
    if (wake.status === "pending") mailbox.forEach((message) => input.database.prepare(`
      UPDATE wg_v2_master_mailbox SET status = 'claimed', updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND status = 'pending'
    `).run(now(), context.organizationId, context.ownerUserId, message.id))
    const attempts = input.database.prepare(`
      SELECT id, work_item_id, lifecycle, terminal_result_json, resolved_execution_profile_json, updated_at
      FROM wg_v2_attempts WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
        AND lifecycle IN ('result', 'failed', 'cancelled')
      ORDER BY CAST(updated_at AS INTEGER) DESC, id DESC LIMIT 20
    `).all(context.organizationId, context.ownerUserId, wake.stream_id) as MasterAttemptRow[]
    return { stream, mailbox, attempts }
  })()
  if (!claimed) return { status: "skipped" as const }
  if ("deferred" in claimed) return { status: "deferred" as const }
  if ("retired" in claimed || !claimed.stream) return complete(input.database, context, wake, now(), "cancelled")
  try {
    const sessionId = masterSessionId(claimed.stream.id)
    const profile = resolveProfile(claimed.stream, claimed.attempts)
    if (wake.status === "running") {
      const result = await input.sessions.result(sessionId)
      if (result.state === "pending" || result.state === "running") return { status: "running" as const, sessionId }
      if (result.state === "failed") throw new Error(result.message)
      if (result.state === "cancelled") throw new Error("Master Session was cancelled")
      if (result.state !== "succeeded") throw new Error("Master Session returned an unsupported result")
      const charter = charterDetails(claimed.stream)
      const resultingDiffs = [...new Set([...artifactRefs(claimed.attempts), ...result.artifacts])]
      const audit = await input.execute(masterContext(context, sessionId), {
        operationId: `audit_master_${claimed.stream.id}_${wake.row_version}` as never,
        command: {
          version: 1,
          type: "record_master_audit",
          streamId: claimed.stream.id as never,
          expectedVersion: claimed.stream.row_version,
          sessionId,
          wakeTrigger: wakeTrigger(wake.payload_json),
          charterHash: charter.hash,
          citedCharterClause: charter.clause,
          modelVersion: `${profile.model.providerId}/${profile.model.modelId}`,
          reasoningSummary: result.summary,
          toolCalls: [],
          resultingDiffs,
          evidenceIds: evidenceIds(input.database, context, claimed.attempts),
          outcome: "succeeded",
        },
      })
      if (!audit.ok) throw new Error(audit.error.message)
      const completed = input.database.transaction(() => {
        claimed.mailbox.forEach((message) => input.database.prepare(`
          UPDATE wg_v2_master_mailbox SET status = 'consumed', updated_at = ?
          WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND status = 'claimed'
        `).run(now(), context.organizationId, context.ownerUserId, message.id))
        return complete(input.database, context, wake, now(), "completed", resultingDiffs)
      })()
      return { ...completed, sessionId }
    }
    const envelope = await input.workspace.provisionOrAdopt(context, {
      streamId: claimed.stream.id as never,
      environment: profile.environment,
      ...(profile.repository ? { repository: profile.repository } : {}),
    })
    const binding = await input.sessionBindings.bind(masterContext(context, sessionId), {
      operationId: `bind_master_${claimed.stream.id}` as never,
      streamId: claimed.stream.id as never,
      sessionId,
      projectId: envelope.workspaceId,
    })
    const mailbox = claimed.mailbox.filter((message) => actorId(message.provenance_json) !== sessionId)
    await input.sessions.admit({
      attemptId: masterAttemptId(claimed.stream.id),
      streamId: claimed.stream.id,
      sessionId,
      messageId: `msg_master_${claimed.stream.id}_${wake.row_version}`,
      directory: input.directory(context, claimed.stream.id),
      workspaceId: envelope.workspaceId,
      title: `Master · ${claimed.stream.title}`,
      prompt: buildMasterPrompt({
        stream: claimed.stream,
        charter: charterDetails(claimed.stream),
        mailbox,
        attempts: claimed.attempts.map((attempt) => ({
          id: attempt.id,
          workItemId: attempt.work_item_id,
          state: attempt.lifecycle,
          result: attempt.terminal_result_json ?? "none",
        })),
        connectionIds: profile.connectionIds,
        capabilities: { landing: true },
      }),
      profile: {
        ...profile,
        tools: [...new Set([
          ...profile.tools.filter((tool) => !tool.includes("approve")),
          WorkGraphMasterLandingToolName,
          ...WorkGraphMasterToolNames,
        ])],
      },
      context: masterContext(context, sessionId),
    })
    return { status: "admitted" as const, sessionId, bindingId: binding.id }
  } catch (error) {
    input.database.transaction(() => {
      const failure = error instanceof Error ? error.message : String(error)
      const job = input.database.prepare(`
        SELECT lease_epoch FROM wg_v2_due_jobs WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `).get(context.organizationId, context.ownerUserId, wake.id) as { lease_epoch: number } | undefined
      const escalated = (job?.lease_epoch ?? 0) >= 3
      claimed.mailbox.forEach((message) => input.database.prepare(`
        UPDATE wg_v2_master_mailbox SET status = ?, updated_at = ?
        WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND status = 'claimed'
      `).run(escalated ? "consumed" : "pending", now(), context.organizationId, context.ownerUserId, message.id))
      input.database.prepare(`
        UPDATE wg_v2_due_jobs SET status = ?, due_at = ?, claimed_by = NULL, claim_expires_at = NULL,
          last_error = ?, updated_at = ? WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `).run(
        escalated ? "attention" : "pending",
        now() + 5_000,
        failure,
        now(),
        context.organizationId,
        context.ownerUserId,
        wake.id,
      )
      setMasterStatus(input.database, context, wake.stream_id, {
        state: escalated ? "attention" : "retrying",
        ...(escalated ? { escalation: "failure_halt" } : {}),
        sessionId: masterSessionId(wake.stream_id),
        message: escalated ? `Master halted after repeated failure: ${failure}` : "Master turn will retry",
        updatedAt: now(),
      })
    })()
    const state = input.database.prepare(`
      SELECT status FROM wg_v2_due_jobs WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `).get(context.organizationId, context.ownerUserId, wake.id) as { status: string }
    return { status: state.status === "attention" ? "attention" as const : "retrying" as const }
  }
}

function resolveProfile(stream: MasterStreamRow, attempts: readonly MasterAttemptRow[]) {
  const candidates = [stream.execution_defaults_json, ...attempts.map((attempt) => attempt.resolved_execution_profile_json)]
  for (const candidate of candidates) {
    const parsed = ResolvedExecutionProfileSchema.safeParse(JSON.parse(candidate))
    if (parsed.success) return parsed.data
  }
  throw new Error("Master wake requires a fully resolved Stream execution profile")
}

function charterDetails(stream: MasterStreamRow) {
  if (stream.charter_json) {
    const charter = JSON.parse(stream.charter_json) as { text: string; hash: string }
    return { ...charter, clause: charterClause(charter.text) }
  }
  const text = DEFAULT_STREAM_CHARTER_HINTS.join("\n")
  return { text, hash: createHash("sha256").update(text).digest("hex"), clause: DEFAULT_STREAM_CHARTER_HINTS[0]! }
}

function wakeTrigger(payload: string) {
  const value = JSON.parse(payload) as { trigger?: unknown }
  return value.trigger === "mailbox" || value.trigger === "schedule" ? value.trigger : "task_settled"
}

function artifactRefs(attempts: readonly MasterAttemptRow[]) {
  return attempts.flatMap((attempt) => {
    if (!attempt.terminal_result_json) return []
    const result = JSON.parse(attempt.terminal_result_json) as { artifactRefs?: unknown }
    return Array.isArray(result.artifactRefs)
      ? result.artifactRefs.filter((value): value is string => typeof value === "string" && !!value.trim())
      : []
  }).slice(0, 100)
}

function evidenceIds(database: Database, context: WorkGraphContext, attempts: readonly MasterAttemptRow[]) {
  if (!attempts.length) return []
  return (database.prepare(`
    SELECT id FROM wg_v2_evidence WHERE organization_id = ? AND owner_user_id = ?
      AND source_attempt_id IN (${attempts.map(() => "?").join(",")})
    ORDER BY created_at, id LIMIT 100
  `).all(context.organizationId, context.ownerUserId, ...attempts.map((attempt) => attempt.id)) as Array<{ id: string }>)
    .map((row) => row.id as never)
}

function masterContext(context: WorkGraphContext, sessionId: string): WorkGraphContext {
  return { ...context, actor: { type: "agent", id: sessionId as never }, requestId: `master_${crypto.randomUUID()}` as never }
}

function actorId(provenance: string) {
  const value = JSON.parse(provenance) as { actor?: { id?: unknown } }
  return typeof value.actor?.id === "string" ? value.actor.id : undefined
}

function complete(
  database: Database,
  context: WorkGraphContext,
  wake: MasterWakeRow,
  completedAt: number,
  status: "completed" | "cancelled",
  receiptRefs?: readonly string[],
) {
  const scheduled = wakeTrigger(wake.payload_json) === "schedule" && status === "completed"
  const claimedRowVersion = wake.status === "pending" ? wake.row_version + 1 : wake.row_version
  const changed = database.prepare(`
    UPDATE wg_v2_due_jobs SET status = ?, due_at = ?, claimed_by = NULL, claim_expires_at = NULL, last_error = NULL,
      updated_at = ? WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        AND status = 'running' AND row_version = ?
  `).run(
    scheduled ? "pending" : status,
    scheduled ? nextDailyMasterRun(completedAt) : completedAt,
    completedAt,
    context.organizationId,
    context.ownerUserId,
    wake.id,
    claimedRowVersion,
  )
  // A concurrent settlement or mailbox append advances row_version and puts
  // the same dirty-flag job back to pending. The older turn has completed, but
  // it must not erase that newer wake or replace its pending status line.
  if (changed.changes !== 1) return { status, superseded: true as const }
  setMasterStatus(database, context, wake.stream_id, {
    state: "hibernating",
    sessionId: masterSessionId(wake.stream_id),
    message: status === "completed" ? "Master is up to date" : "Master stopped",
    updatedAt: completedAt,
    // A completed turn surfaces its audit's resulting diffs as the master's
    // durable receipts, mirroring the Convex runtime (`recordMasterTurn` sets
    // `receiptRefs: args.resulting_diffs` alongside "Master is up to date").
    ...(receiptRefs ? { receiptRefs } : {}),
  })
  return { status }
}


function setMasterStatus(
  database: Database,
  context: WorkGraphContext,
  streamId: string,
  next: Readonly<{
    state: string
    escalation?: string
    sessionId?: string
    message: string
    updatedAt: number
    receiptRefs?: readonly string[]
  }>,
) {
  const row = database.prepare(`
    SELECT master_status_json, charter_json FROM wg_v2_streams
    WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `).get(context.organizationId, context.ownerUserId, streamId) as
    | { master_status_json: string | null; charter_json: string | null }
    | undefined
  if (!row) return
  const previous = row.master_status_json
    ? JSON.parse(row.master_status_json) as { receiptRefs?: unknown }
    : undefined
  const charter = row.charter_json ? JSON.parse(row.charter_json) as { hash?: unknown } : undefined
  database.prepare(`
    UPDATE wg_v2_streams SET master_status_json = ?
    WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `).run(JSON.stringify({
    ...next,
    receiptRefs: next.receiptRefs ?? (Array.isArray(previous?.receiptRefs) ? previous.receiptRefs : []),
    ...(typeof charter?.hash === "string" ? { charterHash: charter.hash } : {}),
  }), context.organizationId, context.ownerUserId, streamId)
}
