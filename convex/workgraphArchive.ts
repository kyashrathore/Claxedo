import { v } from "convex/values"
import {
  WorkGraphArchiveSchema,
  createChangeCursor,
  hashWorkGraphArchive,
  readChangeCursor,
  validateWorkGraphArchive,
  type CanonicalWorkGraphArchive,
  type CanonicalWorkGraphArchiveRecord,
  type WorkGraphArchiveRestoreErrorReason,
} from "@claxedo/workgraph/contracts"
import { dependencyGraphHasCycle } from "@claxedo/workgraph/domain"
import { serviceMutation, serviceQuery } from "./model"
import { assertWorkGraphOwnerReadable, assertWorkGraphOwnerWritable, requireTrustedWorkGraphTenantSubject } from "./workgraphModel"
import { initializeAttentionProjection, syncAttentionRecord, syncCandidateTransition } from "./workgraphAttention"

const ROOT_ID = "workgraph_default"
const activeAttemptStates = new Set(["admitted", "placing", "running"])
const archiveTables = [
  "workgraphs",
  "work_sources",
  "work_source_revisions",
  "workgraph_source_views",
  "workgraph_intake_candidates",
  "workgraph_external_identities",
  "workgraph_streams",
  "workgraph_outcomes",
  "workgraph_work_items",
  "workgraph_work_item_dependencies",
  "workgraph_attempts",
  "workgraph_session_bindings",
  "workgraph_agent_checkpoints",
  "workgraph_decisions",
  "workgraph_decision_work_items",
  "workgraph_evidence",
  "workgraph_durable_effect_receipts",
  "workgraph_recaps",
  "workgraph_notifications",
  "workgraph_record_source_revisions",
  "workgraph_admission_proposals",
  "workgraph_operation_results",
  "workgraph_events",
  "workgraph_changes",
  "workgraph_runtime_effects",
  "workgraph_migration_intake",
  "workgraph_outbox",
  "workgraph_due_jobs",
] as const
const operationalTables = [
  "workgraph_attention_entries",
  "workgraph_attention_summaries",
  "workgraph_attempt_connection_bindings",
  "workgraph_leases",
  "workgraph_cleanup_receipts",
  "workgraph_stream_sequences",
  "workgraph_change_cursors",
] as const

export const exportForService = serviceQuery({
  args: { organization_id: v.id("orgs"), owner_subject: v.string(), exported_at: v.number() },
  handler: async (ctx, args) => {
    const tenant = await requireTrustedWorkGraphTenantSubject(ctx, args.service_token, args.organization_id, args.owner_subject)
    return exportWorkGraphArchive(ctx, String(tenant.organization_id), String(tenant.owner_user_id), args.owner_subject, args.exported_at)
  },
})

export const restoreForService = serviceMutation({
  args: { organization_id: v.id("orgs"), owner_subject: v.string(), operation_id: v.string(), archive_hash: v.string(), archive: v.any(), restored_at: v.number() },
  handler: async (ctx, args) => {
    const tenant = await requireTrustedWorkGraphTenantSubject(ctx, args.service_token, args.organization_id, args.owner_subject)
    return restoreWorkGraphArchive(ctx, String(tenant.organization_id), String(tenant.owner_user_id), args.owner_subject, args)
  },
})

export async function exportWorkGraphArchive(ctx: any, organization: string, owner: string, ownerSubject: string, exportedAt: number) {
  await assertWorkGraphOwnerReadable(ctx, organization, owner)
  if (await notQuiescent(ctx, organization, owner)) return rejected("not_quiescent")
  const rows = Object.fromEntries(await Promise.all(archiveTables.map(async (table) => [table, await ownedRows(ctx, table, organization, owner)]))) as Record<string, any[]>
  const records = (await Promise.all([
    ...rows.workgraphs.map((row) => record("workgraph", row.id, {
      ...publicBase(row), defaults: { execution: row.defaults, recap: row.recap_defaults },
    })),
    ...rows.work_sources.map((row) => record("work_source", row.id, {
      ...storedBase(row), workgraphId: row.workgraph_id, title: row.title, sourceKind: row.source_kind,
      metadata: row.metadata, latestRevisionId: row.latest_revision_id, revisionCount: row.latest_revision_number,
    })),
    ...rows.work_source_revisions.map((row) => record("work_source_revision", row.id, {
      schemaVersion: row.schema_version, workSourceId: row.work_source_id, revisionNumber: row.revision_number,
      content: row.content, contentHash: row.content_hash, origin: row.origin, createdAt: row.created_at, createdBy: row.created_by,
    })),
    ...rows.workgraph_source_views.map((row) => record("source_view", row.id, {
      ...storedBase(row), workgraphId: row.workgraph_id, teamConnectionId: row.team_connection_id,
      provider: row.provider, providerUserId: row.provider_user_id, filters: row.filters,
      syncPolicy: row.sync_policy, status: row.status,
    })),
    ...rows.workgraph_intake_candidates.map((row) => record("intake_candidate", row.id, candidateValue(row))),
    ...rows.workgraph_external_identities.map((row) => record("external_identity", row.id, {
      schemaVersion: row.schema_version, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.intake_candidate_id ? { intakeCandidateId: row.intake_candidate_id } : {}), provider: row.provider,
      teamConnectionId: row.team_connection_id, externalId: row.external_id,
      ...(row.external_key ? { externalKey: row.external_key } : {}), ...(row.external_url ? { externalUrl: row.external_url } : {}),
      ...(row.observed_revision ? { observedRevision: row.observed_revision } : {}), metadata: row.metadata,
    })),
    ...rows.workgraph_streams.map(async (row) => record("stream", row.id, {
      ...publicBase(row), workgraphId: row.workgraph_id, title: row.title,
      ...(row.description === undefined ? {} : { description: row.description }), lifecycleState: row.lifecycle_state,
      visibility: row.visibility, pinned: row.pinned, executionDefaults: row.execution_defaults, recapDefaults: row.recap_defaults,
      activityGranularity: row.activity_granularity ?? "progress",
      ...(row.memory === undefined ? {} : { memory: row.memory }), activity: row.activity,
      ...(row.envelope === undefined ? {} : { envelope: row.envelope }),
      ...(row.replacement_reset === undefined ? {} : { replacementReset: row.replacement_reset }),
      durableEffectCount: rows.workgraph_durable_effect_receipts.filter((receipt) => receipt.stream_id === row.id).length,
      sourceRevisionRefs: refs(row.source_revision_refs),
    })),
    ...rows.workgraph_outcomes.map((row) => record("outcome", row.id, {
      ...publicBase(row), streamId: row.stream_id, title: row.title,
      ...(row.description === undefined ? {} : { description: row.description }), state: row.state,
      successCriteria: row.success_criteria, evidenceIds: row.evidence_ids,
      ...(row.execution_defaults === undefined ? {} : { executionDefaults: row.execution_defaults }),
      sourceRevisionRefs: refs(row.source_revision_refs), ...(row.closed_at === undefined ? {} : { closedAt: row.closed_at }),
      ...(row.ready_to_close_at === undefined ? {} : { readyToCloseAt: row.ready_to_close_at }),
      ...(row.closed_by === undefined ? {} : { closedBy: row.closed_by }), ...(row.close_reason === undefined ? {} : { closeReason: row.close_reason }),
      ...(row.reopened_at === undefined ? {} : { reopenedAt: row.reopened_at }), ...(row.reopen_reason === undefined ? {} : { reopenReason: row.reopen_reason }),
    })),
    ...rows.workgraph_work_items.map((row) => record("work_item", row.id, {
      ...publicBase(row), streamId: row.stream_id, ...(row.outcome_id ? { outcomeId: row.outcome_id } : {}), title: row.title,
      ...(row.description === undefined ? {} : { description: row.description }), state: row.state, priority: row.priority,
      dependencyIds: rows.workgraph_work_item_dependencies.filter((dependency) => dependency.work_item_id === row.id).map((dependency) => dependency.depends_on_work_item_id).sort(),
      sourceRevisionRefs: refs(row.source_revision_refs), completionContract: row.completion_contract, evidenceIds: row.evidence_ids,
      ...(row.execution_defaults === undefined ? {} : { executionDefaults: row.execution_defaults }),
      ...(row.completed_at === undefined ? {} : { completedAt: row.completed_at }),
      ...(row.abandoned_at === undefined ? {} : { abandonedAt: row.abandoned_at }),
      ...(row.abandon_reason === undefined ? {} : { abandonReason: row.abandon_reason }),
    })),
    ...rows.workgraph_work_item_dependencies.map((row) => record("work_item_dependency", row.id, {
      schemaVersion: row.schema_version, createdAt: row.created_at, workItemId: row.work_item_id,
      dependsOnWorkItemId: row.depends_on_work_item_id, dependencyKind: row.dependency_kind,
    })),
    ...rows.workgraph_attempts.map((row) => record("attempt", row.id, {
      ...publicBase(row), streamId: row.stream_id, workItemId: row.work_item_id, attemptNumber: row.attempt_number,
      state: row.state, resolvedExecution: row.resolved_execution, admittedAt: row.admitted_at,
      executionKind: row.execution_kind ?? "managed",
      ...(row.started_at === undefined ? {} : { startedAt: row.started_at }), ...(row.finished_at === undefined ? {} : { finishedAt: row.finished_at }),
      ...(row.result === undefined ? {} : { result: row.result }), ...(row.attention_reason === undefined ? {} : { attentionReason: row.attention_reason }),
      ...(row.envelope_id || row.child_workspace_id || row.session_id ? { executionIdentity: {
        ...(row.envelope_id ? { envelopeId: row.envelope_id } : {}),
        ...(row.child_workspace_id ? { childIsolationId: row.child_workspace_id } : {}),
        ...(row.session_id ? { sessionId: row.session_id } : {}),
      } } : {}),
      sourceRevisionRefs: refs(row.source_revision_refs),
    })),
    ...rows.workgraph_session_bindings.map((row) => record("session_binding", row.id, {
      ...publicBase(row), streamId: row.stream_id, sessionId: row.session_id, projectId: row.project_id,
      ...(row.current_work_item_id === undefined ? {} : { currentWorkItemId: row.current_work_item_id }),
      ...(row.current_attempt_id === undefined ? {} : { currentAttemptId: row.current_attempt_id }),
      state: row.state, boundAt: row.bound_at,
      ...(row.released_at === undefined ? {} : { releasedAt: row.released_at }),
    })),
    ...rows.workgraph_agent_checkpoints.map((row) => record("agent_checkpoint", row.id, {
      ...publicBase(row), streamId: row.stream_id, workItemId: row.work_item_id, attemptId: row.attempt_id,
      sessionBindingId: row.session_binding_id, level: row.level, summary: row.summary,
      evidenceIds: row.evidence_ids, occurredAt: row.occurred_at,
    })),
    ...rows.workgraph_decisions.map((row) => record("decision", row.id, {
      ...publicBase(row), streamId: row.stream_id, state: row.state, proposedBy: row.provenance?.actor,
      question: row.question, options: row.options,
      ...(row.recommendation_option_id === undefined ? {} : { recommendationOptionId: row.recommendation_option_id }),
      ...(row.rationale === undefined ? {} : { rationale: row.rationale }),
      affectedWorkItemIds: rows.workgraph_decision_work_items.filter((link) => link.decision_id === row.id).map((link) => link.work_item_id).sort(),
      sourceRevisionRefs: refs(row.source_revision_refs), ...(row.answer === undefined ? {} : { answer: row.answer }),
      ...(row.dismissed_at === undefined ? {} : { dismissedAt: row.dismissed_at }),
      ...(row.dismiss_reason === undefined ? {} : { dismissReason: row.dismiss_reason }),
    })),
    ...rows.workgraph_decision_work_items.map((row) => record("decision_work_item", row.id, {
      schemaVersion: row.schema_version, createdAt: row.created_at, decisionId: row.decision_id, workItemId: row.work_item_id,
    })),
    ...rows.workgraph_evidence.map((row) => record("evidence", row.id, evidenceValue(row, rows.workgraph_durable_effect_receipts))),
    ...rows.workgraph_durable_effect_receipts.map((row) => record("durable_effect_receipt", row.id, {
      schemaVersion: row.schema_version, createdAt: row.created_at, streamId: row.stream_id,
      ...(row.attempt_id ? { attemptId: row.attempt_id } : {}), effectKind: row.effect_kind,
      idempotencyKey: row.idempotency_key, externalReference: row.external_reference, provenance: cleanProvenance(row.provenance),
    })),
    ...rows.workgraph_recaps.map((row) => record("recap", row.id, {
      ...publicBase({ ...row, row_version: 1, updated_at: row.created_at }), streamId: row.stream_id,
      ...(row.previous_recap_id ? { previousRecapId: row.previous_recap_id } : {}), activityRange: row.activity_range,
      summary: row.summary, actionableReferences: row.actionable_references, generation: row.generation,
      sourceRevisionRefs: refs(row.source_revision_refs),
    })),
    ...rows.workgraph_notifications.map((row) => record("notification", row.id, {
      schemaVersion: row.schema_version, version: row.row_version, kind: row.notification_kind, state: row.state,
      streamId: row.stream_id, recapId: row.recap_id, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.read_at === undefined ? {} : { readAt: row.read_at }),
    })),
    ...rows.workgraph_record_source_revisions.map((row) => record("record_source_revision", row.id, {
      schemaVersion: row.schema_version, createdAt: row.created_at, recordType: row.record_type, recordId: row.record_id,
      workSourceId: row.work_source_id, sourceRevisionId: row.source_revision_id, ordinal: row.ordinal,
    })),
    ...rows.workgraph_admission_proposals.map((row) => record("admission_proposal", row.id, proposalValue(row, organization, owner))),
    ...rows.workgraph_operation_results.map((row) => record("operation_result", row.id, {
      schemaVersion: row.schema_version, createdAt: row.created_at, commandType: row.command_type,
      requestHash: row.request_hash, resultStatus: row.result_status,
      result: row.change_cursor === undefined
        ? row.result
        : { ...row.result, cursor: createChangeCursor({ organizationId: organization, ownerUserId: owner, position: row.change_cursor }) },
      ...(row.change_cursor === undefined ? {} : {
        changeCursor: createChangeCursor({ organizationId: organization, ownerUserId: owner, position: row.change_cursor }),
      }),
    })),
    ...rows.workgraph_events.map((row) => record("event", row.id, {
      schemaVersion: row.schema_version, ...(row.stream_id ? { streamId: row.stream_id } : {}), sequence: row.sequence,
      type: row.event_type, payload: row.payload,
      provenance: {
        actor: { type: row.actor_type, id: row.actor_id }, operationId: row.operation_id,
        requestId: row.request_id, ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
        ...(row.causation_id ? { causationId: row.causation_id } : {}),
      }, occurredAt: row.occurred_at,
    })),
    ...rows.workgraph_changes.map(async (row) => {
      const event = row.event_id
        ? rows.workgraph_events.find((entry) => entry.id === row.event_id)
        : exactlyOne(rows.workgraph_events.filter((entry) => entry.operation_id === row.operation_id))
      return record("change", row.id, {
        schemaVersion: row.schema_version,
        cursor: createChangeCursor({ organizationId: organization, ownerUserId: owner, position: row.cursor }),
        eventId: event?.id,
        operationId: row.operation_id, ...(row.stream_id ? { streamId: row.stream_id } : {}),
        resource: { type: row.resource_type, id: row.resource_id }, changeType: row.change_type,
        payload: row.payload, createdAt: row.created_at,
      })
    }),
    ...rows.workgraph_runtime_effects.map((row) => record("runtime_effect", row.id, {
      schemaVersion: row.schema_version, effectKind: row.effect_kind, resourceType: row.resource_type,
      resourceId: row.resource_id, idempotencyKey: row.idempotency_key, payload: row.payload, state: row.state,
      attemptCount: row.attempt_count, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
    })),
    ...rows.workgraph_migration_intake.map((row) => record("migration_intake", row.id, {
      ...storedBase(row), legacyTable: row.legacy_table, legacyRecordId: row.legacy_record_id,
      intakeKind: row.intake_kind, reason: row.reason, rawReference: row.raw_reference,
      status: row.status, ...(row.resolution === undefined ? {} : { resolution: row.resolution }),
    })),
    ...rows.workgraph_outbox.map((row) => record("completed_external_effect", row.id, {
      schemaVersion: row.schema_version, operationId: row.operation_id, effectType: row.effect_type,
      idempotencyKey: row.idempotency_key, payload: row.payload, status: "completed",
      availableAt: row.available_at, attemptCount: row.attempt_count, createdAt: row.created_at, updatedAt: row.updated_at,
    })),
    ...rows.workgraph_due_jobs.map((row) => record("terminal_scheduled_job", row.id, {
      schemaVersion: row.schema_version, version: row.row_version, ...(row.stream_id ? { streamId: row.stream_id } : {}),
      jobType: row.job_type, subjectId: row.subject_id, dueAt: row.due_at, status: terminalJobStatus(row),
      payload: row.payload, leaseEpoch: row.lease_epoch, createdAt: row.created_at, updatedAt: row.updated_at,
    })),
  ])).sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
  const parsed = WorkGraphArchiveSchema.safeParse({ version: 1, organizationId: organization, ownerUserId: ownerSubject, exportedAt, records })
  if (!parsed.success) return rejected("target_incompatible")
  return { ok: true as const, archive: parsed.data }
}

export async function restoreWorkGraphArchive(
  ctx: any,
  organization: string,
  owner: string,
  ownerSubject: string,
  input: { operation_id: string; archive_hash: string; archive: unknown; restored_at: number },
) {
  await assertWorkGraphOwnerWritable(ctx, organization, owner)
  const validated = await validate(input.archive)
  if (!validated.ok) return validated
  if (validated.archive.organizationId !== organization || validated.archive.ownerUserId !== ownerSubject) return rejected("cross_owner")
  if (await hashWorkGraphArchive(validated.archive) !== input.archive_hash) return rejected("malformed")
  const replay = await ctx.db.query("workgraph_archive_restores")
    .withIndex("by_tenant", (query: any) => query.eq("organization_id", organization).eq("owner_user_id", owner))
    .filter((query: any) => query.eq(query.field("operation_id"), input.operation_id)).unique()
  if (replay) return replay.archive_hash === input.archive_hash
    ? { ok: true as const, result: replay.result }
    : rejected("idempotency_conflict")
  if (await notQuiescent(ctx, organization, owner)) return rejected("not_quiescent")
  if (await ownerHasRows(ctx, organization, owner)) return rejected("non_empty")
  const references = await validateReferences(ctx, organization, owner, validated.archive)
  if (!references.ok) return references
  await initializeAttentionProjection(ctx, organization, owner, input.restored_at)
  for (const record of validated.archive.records) {
    await insertRecord(ctx, organization, owner, record, references.connectionOrgs, references.subjectStreams)
    await syncRestoredAttention(ctx, organization, owner, record)
  }
  const events = validated.archive.records.filter((record) => record.kind === "event")
  const sequences = new Map<string, number>()
  events.forEach((record) => {
    const scope = String(record.value.streamId ?? "__workgraph_owner__")
    sequences.set(scope, Math.max(sequences.get(scope) ?? 0, Number(record.value.sequence)))
  })
  for (const [streamId, sequence] of sequences) await ctx.db.insert("workgraph_stream_sequences", {
    organization_id: organization, owner_user_id: owner, stream_id: streamId, next_sequence: sequence + 1, row_version: 1, schema_version: 1,
    created_at: input.restored_at, updated_at: input.restored_at,
  })
  const baseline = Math.max(0, ...validated.archive.records.filter((record) => record.kind === "change").map((record) =>
    readChangeCursor(String(record.value.cursor), organization, owner)))
  await ctx.db.insert("workgraph_change_cursors", {
    organization_id: organization, owner_user_id: owner, next_cursor: baseline + 1, row_version: 1, schema_version: 1,
    created_at: input.restored_at, updated_at: input.restored_at,
  })
  const result = {
    restored: true as const,
    recordCount: validated.archive.records.length,
    baselineCursor: createChangeCursor({ organizationId: organization, ownerUserId: owner, position: baseline }),
  }
  await ctx.db.insert("workgraph_archive_restores", {
    organization_id: organization, owner_user_id: owner, operation_id: input.operation_id, archive_hash: input.archive_hash,
    result, schema_version: 1, created_at: input.restored_at,
  })
  return { ok: true as const, result }
}

async function syncRestoredAttention(ctx: any, organization: string, owner: string, record: any) {
  const tables: Record<string, string> = {
    intake_candidate: "workgraph_intake_candidates",
    work_item: "workgraph_work_items",
    attempt: "workgraph_attempts",
    decision: "workgraph_decisions",
    notification: "workgraph_notifications",
    admission_proposal: "workgraph_admission_proposals",
    terminal_scheduled_job: "workgraph_due_jobs",
  }
  const table = tables[record.kind]
  if (!table) return
  const row = await ctx.db.query(table).withIndex("by_tenant", (query: any) => query.eq("organization_id", organization).eq("owner_user_id", owner))
    .filter((query: any) => query.eq(query.field("id"), record.id)).unique()
  if (!row) throw new Error(`Restored Attention source ${record.kind}:${record.id} is missing`)
  if (table === "workgraph_intake_candidates") return syncCandidateTransition(ctx, undefined, row)
  return syncAttentionRecord(ctx, table, row)
}

async function notQuiescent(ctx: any, organization: string, owner: string) {
  const [attempts, leases, bindings, outbox, jobs, streams, proposals] = await Promise.all([
    ownedRows(ctx, "workgraph_attempts", organization, owner), ownedRows(ctx, "workgraph_leases", organization, owner),
    ownedRows(ctx, "workgraph_attempt_connection_bindings", organization, owner), ownedRows(ctx, "workgraph_outbox", organization, owner),
    ownedRows(ctx, "workgraph_due_jobs", organization, owner), ownedRows(ctx, "workgraph_streams", organization, owner),
    ownedRows(ctx, "workgraph_admission_proposals", organization, owner),
  ])
  return attempts.some((row: any) => activeAttemptStates.has(row.state)) || leases.length > 0 || bindings.some((row: any) => row.revoked_at === undefined)
    || outbox.some((row: any) => row.status !== "completed") || jobs.some((row: any) => !terminalJobStatus(row))
    || streams.some((row: any) => row.deletion?.state === "pending" || row.closure?.state === "pending")
    || streams.some((row: any) => row.envelope && row.envelope.status !== "destroyed")
    || streams.some((row: any) => row.replacement_reset && row.replacement_reset.state !== "completed")
    || proposals.some((row: any) => row.state === "planning")
}

async function ownerHasRows(ctx: any, organization: string, owner: string) {
  for (const table of [...archiveTables, ...operationalTables]) {
    if ((await ownedRows(ctx, table, organization, owner)).length) return true
  }
  return false
}

async function validateReferences(ctx: any, organization: string, owner: string, archive: CanonicalWorkGraphArchive) {
  const ids = new Map<string, Set<string>>()
  archive.records.forEach((record) => {
    const values = ids.get(record.kind) ?? new Set<string>()
    values.add(record.id)
    ids.set(record.kind, values)
  })
  const has = (kind: string, id: unknown) => typeof id === "string" && ids.get(kind)?.has(id)
  const connectionOrgs = new Map<string, string>()
  const subjectStreams = new Map<string, string>([
    ...archive.records.filter((record) => record.kind === "stream").map((record) => [record.id, record.id] as const),
    ...archive.records.filter((record) => record.kind === "outcome").map((record) => [record.id, String(record.value.streamId)] as const),
    ...archive.records.filter((record) => record.kind === "work_item").map((record) => [record.id, String(record.value.streamId)] as const),
  ])
  if (archive.records.length === 0) return { ok: true as const, connectionOrgs, subjectStreams }
  if (ids.get("workgraph")?.size !== 1 || !has("workgraph", ROOT_ID)) return rejected("malformed")
  const revisions = new Map(archive.records.filter((record) => record.kind === "work_source_revision").map((record) => [record.id, record]))
  const events = new Map(archive.records.filter((record) => record.kind === "event").map((record) => [record.id, record]))
  const validRef = (value: any) => {
    const revision = revisions.get(value?.revisionId)
    if (!revision) return false
    return revision.value.workSourceId === value?.workSourceId && revision.value.contentHash === value?.contentHash
  }
  const dependencyLinks = archive.records.filter((record) => record.kind === "work_item_dependency")
  const decisionLinks = archive.records.filter((record) => record.kind === "decision_work_item")
  const workItems = archive.records.filter((record) => record.kind === "work_item")
  const workItemStreams = new Map(workItems.map((record) => [record.id, String(record.value.streamId)]))
  if (dependencyLinks.some((record) =>
    workItemStreams.get(record.value.workItemId) !== workItemStreams.get(record.value.dependsOnWorkItemId))) {
    return rejected("malformed")
  }
  if (dependencyGraphHasCycle(workItems.map((record) => ({
    id: record.id,
    dependencyIds: record.value.dependencyIds,
  })))) {
    return rejected("malformed")
  }
  const sequences = new Set<string>()
  const cursors = new Set<number>()
  for (const record of archive.records) {
    const value: any = record.value
    if (record.kind === "work_source") {
      const ownedRevisions = [...revisions.values()].filter((revision) => revision.value.workSourceId === record.id)
      const latest = revisions.get(value.latestRevisionId)
      if (!latest || !has("workgraph", value.workgraphId) || latest.value.workSourceId !== record.id || latest.value.revisionNumber !== value.revisionCount || ownedRevisions.length !== value.revisionCount) return rejected("malformed")
    }
    if (record.kind === "work_source_revision" && !has("work_source", value.workSourceId)) return rejected("malformed")
    if (record.kind === "source_view" && !has("workgraph", value.workgraphId)) return rejected("malformed")
    if (record.kind === "intake_candidate" && (
      !has("workgraph", value.workgraphId) ||
      (value.candidateKind === "external_issue" && !has("source_view", value.sourceViewId)) ||
      (value.source && !validRef(value.source)) ||
      (value.admissionProposalId && !has("admission_proposal", value.admissionProposalId))
    )) return rejected("malformed")
    if (record.kind === "external_identity" && value.intakeCandidateId && !has("intake_candidate", value.intakeCandidateId)) return rejected("malformed")
    if (record.kind === "stream") {
      if (!has("workgraph", value.workgraphId) || !value.sourceRevisionRefs.every(validRef)) return rejected("malformed")
      if (value.replacementReset) {
        if (value.replacementReset.state !== "completed") return rejected("not_quiescent")
        if (!has("admission_proposal", value.replacementReset.proposalId) ||
          !validRef(value.replacementReset.previousSource) || !validRef(value.replacementReset.source)) return rejected("malformed")
        if (![value.replacementReset.previousSource, value.replacementReset.source].every((reference) =>
          value.sourceRevisionRefs.some((source: any) => source.workSourceId === reference.workSourceId &&
            source.revisionId === reference.revisionId && source.contentHash === reference.contentHash))) return rejected("malformed")
      }
    }
    if (record.kind === "outcome" && (!has("stream", value.streamId) || !value.evidenceIds.every((id: string) => has("evidence", id)) || !value.sourceRevisionRefs.every(validRef))) return rejected("malformed")
    if (record.kind === "work_item") {
      const linked = dependencyLinks.filter((link) => link.value.workItemId === record.id).map((link) => link.value.dependsOnWorkItemId).sort()
      if (!has("stream", value.streamId) || (value.outcomeId && !has("outcome", value.outcomeId)) || !value.dependencyIds.every((id: string) => has("work_item", id)) || !value.evidenceIds.every((id: string) => has("evidence", id)) || !value.sourceRevisionRefs.every(validRef) || JSON.stringify([...value.dependencyIds].sort()) !== JSON.stringify(linked)) return rejected("malformed")
    }
    if (record.kind === "work_item_dependency" && (!has("work_item", value.workItemId) || !has("work_item", value.dependsOnWorkItemId))) return rejected("malformed")
    if (record.kind === "attempt" && (!has("stream", value.streamId) || !has("work_item", value.workItemId) || !value.sourceRevisionRefs.every(validRef))) return rejected("malformed")
    if (record.kind === "session_binding" && (!has("stream", value.streamId) ||
      (value.currentWorkItemId && !has("work_item", value.currentWorkItemId)) ||
      (value.currentAttemptId && !has("attempt", value.currentAttemptId)))) return rejected("malformed")
    if (record.kind === "agent_checkpoint" && (!has("stream", value.streamId) || !has("work_item", value.workItemId) ||
      !has("attempt", value.attemptId) || !has("session_binding", value.sessionBindingId) ||
      !value.evidenceIds.every((id: string) => has("evidence", id)))) return rejected("malformed")
    if (record.kind === "decision") {
      const linked = decisionLinks.filter((link) => link.value.decisionId === record.id).map((link) => link.value.workItemId).sort()
      if (!has("stream", value.streamId) || JSON.stringify(value.proposedBy) !== JSON.stringify(value.provenance.actor) || !value.affectedWorkItemIds.every((id: string) => has("work_item", id)) || !value.sourceRevisionRefs.every(validRef) || JSON.stringify([...value.affectedWorkItemIds].sort()) !== JSON.stringify(linked)) return rejected("malformed")
    }
    if (record.kind === "decision_work_item" && (!has("decision", value.decisionId) || !has("work_item", value.workItemId))) return rejected("malformed")
    if (record.kind === "durable_effect_receipt" && (!has("stream", value.streamId) || (value.attemptId && !has("attempt", value.attemptId)))) return rejected("malformed")
    if (record.kind === "recap" && (!has("stream", value.streamId) || (value.previousRecapId && !has("recap", value.previousRecapId)) || !value.sourceRevisionRefs.every(validRef))) return rejected("malformed")
    if (record.kind === "notification" && (!has("stream", value.streamId) || !has("recap", value.recapId))) return rejected("malformed")
    if (record.kind === "record_source_revision" && (!has("work_source", value.workSourceId) || !has("work_source_revision", value.sourceRevisionId) || !has(value.recordType, value.recordId))) return rejected("malformed")
    if (record.kind === "admission_proposal" && (!has("workgraph", value.workgraphId) || !validRef(value.source) || (value.previousSource && !validRef(value.previousSource)) || (value.intakeCandidateId && !has("intake_candidate", value.intakeCandidateId)))) return rejected("malformed")
    if (record.kind === "event") {
      const key = `${value.streamId ?? "__workgraph_owner__"}:${value.sequence}`
      if (sequences.has(key)) return rejected("malformed")
      sequences.add(key)
    }
    if (record.kind === "change") {
      const cursor = readArchiveChangeCursor(value.cursor, organization, owner)
      const event = events.get(value.eventId)
      if (cursor === undefined || !event || cursors.has(cursor) || event.value.provenance.operationId !== value.operationId || event.value.type !== value.changeType) return rejected("malformed")
      cursors.add(cursor)
    }
  }
  for (const record of archive.records.filter((entry) => entry.kind === "source_view" || entry.kind === "external_identity")) {
    const value: any = record.value
    const candidates = await ctx.db.query("workgraph_connection_metadata")
      .withIndex("by_connection", (query: any) => query.eq("connection_id", value.teamConnectionId)).collect()
    const eligible = []
    for (const candidate of candidates) {
      const membership = await ctx.db.query("org_memberships")
        .withIndex("by_org_user", (query: any) => query.eq("org_id", candidate.organization_id).eq("user_id", owner)).unique()
      if (membership && String(candidate.organization_id) === organization && candidate.status === "connected" && candidate.capabilities.includes("work-source") && providerMatches(value.provider, candidate.integration_id)) eligible.push(candidate)
    }
    if (eligible.length !== 1) return rejected("dependency_unavailable")
    if (record.kind === "source_view") connectionOrgs.set(record.id, eligible[0].organization_id)
  }
  const attempts = new Map(archive.records.filter((record) => record.kind === "attempt").map((record) => [record.id, record.value]))
  const bindings = new Map(archive.records.filter((record) => record.kind === "session_binding").map((record) => [record.id, record.value]))
  for (const record of archive.records.filter((entry) => entry.kind === "session_binding")) {
    if (record.value.currentWorkItemId && subjectStreams.get(record.value.currentWorkItemId) !== record.value.streamId) return rejected("malformed")
    if (record.value.currentAttemptId && attempts.get(record.value.currentAttemptId)?.workItemId !== record.value.currentWorkItemId) return rejected("malformed")
  }
  for (const record of archive.records.filter((entry) => entry.kind === "agent_checkpoint")) {
    if (subjectStreams.get(record.value.workItemId) !== record.value.streamId ||
      attempts.get(record.value.attemptId)?.workItemId !== record.value.workItemId ||
      bindings.get(record.value.sessionBindingId)?.streamId !== record.value.streamId) return rejected("malformed")
  }
  for (const record of archive.records.filter((entry) => entry.kind === "evidence")) {
    const value: any = record.value
    if (!subjectStreams.has(subjectId(value.subject)) || (value.sourceAttemptId && !has("attempt", value.sourceAttemptId)) || (value.durableEffectReceiptId && !has("durable_effect_receipt", value.durableEffectReceiptId))) return rejected("malformed")
  }
  return { ok: true as const, connectionOrgs, subjectStreams }
}

async function insertRecord(ctx: any, organization: string, owner: string, record: CanonicalWorkGraphArchiveRecord, connectionOrgs: Map<string, string>, subjectStreams: Map<string, string>) {
  const value: any = record.value
  if (record.kind === "workgraph") return ctx.db.insert("workgraphs", { organization_id: organization, owner_user_id: owner, id: record.id, defaults: value.defaults.execution, recap_defaults: value.defaults.recap, provenance: value.provenance, ...physicalBase(value) })
  if (record.kind === "work_source") return ctx.db.insert("work_sources", { organization_id: organization, owner_user_id: owner, id: record.id, workgraph_id: value.workgraphId, title: value.title, source_kind: value.sourceKind, metadata: value.metadata, latest_revision_id: value.latestRevisionId, latest_revision_number: value.revisionCount, ...physicalBase(value) })
  if (record.kind === "work_source_revision") return ctx.db.insert("work_source_revisions", { organization_id: organization, owner_user_id: owner, id: record.id, work_source_id: value.workSourceId, revision_number: value.revisionNumber, content: value.content, content_hash: value.contentHash, origin: value.origin, created_by: value.createdBy, schema_version: value.schemaVersion, created_at: value.createdAt })
  if (record.kind === "source_view") {
    if (connectionOrgs.get(record.id) !== organization) throw new Error("Source View Connection organization mismatch")
    return ctx.db.insert("workgraph_source_views", { organization_id: organization, owner_user_id: owner, id: record.id, workgraph_id: value.workgraphId, team_connection_id: value.teamConnectionId, provider: value.provider, provider_user_id: value.providerUserId, filters: value.filters, sync_policy: value.syncPolicy, status: value.status, ...physicalBase(value) })
  }
  if (record.kind === "intake_candidate") return ctx.db.insert("workgraph_intake_candidates", { organization_id: organization, owner_user_id: owner, id: record.id, workgraph_id: value.workgraphId, ...(value.sourceViewId ? { source_view_id: value.sourceViewId } : {}), candidate_kind: value.candidateKind, title: value.title, body: value.body, normalized: candidateNormalized(value), status: value.state, ...(value.observedRevision ? { observed_revision: value.observedRevision } : {}), ...physicalBase(value) })
  if (record.kind === "external_identity") return ctx.db.insert("workgraph_external_identities", { organization_id: organization, owner_user_id: owner, id: record.id, ...(value.intakeCandidateId ? { intake_candidate_id: value.intakeCandidateId } : {}), provider: value.provider, team_connection_id: value.teamConnectionId, external_id: value.externalId, ...(value.externalKey ? { external_key: value.externalKey } : {}), ...(value.externalUrl ? { external_url: value.externalUrl } : {}), ...(value.observedRevision ? { observed_revision: value.observedRevision } : {}), metadata: value.metadata, schema_version: value.schemaVersion, created_at: value.createdAt, updated_at: value.updatedAt })
  if (record.kind === "stream") return ctx.db.insert("workgraph_streams", { organization_id: organization, owner_user_id: owner, id: record.id, workgraph_id: value.workgraphId, title: value.title, ...(value.description === undefined ? {} : { description: value.description }), lifecycle_state: value.lifecycleState, visibility: value.visibility, pinned: value.pinned, execution_defaults: value.executionDefaults, recap_defaults: value.recapDefaults, activity_granularity: value.activityGranularity, ...(value.memory ? { memory: value.memory } : {}), activity: value.activity, recap_due_at: value.activity.recapDueAt, ...(value.envelope ? { envelope: value.envelope } : {}), ...(value.replacementReset ? { replacement_reset: value.replacementReset } : {}), last_activity_at: value.activity.lastActivityAt, durable_effect_count: value.durableEffectCount, source_revision_refs: snakeRefs(value.sourceRevisionRefs), provenance: value.provenance, ...physicalBase(value) })
  if (record.kind === "outcome") return ctx.db.insert("workgraph_outcomes", { organization_id: organization, owner_user_id: owner, id: record.id, stream_id: value.streamId, title: value.title, ...(value.description === undefined ? {} : { description: value.description }), state: value.state, success_criteria: value.successCriteria, evidence_ids: value.evidenceIds, ...(value.executionDefaults ? { execution_defaults: value.executionDefaults } : {}), source_revision_refs: snakeRefs(value.sourceRevisionRefs), ...(value.readyToCloseAt === undefined ? {} : { ready_to_close_at: value.readyToCloseAt }), ...(value.closedAt === undefined ? {} : { closed_at: value.closedAt }), ...(value.closedBy ? { closed_by: value.closedBy } : {}), ...(value.closeReason ? { close_reason: value.closeReason } : {}), ...(value.reopenedAt === undefined ? {} : { reopened_at: value.reopenedAt }), ...(value.reopenReason ? { reopen_reason: value.reopenReason } : {}), provenance: value.provenance, ...physicalBase(value) })
  if (record.kind === "work_item") return ctx.db.insert("workgraph_work_items", { organization_id: organization, owner_user_id: owner, id: record.id, stream_id: value.streamId, ...(value.outcomeId ? { outcome_id: value.outcomeId } : {}), title: value.title, ...(value.description === undefined ? {} : { description: value.description }), state: value.state, priority: value.priority, source_revision_refs: snakeRefs(value.sourceRevisionRefs), completion_contract: value.completionContract, evidence_ids: value.evidenceIds, ...(value.executionDefaults ? { execution_defaults: value.executionDefaults } : {}), ...(value.completedAt === undefined ? {} : { completed_at: value.completedAt }), ...(value.abandonedAt === undefined ? {} : { abandoned_at: value.abandonedAt }), ...(value.abandonReason ? { abandon_reason: value.abandonReason } : {}), provenance: value.provenance, ...physicalBase(value) })
  if (record.kind === "work_item_dependency") return ctx.db.insert("workgraph_work_item_dependencies", { organization_id: organization, owner_user_id: owner, id: record.id, work_item_id: value.workItemId, stream_id: subjectStreams.get(value.workItemId), depends_on_work_item_id: value.dependsOnWorkItemId, dependency_kind: value.dependencyKind, schema_version: value.schemaVersion, created_at: value.createdAt })
  if (record.kind === "attempt") return ctx.db.insert("workgraph_attempts", { organization_id: organization, owner_user_id: owner, id: record.id, stream_id: value.streamId, work_item_id: value.workItemId, attempt_number: value.attemptNumber, state: value.state, execution_kind: value.executionKind, resolved_execution: value.resolvedExecution, admitted_at: value.admittedAt, ...(value.startedAt === undefined ? {} : { started_at: value.startedAt }), ...(value.finishedAt === undefined ? {} : { finished_at: value.finishedAt }), ...(value.result ? { result: value.result } : {}), ...(value.attentionReason ? { attention_reason: value.attentionReason } : {}), ...(value.executionIdentity?.envelopeId ? { envelope_id: value.executionIdentity.envelopeId } : {}), ...(value.executionIdentity?.childIsolationId ? { child_workspace_id: value.executionIdentity.childIsolationId } : {}), ...(value.executionIdentity?.sessionId ? { session_id: value.executionIdentity.sessionId } : {}), source_revision_refs: snakeRefs(value.sourceRevisionRefs), provenance: value.provenance, ...physicalBase(value) })
  if (record.kind === "session_binding") return ctx.db.insert("workgraph_session_bindings", { organization_id: organization, owner_user_id: owner, id: record.id, stream_id: value.streamId, session_id: value.sessionId, project_id: value.projectId, ...(value.currentWorkItemId ? { current_work_item_id: value.currentWorkItemId } : {}), ...(value.currentAttemptId ? { current_attempt_id: value.currentAttemptId } : {}), state: value.state, bound_at: value.boundAt, ...(value.releasedAt === undefined ? {} : { released_at: value.releasedAt }), provenance: value.provenance, ...physicalBase(value) })
  if (record.kind === "agent_checkpoint") return ctx.db.insert("workgraph_agent_checkpoints", { organization_id: organization, owner_user_id: owner, id: record.id, stream_id: value.streamId, work_item_id: value.workItemId, attempt_id: value.attemptId, session_binding_id: value.sessionBindingId, level: value.level, summary: value.summary, evidence_ids: value.evidenceIds, occurred_at: value.occurredAt, operation_id: value.provenance.operationId ?? `archive:${record.id}`, provenance: value.provenance, ...physicalBase(value) })
  if (record.kind === "decision") return ctx.db.insert("workgraph_decisions", { organization_id: organization, owner_user_id: owner, id: record.id, stream_id: value.streamId, state: value.state, question: value.question, options: value.options, ...(value.recommendationOptionId ? { recommendation_option_id: value.recommendationOptionId } : {}), ...(value.rationale === undefined ? {} : { rationale: value.rationale }), ...(value.answer ? { answer: value.answer } : {}), ...(value.dismissedAt === undefined ? {} : { dismissed_at: value.dismissedAt }), ...(value.dismissReason ? { dismiss_reason: value.dismissReason } : {}), source_revision_refs: snakeRefs(value.sourceRevisionRefs), provenance: value.provenance, ...physicalBase(value) })
  if (record.kind === "decision_work_item") return ctx.db.insert("workgraph_decision_work_items", { organization_id: organization, owner_user_id: owner, id: record.id, decision_id: value.decisionId, stream_id: subjectStreams.get(value.workItemId), work_item_id: value.workItemId, schema_version: value.schemaVersion, created_at: value.createdAt })
  if (record.kind === "evidence") return ctx.db.insert("workgraph_evidence", { organization_id: organization, owner_user_id: owner, id: record.id, stream_id: subjectStreams.get(subjectId(value.subject)), subject_type: value.subject.type, subject_id: subjectId(value.subject), evidence_kind: value.kind, summary: value.summary, reference: evidenceReference(value), provenance: { actor: value.recordedBy }, schema_version: value.schemaVersion, created_at: value.recordedAt })
  if (record.kind === "durable_effect_receipt") return ctx.db.insert("workgraph_durable_effect_receipts", { organization_id: organization, owner_user_id: owner, id: record.id, stream_id: value.streamId, ...(value.attemptId ? { attempt_id: value.attemptId } : {}), effect_kind: value.effectKind, idempotency_key: value.idempotencyKey, external_reference: value.externalReference, provenance: value.provenance, schema_version: value.schemaVersion, created_at: value.createdAt })
  if (record.kind === "recap") return ctx.db.insert("workgraph_recaps", { organization_id: organization, owner_user_id: owner, id: record.id, stream_id: value.streamId, ...(value.previousRecapId ? { previous_recap_id: value.previousRecapId } : {}), activity_range: value.activityRange, summary: value.summary, actionable_references: value.actionableReferences, generation: value.generation, source_revision_refs: snakeRefs(value.sourceRevisionRefs), provenance: value.provenance, schema_version: value.schemaVersion, created_at: value.createdAt })
  if (record.kind === "notification") return ctx.db.insert("workgraph_notifications", { organization_id: organization, owner_user_id: owner, id: record.id, notification_kind: value.kind, state: value.state, stream_id: value.streamId, recap_id: value.recapId, ...(value.readAt === undefined ? {} : { read_at: value.readAt }), row_version: value.version, schema_version: value.schemaVersion, created_at: value.createdAt, updated_at: value.updatedAt })
  if (record.kind === "record_source_revision") return ctx.db.insert("workgraph_record_source_revisions", { organization_id: organization, owner_user_id: owner, id: record.id, record_type: value.recordType, record_id: value.recordId, work_source_id: value.workSourceId, source_revision_id: value.sourceRevisionId, ordinal: value.ordinal, schema_version: value.schemaVersion, created_at: value.createdAt })
  if (record.kind === "admission_proposal") return ctx.db.insert("workgraph_admission_proposals", { organization_id: organization, owner_user_id: owner, id: record.id, workgraph_id: value.workgraphId, state: value.state, source: snakeRef(value.source), ...(value.previousSource ? { previous_source: snakeRef(value.previousSource) } : {}), ...(value.intakeCandidateId ? { intake_candidate_id: value.intakeCandidateId } : {}), proposal_kind: value.proposalKind, generation: value.generation, ...(value.diffSummary === undefined ? {} : { diff_summary: value.diffSummary }), ...(value.suggestedPlacement ? { suggested_placement: value.suggestedPlacement } : {}), ...(value.placementMatches ? { placement_matches: value.placementMatches } : {}), ...(value.proposedOutcomes ? { proposed_outcomes: value.proposedOutcomes } : {}), ...(value.proposedWorkItems ? { proposed_work_items: value.proposedWorkItems } : {}), ...(value.duplicateMatches ? { duplicate_matches: value.duplicateMatches } : {}), planning_evidence: value.planningEvidence, ...(value.disposition ? { disposition: value.disposition } : {}), ...(value.confirmedChangeCursor ? { confirmed_change_cursor: readChangeCursor(value.confirmedChangeCursor, organization, owner) } : {}), provenance: value.provenance, ...physicalBase(value), ...(value.confirmedAt === undefined ? {} : { confirmed_at: value.confirmedAt }) })
  if (record.kind === "operation_result") return ctx.db.insert("workgraph_operation_results", { organization_id: organization, owner_user_id: owner, id: record.id, command_type: value.commandType, request_hash: value.requestHash, result_status: value.resultStatus, result: value.result, ...(value.changeCursor ? { change_cursor: readChangeCursor(value.changeCursor, organization, owner) } : {}), schema_version: value.schemaVersion, created_at: value.createdAt })
  if (record.kind === "event") return ctx.db.insert("workgraph_events", { organization_id: organization, owner_user_id: owner, id: record.id, ...(value.streamId ? { stream_id: value.streamId } : {}), sequence: value.sequence, operation_id: value.provenance.operationId, request_id: value.provenance.requestId, event_type: value.type, actor_type: value.provenance.actor.type, actor_id: value.provenance.actor.id, payload: value.payload, ...(value.provenance.correlationId ? { correlation_id: value.provenance.correlationId } : {}), ...(value.provenance.causationId ? { causation_id: value.provenance.causationId } : {}), occurred_at: value.occurredAt, schema_version: value.schemaVersion })
  if (record.kind === "change") return ctx.db.insert("workgraph_changes", { organization_id: organization, owner_user_id: owner, id: record.id, cursor: readChangeCursor(value.cursor, organization, owner), ...(value.streamId ? { stream_id: value.streamId } : {}), operation_id: value.operationId, event_id: value.eventId, resource_type: value.resource.type, resource_id: value.resource.id, change_type: value.changeType, payload: value.payload, snapshot_relevant: snapshotRelevantChange(value.changeType), schema_version: value.schemaVersion, created_at: value.createdAt })
  if (record.kind === "runtime_effect") return ctx.db.insert("workgraph_runtime_effects", { organization_id: organization, owner_user_id: owner, id: record.id, effect_kind: value.effectKind, resource_type: value.resourceType, resource_id: value.resourceId, idempotency_key: value.idempotencyKey, payload: value.payload, state: value.state, attempt_count: value.attemptCount, schema_version: value.schemaVersion, created_at: value.createdAt, updated_at: value.updatedAt, completed_at: value.completedAt })
  if (record.kind === "migration_intake") return ctx.db.insert("workgraph_migration_intake", { organization_id: organization, owner_user_id: owner, id: record.id, legacy_table: value.legacyTable, legacy_record_id: value.legacyRecordId, intake_kind: value.intakeKind, reason: value.reason, raw_reference: value.rawReference, status: value.status, ...(value.resolution ? { resolution: value.resolution } : {}), ...physicalBase(value) })
  if (record.kind === "completed_external_effect") return ctx.db.insert("workgraph_outbox", { organization_id: organization, owner_user_id: owner, id: record.id, operation_id: value.operationId, effect_type: value.effectType, idempotency_key: value.idempotencyKey, payload: value.payload, status: "completed", available_at: value.availableAt, attempt_count: value.attemptCount, schema_version: value.schemaVersion, created_at: value.createdAt, updated_at: value.updatedAt })
  return ctx.db.insert("workgraph_due_jobs", { organization_id: organization, owner_user_id: owner, id: record.id, ...(value.streamId ? { stream_id: value.streamId } : {}), job_type: value.jobType, subject_id: value.subjectId, due_at: value.dueAt, status: physicalTerminalJobStatus(value.jobType, value.status), payload: value.payload, lease_epoch: value.leaseEpoch, row_version: value.version, schema_version: value.schemaVersion, created_at: value.createdAt, updated_at: value.updatedAt })
}

function snapshotRelevantChange(changeType: string) {
  return !["session_bound", "agent_checkpoint_recorded", "session_binding_released"].includes(changeType)
}

async function validate(input: unknown): Promise<{ ok: true; archive: CanonicalWorkGraphArchive } | { ok: false; reason: WorkGraphArchiveRestoreErrorReason }> {
  try {
    return { ok: true, archive: await validateWorkGraphArchive(input) as CanonicalWorkGraphArchive }
  } catch (error) {
    if (error && typeof error === "object" && "reason" in error) return rejected(error.reason as WorkGraphArchiveRestoreErrorReason)
    return rejected("malformed")
  }
}

function candidateValue(row: any) {
  const normalized = row.normalized ?? {}
  const base = {
    ...storedBase(row), workgraphId: row.workgraph_id, title: row.title, body: row.body,
    ...(row.observed_revision ? { observedRevision: row.observed_revision } : {}), state: row.status,
    ...(normalized.admissionDraft ? { admissionDraft: normalized.admissionDraft } : {}),
    ...(normalized.source ? { source: ref(normalized.source) } : {}),
    ...(normalized.admissionProposalId ? { admissionProposalId: normalized.admissionProposalId } : {}),
  }
  if (row.candidate_kind === "session") return { ...base, candidateKind: "session", sessionId: normalized.sessionId }
  return {
    ...base, candidateKind: "external_issue", sourceViewId: row.source_view_id, provider: normalized.provider,
    externalId: normalized.externalId, ...(normalized.externalKey ? { externalKey: normalized.externalKey } : {}),
    ...(normalized.externalUrl ? { externalUrl: normalized.externalUrl } : {}), externalStatus: normalized.externalStatus,
  }
}

function proposalValue(row: any, organization: string, owner: string) {
  return {
    ...publicBase(row), workgraphId: row.workgraph_id, proposalKind: row.proposal_kind, state: row.state,
    source: ref(row.source), ...(row.previous_source ? { previousSource: ref(row.previous_source) } : {}),
    ...(row.intake_candidate_id ? { intakeCandidateId: row.intake_candidate_id } : {}),
    ...(row.diff_summary === undefined ? {} : { diffSummary: row.diff_summary }), generation: row.generation,
    planningEvidence: normalizePlanningEvidence(row.planning_evidence),
    ...(row.suggested_placement ? { suggestedPlacement: camelPlacement(row.suggested_placement) } : {}),
    ...(row.placement_matches ? { placementMatches: row.placement_matches } : {}),
    ...(row.proposed_outcomes ? { proposedOutcomes: row.proposed_outcomes.map(camelOutcome) } : {}),
    ...(row.proposed_work_items ? { proposedWorkItems: row.proposed_work_items.map(camelItem) } : {}),
    ...(row.duplicate_matches ? { duplicateMatches: row.duplicate_matches } : {}),
    ...(row.disposition ? { disposition: row.disposition } : {}),
    ...(row.confirmed_change_cursor === undefined ? {} : {
      confirmedChangeCursor: createChangeCursor({ organizationId: organization, ownerUserId: owner, position: row.confirmed_change_cursor }),
    }),
    ...(row.confirmed_at === undefined ? {} : { confirmedAt: row.confirmed_at }),
  }
}

function readArchiveChangeCursor(value: unknown, organization: string, owner: string) {
  try {
    return readChangeCursor(String(value), organization, owner)
  } catch {
    return undefined
  }
}

function evidenceValue(row: any, receipts: any[]) {
  const reference = row.reference ?? {}
  const subject = row.subject_type === "stream" ? { type: "stream", streamId: row.subject_id }
    : row.subject_type === "outcome" ? { type: "outcome", outcomeId: row.subject_id }
      : { type: "work_item", workItemId: row.subject_id }
  const receipt = reference.durableEffectReceiptId
    ? receipts.find((entry) => entry.id === reference.durableEffectReceiptId)
    : receipts.find((entry) => entry.provenance?.operationId === row.provenance?.operationId)
  return {
    schemaVersion: row.schema_version, kind: row.evidence_kind, subject,
    ...(reference.requirementId ? { requirementId: reference.requirementId } : {}),
    ...(reference.sourceAttemptId ? { sourceAttemptId: reference.sourceAttemptId } : {}),
    summary: row.summary, recordedAt: row.created_at, recordedBy: row.provenance.actor,
    ...Object.fromEntries(Object.entries(reference).filter(([key]) => !["kind", "summary", "requirementId", "sourceAttemptId"].includes(key))),
    ...(row.evidence_kind === "integration" && reference.effect !== "other" && receipt ? { durableEffectReceiptId: receipt.id } : {}),
  }
}

function publicBase(row: any) {
  return { schemaVersion: row.schema_version, version: row.row_version, createdAt: row.created_at, updatedAt: row.updated_at, provenance: cleanProvenance(row.provenance) }
}
function storedBase(row: any) { return { schemaVersion: row.schema_version, version: row.row_version, createdAt: row.created_at, updatedAt: row.updated_at } }
function cleanProvenance(value: any) { return { actor: value?.actor, ...(value?.operationId ? { operationId: value.operationId } : {}) } }
function physicalBase(value: any) { return { row_version: value.version, schema_version: value.schemaVersion, created_at: value.createdAt, updated_at: value.updatedAt } }
function ref(value: any) { return { workSourceId: value.workSourceId ?? value.work_source_id, revisionId: value.revisionId ?? value.revision_id, contentHash: value.contentHash ?? value.content_hash } }
function refs(values: any[] | undefined) { return (values ?? []).map(ref) }
function snakeRef(value: any) { return { work_source_id: value.workSourceId, revision_id: value.revisionId, content_hash: value.contentHash } }
function snakeRefs(values: any[]) { return values.map(snakeRef) }
function record(kind: CanonicalWorkGraphArchiveRecord["kind"], id: string, value: any) { return { kind, id, value } as CanonicalWorkGraphArchiveRecord }
function rejected(reason: WorkGraphArchiveRestoreErrorReason) { return { ok: false as const, reason } }
function ownedRows(ctx: any, table: string, organization: string, owner: string) {
  return ctx.db.query(table).withIndex("by_tenant", (query: any) =>
    query.eq("organization_id", organization).eq("owner_user_id", owner),
  ).collect()
}
function providerMatches(provider: string, integration: string) { return integration === provider || (provider === "jira" && integration === "atlassian") }
function normalizePlanningEvidence(value: any) { return { ...(value?.targetStreamId ? { targetStreamId: value.targetStreamId } : {}), placementMatches: value?.placementMatches, duplicateMatches: value?.duplicateMatches } }
function camelPlacement(value: any) { return value.mode === "existing" ? { mode: "existing", streamId: value.streamId ?? value.stream_id } : { mode: "new_stream", streamTitle: value.streamTitle ?? value.stream_title } }
function camelOutcome(value: any) { return { key: value.key ?? value.proposalKey, title: value.title, ...(value.description === undefined ? {} : { description: value.description }), successCriteria: value.successCriteria ?? value.success_criteria, execution: value.execution } }
function camelItem(value: any) { return { key: value.key ?? value.proposalKey, ...(value.outcomeKey ?? value.outcomeProposalKey ? { outcomeKey: value.outcomeKey ?? value.outcomeProposalKey } : {}), title: value.title, ...(value.description === undefined ? {} : { description: value.description }), dependencyKeys: value.dependencyKeys ?? value.dependencyProposalKeys, completionContract: value.completionContract, execution: value.execution } }
function candidateNormalized(value: any) { return value.candidateKind === "session" ? { sessionId: value.sessionId, ...(value.admissionDraft ? { admissionDraft: value.admissionDraft } : {}), ...(value.source ? { source: value.source } : {}), ...(value.admissionProposalId ? { admissionProposalId: value.admissionProposalId } : {}) } : { provider: value.provider, externalId: value.externalId, ...(value.externalKey ? { externalKey: value.externalKey } : {}), ...(value.externalUrl ? { externalUrl: value.externalUrl } : {}), externalStatus: value.externalStatus, ...(value.admissionDraft ? { admissionDraft: value.admissionDraft } : {}), ...(value.source ? { source: value.source } : {}), ...(value.admissionProposalId ? { admissionProposalId: value.admissionProposalId } : {}) } }
function subjectId(subject: any) { return subject.streamId ?? subject.outcomeId ?? subject.workItemId }
function evidenceReference(value: any) { return Object.fromEntries(Object.entries(value).filter(([key]) => !["schemaVersion", "subject", "recordedAt", "recordedBy"].includes(key))) }
function exactlyOne(values: any[]) { return values.length === 1 ? values[0] : undefined }
function terminalJobStatus(row: any) {
  if (["completed", "cancelled"].includes(row.status)) return row.status
  if (row.status === "failed_terminal") return "attention"
  if (row.status === "failed" && row.job_type === "recap" && row.lease_epoch >= 3) return "attention"
  return undefined
}
function physicalTerminalJobStatus(jobType: string, status: string) {
  if (status !== "attention") return status
  return jobType === "recap" ? "failed" : "failed_terminal"
}
