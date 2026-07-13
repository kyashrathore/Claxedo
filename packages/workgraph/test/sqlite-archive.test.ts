import BetterSqlite3 from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import { createSqliteIntakeStores, createSqliteWorkGraphArchivePort, createSqliteWorkGraphService } from "../src"
import { WorkGraphArchiveRestoreError, type OperationID, type StreamID, type WorkGraphContext } from "../src/contracts"

const databases: BetterSqlite3.Database[] = []

afterEach(() => databases.splice(0).forEach((database) => database.close()))

describe("SQLite canonical WorkGraph archive", () => {
  it("restores change history and advances the next command beyond the archive baseline", async () => {
    const source = database()
    const target = database()
    let sourceId = 0
    const sourceService = createSqliteWorkGraphService({
      database: source,
      clock: { now: () => 1_000 + sourceId },
      ids: { next: (kind) => `${kind}_source_${++sourceId}` },
    }).service
    await sourceService.execute(owner(), {
      operationId: operation("source_stream"),
      command: { version: 1, type: "create_stream", title: "Portable Stream" },
    })
    await sourceService.execute(owner(), {
      operationId: operation("source_document"),
      command: { version: 1, type: "create_work_source", title: "Plan", content: "Preserve this source exactly." },
    })
    const stream = await sourceService.query(owner(), "streams", "read", { streamId: "stream_source_1" as StreamID })
    if (!stream) throw new Error("Expected portable Stream")
    const outcome = await sourceService.execute(owner(), {
      operationId: operation("source_outcome"),
      command: { version: 1, type: "create_outcome", streamId: stream.id, title: "Cloud ships", successCriteria: ["Smoke passes"] },
    })
    if (!outcome.ok || typeof outcome.value !== "object" || !outcome.value || Array.isArray(outcome.value)) throw new Error("Expected Outcome")
    const firstTask = await sourceService.execute(owner(), {
      operationId: operation("source_task_1"),
      command: {
        version: 1,
        type: "create_work_item",
        streamId: stream.id,
        outcomeId: outcome.value.outcomeId as never,
        title: "Deploy",
        completionContract: completion("deploy-proof"),
      },
    })
    if (!firstTask.ok || typeof firstTask.value !== "object" || !firstTask.value || Array.isArray(firstTask.value)) throw new Error("Expected Task")
    await sourceService.execute(owner(), {
      operationId: operation("source_task_2"),
      command: {
        version: 1,
        type: "create_work_item",
        streamId: stream.id,
        outcomeId: outcome.value.outcomeId as never,
        title: "Announce",
        dependencyIds: [firstTask.value.workItemId as never],
        completionContract: completion("announce-proof"),
      },
    })

    const archive = await createSqliteWorkGraphArchivePort(source, { now: () => 2_000 }).export(owner())
    const restored = await createSqliteWorkGraphArchivePort(target, { now: () => 3_000 }).restore(owner(), {
      operationId: operation("restore"),
      archive,
    })
    await expect(createSqliteWorkGraphArchivePort(target).export(owner())).resolves.toMatchObject({ records: archive.records })
    let targetId = 0
    const targetService = createSqliteWorkGraphService({
      database: target,
      clock: { now: () => 4_000 },
      ids: { next: (kind) => `${kind}_target_${++targetId}` },
    }).service
    const next = await targetService.execute(owner(), {
      operationId: operation("after_restore"),
      command: { version: 1, type: "create_stream", title: "Next Stream" },
    })

    expect(next).toMatchObject({ ok: true })
    if (!next.ok) throw new Error("Expected command after restore")
    expect(Number(next.cursor)).toBe(Number(restored.baselineCursor) + 1)
    await expect(targetService.query(owner(), "changes", "list", { after: restored.baselineCursor, limit: 10 }))
      .resolves.toHaveLength(1)
    await expect(targetService.execute(owner(), {
      operationId: operation("after_restore_owner_event"),
      command: { version: 1, type: "create_work_source", title: "Next source", content: "Owner sequence continues." },
    })).resolves.toMatchObject({ ok: true })
  })

  it("rejects live execution state instead of exporting an unsafe archive", async () => {
    const source = database()
    const service = createSqliteWorkGraphService({ database: source, ids: { next: (kind) => `${kind}_live` } }).service
    const created = await service.execute(owner(), {
      operationId: operation("live_stream"),
      command: { version: 1, type: "create_stream", title: "Live Stream" },
    })
    if (!created.ok || typeof created.value !== "object" || !created.value || Array.isArray(created.value)) throw new Error("Expected Stream")
    const streamId = created.value.streamId as StreamID
    source.prepare(`
      INSERT INTO wg_v2_work_items
        (owner_user_id, id, stream_id, title, lifecycle, completion_contract_json, created_at, updated_at)
      VALUES ('owner', 'item_live', ?, 'Running Task', 'active',
        '{"version":1,"mode":"all","requirements":[{"id":"proof","kind":"test","description":"Pass"}]}', 1, 1)
    `).run(streamId)
    source.prepare(`
      INSERT INTO wg_v2_attempts
        (owner_user_id, id, stream_id, work_item_id, attempt_number, lifecycle,
         resolved_execution_profile_json, created_at, updated_at)
      VALUES ('owner', 'attempt_live', ?, 'item_live', 1, 'running', '{}', 1, 1)
    `).run(streamId)

    await expect(createSqliteWorkGraphArchivePort(source).export(owner()))
      .rejects.toMatchObject({ reason: "not_quiescent" })
  })

  it("rejects owner state without a canonical mapping instead of emitting a partial archive", async () => {
    const source = database()
    let id = 0
    const service = createSqliteWorkGraphService({ database: source, ids: { next: (kind) => `${kind}_${++id}` } }).service
    const created = await service.execute(owner(), {
      operationId: operation("unsupported_stream"),
      command: { version: 1, type: "create_stream", title: "Stream" },
    })
    if (!created.ok || typeof created.value !== "object" || !created.value || Array.isArray(created.value)) throw new Error("Expected Stream")
    source.prepare(`
      INSERT INTO wg_v2_stream_cleanup_reservations
        (owner_user_id, stream_id, operation_id, expected_version, cleanup_mode, state, created_at, updated_at)
      VALUES ('owner', 'stream_1', 'cleanup_unsupported', 1, 'close', 'completed', 1, 1)
    `).run()

    await expect(createSqliteWorkGraphArchivePort(source).export(owner()))
      .rejects.toEqual(expect.objectContaining<Partial<WorkGraphArchiveRestoreError>>({ reason: "target_incompatible" }))
  })

  it("round-trips personal Source Views and discovered candidates only when their team Connection resolves", async () => {
    const source = database()
    const target = database()
    const unavailable = database()
    const service = createSqliteWorkGraphService({ database: source, ids: { next: (kind) => `${kind}_source_view` } }).service
    await service.execute(owner(), {
      operationId: operation("source_view_root"),
      command: { version: 1, type: "create_stream", title: "Connected work" },
    })
    source.prepare(`
      INSERT INTO wg_v2_source_views
        (owner_user_id, id, workgraph_id, team_connection_id, provider, provider_user_id,
         filters_json, sync_policy, status, created_at, updated_at)
      VALUES ('owner', 'source_view_1', 'workgraph_default', 'connection_team', 'github', 'yash',
        '{"repo":"claxedo/claxedo","state":"open"}', 'announce', 'active', 10, 11)
    `).run()
    source.prepare(`
      INSERT INTO wg_v2_intake_candidates
        (owner_user_id, id, workgraph_id, source_view_id, candidate_kind, title, body,
         normalized_json, status, observed_revision, created_at, updated_at)
      VALUES ('owner', 'candidate_1', 'workgraph_default', 'source_view_1', 'external_issue',
        'Fix Cloud', 'Issue body',
        '{"provider":"github","externalId":"123","externalKey":"CLX-123","externalUrl":"https://github.com/claxedo/claxedo/issues/123","externalStatus":"open"}',
        'unorganized', 'etag-1', 12, 13)
    `).run()
    source.prepare(`
      INSERT INTO wg_v2_external_identities
        (owner_user_id, id, intake_candidate_id, provider, team_connection_id, external_id,
         external_key, external_url, observed_revision, metadata_json, created_at, updated_at)
      VALUES ('owner', 'identity_1', 'candidate_1', 'github', 'connection_team', '123',
        'CLX-123', 'https://github.com/claxedo/claxedo/issues/123', 'etag-1', '{}', 12, 13)
    `).run()

    const archive = await createSqliteWorkGraphArchivePort(source).export(owner())
    await expect(createSqliteWorkGraphArchivePort(unavailable).restore(owner(), {
      operationId: operation("connection_missing"),
      archive,
    })).rejects.toMatchObject({ reason: "dependency_unavailable" })
    await createSqliteWorkGraphArchivePort(target, { now: () => 20 }, {
      connectionAvailable: async (_context, connectionId) => connectionId === "connection_team",
    }).restore(owner(), { operationId: operation("connection_restore"), archive })

    await expect(createSqliteWorkGraphArchivePort(target).export(owner())).resolves.toMatchObject({
      records: archive.records,
    })
    expect(unavailable.prepare("SELECT COUNT(*) AS count FROM wg_v2_source_views").get()).toEqual({ count: 0 })
  })

  it("round-trips terminal execution, review, provenance, recap, runtime, migration, and idempotency records", async () => {
    const source = database()
    const target = database()
    const sourceArchive = createSqliteWorkGraphArchivePort(source, { now: () => 500 })
    seedComprehensiveArchive(source)

    const archive = await sourceArchive.export(owner())
    expect(new Set(archive.records.map((record) => record.kind))).toEqual(new Set([
      "workgraph",
      "work_source",
      "work_source_revision",
      "stream",
      "outcome",
      "work_item",
      "attempt",
      "decision",
      "decision_work_item",
      "evidence",
      "durable_effect_receipt",
      "recap",
      "notification",
      "record_source_revision",
      "admission_proposal",
      "operation_result",
      "runtime_effect",
      "migration_intake",
      "completed_external_effect",
      "terminal_scheduled_job",
    ]))
    expect(archive.records.find((record) => record.kind === "attempt")?.value).toMatchObject({
      executionIdentity: {
        envelopeId: "envelope_1",
        childIsolationId: "child_1",
        sessionId: "session_attempt_1",
      },
    })
    expect(archive.records.find((record) => record.kind === "decision")?.value).toMatchObject({
      proposedBy: { type: "agent", id: "agent_1" },
      answer: { answeredBy: { type: "user", id: "owner" } },
    })
    expect(archive.records.find((record) => record.kind === "decision" && record.id === "decision_2")?.value).toMatchObject({
      proposedBy: { type: "system", id: "workgraph_agent" },
      dismissedAt: 10,
      dismissReason: "No longer relevant",
    })
    expect(archive.records.filter((record) => record.kind === "terminal_scheduled_job").map((record) => record.value.status))
      .toEqual(["attention", "completed"])

    await createSqliteWorkGraphArchivePort(target).restore(owner(), {
      operationId: operation("restore_comprehensive"),
      archive,
    })

    await expect(createSqliteWorkGraphArchivePort(target).export(owner())).resolves.toMatchObject({ records: archive.records })
    await expect(createSqliteIntakeStores(target).receipts.begin(owner(), {
      key: "external_sync_key",
      candidateId: "candidate_external",
      effect: "announce",
    })).resolves.toEqual({ state: "completed" })
    expect(target.prepare("SELECT status FROM wg_v2_due_jobs ORDER BY id").all()).toEqual([
      { status: "failed_terminal" },
      { status: "completed" },
    ])
  })

  it("rejects retryable scheduled work and source revisions whose author was never persisted", async () => {
    const retryable = database()
    createSqliteWorkGraphArchivePort(retryable)
    retryable.prepare(`
      INSERT INTO wg_v2_workgraphs (owner_user_id, id, created_at, updated_at)
      VALUES ('owner', 'workgraph_default', 1, 1)
    `).run()
    retryable.prepare(`
      INSERT INTO wg_v2_due_jobs
        (owner_user_id, id, job_type, subject_id, due_at, status, payload_json, created_at, updated_at)
      VALUES ('owner', 'retryable_job', 'source_plan', 'proposal_1', 1, 'failed', '{}', 1, 1)
    `).run()
    await expect(createSqliteWorkGraphArchivePort(retryable).export(owner())).rejects.toMatchObject({ reason: "not_quiescent" })

    const unknownAuthor = database()
    createSqliteWorkGraphArchivePort(unknownAuthor)
    unknownAuthor.exec(`
      INSERT INTO wg_v2_workgraphs (owner_user_id, id, created_at, updated_at)
      VALUES ('owner', 'workgraph_default', 1, 1);
      INSERT INTO wg_v2_work_sources
        (owner_user_id, id, workgraph_id, title, latest_revision_number, created_at, updated_at)
      VALUES ('owner', 'source_unknown', 'workgraph_default', 'Unknown author', 1, 1, 1);
      INSERT INTO wg_v2_work_source_revisions
        (owner_user_id, id, work_source_id, revision_number, content, content_hash, origin_kind, created_at)
      VALUES ('owner', 'revision_unknown', 'source_unknown', 1, 'hello',
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', 'manual', 1);
    `)
    await expect(createSqliteWorkGraphArchivePort(unknownAuthor).export(owner())).rejects.toMatchObject({ reason: "target_incompatible" })
  })
})

function seedComprehensiveArchive(database: BetterSqlite3.Database) {
  database.exec(`
    INSERT INTO wg_v2_workgraphs
      (owner_user_id, id, defaults_json, recap_defaults_json, created_at, updated_at)
    VALUES ('owner', 'workgraph_default', '{}', '{}', 1, 2);

    INSERT INTO wg_v2_work_sources
      (owner_user_id, id, workgraph_id, title, source_kind, metadata_json, latest_revision_number, created_at, updated_at)
    VALUES ('owner', 'source_1', 'workgraph_default', 'Launch plan', 'manual', '{}', 1, 1, 2);

    INSERT INTO wg_v2_work_source_revisions
      (owner_user_id, id, work_source_id, revision_number, content, content_hash, origin_kind, created_by_json, created_at)
    VALUES ('owner', 'revision_1', 'source_1', 1, 'hello',
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      'manual', '{"type":"user","id":"owner"}', 1);

    INSERT INTO wg_v2_streams
      (owner_user_id, id, workgraph_id, title, purpose, lifecycle, execution_defaults_json,
       recap_defaults_json, memory_card_json, last_activity_at, created_at, updated_at)
    VALUES ('owner', 'stream_1', 'workgraph_default', 'Ship Cloud', 'Ship Cloud', 'active',
      '{}', '{}', '{}', 10, 1, 10);

    INSERT INTO wg_v2_outcomes
      (owner_user_id, id, stream_id, title, description, lifecycle, success_criteria_json,
       execution_defaults_json, created_at, updated_at)
    VALUES ('owner', 'outcome_1', 'stream_1', 'Cloud ships', '', 'active', '["Deployed"]', '{}', 2, 10);

    INSERT INTO wg_v2_work_items
      (owner_user_id, id, stream_id, outcome_id, title, description, lifecycle, priority,
       execution_overrides_json, completion_contract_json, completed_at, created_at, updated_at)
    VALUES ('owner', 'work_item_1', 'stream_1', 'outcome_1', 'Deploy', '', 'result_ready', 0, '{}',
      '{"version":1,"mode":"all","requirements":[{"id":"proof","kind":"integration","description":"Merged"}]}',
      NULL, 3, 10);

    INSERT INTO wg_v2_attempts
      (owner_user_id, id, stream_id, work_item_id, attempt_number, lifecycle,
       resolved_execution_profile_json, envelope_id, child_workspace_id, session_id,
       terminal_result_json, row_version, created_at, updated_at, started_at, finished_at)
    VALUES ('owner', 'attempt_1', 'stream_1', 'work_item_1', 1, 'result',
      '{"environment":{"kind":"local_worktree"},"harness":"opencode","agent":"build","model":{"providerId":"openai","modelId":"gpt-5"},"effort":"high","tools":[],"connectionIds":[],"isolation":"child","cleanup":"retain","integration":"pull_request"}',
      'envelope_1', 'child_1', 'session_attempt_1',
      '{"summary":"Implemented","artifactRefs":["pr:1"],"finishedAt":8}', 2, 4, 8, 5, 8);

    INSERT INTO wg_v2_decisions
      (owner_user_id, id, stream_id, question, options_json, recommendation_json, rationale,
       answer_json, lifecycle, proposed_by_json, answered_by_json, row_version, created_at, updated_at, answered_at)
    VALUES ('owner', 'decision_1', 'stream_1', 'Merge?', '[{"id":"yes","label":"Yes"}]',
      '{"optionId":"yes"}', 'Tests pass', '{"optionId":"yes"}', 'answered',
      '{"type":"agent","id":"agent_1"}', '{"type":"user","id":"owner"}', 2, 5, 9, 9);

    INSERT INTO wg_v2_decisions
      (owner_user_id, id, stream_id, question, options_json, answer_json, lifecycle,
       proposed_by_json, answered_by_json, row_version, created_at, updated_at, answered_at)
    VALUES ('owner', 'decision_2', 'stream_1', 'Keep experiment?', '[{"id":"yes","label":"Yes"}]',
      '{"dismissReason":"No longer relevant"}', 'dismissed',
      '{"type":"system","id":"workgraph_agent"}', '{"type":"user","id":"owner"}', 2, 6, 10, 10);

    INSERT INTO wg_v2_decision_work_items
      (owner_user_id, id, decision_id, work_item_id, created_at)
    VALUES ('owner', 'decision_link_1', 'decision_1', 'work_item_1', 5);

    INSERT INTO wg_v2_decision_work_items
      (owner_user_id, id, decision_id, work_item_id, created_at)
    VALUES ('owner', 'decision_link_2', 'decision_2', 'work_item_1', 6);

    INSERT INTO wg_v2_operation_results
      (owner_user_id, id, command_type, request_hash, result_status, result_json, created_at)
    VALUES ('owner', 'operation_1', 'intake_external_sync',
      '0000000000000000000000000000000000000000000000000000000000000000', 200,
      '{"ok":true,"operationId":"operation_1","cursor":"0","value":{"claimed":true}}', 5);

    INSERT INTO wg_v2_durable_effect_receipts
      (owner_user_id, id, stream_id, attempt_id, effect_kind, idempotency_key,
       external_reference_json, provenance_json, created_at)
    VALUES ('owner', 'receipt_1', 'stream_1', 'attempt_1', 'merged', 'operation_1:integration',
      '{"reference":"https://example.com/pr/1"}',
      '{"actor":{"type":"agent","id":"agent_1"},"operationId":"operation_1"}', 8);

    INSERT INTO wg_v2_evidence
      (owner_user_id, id, stream_id, subject_type, subject_id, requirement_id, source_attempt_id,
       evidence_kind, summary, reference_json, provenance_json, created_at)
    VALUES ('owner', 'evidence_1', 'stream_1', 'work_item', 'work_item_1', 'proof', 'attempt_1',
      'integration', 'Merged PR',
      '{"kind":"integration","summary":"Merged PR","effect":"merged","reference":"https://example.com/pr/1"}',
      '{"actor":{"type":"agent","id":"agent_1"},"operationId":"operation_1","requestId":"request_1"}', 8);

    INSERT INTO wg_v2_recaps
      (owner_user_id, id, stream_id, activity_start_sequence, activity_end_sequence, quiet_since,
       summary, actionable_references_json, generation_profile_json, provenance_json,
       generation_result_json, created_at)
    VALUES ('owner', 'recap_1', 'stream_1', 1, 2, 10, 'Ready to merge',
      '[{"type":"work_item","id":"work_item_1"}]',
      '{"model":{"providerId":"openai","modelId":"gpt-5"},"effort":"medium"}',
      '{"actor":{"type":"agent","id":"recap_agent"}}',
      '{"state":"succeeded","generatedAt":11,"method":"agent_session","sessionId":"session_recap_1"}', 11);

    INSERT INTO wg_v2_notifications
      (owner_user_id, id, notification_kind, state, stream_id, recap_id, created_at, updated_at)
    VALUES ('owner', 'notification_1', 'actionable_recap', 'unread', 'stream_1', 'recap_1', 11, 11);

    INSERT INTO wg_v2_record_source_revisions
      (owner_user_id, id, record_type, record_id, work_source_id, source_revision_id, ordinal, created_at)
    VALUES ('owner', 'source_ref_1', 'stream', 'stream_1', 'source_1', 'revision_1', 0, 2);

    INSERT INTO wg_v2_admission_proposals
      (owner_user_id, id, workgraph_id, source_revision_id, proposal_kind, lifecycle,
       proposed_work_json, duplicate_matches_json, created_at, updated_at)
    VALUES ('owner', 'proposal_1', 'workgraph_default', 'revision_1', 'source', 'proposed',
      '{"source":{"workSourceId":"source_1","revisionId":"revision_1","contentHash":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"},"targetStreamId":"stream_1","generation":{"method":"agent_session","sessionId":"session_plan_1","generatedAt":6},"suggestedPlacement":{"mode":"existing","streamId":"stream_1"},"placementMatches":[],"outcomes":[],"workItems":[],"duplicateMatches":[]}',
      '[]', 6, 6);

    INSERT INTO wg_v2_runtime_effects
      (owner_user_id, id, effect_kind, resource_type, resource_id, idempotency_key,
       payload_json, state, attempt_count, created_at, updated_at, completed_at)
    VALUES ('owner', 'runtime_effect_1', 'integration', 'attempt', 'attempt_1', 'runtime_effect_key',
      '{"attemptId":"attempt_1"}', 'completed', 1, 7, 8, 8);

    INSERT INTO wg_v2_migration_intake
      (owner_user_id, id, legacy_table, legacy_record_id, intake_kind, reason,
       raw_reference_json, status, resolution_json, created_at, updated_at)
    VALUES ('owner', 'migration_1', 'runs_current', 'run_1', 'work_mapping_review', 'Owner mapped it',
      '{"runId":"run_1"}', 'resolved', '{"streamId":"stream_1"}', 1, 9);

    INSERT INTO wg_v2_outbox
      (owner_user_id, id, operation_id, effect_type, idempotency_key, payload_json,
       status, available_at, attempt_count, created_at, updated_at)
    VALUES ('owner', 'external_effect_1', 'operation_1', 'intake_external_sync', 'external_sync_key',
      '{"candidateId":"candidate_external","effect":"announce"}', 'completed', 5, 1, 5, 8);

    INSERT INTO wg_v2_due_jobs
      (owner_user_id, id, stream_id, job_type, subject_id, due_at, status, payload_json,
       lease_epoch, last_error, created_at, updated_at)
    VALUES
      ('owner', 'job_completed', 'stream_1', 'recap', 'stream_1:2', 10, 'completed',
       '{"sessionId":"session_recap_1"}', 1, NULL, 10, 11),
      ('owner', 'job_attention', 'stream_1', 'source_plan', 'proposal_attention', 10, 'failed_terminal',
       '{"automaticFailureCount":3}', 2, 'Planning exhausted', 10, 12);
  `)
}

function database() {
  const value = new BetterSqlite3(":memory:")
  databases.push(value)
  return value
}

function owner(): WorkGraphContext {
  return {
    ownerUserId: branded("owner"),
    actor: { type: "user", id: branded("owner") },
    requestId: branded("request"),
    access: { mode: "owner" },
  }
}

function operation(value: string) {
  return branded<OperationID>(value)
}

function completion(id: string) {
  return {
    version: 1 as const,
    mode: "all" as const,
    requirements: [{ id: branded(id), kind: "test" as const, description: "Tests pass" }],
  }
}

function branded<Type>(value: string) {
  return value as Type
}
