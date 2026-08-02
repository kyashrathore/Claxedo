import type BetterSqlite3 from "better-sqlite3"
import { createHash } from "node:crypto"
import {
  AgentCheckpointDtoSchema,
  SessionBindingDtoSchema,
  TaskActivityEntrySchema,
  TaskActivityPageSchema,
  createChangeCursor,
  createTaskActivityPageCursor,
  readTaskActivityPageCursor,
  type AgentCheckpointDto,
  type RunID,
  type SessionBindingDto,
  type StreamActivityGranularity,
  type StreamID,
  type TaskActivityEntry,
  type WorkGraphContext,
  type WorkItemID,
} from "../../contracts"
import {
  WorkGraphSessionBindingError,
  type WorkGraphActivityPort,
  type WorkGraphSessionBindingPort,
} from "../../ports"
import { initializeWorkGraphSqliteSchema } from "./schema"
import { allocateSqliteChangeCursor } from "./change-cursor"

type Database = BetterSqlite3.Database

export function createSqliteWorkGraphActivityPorts(input: Readonly<{
  database: Database
  clock?: Readonly<{ now: () => number }>
  ids?: Readonly<{ next: (kind: string) => string }>
}>) {
  const database = initializeWorkGraphSqliteSchema(input.database).raw()
  if (!database) throw new Error("SQLite activity requires direct transactional database access")
  const clock = input.clock ?? { now: () => Date.now() }
  const ids = input.ids ?? { next: (kind: string) => `${kind}_${crypto.randomUUID()}` }

  const sessionBindings: WorkGraphSessionBindingPort = {
    bind: async (context, binding) => database.transaction(() => {
      requireOwner(context)
      const request = { type: "bind_session", ...binding }
      const replay = operationReplay(database, context, binding.operationId, "bind_session", request)
      if (replay) return SessionBindingDtoSchema.parse({ ...object(replay), ownerUserId: context.ownerUserId })
      if (!owned(database, context, "wg_v2_streams", binding.streamId)) {
        throw new WorkGraphSessionBindingError("not_found", "Stream not found")
      }
      const active = database.prepare(`
        SELECT * FROM wg_v2_session_bindings
        WHERE organization_id = ? AND owner_user_id = ? AND session_id = ? AND state = 'active'
      `).get(context.organizationId, context.ownerUserId, binding.sessionId) as BindingRow | undefined
      if (active) {
        if (active.stream_id === binding.streamId && active.project_id === binding.projectId) return bindingDto(context, active)
        throw new WorkGraphSessionBindingError("conflict", "Session is already bound to another Stream or project")
      }
      const now = clock.now()
      const id = ids.next("session_binding")
      database.prepare(`
        INSERT INTO wg_v2_session_bindings
          (organization_id, owner_user_id, id, stream_id, session_id, project_id, state, bound_at,
           provenance_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
      `).run(
        context.organizationId,
        context.ownerUserId,
        id,
        binding.streamId,
        binding.sessionId,
        binding.projectId,
        now,
        JSON.stringify({ actor: context.actor, operationId: binding.operationId }),
        now,
        now,
      )
      const result = bindingDto(context, requireBinding(database, context, id))
      appendSqliteOwnedChange(database, context, {
        operationId: binding.operationId,
        commandType: "bind_session",
        eventType: "session_bound",
        streamId: binding.streamId,
        resource: { type: "session_binding", id: id as never },
        payload: { bindingId: id, sessionId: binding.sessionId, projectId: binding.projectId },
        request,
        resultValue: ownerNeutral(result),
        occurredAt: now,
      })
      return result
    })(),

    attachTask: async (context, attachment) => database.transaction(() => {
      requireOwner(context)
      const request = { type: "attach_session_task", ...attachment }
      const replay = operationReplay(database, context, attachment.operationId, "attach_session_task", request)
      if (replay) return SessionBindingDtoSchema.parse({ ...object(replay), ownerUserId: context.ownerUserId })
      const binding = requireBinding(database, context, attachment.bindingId)
      if (binding.state !== "active") throw new WorkGraphSessionBindingError("invalid_transition", "Session binding is released")
      if (binding.row_version !== attachment.expectedVersion) throw new WorkGraphSessionBindingError("conflict", "Session binding version changed")
      const item = database.prepare(`
        SELECT id, stream_id, lifecycle FROM wg_v2_work_items
        WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `).get(context.organizationId, context.ownerUserId, attachment.workItemId) as
        | { id: WorkItemID; stream_id: StreamID; lifecycle: string }
        | undefined
      if (!item || item.stream_id !== binding.stream_id) throw new WorkGraphSessionBindingError("not_found", "Work Item not found in the bound Stream")
      if (binding.current_work_item_id === item.id && binding.current_run_id) {
        throw new WorkGraphSessionBindingError("invalid_transition", "Session is already attached to this Work Item")
      }
      if (binding.current_work_item_id) {
        const current = database.prepare(`
          SELECT lifecycle FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `).get(context.organizationId, context.ownerUserId, binding.current_work_item_id) as { lifecycle: string } | undefined
        const currentRun = binding.current_run_id ? database.prepare(`
          SELECT lifecycle FROM wg_v2_runs WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `).get(context.organizationId, context.ownerUserId, binding.current_run_id) as { lifecycle: string } | undefined : undefined
        if (!current || !["completed", "abandoned"].includes(current.lifecycle) ||
          !currentRun || !["result", "failed", "cancelled"].includes(currentRun.lifecycle)) {
          throw new WorkGraphSessionBindingError("invalid_transition", "Settle the current Work Item and Run before attaching another")
        }
      }
      if (item.lifecycle !== "pending" || database.prepare(`
        SELECT 1 FROM wg_v2_work_item_dependencies dependencies
        JOIN wg_v2_work_items blockers
          ON blockers.organization_id = dependencies.organization_id
          AND blockers.owner_user_id = dependencies.owner_user_id
          AND blockers.id = dependencies.depends_on_work_item_id
        WHERE dependencies.organization_id = ? AND dependencies.owner_user_id = ?
          AND dependencies.work_item_id = ? AND blockers.lifecycle <> 'completed' LIMIT 1
      `).get(context.organizationId, context.ownerUserId, item.id)) {
        throw new WorkGraphSessionBindingError("not_ready", "Work Item is not ready")
      }
      if (database.prepare(`
        SELECT 1 FROM wg_v2_decision_work_items links
        JOIN wg_v2_decisions decisions
          ON decisions.organization_id = links.organization_id
          AND decisions.owner_user_id = links.owner_user_id
          AND decisions.id = links.decision_id
        WHERE links.organization_id = ? AND links.owner_user_id = ? AND links.work_item_id = ?
          AND decisions.lifecycle IN ('proposed', 'pending')
        LIMIT 1
      `).get(context.organizationId, context.ownerUserId, item.id)) {
        throw new WorkGraphSessionBindingError("not_ready", "Work Item requires a pending Decision")
      }
      if (database.prepare(`
        SELECT 1 FROM wg_v2_runs
        WHERE organization_id = ? AND owner_user_id = ? AND work_item_id = ?
          AND lifecycle IN ('admitted', 'placing', 'running')
        LIMIT 1
      `).get(context.organizationId, context.ownerUserId, item.id)) {
        throw new WorkGraphSessionBindingError("not_ready", "Work Item already has an active Run")
      }
      const now = clock.now()
      const runId = ids.next("run")
      const runNumber = (database.prepare(`
        SELECT COALESCE(MAX(run_number), 0) + 1 AS value FROM wg_v2_runs
        WHERE organization_id = ? AND owner_user_id = ? AND work_item_id = ?
      `).get(context.organizationId, context.ownerUserId, item.id) as { value: number }).value
      database.prepare(`
        INSERT INTO wg_v2_runs
          (organization_id, owner_user_id, id, stream_id, work_item_id, run_number, lifecycle,
           generation, execution_kind, resolved_execution_profile_json, session_id, created_at, updated_at, started_at)
        VALUES (?, ?, ?, ?, ?, ?, 'running', 1, 'attached', ?, ?, ?, ?, ?)
      `).run(
        context.organizationId,
        context.ownerUserId,
        runId,
        binding.stream_id,
        item.id,
        runNumber,
        JSON.stringify(attachment.resolvedExecution),
        binding.session_id,
        now,
        now,
        now,
      )
      database.prepare(`
        UPDATE wg_v2_work_items SET lifecycle = 'active', row_version = row_version + 1, updated_at = ?
        WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lifecycle = 'pending'
      `).run(now, context.organizationId, context.ownerUserId, item.id)
      database.prepare(`
        UPDATE wg_v2_session_bindings SET current_work_item_id = ?, current_run_id = ?,
          row_version = row_version + 1, updated_at = ?, provenance_json = ?
        WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
      `).run(
        item.id,
        runId,
        now,
        JSON.stringify({ actor: context.actor, operationId: attachment.operationId }),
        context.organizationId,
        context.ownerUserId,
        binding.id,
        binding.row_version,
      )
      const result = bindingDto(context, requireBinding(database, context, binding.id))
      appendSqliteOwnedChange(database, context, {
        operationId: attachment.operationId,
        commandType: "attach_session_task",
        eventType: "session_task_attached",
        streamId: binding.stream_id,
        resource: { type: "session_binding", id: binding.id as never },
        payload: { bindingId: binding.id, workItemId: item.id, runId },
        request,
        resultValue: ownerNeutral(result),
        snapshotRelevant: true,
        occurredAt: now,
      })
      return result
    })(),

    recordCheckpoint: async (context, checkpoint) => database.transaction(() => {
      requireOwner(context)
      const request = { type: "record_agent_checkpoint", ...checkpoint }
      const replay = operationReplay(database, context, checkpoint.operationId, "record_agent_checkpoint", request)
      if (replay) return AgentCheckpointDtoSchema.parse({ ...object(replay), ownerUserId: context.ownerUserId })
      const binding = requireBinding(database, context, checkpoint.bindingId)
      if (binding.state !== "active" || !binding.current_work_item_id || !binding.current_run_id) {
        throw new WorkGraphSessionBindingError("invalid_transition", "Session binding has no active Work Item")
      }
      const evidence = checkpoint.evidenceIds.map((id) => database.prepare(`
        SELECT subject_type, subject_id, source_run_id FROM wg_v2_evidence
        WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `).get(context.organizationId, context.ownerUserId, id) as
        | { subject_type: string; subject_id: string; source_run_id: string | null }
        | undefined)
      if (evidence.some((row) => !row ||
        !((row.subject_type === "work_item" && row.subject_id === binding.current_work_item_id) ||
          row.source_run_id === binding.current_run_id))) {
        throw new WorkGraphSessionBindingError("not_found", "Checkpoint evidence does not belong to the active Task")
      }
      const now = clock.now()
      const occurredAt = checkpoint.occurredAt ?? now
      const id = ids.next("agent_checkpoint")
      database.prepare(`
        INSERT INTO wg_v2_agent_checkpoints
          (organization_id, owner_user_id, id, stream_id, work_item_id, run_id, session_binding_id,
           level, summary, evidence_ids_json, occurred_at, provenance_json, operation_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        context.organizationId,
        context.ownerUserId,
        id,
        binding.stream_id,
        binding.current_work_item_id,
        binding.current_run_id,
        binding.id,
        checkpoint.level,
        checkpoint.summary,
        JSON.stringify(checkpoint.evidenceIds),
        occurredAt,
        JSON.stringify({ actor: context.actor, operationId: checkpoint.operationId }),
        checkpoint.operationId,
        now,
        now,
      )
      const result = checkpointDto(context, requireCheckpoint(database, context, id))
      appendSqliteOwnedChange(database, context, {
        operationId: checkpoint.operationId,
        commandType: "record_agent_checkpoint",
        eventType: "agent_checkpoint_recorded",
        streamId: binding.stream_id,
        resource: { type: "agent_checkpoint", id: id as never },
        payload: { checkpointId: id, workItemId: binding.current_work_item_id, runId: binding.current_run_id },
        request,
        resultValue: ownerNeutral(result),
        occurredAt: now,
      })
      return result
    })(),

    release: async (context, release) => database.transaction(() => {
      requireOwner(context)
      const request = { type: "release_session_binding", ...release }
      const replay = operationReplay(database, context, release.operationId, "release_session_binding", request)
      if (replay) return SessionBindingDtoSchema.parse({ ...object(replay), ownerUserId: context.ownerUserId })
      const binding = requireBinding(database, context, release.bindingId)
      if (binding.state === "released") return bindingDto(context, binding)
      if (binding.row_version !== release.expectedVersion) throw new WorkGraphSessionBindingError("conflict", "Session binding version changed")
      if (binding.current_run_id) {
        const run = database.prepare(`
          SELECT lifecycle FROM wg_v2_runs WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        `).get(context.organizationId, context.ownerUserId, binding.current_run_id) as { lifecycle: string } | undefined
        if (!run || !["result", "failed", "cancelled"].includes(run.lifecycle)) {
          throw new WorkGraphSessionBindingError("invalid_transition", "Settle the attached Run before releasing its Session")
        }
      }
      const now = clock.now()
      database.prepare(`
        UPDATE wg_v2_session_bindings SET state = 'released', released_at = ?, row_version = row_version + 1,
          updated_at = ?, provenance_json = ?
        WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND row_version = ?
      `).run(
        now,
        now,
        JSON.stringify({ actor: context.actor, operationId: release.operationId }),
        context.organizationId,
        context.ownerUserId,
        binding.id,
        binding.row_version,
      )
      const result = bindingDto(context, requireBinding(database, context, binding.id))
      appendSqliteOwnedChange(database, context, {
        operationId: release.operationId,
        commandType: "release_session_binding",
        eventType: "session_binding_released",
        streamId: binding.stream_id,
        resource: { type: "session_binding", id: binding.id as never },
        payload: { bindingId: binding.id },
        request,
        resultValue: ownerNeutral(result),
        occurredAt: now,
      })
      return result
    })(),

    read: async (context, bindingId) => {
      requireOwner(context)
      const row = database.prepare(`
        SELECT * FROM wg_v2_session_bindings WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `).get(context.organizationId, context.ownerUserId, bindingId) as BindingRow | undefined
      return row ? bindingDto(context, row) : undefined
    },

    readForSession: async (context, sessionId) => {
      requireOwner(context)
      const row = database.prepare(`
        SELECT * FROM wg_v2_session_bindings
        WHERE organization_id = ? AND owner_user_id = ? AND session_id = ? AND state = 'active'
      `).get(context.organizationId, context.ownerUserId, sessionId) as BindingRow | undefined
      return row ? bindingDto(context, row) : undefined
    },
  }

  const activity: WorkGraphActivityPort = {
    list: async (context, query) => {
      requireOwner(context)
      const item = database.prepare(`
        SELECT stream_id FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `).get(context.organizationId, context.ownerUserId, query.workItemId) as { stream_id: StreamID } | undefined
      if (!item) throw new WorkGraphSessionBindingError("not_found", "Work Item not found")
      const cursor = query.after
        ? readTaskActivityPageCursor(query.after, context.organizationId, context.ownerUserId, query.workItemId, query.granularity)
        : undefined
      const importance = allowedImportance(query.granularity)
      const rows = database.prepare(taskActivitySql(importance.length)).all({
        organization: context.organizationId,
        owner: context.ownerUserId,
        workItem: query.workItemId,
        ...Object.fromEntries(importance.map((value, index) => [`importance${index}`, value])),
        cursorOccurredAt: cursor?.occurredAt ?? null,
        cursorEntryId: cursor?.entryId ?? null,
        limit: query.limit + 1,
      }) as ActivityRow[]
      const entries = rows.slice(0, query.limit).map((row) => activityEntry(item.stream_id, query.workItemId, row))
      const hasMore = rows.length > query.limit
      return TaskActivityPageSchema.parse({
        entries,
        hasMore,
        ...(hasMore ? {
          nextCursor: createTaskActivityPageCursor({
            organizationId: context.organizationId,
            ownerUserId: context.ownerUserId,
            workItemId: query.workItemId,
            granularity: query.granularity,
            occurredAt: entries.at(-1)!.occurredAt,
            entryId: entries.at(-1)!.id,
          }),
        } : {}),
      })
    },
  }

  return { activity, sessionBindings }
}

function taskActivitySql(importanceCount: number) {
  return `
    SELECT * FROM (
      SELECT 'event:' || events.id AS id, 'lifecycle' AS category,
        CASE WHEN events.event_type = 'work_item_state_changed' THEN 'milestones'
             WHEN events.event_type = 'work_item_updated' THEN 'detailed' ELSE 'progress' END AS importance,
        REPLACE(events.event_type, '_', ' ') AS summary, CAST(events.occurred_at AS INTEGER) AS occurred_at,
        events.actor_type, events.actor_id, 'event' AS source_type, events.id AS source_id
      FROM wg_v2_events events
      JOIN wg_v2_changes changes ON changes.organization_id = events.organization_id
        AND changes.owner_user_id = events.owner_user_id AND changes.operation_id = events.operation_id
      WHERE events.organization_id = @organization AND events.owner_user_id = @owner
        AND changes.resource_type = 'work_item' AND changes.resource_id = @workItem
      UNION ALL
      SELECT 'run:' || id || ':' || lifecycle, 'run',
        CASE WHEN lifecycle IN ('result', 'failed', 'cancelled') THEN 'milestones' ELSE 'progress' END,
        'Run ' || run_number || ' ' || lifecycle, CAST(updated_at AS INTEGER),
        'system', 'workgraph_runtime', 'run', id
      FROM wg_v2_runs WHERE organization_id = @organization AND owner_user_id = @owner AND work_item_id = @workItem
      UNION ALL
      SELECT 'checkpoint:' || id, 'checkpoint',
        CASE level WHEN 'milestone' THEN 'milestones' WHEN 'detail' THEN 'detailed' ELSE 'progress' END,
        summary, CAST(occurred_at AS INTEGER),
        COALESCE(json_extract(provenance_json, '$.actor.type'), 'agent'),
        COALESCE(json_extract(provenance_json, '$.actor.id'), 'workgraph_agent'), 'checkpoint', id
      FROM wg_v2_agent_checkpoints WHERE organization_id = @organization AND owner_user_id = @owner AND work_item_id = @workItem
      UNION ALL
      SELECT 'decision:' || decisions.id, 'decision', 'milestones', decisions.question,
        CAST(decisions.updated_at AS INTEGER),
        COALESCE(json_extract(decisions.proposed_by_json, '$.type'), 'agent'),
        COALESCE(json_extract(decisions.proposed_by_json, '$.id'), 'workgraph_agent'), 'decision', decisions.id
      FROM wg_v2_decisions decisions
      JOIN wg_v2_decision_work_items links ON links.organization_id = decisions.organization_id
        AND links.owner_user_id = decisions.owner_user_id AND links.decision_id = decisions.id
      WHERE decisions.organization_id = @organization AND decisions.owner_user_id = @owner AND links.work_item_id = @workItem
      UNION ALL
      SELECT 'evidence:' || id,
        CASE WHEN evidence_kind = 'integration' THEN 'external_effect' ELSE 'evidence' END,
        'milestones', summary, CAST(created_at AS INTEGER),
        COALESCE(json_extract(provenance_json, '$.actor.type'), 'agent'),
        COALESCE(json_extract(provenance_json, '$.actor.id'), 'workgraph_agent'), 'evidence', id
      FROM wg_v2_evidence WHERE organization_id = @organization AND owner_user_id = @owner
        AND ((subject_type = 'work_item' AND subject_id = @workItem) OR source_run_id IN (
          SELECT id FROM wg_v2_runs WHERE organization_id = @organization AND owner_user_id = @owner AND work_item_id = @workItem
        ))
      UNION ALL
      SELECT 'external_effect:' || receipts.id, 'external_effect', 'milestones', receipts.effect_kind,
        CAST(receipts.created_at AS INTEGER),
        COALESCE(json_extract(receipts.provenance_json, '$.actor.type'), 'system'),
        COALESCE(json_extract(receipts.provenance_json, '$.actor.id'), 'workgraph_runtime'),
        'external_effect', receipts.id
      FROM wg_v2_durable_effect_receipts receipts
      WHERE receipts.organization_id = @organization AND receipts.owner_user_id = @owner AND receipts.run_id IN (
        SELECT id FROM wg_v2_runs WHERE organization_id = @organization AND owner_user_id = @owner AND work_item_id = @workItem
      )
    ) activity
    WHERE importance IN (${Array.from({ length: importanceCount }, (_, index) => `@importance${index}`).join(", ")})
      AND (@cursorOccurredAt IS NULL OR occurred_at < @cursorOccurredAt
        OR (occurred_at = @cursorOccurredAt AND id < @cursorEntryId))
    ORDER BY occurred_at DESC, id DESC LIMIT @limit
  `
}

function allowedImportance(granularity: StreamActivityGranularity) {
  if (granularity === "milestones") return ["milestones"]
  if (granularity === "progress") return ["milestones", "progress"]
  return ["milestones", "progress", "detailed"]
}

function activityEntry(streamId: StreamID, workItemId: WorkItemID, row: ActivityRow): TaskActivityEntry {
  return TaskActivityEntrySchema.parse({
    id: row.id,
    streamId,
    workItemId,
    category: row.category,
    importance: row.importance,
    summary: row.summary,
    occurredAt: row.occurred_at,
    actor: { type: row.actor_type, id: row.actor_id },
    source: { type: row.source_type, id: row.source_id },
  })
}

function appendSqliteOwnedChange(
  database: Database,
  context: WorkGraphContext,
  input: Readonly<{
    operationId: string
    commandType: string
    eventType: string
    streamId: StreamID
    resource: Readonly<{ type: string; id: string }>
    payload: Record<string, unknown>
    request: unknown
    resultValue: unknown
    snapshotRelevant?: boolean
    occurredAt: number
  }>,
) {
  const cursorPosition = allocateSqliteChangeCursor(database, context, input.occurredAt)
  const cursor = createChangeCursor({
    organizationId: context.organizationId,
    ownerUserId: context.ownerUserId,
    position: cursorPosition,
  })
  database.prepare(`
    INSERT INTO wg_v2_operation_results
      (organization_id, owner_user_id, id, command_type, request_hash, result_status, result_json, change_cursor, created_at)
    VALUES (?, ?, ?, ?, ?, 200, ?, ?, ?)
  `).run(
    context.organizationId,
    context.ownerUserId,
    input.operationId,
    input.commandType,
    createHash("sha256").update(stableJson(input.request)).digest("hex"),
    JSON.stringify({ ok: true, operationId: input.operationId, cursor, value: input.resultValue }),
    cursorPosition,
    input.occurredAt,
  )
  const sequence = allocateActivitySequence(database, context, input.streamId, input.occurredAt)
  const payload = JSON.stringify({ ...input.payload, streamId: input.streamId })
  database.prepare(`
    INSERT INTO wg_v2_events
      (organization_id, owner_user_id, id, stream_id, sequence, schema_version, operation_id, event_type,
       actor_type, actor_id, request_id, payload_json, occurred_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    context.organizationId,
    context.ownerUserId,
    `event_${crypto.randomUUID()}`,
    input.streamId,
    sequence,
    input.operationId,
    input.eventType,
    context.actor.type,
    context.actor.id,
    context.requestId,
    payload,
    input.occurredAt,
  )
  database.prepare(`
    INSERT INTO wg_v2_changes
      (organization_id, owner_user_id, cursor, id, stream_id, operation_id, resource_type, resource_id,
       change_type, payload_json, snapshot_relevant, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    context.organizationId,
    context.ownerUserId,
    cursorPosition,
    `change_${crypto.randomUUID()}`,
    input.streamId,
    input.operationId,
    input.resource.type,
    input.resource.id,
    input.eventType,
    payload,
    input.snapshotRelevant ? 1 : 0,
    input.occurredAt,
  )
  return cursor
}

function allocateActivitySequence(
  database: Database,
  context: WorkGraphContext,
  streamId: StreamID,
  occurredAt: number,
) {
  database.prepare(`
    INSERT OR IGNORE INTO wg_v2_stream_sequences
      (organization_id, owner_user_id, stream_id, next_sequence, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
  `).run(context.organizationId, context.ownerUserId, streamId, occurredAt, occurredAt)
  const row = database.prepare(`
    SELECT next_sequence FROM wg_v2_stream_sequences
    WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
  `).get(context.organizationId, context.ownerUserId, streamId) as { next_sequence: number }
  database.prepare(`
    UPDATE wg_v2_stream_sequences SET next_sequence = next_sequence + 1, row_version = row_version + 1, updated_at = ?
    WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
  `).run(occurredAt, context.organizationId, context.ownerUserId, streamId)
  return row.next_sequence
}

function operationReplay(
  database: Database,
  context: WorkGraphContext,
  operationId: string,
  commandType: string,
  request: unknown,
) {
  const row = database.prepare(`
    SELECT command_type, request_hash, result_json FROM wg_v2_operation_results
    WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `).get(context.organizationId, context.ownerUserId, operationId) as
    | { command_type: string; request_hash: string; result_json: string }
    | undefined
  if (!row) return undefined
  if (row.command_type !== commandType || row.request_hash !== createHash("sha256").update(stableJson(request)).digest("hex")) {
    throw new WorkGraphSessionBindingError("conflict", "Operation ID already used")
  }
  const result = JSON.parse(row.result_json) as { ok?: unknown; value?: unknown }
  if (result.ok !== true || result.value === undefined) {
    throw new WorkGraphSessionBindingError("conflict", "Stored activity operation result is invalid")
  }
  return result.value
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`
  return JSON.stringify(value)
}

function ownerNeutral(value: SessionBindingDto | AgentCheckpointDto) {
  const { ownerUserId: _ownerUserId, ...result } = value
  return result
}

function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkGraphSessionBindingError("conflict", "Stored activity operation result is invalid")
  }
  return value
}

function requireBinding(database: Database, context: WorkGraphContext, bindingId: string) {
  const row = database.prepare(`
    SELECT * FROM wg_v2_session_bindings WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `).get(context.organizationId, context.ownerUserId, bindingId) as BindingRow | undefined
  if (!row) throw new WorkGraphSessionBindingError("not_found", "Session binding not found")
  return row
}

function requireCheckpoint(database: Database, context: WorkGraphContext, checkpointId: string) {
  const row = database.prepare(`
    SELECT * FROM wg_v2_agent_checkpoints WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `).get(context.organizationId, context.ownerUserId, checkpointId) as CheckpointRow | undefined
  if (!row) throw new WorkGraphSessionBindingError("not_found", "Agent checkpoint not found")
  return row
}

function bindingDto(context: WorkGraphContext, row: BindingRow): SessionBindingDto {
  return SessionBindingDtoSchema.parse({
    recordType: "session_binding",
    schemaVersion: 1,
    ownerUserId: context.ownerUserId,
    id: row.id,
    version: row.row_version,
    streamId: row.stream_id,
    sessionId: row.session_id,
    projectId: row.project_id,
    ...(row.current_work_item_id ? { currentWorkItemId: row.current_work_item_id } : {}),
    ...(row.current_run_id ? { currentRunId: row.current_run_id } : {}),
    state: row.state,
    boundAt: Number(row.bound_at),
    ...(row.released_at === null ? {} : { releasedAt: Number(row.released_at) }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    provenance: JSON.parse(row.provenance_json),
  })
}

function checkpointDto(context: WorkGraphContext, row: CheckpointRow): AgentCheckpointDto {
  return AgentCheckpointDtoSchema.parse({
    recordType: "agent_checkpoint",
    schemaVersion: 1,
    ownerUserId: context.ownerUserId,
    id: row.id,
    version: row.row_version,
    streamId: row.stream_id,
    workItemId: row.work_item_id,
    runId: row.run_id,
    sessionBindingId: row.session_binding_id,
    level: row.level,
    summary: row.summary,
    evidenceIds: JSON.parse(row.evidence_ids_json),
    occurredAt: Number(row.occurred_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    provenance: JSON.parse(row.provenance_json),
  })
}

function owned(database: Database, context: WorkGraphContext, table: string, id: string) {
  return database.prepare(`SELECT 1 FROM ${table} WHERE organization_id = ? AND owner_user_id = ? AND id = ?`)
    .get(context.organizationId, context.ownerUserId, id)
}

function requireOwner(context: WorkGraphContext) {
  if (context.access.mode !== "owner") throw new WorkGraphSessionBindingError("not_found", "Owner access is required")
}

type BindingRow = {
  id: string
  stream_id: StreamID
  session_id: string
  project_id: string
  current_work_item_id: WorkItemID | null
  current_run_id: RunID | null
  state: "active" | "released"
  bound_at: string | number
  released_at: string | number | null
  provenance_json: string
  row_version: number
  created_at: string | number
  updated_at: string | number
}

type CheckpointRow = {
  id: string
  stream_id: StreamID
  work_item_id: WorkItemID
  run_id: RunID
  session_binding_id: string
  level: "milestone" | "progress" | "detail"
  summary: string
  evidence_ids_json: string
  occurred_at: string | number
  provenance_json: string
  row_version: number
  created_at: string | number
  updated_at: string | number
}

type ActivityRow = {
  id: string
  category: TaskActivityEntry["category"]
  importance: TaskActivityEntry["importance"]
  summary: string
  occurred_at: number
  actor_type: TaskActivityEntry["actor"]["type"]
  actor_id: string
  source_type: TaskActivityEntry["source"]["type"]
  source_id: string
}
