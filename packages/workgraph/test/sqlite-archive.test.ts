import BetterSqlite3 from "better-sqlite3"
import { createHash } from "node:crypto"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createSqliteIntakeStores, createSqliteWorkGraphArchivePort, createSqliteWorkGraphService } from "../src"
import { createSqliteSourcePlanningRuntime } from "../src/adapters/sqlite/source-planning-runtime"
import {
  CompletionContractSchema,
  readChangeCursor,
  WorkGraphArchiveSchema,
  WorkGraphArchiveRestoreError,
  type AdmissionAgentPlan,
  type OperationID,
  type StreamID,
  type WorkGraphContext,
  type WorkSourceRevisionRef,
} from "../src/contracts"
import type { WorkspaceExecutionPort } from "../src/ports"

const databases: BetterSqlite3.Database[] = []
const databaseFiles: string[] = []
const planningProfile = {
  environment: { kind: "local_worktree" as const },
  repository: { baseRevision: "HEAD" },
  harness: "claxedo-v2",
  agent: "build",
  model: { providerId: "openai", modelId: "gpt-5" },
  effort: "high",
}
const capabilityPort = {
  read: async (context: WorkGraphContext) => {
    const observedAt = Date.now()
    return {
    schemaVersion: 1 as const,
    organizationId: context.organizationId,
    ownerUserId: context.ownerUserId,
    catalogRevision: "e".repeat(64),
    observedAt,
    expiresAt: observedAt + 300_000,
    environments: [{
      kind: "local_worktree" as const,
      repositoryRequired: true,
      remoteUrlInput: false,
      baseRevisionInput: true,
    }],
    harnesses: [{ id: "claxedo-v2" }],
    agents: [{ harnessId: "claxedo-v2", id: "build", label: "Build" }],
    models: [{ harnessId: "claxedo-v2", providerId: "openai", modelId: "gpt-5", label: "GPT-5", efforts: ["high"] }],
    tools: [],
    repository: { baseRevisions: ["HEAD"] },
    connections: [],
    }
  },
}
const archiveExecution: WorkspaceExecutionPort = {
  provisionOrAdopt: async (_context, input) => ({
    id: branded("archive_envelope"),
    streamId: input.streamId,
    environment: input.environment,
    repository: input.repository,
    workspaceId: "/repo",
  }),
  launch: async () => { throw new Error("Archive regression does not launch Sessions") },
  cancel: async () => undefined,
  result: async () => ({ state: "running" }),
  cleanup: async () => undefined,
}

afterEach(() => {
  databases.splice(0).forEach((database) => database.close())
  databaseFiles.splice(0).forEach((path) => rmSync(path, { force: true }))
})

describe("SQLite canonical WorkGraph archive", () => {
  it.each(["keep", "replace", "fork"] as const)("exports a revised Source proposal after its %s disposition is confirmed through public commands", async (mode) => {
    const source = database()
    let id = 0
    const service = createSqliteWorkGraphService({
      database: source,
      executionCapabilities: capabilityPort,
      execution: archiveExecution,
      clock: { now: () => 1_000 + id },
      ids: { next: (kind) => `${kind}_proposal_${++id}` },
    }).service
    const execute = (type: string, command: Record<string, unknown>) => service.execute(owner(), {
      operationId: operation(`proposal_${crypto.randomUUID()}`),
      command: { version: 1, type, ...command },
    } as never)
    const firstContent = "Initial launch document"
    const createdSource = await execute("create_work_source", { title: "Launch", content: firstContent })
    if (!createdSource.ok || typeof createdSource.value !== "object" || !createdSource.value || Array.isArray(createdSource.value)) {
      throw new Error("Expected Work Source")
    }
    const previousSource = {
      workSourceId: String(createdSource.value.workSourceId),
      revisionId: String(createdSource.value.revisionId),
      contentHash: createHash("sha256").update(firstContent).digest("hex"),
    } as WorkSourceRevisionRef
    const createdStream = await execute("create_stream", { title: "Launch", source: previousSource })
    if (!createdStream.ok || typeof createdStream.value !== "object" || !createdStream.value || Array.isArray(createdStream.value)) {
      throw new Error("Expected Stream")
    }
    const streamId = String(createdStream.value.streamId) as StreamID
    const workItem = mode === "replace"
      ? await execute("create_work_item", {
        streamId,
        source: previousSource,
        title: "Initial launch work",
        completionContract: completion("initial-work"),
      })
      : undefined
    if (workItem && (!workItem.ok || typeof workItem.value !== "object" || !workItem.value || Array.isArray(workItem.value))) {
      throw new Error("Expected Work Item")
    }
    const workItemId = workItem?.ok && typeof workItem.value === "object" && workItem.value && !Array.isArray(workItem.value)
      ? String(workItem.value.workItemId)
      : undefined
    const nextContent = `${firstContent}\nAdd rollout checks`
    const revisedSource = await execute("revise_work_source", {
      workSourceId: previousSource.workSourceId,
      expectedRevisionId: previousSource.revisionId,
      content: nextContent,
    })
    if (!revisedSource.ok || typeof revisedSource.value !== "object" || !revisedSource.value || Array.isArray(revisedSource.value)) {
      throw new Error("Expected revised Work Source")
    }
    const nextSource = {
      workSourceId: previousSource.workSourceId,
      revisionId: String(revisedSource.value.revisionId),
      contentHash: createHash("sha256").update(nextContent).digest("hex"),
    } as WorkSourceRevisionRef
    const proposed = await execute("propose_admission", { source: nextSource, targetStreamId: streamId })
    if (!proposed.ok || typeof proposed.value !== "object" || !proposed.value || Array.isArray(proposed.value)) {
      throw new Error("Expected admission proposal")
    }
    const plan = {
      source: nextSource,
      suggestedPlacement: { mode: "existing", streamId },
      placementMatches: [{ streamId, confidence: "high", score: 1, reason: "Exact target", evidence: ["Owner selected Stream"] }],
      proposedOutcomes: [],
      proposedWorkItems: [],
      duplicateMatches: [],
    } satisfies AdmissionAgentPlan
    await expect(execute("update_workgraph_defaults", {
      expectedVersion: 1,
      defaults: { execution: planningProfile, recap: {} },
    })).resolves.toMatchObject({ ok: true })
    await expect(createSqliteSourcePlanningRuntime({
      database: source,
      workerId: "archive-source-planner",
      sessionDirectory: "/repo",
      sessions: {
        async admit(input) { return String(input.sessionId) },
        async result() { return { state: "succeeded", summary: JSON.stringify(plan), artifacts: [] } },
      },
    }).runDue(owner())).resolves.toMatchObject({ state: "completed" })
    const publications = source.prepare(`
      SELECT id, request_hash, result_json FROM wg_v2_operation_results
      WHERE command_type = 'source_plan_publication' ORDER BY id
    `).all() as Array<{ id: string; request_hash: string; result_json: string }>
    expect(publications).toHaveLength(2)
    expect(publications.every((publication) => /^[a-f0-9]{64}$/i.test(publication.request_hash) &&
      (JSON.parse(publication.result_json) as { ok?: boolean }).ok === true)).toBe(true)
    const selection = mode === "keep"
      ? { mode, streamId }
      : mode === "fork"
        ? { mode, streamId, streamTitle: "Launch fork" }
        : {
          mode,
          streamId,
          workItems: [{ workItemId: workItemId!, expectedVersion: 1 }],
        }
    await expect(execute("confirm_admission", {
      proposalId: String(proposed.value.proposalId),
      expectedVersion: 3,
      source: nextSource,
      selection,
    })).resolves.toMatchObject({ ok: true })
    if (mode === "replace") {
      await vi.waitFor(() => {
        expect(source.prepare("SELECT state FROM wg_v2_runtime_effects WHERE effect_kind = 'reset_stream'").get())
          .toEqual({ state: "completed" })
      })
    }
    if (mode === "keep") {
      source.prepare(`
        UPDATE wg_v2_operation_results SET request_hash = id, result_json = '{}'
        WHERE command_type = 'source_plan_publication'
      `).run()
    }

    const archive = await createSqliteWorkGraphArchivePort(source).export(owner())
    expect(archive).toMatchObject({
      records: expect.arrayContaining([
        expect.objectContaining({
          kind: "admission_proposal",
          value: expect.objectContaining({
            state: "confirmed",
            disposition: expect.objectContaining({ selection }),
          }),
        }),
      ]),
    })
    const target = database()
    await createSqliteWorkGraphArchivePort(target).restore(owner(), {
      operationId: operation(`restore_${mode}`),
      archive,
    })
    await expect(createSqliteWorkGraphArchivePort(target).export(owner())).resolves.toMatchObject({ records: archive.records })
  })

  it("does not repair an uncorroborated source-planning publication receipt", async () => {
    const source = database()
    const service = createSqliteWorkGraphService({ database: source }).service
    await service.execute(owner(), {
      operationId: operation("create_repair_guard_stream"),
      command: { version: 1, type: "create_stream", title: "Repair guard" },
    })
    source.prepare(`
      INSERT INTO wg_v2_operation_results
        (organization_id, owner_user_id, id, command_type, request_hash, result_status, result_json, created_at)
      VALUES ('organization', 'owner', 'unverified_publication', 'source_plan_publication',
        'unverified_publication', 200, '{}', 1)
    `).run()

    await expect(createSqliteWorkGraphArchivePort(source).export(owner()))
      .rejects.toMatchObject({ reason: "target_incompatible" })
  })

  it("holds one read snapshot across archive checks and record export", async () => {
    const path = join(tmpdir(), `workgraph-archive-${crypto.randomUUID()}.sqlite`)
    databaseFiles.push(path)
    const source = new BetterSqlite3(path)
    const writer = new BetterSqlite3(path)
    databases.push(source, writer)
    source.pragma("journal_mode = DELETE")
    writer.pragma("busy_timeout = 0")
    const service = createSqliteWorkGraphService({ database: source }).service
    await service.execute(owner(), {
      operationId: operation("snapshot_stream"),
      command: { version: 1, type: "create_stream", title: "Snapshot title" },
    })
    let writeError: unknown

    const archive = await createSqliteWorkGraphArchivePort(source, {
      now: () => {
        try {
          writer.prepare(`
            UPDATE wg_v2_streams SET title = 'Changed during export'
            WHERE organization_id = 'organization' AND owner_user_id = 'owner'
          `).run()
        } catch (error) {
          writeError = error
        }
        return 2_000
      },
    }).export(owner())

    expect(writeError).toMatchObject({ code: "SQLITE_BUSY" })
    expect(archive.records.find((record) => record.kind === "stream")?.value.title).toBe("Snapshot title")
  })

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
    expect(readChangeCursor(next.cursor, owner().organizationId, owner().ownerUserId)).toBe(
      readChangeCursor(restored.baselineCursor, owner().organizationId, owner().ownerUserId) + 1,
    )
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
        (organization_id, owner_user_id, id, stream_id, title, lifecycle, completion_contract_json, created_at, updated_at)
      VALUES ('organization', 'owner', 'item_live', ?, 'Running Task', 'active',
        '{"version":1,"mode":"all","requirements":[{"id":"proof","kind":"test","description":"Pass"}]}', 1, 1)
    `).run(streamId)
    source.prepare(`
      INSERT INTO wg_v2_attempts
        (organization_id, owner_user_id, id, stream_id, work_item_id, attempt_number, lifecycle,
         resolved_execution_profile_json, created_at, updated_at)
      VALUES ('organization', 'owner', 'attempt_live', ?, 'item_live', 1, 'running', '{}', 1, 1)
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
        (organization_id, owner_user_id, stream_id, operation_id, expected_version, cleanup_mode, state, created_at, updated_at)
      VALUES ('organization', 'owner', 'stream_1', 'cleanup_unsupported', 1, 'close', 'completed', 1, 1)
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
        (organization_id, owner_user_id, id, workgraph_id, team_connection_id, provider, provider_user_id,
         filters_json, sync_policy, status, created_at, updated_at)
      VALUES ('organization', 'owner', 'source_view_1', 'workgraph_default', 'connection_team', 'github', 'yash',
        '{"repo":"claxedo/claxedo","state":"open"}', 'announce', 'active', 10, 11)
    `).run()
    source.prepare(`
      INSERT INTO wg_v2_intake_candidates
        (organization_id, owner_user_id, id, workgraph_id, source_view_id, candidate_kind, title, body,
         normalized_json, status, observed_revision, created_at, updated_at)
      VALUES ('organization', 'owner', 'candidate_1', 'workgraph_default', 'source_view_1', 'external_issue',
        'Fix Cloud', 'Issue body',
        '{"provider":"github","externalId":"123","externalKey":"CLX-123","externalUrl":"https://github.com/claxedo/claxedo/issues/123","externalStatus":"open"}',
        'unorganized', 'etag-1', 12, 13)
    `).run()
    source.prepare(`
      INSERT INTO wg_v2_external_identities
        (organization_id, owner_user_id, id, intake_candidate_id, provider, team_connection_id, external_id,
         external_key, external_url, observed_revision, metadata_json, created_at, updated_at)
      VALUES ('organization', 'owner', 'identity_1', 'candidate_1', 'github', 'connection_team', '123',
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
    expect(archive.records.find((record) => record.kind === "stream")?.value).toMatchObject({
      replacementReset: { state: "completed", proposalId: "proposal_1", completedAt: 9 },
    })

    const pendingArchive = WorkGraphArchiveSchema.parse({
      ...archive,
      records: archive.records.map((record) => record.kind !== "stream" ? record : {
        ...record,
        value: {
          ...record.value,
          replacementReset: {
            state: "pending",
            proposalId: "proposal_1",
            previousSource: {
              workSourceId: "source_1",
              revisionId: "revision_1",
              contentHash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            },
            source: {
              workSourceId: "source_1",
              revisionId: "revision_1",
              contentHash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            },
            requestedAt: 7,
          },
        },
      }),
    })
    await expect(createSqliteWorkGraphArchivePort(database()).restore(owner(), {
      operationId: operation("restore_pending_replacement"),
      archive: pendingArchive,
    })).rejects.toMatchObject({ reason: "not_quiescent" })

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
    source.prepare(`
      UPDATE wg_v2_streams SET replacement_reset_json = json_set(replacement_reset_json, '$.state', 'pending')
      WHERE organization_id = 'organization' AND owner_user_id = 'owner' AND id = 'stream_1'
    `).run()
    await expect(sourceArchive.export(owner())).rejects.toMatchObject({ reason: "not_quiescent" })
  })

  it("rejects retryable scheduled work and source revisions whose author was never persisted", async () => {
    const retryable = database()
    createSqliteWorkGraphArchivePort(retryable)
    retryable.prepare(`
      INSERT INTO wg_v2_workgraphs (organization_id, owner_user_id, id, created_at, updated_at)
      VALUES ('organization', 'owner', 'workgraph_default', 1, 1)
    `).run()
    retryable.prepare(`
      INSERT INTO wg_v2_due_jobs
        (organization_id, owner_user_id, id, job_type, subject_id, due_at, status, payload_json, created_at, updated_at)
      VALUES ('organization', 'owner', 'retryable_job', 'source_plan', 'proposal_1', 1, 'failed', '{}', 1, 1)
    `).run()
    await expect(createSqliteWorkGraphArchivePort(retryable).export(owner())).rejects.toMatchObject({ reason: "not_quiescent" })

    const unknownAuthor = database()
    createSqliteWorkGraphArchivePort(unknownAuthor)
    unknownAuthor.exec(`
      INSERT INTO wg_v2_workgraphs (organization_id, owner_user_id, id, created_at, updated_at)
      VALUES ('organization', 'owner', 'workgraph_default', 1, 1);
      INSERT INTO wg_v2_work_sources
        (organization_id, owner_user_id, id, workgraph_id, title, latest_revision_number, created_at, updated_at)
      VALUES ('organization', 'owner', 'source_unknown', 'workgraph_default', 'Unknown author', 1, 1, 1);
      INSERT INTO wg_v2_work_source_revisions
        (organization_id, owner_user_id, id, work_source_id, revision_number, content, content_hash, origin_kind, created_at)
      VALUES ('organization', 'owner', 'revision_unknown', 'source_unknown', 1, 'hello',
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', 'manual', 1);
    `)
    await expect(createSqliteWorkGraphArchivePort(unknownAuthor).export(owner())).rejects.toMatchObject({ reason: "target_incompatible" })
  })
})

function seedComprehensiveArchive(database: BetterSqlite3.Database) {
  database.exec(`
    INSERT INTO wg_v2_workgraphs
      (organization_id, owner_user_id, id, defaults_json, recap_defaults_json, created_at, updated_at)
    VALUES ('organization', 'owner', 'workgraph_default', '{}', '{}', 1, 2);

    INSERT INTO wg_v2_work_sources
      (organization_id, owner_user_id, id, workgraph_id, title, source_kind, metadata_json, latest_revision_number, created_at, updated_at)
    VALUES ('organization', 'owner', 'source_1', 'workgraph_default', 'Launch plan', 'manual', '{}', 1, 1, 2);

    INSERT INTO wg_v2_work_source_revisions
      (organization_id, owner_user_id, id, work_source_id, revision_number, content, content_hash, origin_kind, created_by_json, created_at)
    VALUES ('organization', 'owner', 'revision_1', 'source_1', 1, 'hello',
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      'manual', '{"type":"user","id":"owner"}', 1);

    INSERT INTO wg_v2_streams
      (organization_id, owner_user_id, id, workgraph_id, title, purpose, lifecycle, execution_defaults_json,
       recap_defaults_json, memory_card_json, last_activity_at, replacement_reset_json, created_at, updated_at)
    VALUES ('organization', 'owner', 'stream_1', 'workgraph_default', 'Ship Cloud', 'Ship Cloud', 'active',
      '{}', '{}', '{}', 10,
      '{"state":"completed","proposalId":"proposal_1","previousSource":{"workSourceId":"source_1","revisionId":"revision_1","contentHash":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"},"source":{"workSourceId":"source_1","revisionId":"revision_1","contentHash":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"},"requestedAt":7,"completedAt":9}',
      1, 10);

    INSERT INTO wg_v2_outcomes
      (organization_id, owner_user_id, id, stream_id, title, description, lifecycle, success_criteria_json,
       execution_defaults_json, created_at, updated_at)
    VALUES ('organization', 'owner', 'outcome_1', 'stream_1', 'Cloud ships', '', 'active', '["Deployed"]', '{}', 2, 10);

    INSERT INTO wg_v2_work_items
      (organization_id, owner_user_id, id, stream_id, outcome_id, title, description, lifecycle, priority,
       execution_overrides_json, completion_contract_json, completed_at, created_at, updated_at)
    VALUES ('organization', 'owner', 'work_item_1', 'stream_1', 'outcome_1', 'Deploy', '', 'result_ready', 0, '{}',
      '{"version":1,"mode":"all","requirements":[{"id":"proof","kind":"integration","description":"Merged"}]}',
      NULL, 3, 10);

    INSERT INTO wg_v2_attempts
      (organization_id, owner_user_id, id, stream_id, work_item_id, attempt_number, lifecycle,
       resolved_execution_profile_json, envelope_id, child_workspace_id, session_id,
       terminal_result_json, row_version, created_at, updated_at, started_at, finished_at)
    VALUES ('organization', 'owner', 'attempt_1', 'stream_1', 'work_item_1', 1, 'result',
      '{"environment":{"kind":"local_worktree"},"harness":"opencode","agent":"build","model":{"providerId":"openai","modelId":"gpt-5"},"effort":"high","tools":[],"connectionIds":[],"isolation":"child","cleanup":"retain","integration":"pull_request"}',
      'envelope_1', 'child_1', 'session_attempt_1',
      '{"summary":"Implemented","artifactRefs":["pr:1"],"finishedAt":8}', 2, 4, 8, 5, 8);

    INSERT INTO wg_v2_decisions
      (organization_id, owner_user_id, id, stream_id, question, options_json, recommendation_json, rationale,
       answer_json, lifecycle, proposed_by_json, answered_by_json, row_version, created_at, updated_at, answered_at)
    VALUES ('organization', 'owner', 'decision_1', 'stream_1', 'Merge?', '[{"id":"yes","label":"Yes"}]',
      '{"optionId":"yes"}', 'Tests pass', '{"optionId":"yes"}', 'answered',
      '{"type":"agent","id":"agent_1"}', '{"type":"user","id":"owner"}', 2, 5, 9, 9);

    INSERT INTO wg_v2_decisions
      (organization_id, owner_user_id, id, stream_id, question, options_json, answer_json, lifecycle,
       proposed_by_json, answered_by_json, row_version, created_at, updated_at, answered_at)
    VALUES ('organization', 'owner', 'decision_2', 'stream_1', 'Keep experiment?', '[{"id":"yes","label":"Yes"}]',
      '{"dismissReason":"No longer relevant"}', 'dismissed',
      '{"type":"system","id":"workgraph_agent"}', '{"type":"user","id":"owner"}', 2, 6, 10, 10);

    INSERT INTO wg_v2_decision_work_items
      (organization_id, owner_user_id, id, decision_id, work_item_id, created_at)
    VALUES ('organization', 'owner', 'decision_link_1', 'decision_1', 'work_item_1', 5);

    INSERT INTO wg_v2_decision_work_items
      (organization_id, owner_user_id, id, decision_id, work_item_id, created_at)
    VALUES ('organization', 'owner', 'decision_link_2', 'decision_2', 'work_item_1', 6);

    INSERT INTO wg_v2_operation_results
      (organization_id, owner_user_id, id, command_type, request_hash, result_status, result_json, created_at)
    VALUES ('organization', 'owner', 'operation_1', 'intake_external_sync',
      '0000000000000000000000000000000000000000000000000000000000000000', 200,
      '{"ok":true,"operationId":"operation_1","cursor":"0","value":{"claimed":true}}', 5);

    INSERT INTO wg_v2_durable_effect_receipts
      (organization_id, owner_user_id, id, stream_id, attempt_id, effect_kind, idempotency_key,
       external_reference_json, provenance_json, created_at)
    VALUES ('organization', 'owner', 'receipt_1', 'stream_1', 'attempt_1', 'merged', 'operation_1:integration',
      '{"reference":"https://example.com/pr/1"}',
      '{"actor":{"type":"agent","id":"agent_1"},"operationId":"operation_1"}', 8);

    INSERT INTO wg_v2_evidence
      (organization_id, owner_user_id, id, stream_id, subject_type, subject_id, requirement_id, source_attempt_id,
       evidence_kind, summary, reference_json, provenance_json, created_at)
    VALUES ('organization', 'owner', 'evidence_1', 'stream_1', 'work_item', 'work_item_1', 'proof', 'attempt_1',
      'integration', 'Merged PR',
      '{"kind":"integration","summary":"Merged PR","effect":"merged","reference":"https://example.com/pr/1"}',
      '{"actor":{"type":"agent","id":"agent_1"},"operationId":"operation_1","requestId":"request_1"}', 8);

    INSERT INTO wg_v2_recaps
      (organization_id, owner_user_id, id, stream_id, activity_start_sequence, activity_end_sequence, quiet_since,
       summary, actionable_references_json, generation_profile_json, provenance_json,
       generation_result_json, created_at)
    VALUES ('organization', 'owner', 'recap_1', 'stream_1', 1, 2, 10, 'Ready to merge',
      '[{"type":"work_item","id":"work_item_1"}]',
      '{"model":{"providerId":"openai","modelId":"gpt-5"},"effort":"medium"}',
      '{"actor":{"type":"agent","id":"recap_agent"}}',
      '{"state":"succeeded","generatedAt":11,"method":"agent_session","sessionId":"session_recap_1"}', 11);

    INSERT INTO wg_v2_notifications
      (organization_id, owner_user_id, id, notification_kind, state, stream_id, recap_id, created_at, updated_at)
    VALUES ('organization', 'owner', 'notification_1', 'actionable_recap', 'unread', 'stream_1', 'recap_1', 11, 11);

    INSERT INTO wg_v2_record_source_revisions
      (organization_id, owner_user_id, id, record_type, record_id, work_source_id, source_revision_id, ordinal, created_at)
    VALUES ('organization', 'owner', 'source_ref_1', 'stream', 'stream_1', 'source_1', 'revision_1', 0, 2);

    INSERT INTO wg_v2_admission_proposals
      (organization_id, owner_user_id, id, workgraph_id, source_revision_id, proposal_kind, lifecycle,
       proposed_work_json, duplicate_matches_json, created_at, updated_at)
    VALUES ('organization', 'owner', 'proposal_1', 'workgraph_default', 'revision_1', 'source', 'proposed',
      '{"source":{"workSourceId":"source_1","revisionId":"revision_1","contentHash":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"},"targetStreamId":"stream_1","generation":{"method":"agent_session","sessionId":"session_plan_1","generatedAt":6},"suggestedPlacement":{"mode":"existing","streamId":"stream_1"},"placementMatches":[],"outcomes":[],"workItems":[],"duplicateMatches":[]}',
      '[]', 6, 6);

    INSERT INTO wg_v2_runtime_effects
      (organization_id, owner_user_id, id, effect_kind, resource_type, resource_id, idempotency_key,
       payload_json, state, attempt_count, created_at, updated_at, completed_at)
    VALUES ('organization', 'owner', 'runtime_effect_1', 'integration', 'attempt', 'attempt_1', 'runtime_effect_key',
      '{"attemptId":"attempt_1"}', 'completed', 1, 7, 8, 8);

    INSERT INTO wg_v2_migration_intake
      (organization_id, owner_user_id, id, legacy_table, legacy_record_id, intake_kind, reason,
       raw_reference_json, status, resolution_json, created_at, updated_at)
    VALUES ('organization', 'owner', 'migration_1', 'runs_current', 'run_1', 'work_mapping_review', 'Owner mapped it',
      '{"runId":"run_1"}', 'resolved', '{"streamId":"stream_1"}', 1, 9);

    INSERT INTO wg_v2_outbox
      (organization_id, owner_user_id, id, operation_id, effect_type, idempotency_key, payload_json,
       status, available_at, attempt_count, created_at, updated_at)
    VALUES ('organization', 'owner', 'external_effect_1', 'operation_1', 'intake_external_sync', 'external_sync_key',
      '{"candidateId":"candidate_external","effect":"announce"}', 'completed', 5, 1, 5, 8);

    INSERT INTO wg_v2_due_jobs
      (organization_id, owner_user_id, id, stream_id, job_type, subject_id, due_at, status, payload_json,
       lease_epoch, last_error, created_at, updated_at)
    VALUES
      ('organization', 'owner', 'job_completed', 'stream_1', 'recap', 'stream_1:2', 10, 'completed',
       '{"sessionId":"session_recap_1"}', 1, NULL, 10, 11),
      ('organization', 'owner', 'job_attention', 'stream_1', 'source_plan', 'proposal_attention', 10, 'failed_terminal',
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
    organizationId: branded("organization"),
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
  return CompletionContractSchema.parse({
    version: 1,
    mode: "all",
    requirements: [{ id, kind: "test", description: "Tests pass" }],
  })
}

function branded<Type>(value: string) {
  return value as Type
}
