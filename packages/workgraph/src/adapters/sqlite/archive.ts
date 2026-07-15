import {
  ChangeCursorSchema,
  createChangeCursor,
  readChangeCursor,
  ModelSelectionSchema,
  WorkGraphArchiveRestoreError,
  WorkGraphArchiveSchema,
  hashWorkGraphArchive,
  validateWorkGraphArchive,
  type CanonicalWorkGraphArchiveRecord,
  type WorkGraphActor,
  type WorkGraphArchive,
  type WorkGraphContext,
  type WorkGraphPublicRecord,
  type WorkSourceOrigin,
} from "../../contracts"
import { dependencyGraphHasCycle } from "../../domain"
import type { WorkGraphArchivePort, WorkGraphArchiveRestoreResult } from "../../ports"
import type { RawDatabase, SqliteInput } from "../../sqlite"
import { assertNoSqliteWorkGraphOwnerDeletion, SqliteWorkGraphOwnerDeletionInProgressError } from "./deletion-barrier"
import { initializeWorkGraphSqliteSchema } from "./schema"
import { readSqliteWorkGraphPublicRecords } from "./store"

const ownerEventScopeId = "__workgraph_owner_events__"

const supportedTables = new Set([
  "wg_v2_workgraphs",
  "wg_v2_work_sources",
  "wg_v2_work_source_revisions",
  "wg_v2_source_views",
  "wg_v2_intake_candidates",
  "wg_v2_external_identities",
  "wg_v2_streams",
  "wg_v2_outcomes",
  "wg_v2_work_items",
  "wg_v2_work_item_dependencies",
  "wg_v2_attempts",
  "wg_v2_session_bindings",
  "wg_v2_agent_checkpoints",
  "wg_v2_decisions",
  "wg_v2_decision_work_items",
  "wg_v2_evidence",
  "wg_v2_durable_effect_receipts",
  "wg_v2_recaps",
  "wg_v2_notifications",
  "wg_v2_record_source_revisions",
  "wg_v2_admission_proposals",
  "wg_v2_operation_results",
  "wg_v2_stream_sequences",
  "wg_v2_change_cursors",
  "wg_v2_events",
  "wg_v2_changes",
  "wg_v2_runtime_effects",
  "wg_v2_migration_intake",
  "wg_v2_outbox",
  "wg_v2_due_jobs",
])

const ownerTables = [
  "wg_v2_workgraphs",
  "wg_v2_work_sources",
  "wg_v2_work_source_revisions",
  "wg_v2_source_views",
  "wg_v2_intake_candidates",
  "wg_v2_external_identities",
  "wg_v2_streams",
  "wg_v2_outcomes",
  "wg_v2_work_items",
  "wg_v2_work_item_dependencies",
  "wg_v2_attempts",
  "wg_v2_session_bindings",
  "wg_v2_agent_checkpoints",
  "wg_v2_leases",
  "wg_v2_runtime_effects",
  "wg_v2_stream_cleanup_reservations",
  "wg_v2_decisions",
  "wg_v2_decision_work_items",
  "wg_v2_evidence",
  "wg_v2_durable_effect_receipts",
  "wg_v2_recaps",
  "wg_v2_notifications",
  "wg_v2_record_source_revisions",
  "wg_v2_admission_proposals",
  "wg_v2_operation_results",
  "wg_v2_stream_sequences",
  "wg_v2_change_cursors",
  "wg_v2_events",
  "wg_v2_changes",
  "wg_v2_outbox",
  "wg_v2_due_jobs",
  "wg_v2_migration_intake",
] as const

export function createSqliteWorkGraphArchivePort(
  databaseInput: SqliteInput,
  clock: Readonly<{ now: () => number }> = { now: () => Date.now() },
  dependencies?: Readonly<{
    connectionAvailable: (context: WorkGraphContext, connectionId: string) => Promise<boolean>
  }>,
): WorkGraphArchivePort {
  const database = initializeWorkGraphSqliteSchema(databaseInput).raw()
  if (!database) throw new Error("SQLite archive requires direct transactional database access")

  return {
    export: async (context) => {
      requireOwner(context)
      return database.transaction(() => {
        assertArchiveAvailable(database, context)
        assertQuiescent(database, context)
        assertCanonicalCoverage(database, context)
        const archive = WorkGraphArchiveSchema.safeParse({
          version: 1,
          organizationId: context.organizationId,
          ownerUserId: context.ownerUserId,
          exportedAt: clock.now(),
          records: exportRecords(database, context),
        })
        if (!archive.success) throw new WorkGraphArchiveRestoreError("target_incompatible")
        return archive.data
      })()
    },
    restore: async (context, input) => {
      requireOwner(context)
      assertArchiveAvailable(database, context)
      const archive = await validateWorkGraphArchive(input.archive)
      if (archive.organizationId !== context.organizationId || archive.ownerUserId !== context.ownerUserId) {
        throw new WorkGraphArchiveRestoreError("cross_owner")
      }
      const archiveHash = await hashWorkGraphArchive(archive)
      const prior = database.prepare(`
        SELECT archive_hash, result_json FROM wg_v2_archive_restores
        WHERE organization_id = ? AND owner_user_id = ? AND operation_id = ?
      `).get(context.organizationId, context.ownerUserId, input.operationId) as { archive_hash: string; result_json: string } | undefined
      if (prior) {
        if (prior.archive_hash !== archiveHash) throw new WorkGraphArchiveRestoreError("idempotency_conflict")
        return restoreResult(prior.result_json)
      }
      if (ownerTables.some((table) => hasOwnerRow(database, table, context))) {
        throw new WorkGraphArchiveRestoreError("non_empty")
      }
      const records = narrowSupportedArchive(archive)
      validateReferences(records)
      await validateDependencies(context, records, dependencies)

      return database.transaction(() => {
        assertArchiveAvailable(database, context)
        records.filter(kind("operation_result")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_operation_results
            (organization_id, owner_user_id, id, command_type, request_hash, result_status, result_json, change_cursor, schema_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.commandType,
          record.value.requestHash,
          record.value.resultStatus,
          JSON.stringify(record.value.result),
          record.value.changeCursor === undefined
            ? null
            : readChangeCursor(record.value.changeCursor, context.organizationId, context.ownerUserId),
          record.value.schemaVersion,
          record.value.createdAt,
        ))
        records.filter(kind("workgraph")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_workgraphs
            (organization_id, owner_user_id, id, defaults_json, recap_defaults_json, row_version, schema_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          JSON.stringify(record.value.defaults.execution),
          JSON.stringify(record.value.defaults.recap),
          record.value.version,
          record.value.schemaVersion,
          record.value.createdAt,
          record.value.updatedAt,
        ))
        records.filter(kind("work_source")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_work_sources
            (organization_id, owner_user_id, id, workgraph_id, title, source_kind, metadata_json, latest_revision_number,
             row_version, schema_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.workgraphId,
          record.value.title,
          record.value.sourceKind,
          JSON.stringify(record.value.metadata),
          record.value.revisionCount,
          record.value.version,
          record.value.schemaVersion,
          record.value.createdAt,
          record.value.updatedAt,
        ))
        records.filter(kind("work_source_revision")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_work_source_revisions
            (organization_id, owner_user_id, id, work_source_id, revision_number, content, content_hash, origin_kind,
             origin_reference_json, created_by_json, schema_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.workSourceId,
          record.value.revisionNumber,
          record.value.content,
          record.value.contentHash,
          record.value.origin.kind,
          workSourceOriginReference(record.value.origin),
          JSON.stringify(record.value.createdBy),
          record.value.schemaVersion,
          record.value.createdAt,
        ))
        records.filter(kind("source_view")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_source_views
            (organization_id, owner_user_id, id, workgraph_id, team_connection_id, provider, provider_user_id,
             filters_json, target_json, sync_policy, status, row_version, schema_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.workgraphId,
          record.value.teamConnectionId,
          record.value.provider,
          record.value.providerUserId,
          JSON.stringify(record.value.filters),
          record.value.target ? JSON.stringify(record.value.target) : null,
          record.value.syncPolicy,
          record.value.status,
          record.value.version,
          record.value.schemaVersion,
          record.value.createdAt,
          record.value.updatedAt,
        ))
        records.filter(kind("intake_candidate")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_intake_candidates
            (organization_id, owner_user_id, id, workgraph_id, source_view_id, candidate_kind, title, body,
             normalized_json, status, observed_revision, row_version, schema_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.workgraphId,
          record.value.candidateKind === "external_issue" ? record.value.sourceViewId : null,
          record.value.candidateKind,
          record.value.title,
          record.value.body,
          JSON.stringify({
            ...(record.value.candidateKind === "session"
              ? { sessionId: record.value.sessionId }
              : {
                provider: record.value.provider,
                externalId: record.value.externalId,
                externalStatus: record.value.externalStatus,
                ...(record.value.externalKey === undefined ? {} : { externalKey: record.value.externalKey }),
                ...(record.value.externalUrl === undefined ? {} : { externalUrl: record.value.externalUrl }),
              }),
            ...(record.value.admissionDraft === undefined ? {} : { admissionDraft: record.value.admissionDraft }),
            ...(record.value.source === undefined ? {} : { source: record.value.source }),
            ...(record.value.admissionProposalId === undefined ? {} : { admissionProposalId: record.value.admissionProposalId }),
          }),
          record.value.state === "confirmed" ? "staged" : record.value.state,
          record.value.observedRevision ?? null,
          record.value.version,
          record.value.schemaVersion,
          record.value.createdAt,
          record.value.updatedAt,
        ))
        records.filter(kind("external_identity")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_external_identities
            (organization_id, owner_user_id, id, intake_candidate_id, provider, team_connection_id, external_id,
             external_key, external_url, observed_revision, metadata_json, schema_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.intakeCandidateId ?? null,
          record.value.provider,
          record.value.teamConnectionId,
          record.value.externalId,
          record.value.externalKey ?? null,
          record.value.externalUrl ?? null,
          record.value.observedRevision ?? null,
          JSON.stringify(record.value.metadata),
          record.value.schemaVersion,
          record.value.createdAt,
          record.value.updatedAt,
        ))
        records.filter(kind("stream")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_streams
            (organization_id, owner_user_id, id, workgraph_id, title, purpose, lifecycle, visibility, pinned,
             execution_defaults_json, recap_defaults_json, memory_card_json, last_activity_at,
             activity_granularity, replacement_reset_json, row_version, schema_version, created_at, updated_at, closed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.workgraphId,
          record.value.title,
          record.value.description ?? record.value.title,
          record.value.lifecycleState,
          record.value.visibility,
          record.value.pinned ? 1 : 0,
          JSON.stringify(record.value.executionDefaults),
          JSON.stringify(record.value.recapDefaults),
          JSON.stringify(record.value.memory ?? {}),
          record.value.activity.lastActivityAt,
          record.value.activityGranularity,
          record.value.replacementReset === undefined ? null : JSON.stringify(record.value.replacementReset),
          record.value.version,
          record.value.schemaVersion,
          record.value.createdAt,
          record.value.updatedAt,
          record.value.lifecycleState === "closed" ? record.value.updatedAt : null,
        ))
        records.filter(kind("outcome")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_outcomes
            (organization_id, owner_user_id, id, stream_id, title, description, lifecycle, success_criteria_json,
             execution_defaults_json, ready_to_close_at, completed_at, closed_by_json, close_reason,
             reopened_at, reopen_reason, row_version, schema_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.streamId,
          record.value.title,
          record.value.description ?? "",
          record.value.state,
          JSON.stringify(record.value.successCriteria),
          JSON.stringify(record.value.executionDefaults ?? {}),
          record.value.readyToCloseAt ?? null,
          record.value.closedAt ?? null,
          record.value.closedBy === undefined ? null : JSON.stringify(record.value.closedBy),
          record.value.closeReason ?? null,
          record.value.reopenedAt ?? null,
          record.value.reopenReason ?? null,
          record.value.version,
          record.value.schemaVersion,
          record.value.createdAt,
          record.value.updatedAt,
        ))
        records.filter(kind("work_item")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_work_items
            (organization_id, owner_user_id, id, stream_id, outcome_id, title, description, lifecycle, priority,
             execution_overrides_json, completion_contract_json, abandoned_reason, abandoned_at,
             row_version, schema_version, created_at, updated_at, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.streamId,
          record.value.outcomeId ?? null,
          record.value.title,
          record.value.description ?? "",
          record.value.state,
          record.value.priority,
          JSON.stringify(record.value.executionDefaults ?? {}),
          JSON.stringify(record.value.completionContract),
          record.value.abandonReason ?? null,
          record.value.abandonedAt ?? null,
          record.value.version,
          record.value.schemaVersion,
          record.value.createdAt,
          record.value.updatedAt,
          record.value.completedAt ?? null,
        ))
        records.filter(kind("work_item_dependency")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_work_item_dependencies
            (organization_id, owner_user_id, id, work_item_id, depends_on_work_item_id, dependency_kind, schema_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.workItemId,
          record.value.dependsOnWorkItemId,
          record.value.dependencyKind,
          record.value.schemaVersion,
          record.value.createdAt,
        ))
        records.filter(kind("attempt")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_attempts
            (organization_id, owner_user_id, id, stream_id, work_item_id, attempt_number, lifecycle,
             execution_kind, resolved_execution_profile_json, envelope_id, child_workspace_id, session_id,
             terminal_result_json, attention_reason, row_version, schema_version,
             created_at, updated_at, started_at, finished_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.streamId,
          record.value.workItemId,
          record.value.attemptNumber,
          record.value.state,
          record.value.executionKind,
          JSON.stringify(record.value.resolvedExecution),
          record.value.executionIdentity?.envelopeId ?? null,
          record.value.executionIdentity?.childIsolationId ?? null,
          record.value.executionIdentity?.sessionId ?? null,
          record.value.result === undefined ? null : JSON.stringify(record.value.result),
          record.value.attentionReason ?? null,
          record.value.version,
          record.value.schemaVersion,
          record.value.admittedAt,
          record.value.updatedAt,
          record.value.startedAt ?? null,
          record.value.finishedAt ?? null,
        ))
        records.filter(kind("session_binding")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_session_bindings
            (organization_id, owner_user_id, id, stream_id, session_id, project_id, current_work_item_id,
             current_attempt_id, state, bound_at, released_at, provenance_json, row_version, schema_version,
             created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.streamId,
          record.value.sessionId,
          record.value.projectId,
          record.value.currentWorkItemId ?? null,
          record.value.currentAttemptId ?? null,
          record.value.state,
          record.value.boundAt,
          record.value.releasedAt ?? null,
          JSON.stringify(record.value.provenance),
          record.value.version,
          record.value.schemaVersion,
          record.value.createdAt,
          record.value.updatedAt,
        ))
        records.filter(kind("agent_checkpoint")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_agent_checkpoints
            (organization_id, owner_user_id, id, stream_id, work_item_id, attempt_id, session_binding_id,
             level, summary, evidence_ids_json, occurred_at, provenance_json, operation_id, row_version,
             schema_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.streamId,
          record.value.workItemId,
          record.value.attemptId,
          record.value.sessionBindingId,
          record.value.level,
          record.value.summary,
          JSON.stringify(record.value.evidenceIds),
          record.value.occurredAt,
          JSON.stringify(record.value.provenance),
          record.value.provenance.operationId ?? `archive:${record.id}`,
          record.value.version,
          record.value.schemaVersion,
          record.value.createdAt,
          record.value.updatedAt,
        ))
        records.filter(kind("decision")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_decisions
            (organization_id, owner_user_id, id, stream_id, question, options_json, recommendation_json, rationale,
             answer_json, lifecycle, proposed_by_json, answered_by_json, row_version, schema_version,
             created_at, updated_at, answered_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.streamId,
          record.value.question,
          JSON.stringify(record.value.options),
          record.value.recommendationOptionId === undefined ? null : JSON.stringify({ optionId: record.value.recommendationOptionId }),
          record.value.rationale ?? null,
          record.value.answer === undefined
            ? record.value.dismissReason === undefined ? null : JSON.stringify({ dismissReason: record.value.dismissReason })
            : JSON.stringify({
              ...(record.value.answer.optionId === undefined ? {} : { optionId: record.value.answer.optionId }),
              ...(record.value.answer.answer === undefined ? {} : { answer: record.value.answer.answer }),
            }),
          record.value.state,
          JSON.stringify(record.value.proposedBy),
          record.value.answer === undefined && record.value.dismissedAt === undefined
            ? null
            : JSON.stringify(record.value.answer?.answeredBy ?? record.value.provenance.actor),
          record.value.version,
          record.value.schemaVersion,
          record.value.createdAt,
          record.value.updatedAt,
          record.value.answer?.answeredAt ?? record.value.dismissedAt ?? null,
        ))
        records.filter(kind("decision_work_item")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_decision_work_items
            (organization_id, owner_user_id, id, decision_id, work_item_id, schema_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.decisionId,
          record.value.workItemId,
          record.value.schemaVersion,
          record.value.createdAt,
        ))
        records.filter(kind("durable_effect_receipt")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_durable_effect_receipts
            (organization_id, owner_user_id, id, stream_id, attempt_id, effect_kind, idempotency_key,
             external_reference_json, provenance_json, schema_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.streamId,
          record.value.attemptId ?? null,
          record.value.effectKind,
          record.value.idempotencyKey,
          JSON.stringify(record.value.externalReference),
          JSON.stringify(record.value.provenance),
          record.value.schemaVersion,
          record.value.createdAt,
        ))
        records.filter(kind("evidence")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_evidence
            (organization_id, owner_user_id, id, stream_id, subject_type, subject_id, requirement_id,
             source_attempt_id, evidence_kind, summary, reference_json, provenance_json,
             schema_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          subjectStreamId(records, record.value.subject),
          record.value.subject.type,
          subjectId(record.value.subject),
          record.value.requirementId ?? null,
          record.value.sourceAttemptId ?? null,
          record.value.kind,
          record.value.summary,
          JSON.stringify(evidenceReference(record.value)),
          JSON.stringify({ actor: record.value.recordedBy }),
          record.value.schemaVersion,
          record.value.recordedAt,
        ))
        orderedRecaps(records).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_recaps
            (organization_id, owner_user_id, id, stream_id, previous_recap_id, activity_start_sequence,
             activity_end_sequence, quiet_since, summary, actionable_references_json,
             generation_profile_json, provenance_json, generation_result_json,
             schema_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.streamId,
          record.value.previousRecapId ?? null,
          record.value.activityRange.fromSequence,
          record.value.activityRange.toSequence,
          record.value.activityRange.quietSince,
          record.value.summary,
          JSON.stringify(record.value.actionableReferences),
          JSON.stringify({ model: record.value.generation.model, effort: record.value.generation.effort }),
          JSON.stringify(record.value.provenance),
          JSON.stringify(recapGenerationResult(record.value.generation)),
          record.value.schemaVersion,
          record.value.createdAt,
        ))
        records.filter(kind("notification")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_notifications
            (organization_id, owner_user_id, id, notification_kind, state, stream_id, recap_id, row_version,
             schema_version, created_at, updated_at, read_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.kind,
          record.value.state,
          record.value.streamId,
          record.value.recapId,
          record.value.version,
          record.value.schemaVersion,
          record.value.createdAt,
          record.value.updatedAt,
          record.value.readAt ?? null,
        ))
        records.filter(kind("record_source_revision")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_record_source_revisions
            (organization_id, owner_user_id, id, record_type, record_id, work_source_id,
             source_revision_id, ordinal, schema_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.recordType,
          record.value.recordId,
          record.value.workSourceId,
          record.value.sourceRevisionId,
          record.value.ordinal,
          record.value.schemaVersion,
          record.value.createdAt,
        ))
        records.filter(kind("admission_proposal")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_admission_proposals
            (organization_id, owner_user_id, id, workgraph_id, source_revision_id, previous_source_revision_id,
             intake_candidate_id, proposal_kind, lifecycle, proposed_work_json,
             duplicate_matches_json, disposition_json, confirmed_change_cursor,
             row_version, schema_version, created_at, updated_at, confirmed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.workgraphId,
          record.value.source.revisionId,
          record.value.previousSource?.revisionId ?? null,
          record.value.intakeCandidateId ?? null,
          record.value.proposalKind,
          record.value.state,
          JSON.stringify(storedProposal(record.value)),
          JSON.stringify(record.value.planningEvidence.duplicateMatches),
          "disposition" in record.value && record.value.disposition !== undefined ? JSON.stringify(record.value.disposition) : null,
          "confirmedChangeCursor" in record.value && record.value.confirmedChangeCursor !== undefined
            ? readChangeCursor(record.value.confirmedChangeCursor, context.organizationId, context.ownerUserId)
            : null,
          record.value.version,
          record.value.schemaVersion,
          record.value.createdAt,
          record.value.updatedAt,
          "confirmedAt" in record.value ? record.value.confirmedAt ?? null : null,
        ))
        records.filter(kind("runtime_effect")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_runtime_effects
            (organization_id, owner_user_id, id, effect_kind, resource_type, resource_id, idempotency_key,
             payload_json, state, attempt_count, schema_version, created_at, updated_at, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.effectKind,
          record.value.resourceType,
          record.value.resourceId,
          record.value.idempotencyKey,
          JSON.stringify(record.value.payload),
          record.value.attemptCount,
          record.value.schemaVersion,
          record.value.createdAt,
          record.value.updatedAt,
          record.value.completedAt,
        ))
        records.filter(kind("migration_intake")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_migration_intake
            (organization_id, owner_user_id, id, legacy_table, legacy_record_id, intake_kind, reason,
             raw_reference_json, status, resolution_json, row_version, schema_version,
             created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.legacyTable,
          record.value.legacyRecordId,
          record.value.intakeKind,
          record.value.reason,
          JSON.stringify(record.value.rawReference),
          record.value.status,
          record.value.resolution === undefined ? null : JSON.stringify(record.value.resolution),
          record.value.version,
          record.value.schemaVersion,
          record.value.createdAt,
          record.value.updatedAt,
        ))
        records.filter(kind("completed_external_effect")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_outbox
            (organization_id, owner_user_id, id, operation_id, effect_type, idempotency_key, payload_json,
             status, available_at, attempt_count, schema_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.operationId,
          record.value.effectType,
          record.value.idempotencyKey,
          JSON.stringify(record.value.payload),
          record.value.availableAt,
          record.value.attemptCount,
          record.value.schemaVersion,
          record.value.createdAt,
          record.value.updatedAt,
        ))
        records.filter(kind("terminal_scheduled_job")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_due_jobs
            (organization_id, owner_user_id, id, stream_id, job_type, subject_id, due_at, status, payload_json,
             lease_epoch, row_version, schema_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.streamId ?? null,
          record.value.jobType,
          record.value.subjectId,
          record.value.dueAt,
          record.value.status === "attention" ? "failed_terminal" : record.value.status,
          JSON.stringify(record.value.payload),
          record.value.leaseEpoch,
          record.value.version,
          record.value.schemaVersion,
          record.value.createdAt,
          record.value.updatedAt,
        ))
        records.filter(kind("event")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_events
            (organization_id, owner_user_id, id, stream_id, sequence, schema_version, operation_id, event_type,
             actor_type, actor_id, request_id, payload_json, correlation_id, causation_id, occurred_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          record.id,
          record.value.streamId ?? null,
          record.value.sequence,
          record.value.schemaVersion,
          record.value.provenance.operationId,
          record.value.type,
          record.value.provenance.actor.type,
          record.value.provenance.actor.id,
          record.value.provenance.requestId,
          JSON.stringify(record.value.payload),
          record.value.provenance.correlationId ?? null,
          record.value.provenance.causationId ?? null,
          record.value.occurredAt,
        ))
        records.filter(kind("change")).forEach((record) => database.prepare(`
          INSERT INTO wg_v2_changes
            (organization_id, owner_user_id, cursor, id, stream_id, operation_id, resource_type, resource_id,
             change_type, payload_json, snapshot_relevant, schema_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.organizationId, context.ownerUserId,
          readChangeCursor(record.value.cursor, context.organizationId, context.ownerUserId),
          record.id,
          record.value.streamId ?? null,
          record.value.operationId,
          record.value.resource.type,
          record.value.resource.id,
          record.value.changeType,
          JSON.stringify(record.value.payload),
          snapshotRelevantChange(record.value.changeType) ? 1 : 0,
          record.value.schemaVersion,
          record.value.createdAt,
        ))

        rebuildAllocators(database, context, records, clock.now())
        const baselineCursor = createChangeCursor({
          organizationId: context.organizationId,
          ownerUserId: context.ownerUserId,
          position: Math.max(0, ...records.filter(kind("change")).map((record) =>
            readChangeCursor(record.value.cursor, context.organizationId, context.ownerUserId))),
        })
        const result = { restored: true, recordCount: archive.records.length, baselineCursor }
        database.prepare(`
          INSERT INTO wg_v2_archive_restores
            (organization_id, owner_user_id, operation_id, archive_hash, result_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(context.organizationId, context.ownerUserId, input.operationId, archiveHash, JSON.stringify(result), clock.now())
        return result
      })()
    },
  }
}

function assertArchiveAvailable(database: RawDatabase, context: WorkGraphContext) {
  try {
    assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
  } catch (error) {
    if (error instanceof SqliteWorkGraphOwnerDeletionInProgressError) {
      throw new WorkGraphArchiveRestoreError("not_quiescent")
    }
    throw error
  }
}

function exportRecords(database: NonNullable<ReturnType<ReturnType<typeof initializeWorkGraphSqliteSchema>["raw"]>>, context: WorkGraphContext) {
  const workgraphs = rows(database, "wg_v2_workgraphs", context).map((row) => ({
    kind: "workgraph" as const,
    id: id(row),
    value: {
      schemaVersion: integer(row.schema_version),
      version: integer(row.row_version),
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
      provenance: provenance(database, context, "workgraph", id(row)),
      defaults: { execution: json(row.defaults_json), recap: json(row.recap_defaults_json) },
    },
  }))
  const sources = rows(database, "wg_v2_work_sources", context).map((row) => {
    const latest = database.prepare(`
      SELECT id FROM wg_v2_work_source_revisions
      WHERE organization_id = ? AND owner_user_id = ? AND work_source_id = ? AND revision_number = ?
    `).get(context.organizationId, context.ownerUserId, id(row), integer(row.latest_revision_number)) as { id: string } | undefined
    if (!latest) throw new WorkGraphArchiveRestoreError("target_incompatible")
    return {
      kind: "work_source" as const,
      id: id(row),
      value: {
        schemaVersion: integer(row.schema_version),
        version: integer(row.row_version),
        createdAt: timestamp(row.created_at),
        updatedAt: timestamp(row.updated_at),
        workgraphId: string(row.workgraph_id),
        title: string(row.title),
        sourceKind: string(row.source_kind),
        metadata: json(row.metadata_json),
        latestRevisionId: latest.id,
        revisionCount: integer(row.latest_revision_number),
      },
    }
  })
  const revisions = rows(database, "wg_v2_work_source_revisions", context).map((row) => ({
    kind: "work_source_revision" as const,
    id: id(row),
    value: {
      schemaVersion: integer(row.schema_version),
      createdAt: timestamp(row.created_at),
      workSourceId: string(row.work_source_id),
      revisionNumber: integer(row.revision_number),
      content: string(row.content),
      contentHash: string(row.content_hash),
      origin: string(row.origin_kind) === "manual"
        ? { kind: "manual" as const }
        : string(row.origin_kind) === "authoring"
          ? { kind: "authoring" as const, ...json(row.origin_reference_json) }
          : { kind: "external" as const, ...json(row.origin_reference_json) },
      createdBy: actor(json(row.created_by_json)),
    },
  }))
  const sourceViews = rows(database, "wg_v2_source_views", context).map((row) => ({
    kind: "source_view" as const,
    id: id(row),
    value: {
      schemaVersion: integer(row.schema_version),
      version: integer(row.row_version),
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
      workgraphId: string(row.workgraph_id),
      teamConnectionId: string(row.team_connection_id),
      provider: string(row.provider),
      providerUserId: string(row.provider_user_id),
      filters: json(row.filters_json),
      ...(row.target_json === null ? {} : { target: json(row.target_json) }),
      syncPolicy: string(row.sync_policy),
      status: string(row.status),
    },
  }))
  const candidates = rows(database, "wg_v2_intake_candidates", context).map((row) => {
    const normalized = json(row.normalized_json)
    const state = candidateState(database, context, row, normalized)
    const common = {
      schemaVersion: integer(row.schema_version),
      version: integer(row.row_version),
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
      workgraphId: string(row.workgraph_id),
      title: string(row.title),
      body: typeof row.body === "string" ? row.body : "",
      ...(row.observed_revision === null ? {} : { observedRevision: string(row.observed_revision) }),
      state,
      ...(isObject(normalized.admissionDraft) ? { admissionDraft: normalized.admissionDraft } : {}),
      ...(isObject(normalized.source) ? { source: normalized.source } : {}),
      ...(typeof normalized.admissionProposalId === "string" ? { admissionProposalId: normalized.admissionProposalId } : {}),
    }
    if (string(row.candidate_kind) === "session") {
      return {
        kind: "intake_candidate" as const,
        id: id(row),
        value: { ...common, candidateKind: "session" as const, sessionId: string(normalized.sessionId) },
      }
    }
    return {
      kind: "intake_candidate" as const,
      id: id(row),
      value: {
        ...common,
        candidateKind: "external_issue" as const,
        sourceViewId: string(row.source_view_id),
        provider: string(normalized.provider),
        externalId: string(normalized.externalId),
        ...(typeof normalized.externalKey === "string" ? { externalKey: normalized.externalKey } : {}),
        ...(typeof normalized.externalUrl === "string" ? { externalUrl: normalized.externalUrl } : {}),
        externalStatus: string(normalized.externalStatus),
      },
    }
  })
  const externalIdentities = rows(database, "wg_v2_external_identities", context).map((row) => ({
    kind: "external_identity" as const,
    id: id(row),
    value: {
      schemaVersion: integer(row.schema_version),
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
      ...(row.intake_candidate_id === null ? {} : { intakeCandidateId: string(row.intake_candidate_id) }),
      provider: string(row.provider),
      teamConnectionId: string(row.team_connection_id),
      externalId: string(row.external_id),
      ...(row.external_key === null ? {} : { externalKey: string(row.external_key) }),
      ...(row.external_url === null ? {} : { externalUrl: string(row.external_url) }),
      ...(row.observed_revision === null ? {} : { observedRevision: string(row.observed_revision) }),
      metadata: json(row.metadata_json),
    },
  }))
  const publicRecords = readSqliteWorkGraphPublicRecords(database, context)
  const streams = publicRecords.filter((record) => record.recordType === "stream").map((record) => ({
    kind: "stream" as const,
    id: record.id,
    value: {
      ...publicValue(record),
      workgraphId: string((database.prepare(`
        SELECT workgraph_id FROM wg_v2_streams WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `).get(context.organizationId, context.ownerUserId, record.id) as { workgraph_id: string }).workgraph_id),
    },
  }))
  const outcomes = publicRecords.filter((record) => record.recordType === "outcome").map((record) => {
    const row = database.prepare(`
      SELECT ready_to_close_at FROM wg_v2_outcomes WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `).get(context.organizationId, context.ownerUserId, record.id) as { ready_to_close_at: string | number | null }
    return {
      kind: "outcome" as const,
      id: record.id,
      value: {
        ...publicValue(record),
        ...(row.ready_to_close_at === null ? {} : { readyToCloseAt: timestamp(row.ready_to_close_at) }),
      },
    }
  })
  const workItems = publicRecords.filter((record) => record.recordType === "work_item").map((record) => {
    const row = database.prepare(`
      SELECT completed_at FROM wg_v2_work_items WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `).get(context.organizationId, context.ownerUserId, record.id) as { completed_at: string | number | null }
    return {
      kind: "work_item" as const,
      id: record.id,
      value: {
        ...publicValue(record),
        ...(row.completed_at === null ? {} : { completedAt: timestamp(row.completed_at) }),
      },
    }
  })
  const dependencies = rows(database, "wg_v2_work_item_dependencies", context).map((row) => ({
    kind: "work_item_dependency" as const,
    id: id(row),
    value: {
      schemaVersion: integer(row.schema_version),
      createdAt: timestamp(row.created_at),
      workItemId: string(row.work_item_id),
      dependsOnWorkItemId: string(row.depends_on_work_item_id),
      dependencyKind: string(row.dependency_kind),
    },
  }))
  const attempts = publicRecords.filter((record) => record.recordType === "attempt").map((record) => {
    const { executionReferences: _executionReferences, ...archiveValue } = publicValue(record)
    const row = database.prepare(`
      SELECT envelope_id, child_workspace_id, session_id FROM wg_v2_attempts
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
    `).get(context.organizationId, context.ownerUserId, record.id) as {
      envelope_id: string | null
      child_workspace_id: string | null
      session_id: string | null
    }
    const executionIdentity = {
      ...(row.envelope_id === null ? {} : { envelopeId: row.envelope_id }),
      ...(row.child_workspace_id === null ? {} : { childIsolationId: row.child_workspace_id }),
      ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    }
    return {
      kind: "attempt" as const,
      id: record.id,
      value: {
        ...archiveValue,
        ...(Object.keys(executionIdentity).length === 0 ? {} : { executionIdentity }),
      },
    }
  })
  const sessionBindings = rows(database, "wg_v2_session_bindings", context).map((row) => ({
    kind: "session_binding" as const,
    id: id(row),
    value: {
      schemaVersion: integer(row.schema_version),
      version: integer(row.row_version),
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
      provenance: recordProvenance(row.provenance_json),
      streamId: string(row.stream_id),
      sessionId: string(row.session_id),
      projectId: string(row.project_id),
      ...(row.current_work_item_id === null ? {} : { currentWorkItemId: string(row.current_work_item_id) }),
      ...(row.current_attempt_id === null ? {} : { currentAttemptId: string(row.current_attempt_id) }),
      state: string(row.state),
      boundAt: timestamp(row.bound_at),
      ...(row.released_at === null ? {} : { releasedAt: timestamp(row.released_at) }),
    },
  }))
  const agentCheckpoints = rows(database, "wg_v2_agent_checkpoints", context).map((row) => ({
    kind: "agent_checkpoint" as const,
    id: id(row),
    value: {
      schemaVersion: integer(row.schema_version),
      version: integer(row.row_version),
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
      provenance: recordProvenance(row.provenance_json),
      streamId: string(row.stream_id),
      workItemId: string(row.work_item_id),
      attemptId: string(row.attempt_id),
      sessionBindingId: string(row.session_binding_id),
      level: string(row.level),
      summary: string(row.summary),
      evidenceIds: array(row.evidence_ids_json),
      occurredAt: timestamp(row.occurred_at),
    },
  }))
  const decisions = publicRecords.filter((record) => record.recordType === "decision").map((record) => ({
    kind: "decision" as const,
    id: record.id,
    value: {
      ...publicValue(record),
      proposedBy: actor(json((database.prepare(`
        SELECT proposed_by_json FROM wg_v2_decisions WHERE organization_id = ? AND owner_user_id = ? AND id = ?
      `).get(context.organizationId, context.ownerUserId, record.id) as { proposed_by_json: string }).proposed_by_json)),
    },
  }))
  const decisionWorkItems = rows(database, "wg_v2_decision_work_items", context).map((row) => ({
    kind: "decision_work_item" as const,
    id: id(row),
    value: {
      schemaVersion: integer(row.schema_version),
      createdAt: timestamp(row.created_at),
      decisionId: string(row.decision_id),
      workItemId: string(row.work_item_id),
    },
  }))
  const receipts = rows(database, "wg_v2_durable_effect_receipts", context).map((row) => ({
    kind: "durable_effect_receipt" as const,
    id: id(row),
    value: {
      schemaVersion: integer(row.schema_version),
      createdAt: timestamp(row.created_at),
      streamId: string(row.stream_id),
      ...(row.attempt_id === null ? {} : { attemptId: string(row.attempt_id) }),
      effectKind: string(row.effect_kind),
      idempotencyKey: string(row.idempotency_key),
      externalReference: json(row.external_reference_json),
      provenance: recordProvenance(row.provenance_json),
    },
  }))
  const evidence = rows(database, "wg_v2_evidence", context).map((row) => {
    const reference = json(row.reference_json)
    const evidenceProvenance = json(row.provenance_json)
    const operationId = typeof evidenceProvenance.operationId === "string" ? evidenceProvenance.operationId : undefined
    const receipt = reference.kind === "integration" && reference.effect !== "other" && operationId
      ? receipts.find((record) => record.value.idempotencyKey === `${operationId}:integration`)
      : undefined
    return {
      kind: "evidence" as const,
      id: id(row),
      value: {
        ...reference,
        schemaVersion: integer(row.schema_version),
        subject: evidenceSubject(row),
        ...(row.requirement_id === null ? {} : { requirementId: string(row.requirement_id) }),
        ...(row.source_attempt_id === null ? {} : { sourceAttemptId: string(row.source_attempt_id) }),
        summary: string(row.summary),
        recordedAt: timestamp(row.created_at),
        recordedBy: actor(evidenceProvenance.actor),
        ...(receipt === undefined ? {} : { durableEffectReceiptId: receipt.id }),
      },
    }
  })
  const recaps = rows(database, "wg_v2_recaps", context).map((row) => archiveRecap(database, context, row))
  const notifications = rows(database, "wg_v2_notifications", context).map((row) => ({
    kind: "notification" as const,
    id: id(row),
    value: {
      schemaVersion: integer(row.schema_version),
      version: integer(row.row_version),
      kind: string(row.notification_kind),
      state: string(row.state),
      streamId: string(row.stream_id),
      recapId: string(row.recap_id),
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
      ...(row.read_at === null ? {} : { readAt: timestamp(row.read_at) }),
    },
  }))
  const sourceReferences = rows(database, "wg_v2_record_source_revisions", context).map((row) => ({
    kind: "record_source_revision" as const,
    id: id(row),
    value: {
      schemaVersion: integer(row.schema_version),
      createdAt: timestamp(row.created_at),
      recordType: string(row.record_type),
      recordId: string(row.record_id),
      workSourceId: string(row.work_source_id),
      sourceRevisionId: string(row.source_revision_id),
      ordinal: integer(row.ordinal),
    },
  }))
  const proposals = rows(database, "wg_v2_admission_proposals", context).map((row) => archiveProposal(
    database,
    context,
    row,
    publicRecords.find((record) => record.recordType === "admission_proposal" && record.id === id(row)),
  ))
  const operations = rows(database, "wg_v2_operation_results", context).map((row) => archiveOperation(context, row))
  const runtimeEffects = rows(database, "wg_v2_runtime_effects", context).map((row) => ({
    kind: "runtime_effect" as const,
    id: id(row),
    value: {
      schemaVersion: integer(row.schema_version),
      effectKind: string(row.effect_kind),
      resourceType: string(row.resource_type),
      resourceId: string(row.resource_id),
      idempotencyKey: string(row.idempotency_key),
      payload: jsonValue(row.payload_json),
      state: string(row.state),
      attemptCount: integer(row.attempt_count),
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
      completedAt: timestamp(row.completed_at),
    },
  }))
  const migrationIntake = rows(database, "wg_v2_migration_intake", context).map((row) => ({
    kind: "migration_intake" as const,
    id: id(row),
    value: {
      schemaVersion: integer(row.schema_version),
      version: integer(row.row_version),
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
      legacyTable: string(row.legacy_table),
      legacyRecordId: string(row.legacy_record_id),
      intakeKind: string(row.intake_kind),
      reason: string(row.reason),
      rawReference: json(row.raw_reference_json),
      status: string(row.status),
      ...(row.resolution_json === null ? {} : { resolution: json(row.resolution_json) }),
    },
  }))
  const completedExternalEffects = rows(database, "wg_v2_outbox", context).map((row) => {
    if (row.status !== "completed" || row.claimed_by !== null || row.claim_expires_at !== null || row.last_error !== null) {
      throw new WorkGraphArchiveRestoreError("not_quiescent")
    }
    return {
      kind: "completed_external_effect" as const,
      id: id(row),
      value: {
        schemaVersion: integer(row.schema_version),
        operationId: string(row.operation_id),
        effectType: string(row.effect_type),
        idempotencyKey: string(row.idempotency_key),
        payload: jsonValue(row.payload_json),
        status: "completed" as const,
        availableAt: timestamp(row.available_at),
        attemptCount: integer(row.attempt_count),
        createdAt: timestamp(row.created_at),
        updatedAt: timestamp(row.updated_at),
      },
    }
  })
  const terminalScheduledJobs = rows(database, "wg_v2_due_jobs", context).map((row) => {
    if (!["completed", "cancelled", "attention", "failed_terminal"].includes(String(row.status)) ||
      row.claimed_by !== null || row.claim_expires_at !== null) {
      throw new WorkGraphArchiveRestoreError("not_quiescent")
    }
    return {
      kind: "terminal_scheduled_job" as const,
      id: id(row),
      value: {
        schemaVersion: integer(row.schema_version),
        version: integer(row.row_version),
        ...(row.stream_id === null ? {} : { streamId: string(row.stream_id) }),
        jobType: string(row.job_type),
        subjectId: string(row.subject_id),
        dueAt: timestamp(row.due_at),
        status: row.status === "attention" || row.status === "failed_terminal" ? "attention" as const : string(row.status),
        payload: jsonValue(row.payload_json),
        leaseEpoch: integer(row.lease_epoch),
        createdAt: timestamp(row.created_at),
        updatedAt: timestamp(row.updated_at),
      },
    }
  })
  const events = rows(database, "wg_v2_events", context).map((row) => ({
    kind: "event" as const,
    id: id(row),
    value: {
      schemaVersion: integer(row.schema_version),
      ...(row.stream_id === null ? {} : { streamId: string(row.stream_id) }),
      sequence: integer(row.sequence),
      type: string(row.event_type),
      payload: json(row.payload_json),
      provenance: {
        actor: { type: string(row.actor_type), id: string(row.actor_id) },
        operationId: string(row.operation_id),
        requestId: string(row.request_id),
        ...(row.correlation_id === null ? {} : { correlationId: string(row.correlation_id) }),
        ...(row.causation_id === null ? {} : { causationId: string(row.causation_id) }),
      },
      occurredAt: timestamp(row.occurred_at),
    },
  }))
  const changes = rows(database, "wg_v2_changes", context).map((row) => {
    const events = database.prepare(`
      SELECT id FROM wg_v2_events WHERE organization_id = ? AND owner_user_id = ? AND operation_id = ?
    `).all(context.organizationId, context.ownerUserId, string(row.operation_id)) as Array<{ id: string }>
    if (events.length !== 1) throw new WorkGraphArchiveRestoreError("target_incompatible")
    return {
      kind: "change" as const,
      id: id(row),
      value: {
        schemaVersion: integer(row.schema_version),
        cursor: createChangeCursor({
          organizationId: context.organizationId,
          ownerUserId: context.ownerUserId,
          position: integer(row.cursor),
        }),
        eventId: events[0]!.id,
        operationId: string(row.operation_id),
        ...(row.stream_id === null ? {} : { streamId: string(row.stream_id) }),
        resource: { type: string(row.resource_type), id: string(row.resource_id) },
        changeType: string(row.change_type),
        payload: json(row.payload_json),
        createdAt: timestamp(row.created_at),
      },
    }
  })
  return [
    ...workgraphs, ...sources, ...revisions, ...sourceViews, ...candidates, ...externalIdentities,
    ...streams, ...outcomes, ...workItems, ...dependencies, ...attempts, ...sessionBindings, ...agentCheckpoints,
    ...decisions, ...decisionWorkItems,
    ...evidence, ...receipts, ...recaps, ...notifications, ...sourceReferences, ...proposals,
    ...operations, ...events, ...changes, ...runtimeEffects, ...migrationIntake,
    ...completedExternalEffects, ...terminalScheduledJobs,
  ]
    .sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
}

function narrowSupportedArchive(archive: WorkGraphArchive) {
  const unsupported = archive.records.find((record) => ![
    "workgraph", "work_source", "work_source_revision", "source_view", "intake_candidate", "external_identity",
    "stream", "outcome", "work_item", "work_item_dependency", "attempt", "session_binding", "agent_checkpoint",
    "decision", "decision_work_item",
    "evidence", "durable_effect_receipt", "recap", "notification", "record_source_revision",
    "admission_proposal", "operation_result", "event", "change", "runtime_effect", "migration_intake",
    "completed_external_effect", "terminal_scheduled_job",
  ].includes(record.kind))
  if (unsupported) throw new WorkGraphArchiveRestoreError("target_incompatible")
  return WorkGraphArchiveSchema.parse(archive).records as CanonicalWorkGraphArchiveRecord[]
}

function archiveProposal(
  database: Database,
  context: WorkGraphContext,
  row: Record<string, unknown>,
  publicRecord: WorkGraphPublicRecord | undefined,
) {
  if (!publicRecord || publicRecord.recordType !== "admission_proposal") {
    throw new WorkGraphArchiveRestoreError("target_incompatible")
  }
  const proposed = json(row.proposed_work_json)
  const planning = isObject(proposed.planningEvidence) ? proposed.planningEvidence : {}
  const previousSource = row.previous_source_revision_id === null
    ? undefined
    : sourceRevisionReference(database, context, string(row.previous_source_revision_id))
  const disposition = row.disposition_json === null ? undefined : json(row.disposition_json)
  return {
    kind: "admission_proposal" as const,
    id: id(row),
    value: {
      ...publicValue(publicRecord),
      workgraphId: string(row.workgraph_id),
      proposalKind: string(row.proposal_kind),
      ...(previousSource === undefined ? {} : { previousSource }),
      ...(row.intake_candidate_id === null ? {} : { intakeCandidateId: string(row.intake_candidate_id) }),
      ...(typeof proposed.diffSummary === "string" ? { diffSummary: proposed.diffSummary } : {}),
      planningEvidence: {
        ...(typeof planning.targetStreamId === "string"
          ? { targetStreamId: planning.targetStreamId }
          : typeof proposed.targetStreamId === "string" ? { targetStreamId: proposed.targetStreamId } : {}),
        placementMatches: Array.isArray(planning.placementMatches)
          ? planning.placementMatches
          : Array.isArray(proposed.placementMatches) ? proposed.placementMatches : [],
        duplicateMatches: Array.isArray(planning.duplicateMatches)
          ? planning.duplicateMatches
          : Array.isArray(proposed.duplicateMatches) ? proposed.duplicateMatches : array(row.duplicate_matches_json),
      },
      ...(publicRecord.state === "planning" || publicRecord.state === "planning_failed" ? {} : {
        ...(disposition === undefined ? {} : { disposition }),
        ...(row.confirmed_change_cursor === null ? {} : {
          confirmedChangeCursor: createChangeCursor({
            organizationId: context.organizationId,
            ownerUserId: context.ownerUserId,
            position: integer(row.confirmed_change_cursor),
          }),
        }),
        ...(row.confirmed_at === null ? {} : { confirmedAt: timestamp(row.confirmed_at) }),
      }),
    },
  }
}

function archiveRecap(database: Database, context: WorkGraphContext, row: Record<string, unknown>) {
  const profile = json(row.generation_profile_json)
  const result = json(row.generation_result_json)
  const model = ModelSelectionSchema.safeParse(profile.model)
  const effort = typeof profile.effort === "string" && profile.effort.trim() ? profile.effort : undefined
  const nonSession = result.state === "succeeded" && (result.method !== "agent_session" || typeof result.sessionId !== "string")
  const completeSuccess = result.state === "succeeded" && !nonSession && model.success && effort && Number.isFinite(result.generatedAt)
  const completeFailure = result.state === "failed" && model.success && effort &&
    typeof result.reason === "string" && result.reason.trim() &&
    (Number.isFinite(result.failedAt) || Number.isFinite(result.invalidatedAt))
  const generation = !completeSuccess && !completeFailure
    ? {
        state: "invalidated" as const,
        ...(model.success ? { model: model.data } : {}),
        ...(effort ? { effort } : {}),
        reason: nonSession
          ? "Retired deterministic Recap fallback is non-authoritative"
          : "Incomplete legacy Recap generation metadata is non-authoritative",
        source: nonSession ? "retired_non_session_generation" as const : "retired_incomplete_generation" as const,
      }
    : result.state === "succeeded"
      ? {
          state: "succeeded" as const,
          model: model.data!,
          effort: effort!,
          generatedAt: timestamp(result.generatedAt),
          method: "agent_session" as const,
          sessionId: string(result.sessionId),
        }
      : {
          state: "failed" as const,
          model: model.data!,
          effort: effort!,
          ...(result.failedAt === undefined ? {} : { failedAt: timestamp(result.failedAt) }),
          ...(result.invalidatedAt === undefined ? {} : { invalidatedAt: timestamp(result.invalidatedAt) }),
          reason: string(result.reason),
        }
  return {
    kind: "recap" as const,
    id: id(row),
    value: {
      schemaVersion: integer(row.schema_version),
      version: 1,
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.created_at),
      provenance: recordProvenance(row.provenance_json),
      streamId: string(row.stream_id),
      ...(row.previous_recap_id === null ? {} : { previousRecapId: string(row.previous_recap_id) }),
      activityRange: {
        fromSequence: integer(row.activity_start_sequence),
        toSequence: integer(row.activity_end_sequence),
        quietSince: timestamp(row.quiet_since),
      },
      summary: string(row.summary),
      actionableReferences: array(row.actionable_references_json),
      generation,
      sourceRevisionRefs: sourceReferences(database, context, "recap", id(row)),
    },
  }
}

function archiveOperation(context: WorkGraphContext, row: Record<string, unknown>) {
  const operationId = id(row)
  const result = json(row.result_json)
  const legacyExternalSync = row.command_type === "intake_external_sync" && integer(row.result_status) === 1 && result.claimed === true
  return {
    kind: "operation_result" as const,
    id: operationId,
    value: {
      schemaVersion: integer(row.schema_version),
      createdAt: timestamp(row.created_at),
      commandType: string(row.command_type),
      requestHash: string(row.request_hash),
      resultStatus: legacyExternalSync ? 200 : integer(row.result_status),
      result: row.change_cursor === null
        ? result
        : {
            ...result,
            cursor: createChangeCursor({
              organizationId: context.organizationId,
              ownerUserId: context.ownerUserId,
              position: legacyExternalSync ? 0 : integer(row.change_cursor),
            }),
            ...(legacyExternalSync ? { value: { claimed: true } } : {}),
          },
      ...(row.change_cursor === null ? {} : {
        changeCursor: createChangeCursor({
          organizationId: context.organizationId,
          ownerUserId: context.ownerUserId,
          position: integer(row.change_cursor),
        }),
      }),
    },
  }
}

function sourceRevisionReference(database: Database, context: WorkGraphContext, revisionId: string) {
  const row = database.prepare(`
    SELECT work_source_id, id, content_hash FROM wg_v2_work_source_revisions
    WHERE organization_id = ? AND owner_user_id = ? AND id = ?
  `).get(context.organizationId, context.ownerUserId, revisionId) as {
    work_source_id: string
    id: string
    content_hash: string
  } | undefined
  if (!row) throw new WorkGraphArchiveRestoreError("target_incompatible")
  return { workSourceId: row.work_source_id, revisionId: row.id, contentHash: row.content_hash }
}

function sourceReferences(database: Database, context: WorkGraphContext, recordType: string, recordId: string) {
  return (database.prepare(`
    SELECT refs.work_source_id, refs.source_revision_id, revisions.content_hash
    FROM wg_v2_record_source_revisions refs
    JOIN wg_v2_work_source_revisions revisions
      ON revisions.organization_id = refs.organization_id AND revisions.owner_user_id = refs.owner_user_id
      AND revisions.work_source_id = refs.work_source_id
      AND revisions.id = refs.source_revision_id
    WHERE refs.organization_id = ? AND refs.owner_user_id = ? AND refs.record_type = ? AND refs.record_id = ?
    ORDER BY refs.ordinal
  `).all(context.organizationId, context.ownerUserId, recordType, recordId) as Array<{
    work_source_id: string
    source_revision_id: string
    content_hash: string
  }>).map((row) => ({
    workSourceId: row.work_source_id,
    revisionId: row.source_revision_id,
    contentHash: row.content_hash,
  }))
}

function evidenceSubject(row: Record<string, unknown>) {
  const subjectId = string(row.subject_id)
  if (row.subject_type === "stream") return { type: "stream" as const, streamId: subjectId }
  if (row.subject_type === "work_item") return { type: "work_item" as const, workItemId: subjectId }
  if (row.subject_type === "outcome") return { type: "outcome" as const, outcomeId: subjectId }
  throw new WorkGraphArchiveRestoreError("target_incompatible")
}

function recordProvenance(value: unknown) {
  const provenance = json(value)
  return {
    actor: actor(provenance.actor),
    ...(typeof provenance.operationId === "string" ? { operationId: provenance.operationId } : {}),
  }
}

function actor(value: unknown) {
  const candidate = isObject(value) ? value : undefined
  if (!candidate || !["user", "agent", "system"].includes(String(candidate.type)) || typeof candidate.id !== "string" || !candidate.id) {
    throw new WorkGraphArchiveRestoreError("target_incompatible")
  }
  return { type: candidate.type as WorkGraphActor["type"], id: candidate.id }
}

function storedProposal(record: Extract<CanonicalWorkGraphArchiveRecord, { kind: "admission_proposal" }>["value"]) {
  const common = {
    source: record.source,
    ...(record.previousSource === undefined ? {} : { previousSource: record.previousSource }),
    ...(record.diffSummary === undefined ? {} : { diffSummary: record.diffSummary }),
    planningEvidence: record.planningEvidence,
    generation: record.generation,
  }
  if (record.state === "planning" || record.state === "planning_failed") return common
  return {
    ...common,
    ...(record.planningEvidence.targetStreamId === undefined ? {} : { targetStreamId: record.planningEvidence.targetStreamId }),
    suggestedPlacement: record.suggestedPlacement,
    placementMatches: record.placementMatches,
    outcomes: record.proposedOutcomes.map((outcome) => ({
      proposalKey: outcome.key,
      title: outcome.title,
      ...(outcome.description === undefined ? {} : { description: outcome.description }),
      successCriteria: outcome.successCriteria,
      execution: outcome.execution,
    })),
    workItems: record.proposedWorkItems.map((item) => ({
      proposalKey: item.key,
      ...(item.outcomeKey === undefined ? {} : { outcomeProposalKey: item.outcomeKey }),
      title: item.title,
      ...(item.description === undefined ? {} : { description: item.description }),
      dependencyProposalKeys: item.dependencyKeys,
      completionContract: item.completionContract,
      execution: item.execution,
    })),
    duplicateMatches: record.duplicateMatches,
  }
}

function evidenceReference(record: Extract<CanonicalWorkGraphArchiveRecord, { kind: "evidence" }>["value"]) {
  const common = { kind: record.kind, summary: record.summary }
  if (record.kind === "test_result") return {
    ...common,
    passed: record.passed,
    ...(record.command === undefined ? {} : { command: record.command }),
    ...(record.outputRef === undefined ? {} : { outputRef: record.outputRef }),
  }
  if (record.kind === "artifact") return {
    ...common,
    artifactRef: record.artifactRef,
    ...(record.mediaType === undefined ? {} : { mediaType: record.mediaType }),
  }
  if (record.kind === "review") return {
    ...common,
    verdict: record.verdict,
    ...(record.reviewer === undefined ? {} : { reviewer: record.reviewer }),
  }
  if (record.kind === "integration") return {
    ...common,
    effect: record.effect,
    reference: record.reference,
    ...(record.durableEffectReceiptId === undefined ? {} : { durableEffectReceiptId: record.durableEffectReceiptId }),
  }
  if (record.kind === "owner_confirmation") return { ...common, confirmed: record.confirmed }
  return { ...common, ...(record.sourceRef === undefined ? {} : { sourceRef: record.sourceRef }) }
}

function recapGenerationResult(record: Extract<CanonicalWorkGraphArchiveRecord, { kind: "recap" }>["value"]["generation"]) {
  if (record.state === "succeeded") return {
    state: "succeeded",
    generatedAt: record.generatedAt,
    method: "agent_session",
    sessionId: record.sessionId,
  }
  if (record.state === "invalidated") return { state: "succeeded", method: "deterministic_fallback" }
  return {
    state: "failed",
    ...(record.failedAt === undefined ? {} : { failedAt: record.failedAt }),
    ...(record.invalidatedAt === undefined ? {} : { invalidatedAt: record.invalidatedAt }),
    reason: record.reason,
  }
}

function orderedRecaps(records: CanonicalWorkGraphArchiveRecord[]) {
  const recaps = records.filter(kind("recap"))
  const depth = (record: typeof recaps[number], seen = new Set<string>()): number => {
    if (!record.value.previousRecapId) return 0
    if (seen.has(record.id)) throw new WorkGraphArchiveRestoreError("malformed")
    const previous = recaps.find((candidate) => candidate.id === record.value.previousRecapId)
    if (!previous) throw new WorkGraphArchiveRestoreError("malformed")
    return 1 + depth(previous, new Set([...seen, record.id]))
  }
  return recaps.sort((left, right) => depth(left) - depth(right) || left.id.localeCompare(right.id))
}

function subjectId(subject: Extract<CanonicalWorkGraphArchiveRecord, { kind: "evidence" }>["value"]["subject"]) {
  if (subject.type === "stream") return subject.streamId
  if (subject.type === "work_item") return subject.workItemId
  return subject.outcomeId
}

function subjectStreamId(
  records: CanonicalWorkGraphArchiveRecord[],
  subject: Extract<CanonicalWorkGraphArchiveRecord, { kind: "evidence" }>["value"]["subject"],
) {
  if (subject.type === "stream") return subject.streamId
  const record = records.find((candidate) =>
    candidate.kind === subject.type && candidate.id === subjectId(subject),
  )
  if (!record || (record.kind !== "work_item" && record.kind !== "outcome")) {
    throw new WorkGraphArchiveRestoreError("malformed")
  }
  return record.value.streamId
}

function assertQuiescent(database: Database, context: WorkGraphContext) {
  const checks = [
    "SELECT 1 FROM wg_v2_attempts WHERE organization_id = ? AND owner_user_id = ? AND lifecycle IN ('admitted', 'placing', 'running') LIMIT 1",
    "SELECT 1 FROM wg_v2_leases WHERE organization_id = ? AND owner_user_id = ? LIMIT 1",
    "SELECT 1 FROM wg_v2_runtime_effects WHERE organization_id = ? AND owner_user_id = ? AND state != 'completed' LIMIT 1",
    "SELECT 1 FROM wg_v2_stream_cleanup_reservations WHERE organization_id = ? AND owner_user_id = ? AND state = 'reserved' LIMIT 1",
    "SELECT 1 FROM wg_v2_admission_proposals WHERE organization_id = ? AND owner_user_id = ? AND lifecycle = 'planning' LIMIT 1",
    "SELECT 1 FROM wg_v2_outbox WHERE organization_id = ? AND owner_user_id = ? AND status != 'completed' LIMIT 1",
    "SELECT 1 FROM wg_v2_due_jobs WHERE organization_id = ? AND owner_user_id = ? AND status NOT IN ('completed', 'cancelled', 'attention', 'failed_terminal') LIMIT 1",
    "SELECT 1 FROM wg_v2_streams WHERE organization_id = ? AND owner_user_id = ? AND envelope_identity_json IS NOT NULL LIMIT 1",
    "SELECT 1 FROM wg_v2_streams WHERE organization_id = ? AND owner_user_id = ? AND replacement_reset_json IS NOT NULL AND json_extract(replacement_reset_json, '$.state') != 'completed' LIMIT 1",
  ]
  if (checks.some((query) => database.prepare(query).get(context.organizationId, context.ownerUserId))) {
    throw new WorkGraphArchiveRestoreError("not_quiescent")
  }
}

function assertCanonicalCoverage(database: Database, context: WorkGraphContext) {
  const unsupported = ownerTables.find((table) => !supportedTables.has(table) && hasOwnerRow(database, table, context))
  if (unsupported) throw new WorkGraphArchiveRestoreError("target_incompatible")
  const invalidRuntimeEffect = database.prepare(`
    SELECT 1 FROM wg_v2_runtime_effects
    WHERE organization_id = ? AND owner_user_id = ? AND state = 'completed' AND (completed_at IS NULL OR last_error IS NOT NULL)
    LIMIT 1
  `).get(context.organizationId, context.ownerUserId)
  if (invalidRuntimeEffect) throw new WorkGraphArchiveRestoreError("target_incompatible")
  rows(database, "wg_v2_stream_sequences", context).forEach((row) => {
    const scope = string(row.stream_id)
    const maximum = (scope === ownerEventScopeId
      ? database.prepare(`
          SELECT COALESCE(MAX(sequence), 0) AS value FROM wg_v2_events
          WHERE organization_id = ? AND owner_user_id = ? AND stream_id IS NULL
        `).get(context.organizationId, context.ownerUserId)
      : database.prepare(`
          SELECT COALESCE(MAX(sequence), 0) AS value FROM wg_v2_events
          WHERE organization_id = ? AND owner_user_id = ? AND stream_id = ?
        `).get(context.organizationId, context.ownerUserId, scope)) as { value: number }
    if (integer(row.next_sequence) !== integer(maximum.value) + 1) {
      throw new WorkGraphArchiveRestoreError("target_incompatible")
    }
  })
  const cursor = rows(database, "wg_v2_change_cursors", context)[0]
  if (!cursor) return
  const maximum = database.prepare(`
    SELECT COALESCE(MAX(cursor), 0) AS value FROM wg_v2_changes WHERE organization_id = ? AND owner_user_id = ?
  `).get(context.organizationId, context.ownerUserId) as { value: number }
  if (integer(cursor.next_cursor) !== integer(maximum.value) + 1) {
    throw new WorkGraphArchiveRestoreError("target_incompatible")
  }
}

function validateReferences(records: CanonicalWorkGraphArchiveRecord[]) {
  const identities = new Set(records.map((record) => `${record.kind}:${record.id}`))
  const require = (kind: string, id: string) => {
    if (!identities.has(`${kind}:${id}`)) throw new WorkGraphArchiveRestoreError("malformed")
  }
  const revisions = new Map(records.filter(kind("work_source_revision")).map((record) => [record.id, record]))
  const requireSourceReference = (reference: Readonly<{ workSourceId: string; revisionId: string; contentHash: string }>) => {
    require("work_source", reference.workSourceId)
    require("work_source_revision", reference.revisionId)
    const revision = revisions.get(reference.revisionId)
    if (!revision || revision.value.workSourceId !== reference.workSourceId || revision.value.contentHash !== reference.contentHash) {
      throw new WorkGraphArchiveRestoreError("malformed")
    }
  }
  const requireSourceReferences = (record: { value: { sourceRevisionRefs: readonly { workSourceId: string; revisionId: string; contentHash: string }[] } }) => {
    record.value.sourceRevisionRefs.forEach(requireSourceReference)
  }
  records.forEach((record) => {
    if (record.kind === "work_source") {
      require("workgraph", record.value.workgraphId)
      require("work_source_revision", record.value.latestRevisionId)
      const latest = revisions.get(record.value.latestRevisionId)
      if (!latest || latest.value.workSourceId !== record.id || latest.value.revisionNumber !== record.value.revisionCount) {
        throw new WorkGraphArchiveRestoreError("malformed")
      }
    }
    if (record.kind === "work_source_revision") require("work_source", record.value.workSourceId)
    if (record.kind === "source_view") require("workgraph", record.value.workgraphId)
    if (record.kind === "intake_candidate") {
      require("workgraph", record.value.workgraphId)
      if (record.value.candidateKind === "external_issue") require("source_view", record.value.sourceViewId)
      if (record.value.source) {
        require("work_source", record.value.source.workSourceId)
        require("work_source_revision", record.value.source.revisionId)
      }
      if (record.value.admissionProposalId) require("admission_proposal", record.value.admissionProposalId)
    }
    if (record.kind === "external_identity" && record.value.intakeCandidateId) {
      require("intake_candidate", record.value.intakeCandidateId)
    }
    if (record.kind === "stream") {
      require("workgraph", record.value.workgraphId)
      requireSourceReferences(record)
      if (record.value.activity.lastRecapId) require("recap", record.value.activity.lastRecapId)
      if (record.value.replacementReset) {
        if (record.value.replacementReset.state !== "completed") throw new WorkGraphArchiveRestoreError("not_quiescent")
        require("admission_proposal", record.value.replacementReset.proposalId)
        requireSourceReference(record.value.replacementReset.previousSource)
        requireSourceReference(record.value.replacementReset.source)
        if (![record.value.replacementReset.previousSource, record.value.replacementReset.source].every((reference) =>
          record.value.sourceRevisionRefs.some((source) => source.workSourceId === reference.workSourceId &&
            source.revisionId === reference.revisionId && source.contentHash === reference.contentHash))) {
          throw new WorkGraphArchiveRestoreError("malformed")
        }
      }
    }
    if (record.kind === "outcome") {
      require("stream", record.value.streamId)
      record.value.evidenceIds.forEach((id) => require("evidence", id))
      requireSourceReferences(record)
    }
    if (record.kind === "work_item") {
      require("stream", record.value.streamId)
      if (record.value.outcomeId) require("outcome", record.value.outcomeId)
      record.value.dependencyIds.forEach((id) => require("work_item", id))
      record.value.evidenceIds.forEach((id) => require("evidence", id))
      requireSourceReferences(record)
    }
    if (record.kind === "work_item_dependency") {
      require("work_item", record.value.workItemId)
      require("work_item", record.value.dependsOnWorkItemId)
    }
    if (record.kind === "attempt") {
      require("stream", record.value.streamId)
      require("work_item", record.value.workItemId)
      requireSourceReferences(record)
    }
    if (record.kind === "session_binding") {
      require("stream", record.value.streamId)
      if (record.value.currentWorkItemId) require("work_item", record.value.currentWorkItemId)
      if (record.value.currentAttemptId) require("attempt", record.value.currentAttemptId)
    }
    if (record.kind === "agent_checkpoint") {
      require("stream", record.value.streamId)
      require("work_item", record.value.workItemId)
      require("attempt", record.value.attemptId)
      require("session_binding", record.value.sessionBindingId)
      record.value.evidenceIds.forEach((id) => require("evidence", id))
    }
    if (record.kind === "decision") {
      require("stream", record.value.streamId)
      record.value.affectedWorkItemIds.forEach((id) => require("work_item", id))
      requireSourceReferences(record)
    }
    if (record.kind === "decision_work_item") {
      require("decision", record.value.decisionId)
      require("work_item", record.value.workItemId)
    }
    if (record.kind === "evidence") {
      require(record.value.subject.type, subjectId(record.value.subject))
      if (record.value.sourceAttemptId) require("attempt", record.value.sourceAttemptId)
      if (record.value.kind === "integration" && record.value.durableEffectReceiptId) {
        require("durable_effect_receipt", record.value.durableEffectReceiptId)
      }
    }
    if (record.kind === "durable_effect_receipt") {
      require("stream", record.value.streamId)
      if (record.value.attemptId) require("attempt", record.value.attemptId)
    }
    if (record.kind === "recap") {
      require("stream", record.value.streamId)
      if (record.value.previousRecapId) require("recap", record.value.previousRecapId)
      record.value.actionableReferences.forEach((reference) => require(reference.type, reference.id))
      requireSourceReferences(record)
    }
    if (record.kind === "notification") {
      require("stream", record.value.streamId)
      require("recap", record.value.recapId)
    }
    if (record.kind === "record_source_revision") {
      require(record.value.recordType, record.value.recordId)
      const revision = revisions.get(record.value.sourceRevisionId)
      if (!revision || revision.value.workSourceId !== record.value.workSourceId) {
        throw new WorkGraphArchiveRestoreError("malformed")
      }
    }
    if (record.kind === "admission_proposal") {
      require("workgraph", record.value.workgraphId)
      requireSourceReference(record.value.source)
      if (record.value.previousSource) requireSourceReference(record.value.previousSource)
      if (record.value.intakeCandidateId) require("intake_candidate", record.value.intakeCandidateId)
      if (record.value.planningEvidence.targetStreamId) require("stream", record.value.planningEvidence.targetStreamId)
      record.value.planningEvidence.placementMatches.forEach((match) => require("stream", match.streamId))
      record.value.planningEvidence.duplicateMatches.forEach((match) => {
        require("stream", match.streamId)
        require(match.subject.type, match.subject.type === "outcome" ? match.subject.outcomeId : match.subject.workItemId)
      })
      if (record.value.state !== "planning" && record.value.state !== "planning_failed") {
        if (record.value.suggestedPlacement.mode === "existing") require("stream", record.value.suggestedPlacement.streamId)
        if (record.value.disposition) require("stream", record.value.disposition.streamId)
      }
    }
    if (record.kind === "event") require("operation_result", record.value.provenance.operationId)
    if (record.kind === "change") {
      require("event", record.value.eventId)
      require("operation_result", record.value.operationId)
    }
    if (record.kind === "completed_external_effect") require("operation_result", record.value.operationId)
    if (record.kind === "terminal_scheduled_job" && record.value.streamId) require("stream", record.value.streamId)
  })
  const workItems = records.filter(kind("work_item"))
  workItems.forEach((record) => {
    const related = records.filter(kind("work_item_dependency"))
      .filter((dependency) => dependency.value.workItemId === record.id)
      .map((dependency) => dependency.value.dependsOnWorkItemId)
    if (!sameMembers(record.value.dependencyIds, related)) throw new WorkGraphArchiveRestoreError("malformed")
  })
  const workItemStreams = new Map(workItems.map((record) => [record.id, record.value.streamId]))
  const attemptWorkItems = new Map(records.filter(kind("attempt")).map((record) => [record.id, record.value.workItemId]))
  records.filter(kind("session_binding")).forEach((record) => {
    if (record.value.currentWorkItemId && workItemStreams.get(record.value.currentWorkItemId) !== record.value.streamId) {
      throw new WorkGraphArchiveRestoreError("malformed")
    }
    if (record.value.currentAttemptId && attemptWorkItems.get(record.value.currentAttemptId) !== record.value.currentWorkItemId) {
      throw new WorkGraphArchiveRestoreError("malformed")
    }
  })
  const bindingStreams = new Map(records.filter(kind("session_binding")).map((record) => [record.id, record.value.streamId]))
  records.filter(kind("agent_checkpoint")).forEach((record) => {
    if (workItemStreams.get(record.value.workItemId) !== record.value.streamId ||
      attemptWorkItems.get(record.value.attemptId) !== record.value.workItemId ||
      bindingStreams.get(record.value.sessionBindingId) !== record.value.streamId) {
      throw new WorkGraphArchiveRestoreError("malformed")
    }
  })
  if (records.filter(kind("work_item_dependency")).some((record) =>
    workItemStreams.get(record.value.workItemId) !== workItemStreams.get(record.value.dependsOnWorkItemId))) {
    throw new WorkGraphArchiveRestoreError("malformed")
  }
  if (dependencyGraphHasCycle(workItems.map((record) => ({
    id: record.id,
    dependencyIds: record.value.dependencyIds,
  })))) {
    throw new WorkGraphArchiveRestoreError("malformed")
  }
  records.filter(kind("decision")).forEach((record) => {
    const related = records.filter(kind("decision_work_item"))
      .filter((link) => link.value.decisionId === record.id)
      .map((link) => link.value.workItemId)
    if (!sameMembers(record.value.affectedWorkItemIds, related)) throw new WorkGraphArchiveRestoreError("malformed")
  })
  records.filter(kind("stream")).forEach((record) => {
    const count = records.filter(kind("durable_effect_receipt"))
      .filter((receipt) => receipt.value.streamId === record.id).length
    if (record.value.durableEffectCount !== count) throw new WorkGraphArchiveRestoreError("malformed")
  })
  records.filter(kind("record_source_revision")).forEach((reference) => {
    const record = records.find((candidate) => candidate.kind === reference.value.recordType && candidate.id === reference.value.recordId)
    if (!record || !["stream", "outcome", "work_item", "attempt", "decision", "recap"].includes(record.kind)) {
      throw new WorkGraphArchiveRestoreError("malformed")
    }
    if (!("sourceRevisionRefs" in record.value) || !record.value.sourceRevisionRefs.some((source) =>
      source.workSourceId === reference.value.workSourceId && source.revisionId === reference.value.sourceRevisionId,
    )) throw new WorkGraphArchiveRestoreError("malformed")
  })
  records.filter((record): record is Extract<CanonicalWorkGraphArchiveRecord, {
    kind: "stream" | "outcome" | "work_item" | "attempt" | "decision" | "recap"
  }> => ["stream", "outcome", "work_item", "attempt", "decision", "recap"].includes(record.kind)).forEach((record) => {
    record.value.sourceRevisionRefs.forEach((source) => {
      if (!records.filter(kind("record_source_revision")).some((reference) =>
        reference.value.recordType === record.kind && reference.value.recordId === record.id &&
        reference.value.workSourceId === source.workSourceId && reference.value.sourceRevisionId === source.revisionId,
      )) throw new WorkGraphArchiveRestoreError("malformed")
    })
  })
}

async function validateDependencies(
  context: WorkGraphContext,
  records: CanonicalWorkGraphArchiveRecord[],
  dependencies: Parameters<typeof createSqliteWorkGraphArchivePort>[2],
) {
  const connectionIds = new Set(records.flatMap((record) => {
    if (record.kind === "source_view" || record.kind === "external_identity") return [record.value.teamConnectionId]
    return []
  }))
  if (connectionIds.size === 0) return
  if (!dependencies) throw new WorkGraphArchiveRestoreError("dependency_unavailable")
  const available = await Promise.all([...connectionIds].map((connectionId) => dependencies.connectionAvailable(context, connectionId)))
  if (available.some((value) => !value)) throw new WorkGraphArchiveRestoreError("dependency_unavailable")
}

function candidateState(
  database: Database,
  context: WorkGraphContext,
  row: Record<string, unknown>,
  normalized: Record<string, unknown>,
) {
  if (typeof normalized.admissionProposalId !== "string" || !isObject(normalized.source)) return string(row.status)
  const source = normalized.source
  const confirmed = database.prepare(`
    SELECT 1 AS present FROM wg_v2_admission_proposals proposals
    JOIN wg_v2_work_source_revisions revisions
      ON revisions.organization_id = proposals.organization_id AND revisions.owner_user_id = proposals.owner_user_id AND revisions.id = proposals.source_revision_id
    WHERE proposals.organization_id = ? AND proposals.owner_user_id = ? AND proposals.id = ? AND proposals.intake_candidate_id = ?
      AND proposals.lifecycle = 'confirmed' AND revisions.work_source_id = ?
      AND revisions.id = ? AND revisions.content_hash = ?
  `).get(
    context.organizationId, context.ownerUserId,
    normalized.admissionProposalId,
    id(row),
    source.workSourceId,
    source.revisionId,
    source.contentHash,
  )
  return confirmed ? "confirmed" : string(row.status)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function publicValue(record: { recordType: string; ownerUserId: string; id: string } & Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !["recordType", "ownerUserId", "id"].includes(key)))
}

function rebuildAllocators(database: Database, context: WorkGraphContext, records: CanonicalWorkGraphArchiveRecord[], now: number) {
  const sequences = new Map<string, number>()
  records.filter(kind("event")).forEach((record) => {
    const scope = record.value.streamId ?? ownerEventScopeId
    sequences.set(scope, Math.max(sequences.get(scope) ?? 0, record.value.sequence))
  })
  sequences.forEach((sequence, streamId) => database.prepare(`
    INSERT INTO wg_v2_stream_sequences
      (organization_id, owner_user_id, stream_id, next_sequence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(context.organizationId, context.ownerUserId, streamId, sequence + 1, now, now))
  const cursor = Math.max(0, ...records.filter(kind("change")).map((record) =>
    readChangeCursor(record.value.cursor, context.organizationId, context.ownerUserId)))
  if (cursor === 0) return
  database.prepare(`
    INSERT INTO wg_v2_change_cursors (organization_id, owner_user_id, next_cursor, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(context.organizationId, context.ownerUserId, cursor + 1, now, now)
}

function provenance(database: Database, context: WorkGraphContext, resourceType: string, resourceId: string) {
  const row = database.prepare(`
    SELECT events.actor_type, events.actor_id, events.operation_id
    FROM wg_v2_changes changes
    JOIN wg_v2_events events ON events.organization_id = changes.organization_id AND events.owner_user_id = changes.owner_user_id AND events.operation_id = changes.operation_id
    WHERE changes.organization_id = ? AND changes.owner_user_id = ? AND changes.resource_type = ? AND changes.resource_id = ?
    ORDER BY changes.cursor DESC LIMIT 1
  `).get(context.organizationId, context.ownerUserId, resourceType, resourceId) as {
    actor_type: WorkGraphActor["type"]
    actor_id: string
    operation_id: string
  } | undefined
  if (!row) return { actor: { type: "user" as const, id: context.ownerUserId } }
  return { actor: { type: row.actor_type, id: row.actor_id }, operationId: row.operation_id }
}

function rows(database: Database, table: string, context: WorkGraphContext) {
  return database.prepare(`SELECT * FROM ${table} WHERE organization_id = ? AND owner_user_id = ?`).all(context.organizationId, context.ownerUserId) as Array<Record<string, unknown>>
}

function hasOwnerRow(database: Database, table: string, context: WorkGraphContext) {
  return !!database.prepare(`SELECT 1 AS present FROM ${table} WHERE organization_id = ? AND owner_user_id = ? LIMIT 1`).get(context.organizationId, context.ownerUserId)
}

function snapshotRelevantChange(changeType: string) {
  return !["session_bound", "agent_checkpoint_recorded", "session_binding_released"].includes(changeType)
}

function kind<Kind extends CanonicalWorkGraphArchiveRecord["kind"]>(value: Kind) {
  return (record: CanonicalWorkGraphArchiveRecord): record is Extract<CanonicalWorkGraphArchiveRecord, { kind: Kind }> => record.kind === value
}

function workSourceOriginReference(origin: WorkSourceOrigin) {
  if (origin.kind === "manual") return null
  if (origin.kind === "authoring") return JSON.stringify({
    adapterId: origin.adapterId,
    projectId: origin.projectId,
    documentId: origin.documentId,
    documentRevisionId: origin.documentRevisionId,
    documentRevisionNumber: origin.documentRevisionNumber,
    ...(origin.parentDocumentRevisionId ? { parentDocumentRevisionId: origin.parentDocumentRevisionId } : {}),
    authoredAt: origin.authoredAt,
    authoredBy: origin.authoredBy,
    contentHash: origin.contentHash,
  })
  return JSON.stringify({
    provider: origin.provider,
    externalId: origin.externalId,
    externalRevision: origin.externalRevision,
    ...(origin.url === undefined ? {} : { url: origin.url }),
  })
}

function requireOwner(context: WorkGraphContext) {
  if (context.access.mode !== "owner") throw new WorkGraphArchiveRestoreError("cross_owner")
}

function id(row: Record<string, unknown>) {
  return string(row.id)
}

function string(value: unknown) {
  if (typeof value !== "string" || !value) throw new WorkGraphArchiveRestoreError("target_incompatible")
  return value
}

function integer(value: unknown) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new WorkGraphArchiveRestoreError("target_incompatible")
  return parsed
}

function timestamp(value: unknown) {
  return integer(value)
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new WorkGraphArchiveRestoreError("target_incompatible")
  }
}

function json(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WorkGraphArchiveRestoreError("target_incompatible")
  return parsed as Record<string, unknown>
}

function array(value: unknown) {
  const parsed = jsonValue(value)
  if (!Array.isArray(parsed)) throw new WorkGraphArchiveRestoreError("target_incompatible")
  return parsed
}

function sameMembers(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index])
}

function restoreResult(value: string): WorkGraphArchiveRestoreResult {
  const parsed = JSON.parse(value) as Record<string, unknown>
  if (parsed.restored !== true || !Number.isInteger(parsed.recordCount) || Number(parsed.recordCount) < 0) {
    throw new WorkGraphArchiveRestoreError("malformed")
  }
  return {
    restored: true,
    recordCount: Number(parsed.recordCount),
    baselineCursor: ChangeCursorSchema.parse(parsed.baselineCursor),
  }
}

type Database = NonNullable<ReturnType<ReturnType<typeof initializeWorkGraphSqliteSchema>["raw"]>>
