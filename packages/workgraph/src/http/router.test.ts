import { describe, expect, it } from "vitest"
import BetterSqlite3 from "better-sqlite3"
import type {
  ChangeCursor,
  ChangeEnvelope,
  CommandErrorCode,
  CommandResult,
  OperationID,
  OwnerUserID,
  RequestID,
  SnapshotResumeCursor,
  StreamDto,
  StreamID,
  WorkGraphCommandRequest,
  WorkGraphContext,
  WorkGraphEventID,
  WorkGraphSnapshotPage,
  WorkGraphArchive,
} from "../contracts"
import { createAttentionCursor, createChangeCursor, readChangeCursor, WorkGraphArchiveRestoreError } from "../contracts"
import { createAttentionAcknowledgementService, createWorkGraphService } from "../application"
import { createSqliteWorkGraphService } from "../adapters/sqlite/store"
import { createSqliteWorkGraphArchivePort } from "../adapters/sqlite/archive"
import { createSqliteWorkGraphOwnerDeletionPort } from "../adapters/sqlite/owner-deletion"
import {
  WorkGraphOwnerDeletionError,
  ExecutionCapabilitiesUnavailableError,
  defineAtomicWorkGraphStore,
  type WorkGraphCommandHandler,
  type WorkGraphCommandHandlers,
  type WorkGraphOwnerDeletionResult,
} from "../ports"
import { createWorkGraphHttpRouter, type WorkGraphHttpErrorReport } from "./router"

const branded = <Type>(value: string) => value as Type

describe("WorkGraph northbound HTTP router", () => {
  it("normalizes snapshot cursor errors thrown by a separately bundled contract entrypoint", async () => {
    const fixture = createFixture()
    const response = await fixture.app.request("/snapshot?after=bundled_cursor_error&limit=1", fixture.auth("owner_a"))

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: { code: "cursor_invalid", message: "Snapshot cursor is no longer valid", retryable: false },
    })
  })

  it("reports the underlying exception before returning the generic 500 response", async () => {
    const reports: WorkGraphHttpErrorReport[] = []
    const fixture = createFixture({ reportError: (report) => reports.push(report) })
    fixture.failAttention(new Error("attention owner projection failed"))

    const response = await fixture.app.request("/attention?limit=50", fixture.auth("owner_a"))

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: { code: "internal_error", message: "WorkGraph request failed", retryable: false },
    })
    expect(reports).toMatchObject([{
      method: "GET",
      path: "/attention",
      requestId: "request_owner_a",
      error: expect.objectContaining({ message: "attention owner projection failed" }),
    }])
  })

  it("persists owner-scoped Attention read and clear acknowledgements", async () => {
    const fixture = createFixture()
    expect(await (await fixture.app.request("/attention/read", { method: "POST", headers: { authorization: "Bearer owner_a" } })).json())
      .toEqual({ ownerUserId: "owner_a", readAt: 100 })
    expect(await (await fixture.app.request("/attention/clear", { method: "POST", headers: { authorization: "Bearer owner_a" } })).json())
      .toEqual({ ownerUserId: "owner_a", readAt: 200, clearedAt: 200 })
    expect(fixture.attentionAcknowledgements).toEqual([
      { owner: "owner_a", operation: "mark_all_read" },
      { owner: "owner_a", operation: "clear" },
    ])
  })

  it("accepts a SQLite service with additional query capabilities without an adapter cast", async () => {
    const database = new BetterSqlite3(":memory:")
    try {
      const service = createSqliteWorkGraphService({ database, executionCapabilities: testExecutionCapabilities }).service
      const app = createWorkGraphHttpRouter({
        service,
        archive: createSqliteWorkGraphArchivePort(database),
        deletion: createSqliteWorkGraphOwnerDeletionPort(database, {
          provisionOrAdopt: async () => { throw new Error("unused") },
          launch: async () => { throw new Error("unused") },
          cancel: async () => undefined,
          result: async () => { throw new Error("unused") },
          cleanup: async () => undefined,
        }),
        resolveContext: () => ({
          organizationId: "organization_sqlite",
          ownerUserId: "owner_sqlite",
          actor: { type: "user", id: "owner_sqlite" },
          requestId: "request_sqlite",
          access: { mode: "owner" },
        }),
      })
      expect(await (await app.request("/defaults")).json()).toMatchObject({
        recordType: "workgraph",
        id: "workgraph_default",
        ownerUserId: "owner_sqlite",
        version: 1,
        defaults: { execution: {} },
      })
      expect((await app.request("/defaults?ownerUserId=other")).status).toBe(400)
      expect(await (await app.request("/attention?limit=5")).json()).toEqual({ items: [], total: 0, hasMore: false })
      expect((await app.request("/attention?limit=0")).status).toBe(400)
      expect((await app.request(`/attention?after=${encodeURIComponent(createAttentionCursor("organization_sqlite", "other", { updatedAt: 1, kind: "decision", id: "decision_1" }))}`)).status).toBe(409)
      const updatedDefaults = await app.request("/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: "operation_defaults",
          command: {
            version: 1,
            type: "update_workgraph_defaults",
            expectedVersion: 1,
            defaults: {
              execution: { effort: "high" },
            },
          },
        }),
      })
      expect(updatedDefaults.status).toBe(200)
      expect(await (await app.request("/defaults")).json()).toMatchObject({
        version: 2,
        defaults: { execution: { effort: "high" } },
      })
      const created = await app.request("/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: "operation_sqlite",
          command: { version: 1, type: "create_stream", title: "SQLite Stream" },
        }),
      })
      expect(created.status).toBe(200)
      const createdBody = await created.json() as { value: { streamId: string } }
      const snapshot = await (await app.request("/snapshot")).json() as WorkGraphSnapshotPage
      expect(readChangeCursor(snapshot.snapshotCursor, "organization_sqlite", "owner_sqlite")).toBe(2)
      expect(snapshot.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ recordType: "workgraph", version: 2 }),
        expect.objectContaining({ recordType: "stream", title: "SQLite Stream" }),
      ]))
      const firstPage = await (await app.request("/snapshot?limit=1")).json() as WorkGraphSnapshotPage
      expect(firstPage.nextCursor).toMatch(/^wgsp1:/)
      expect(await (await app.request("/snapshot?after=malformed&limit=1")).json()).toEqual({
        error: { code: "cursor_invalid", message: "Snapshot cursor is no longer valid", retryable: false },
      })
      const source = await app.request("/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: "operation_source",
          command: { version: 1, type: "create_work_source", title: "Launch plan", content: "Ship the cloud" },
        }),
      })
      const createdSource = await source.json() as { value: { workSourceId: string; revisionId: string } }
      const invalidated = await app.request(`/snapshot?after=${encodeURIComponent(firstPage.nextCursor!)}&limit=1`)
      expect(invalidated.status).toBe(409)
      expect(await invalidated.json()).toEqual({
        error: { code: "cursor_invalid", message: "Snapshot cursor is no longer valid", retryable: false },
      })
      expect(await (await app.request("/sources?limit=10")).json()).toMatchObject({
        sources: [{ id: createdSource.value.workSourceId, title: "Launch plan", revisionCount: 1 }],
        hasMore: false,
      })
      expect((await app.request("/sources?after=malformed&limit=1")).status).toBe(409)
      expect(await (await app.request(`/sources/${createdSource.value.workSourceId}`)).json())
        .toMatchObject({ id: createdSource.value.workSourceId, latestRevisionId: createdSource.value.revisionId })
      const sourceRevision = await (await app.request(`/sources/${createdSource.value.workSourceId}/revisions/${createdSource.value.revisionId}`)).json() as { contentHash: string }
      expect(sourceRevision).toMatchObject({ id: createdSource.value.revisionId, content: "Ship the cloud", origin: { kind: "manual" } })
      const proposal = await app.request("/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: "operation_proposal",
          command: {
            version: 1,
            type: "propose_admission",
            source: {
              workSourceId: createdSource.value.workSourceId,
              revisionId: createdSource.value.revisionId,
              contentHash: sourceRevision.contentHash,
            },
          },
        }),
      })
      const proposalBody = await proposal.json() as { value: { proposalId: string } }
      expect(await (await app.request(`/proposals/${proposalBody.value.proposalId}`)).json()).toMatchObject({
        id: proposalBody.value.proposalId,
        state: "planning",
      })
      const item = await app.request("/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: "operation_item",
          command: {
            version: 1,
            type: "create_work_item",
            streamId: createdBody.value.streamId,
            title: "Verify cloud",
            dependencyIds: [],
            source: {
              workSourceId: createdSource.value.workSourceId,
              revisionId: createdSource.value.revisionId,
              contentHash: sourceRevision.contentHash,
            },
            completionContract: {
              version: 1,
              mode: "all",
              requirements: [{ id: "verified", kind: "verification", description: "Verified", instructions: "Inspect" }],
            },
          },
        }),
      })
      const itemBody = await item.json() as { value: { workItemId: string } }
      expect(await (await app.request(`/work-items/${itemBody.value.workItemId}`)).json()).toMatchObject({
        id: itemBody.value.workItemId,
        title: "Verify cloud",
      })
      const reviewQuery = new URLSearchParams({
        workSourceId: createdSource.value.workSourceId,
        revisionId: createdSource.value.revisionId,
        contentHash: sourceRevision.contentHash,
      })
      expect(await (await app.request(`/streams/${createdBody.value.streamId}/replacement-review?${reviewQuery}`)).json()).toMatchObject({
        streamId: createdBody.value.streamId,
        streamTitle: "SQLite Stream",
        status: "eligible",
        targets: [{ workItemId: itemBody.value.workItemId, expectedVersion: 1, title: "Verify cloud", state: "pending" }],
      })
      reviewQuery.set("contentHash", "f".repeat(64))
      expect((await app.request(`/streams/${createdBody.value.streamId}/replacement-review?${reviewQuery}`)).status).toBe(404)
      reviewQuery.set("contentHash", sourceRevision.contentHash)
      reviewQuery.set("ownerUserId", "other")
      expect((await app.request(`/streams/${createdBody.value.streamId}/replacement-review?${reviewQuery}`)).status).toBe(400)
      expect(await (await app.request(`/work-items/${itemBody.value.workItemId}/attempts?limit=10`)).json()).toEqual({
        attempts: [],
        hasMore: false,
      })
      expect((await app.request(`/work-items/${itemBody.value.workItemId}/attempts?after=malformed&limit=10`)).status).toBe(409)
      expect(await (await app.request(`/work-items/${itemBody.value.workItemId}/activity?limit=10`)).json()).toMatchObject({
        entries: expect.any(Array),
        hasMore: false,
      })
      expect((await app.request(`/work-items/${itemBody.value.workItemId}/activity?after=malformed&limit=10`)).status).toBe(409)
      const recorded = await app.request("/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: "operation_evidence",
          command: {
            version: 1,
            type: "record_evidence",
            subject: { type: "work_item", workItemId: itemBody.value.workItemId },
            requirementId: "verified",
            evidence: { kind: "finding", summary: "Cloud is healthy", sourceRef: "session:smoke" },
          },
        }),
      })
      const recordedBody = await recorded.json() as { value: { evidenceId: string } }
      expect(await (await app.request(`/evidence/${recordedBody.value.evidenceId}`)).json()).toMatchObject({
        id: recordedBody.value.evidenceId,
        subject: { type: "work_item", workItemId: itemBody.value.workItemId },
        requirementId: "verified",
        kind: "finding",
        summary: "Cloud is healthy",
      })
      expect(await (await app.request(`/evidence?subjectType=work_item&workItemId=${itemBody.value.workItemId}&limit=1`)).json()).toMatchObject({
        evidence: [{ id: recordedBody.value.evidenceId }],
        hasMore: false,
      })
      expect((await app.request(`/evidence?subjectType=work_item&workItemId=${itemBody.value.workItemId}&limit=0`)).status).toBe(400)
      expect((await app.request(`/evidence/${recordedBody.value.evidenceId}?ownerUserId=other`)).status).toBe(400)
    } finally {
      database.close()
    }
  })

  it("rejects missing or untrusted context and never accepts a client owner selector", async () => {
    const fixture = createFixture()

    expect((await fixture.app.request("/snapshot")).status).toBe(401)
    expect((await fixture.app.request("/snapshot", { headers: { "x-owner-user-id": "owner_a" } })).status).toBe(401)
    expect((await fixture.app.request("/snapshot?ownerUserId=owner_b", fixture.auth("owner_a"))).status).toBe(400)
    expect((await fixture.app.request("/archive", { headers: { authorization: "Bearer shared_owner_a" } })).status).toBe(403)
    expect((await fixture.app.request("/commands", {
      method: "POST",
      headers: { authorization: "Bearer shared_owner_a", "content-type": "application/json" },
      body: JSON.stringify(createStream("operation_shared", "Read-only mutation")),
    })).status).toBe(403)

    const response = await fixture.command("owner_a", {
      operationId: "operation_1",
      ownerUserId: "owner_b",
      command: { version: 1, type: "create_stream", title: "Smuggled owner" },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "validation_error" } })
  })

  it("reads truthful owner-scoped execution capabilities and preserves typed unavailability", async () => {
    const fixture = createFixture()

    const success = await fixture.app.request("/execution-capabilities", fixture.auth("owner_a"))
    expect(success.status).toBe(200)
    expect(await success.json()).toMatchObject({
      schemaVersion: 1,
      ownerUserId: "owner_a",
      harnesses: [{ id: "opencode" }],
      agents: [{ id: "build", harnessId: "opencode" }],
      models: [],
      tools: [{ id: "terminal", harnessId: "opencode" }],
      connections: [],
    })
    expect(fixture.executionContexts[0]).toBe(fixture.resolvedContexts[0])
    // Absent selector → today's unscoped behavior (no directory in the read input).
    expect(fixture.executionReadInputs[0]).toEqual({})
    // An absolute directory selector is validated and forwarded to the port.
    const scoped = await fixture.app.request("/execution-capabilities?directory=%2Frepos%2Fclaxedo", fixture.auth("owner_a"))
    expect(scoped.status).toBe(200)
    expect(fixture.executionReadInputs.at(-1)).toEqual({ directory: "/repos/claxedo" })
    // An invalid (non-absolute / empty) directory string is a route validation error.
    expect((await fixture.app.request("/execution-capabilities?directory=relative%2Fpath", fixture.auth("owner_a"))).status).toBe(400)
    expect((await fixture.app.request("/execution-capabilities?directory=", fixture.auth("owner_a"))).status).toBe(400)
    expect((await fixture.app.request("/execution-capabilities?ownerUserId=owner_b", fixture.auth("owner_a"))).status).toBe(400)
    expect((await fixture.app.request("/execution-capabilities?workspaceId=workspace_1", fixture.auth("owner_a"))).status).toBe(400)
    expect((await fixture.app.request("/execution-capabilities", fixture.auth("shared_owner_a"))).status).toBe(403)
    expect((await fixture.app.request("/execution-capabilities/refresh?workspaceId=workspace_1", {
      ...fixture.auth("owner_a"),
      method: "POST",
    })).status).toBe(400)

    const unavailable = await fixture.app.request("/execution-capabilities/refresh", {
      ...fixture.auth("owner_a"),
      method: "POST",
    })
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({
      error: {
        code: "execution_capabilities_unavailable",
        capability: "catalog_workspace",
        reason: "catalog_workspace_unavailable",
        message: "The capability catalog is unavailable",
        retryable: false,
      },
    })
  })

  it("exports and restores canonical archives only for the trusted owner", async () => {
    const fixture = createFixture()
    const exported = await fixture.app.request("/archive", fixture.auth("owner_a"))
    expect(exported.status).toBe(200)
    const archive = await exported.json() as WorkGraphArchive
    expect(archive).toMatchObject({ version: 1, ownerUserId: "owner_a" })
    expect((await fixture.app.request("/archive?ownerUserId=owner_b", fixture.auth("owner_a"))).status).toBe(400)

    const restored = await fixture.app.request("/archive/restore", {
      method: "POST",
      headers: { authorization: "Bearer owner_a", "content-type": "application/json" },
      body: JSON.stringify({ operationId: "operation_restore", archive }),
    })
    expect(restored.status).toBe(200)
    expect(await restored.json()).toEqual({
      restored: true,
      recordCount: archive.records.length,
      baselineCursor: createChangeCursor({ organizationId: "organization", ownerUserId: "owner_a", position: 0 }),
    })

    const crossOwner = await fixture.app.request("/archive/restore", {
      method: "POST",
      headers: { authorization: "Bearer owner_b", "content-type": "application/json" },
      body: JSON.stringify({ operationId: "operation_restore_cross_owner", archive }),
    })
    expect(crossOwner.status).toBe(403)
    expect(await crossOwner.json()).toMatchObject({ error: { code: "archive_restore_rejected", reason: "cross_owner" } })

    const malformed = await fixture.app.request("/archive/restore", {
      method: "POST",
      headers: { authorization: "Bearer owner_a", "content-type": "application/json" },
      body: JSON.stringify({ operationId: "operation_restore_malformed", archive: { version: 1 } }),
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ error: { code: "archive_restore_rejected", reason: "malformed" } })

    const bundledError = await fixture.app.request("/archive/restore", {
      method: "POST",
      headers: { authorization: "Bearer owner_a", "content-type": "application/json" },
      body: JSON.stringify({ operationId: "operation_bundled_archive_error", archive }),
    })
    expect(bundledError.status).toBe(503)
    expect(await bundledError.json()).toMatchObject({ error: { reason: "dependency_unavailable", retryable: true } })
  })

  it("permanently deletes only the trusted owner through an idempotent protected request", async () => {
    const fixture = createFixture()
    await fixture.command("owner_a", createStream("delete_owner_a_stream", "Delete me"))
    await fixture.command("owner_b", createStream("keep_owner_b_stream", "Keep me"))

    expect((await fixture.app.request("/owner", {
      method: "DELETE",
      headers: { authorization: "Bearer shared_owner_a", "content-type": "application/json" },
      body: JSON.stringify({ operationId: "delete_owner_a" }),
    })).status).toBe(403)
    expect((await fixture.app.request("/owner", {
      method: "DELETE",
      headers: { authorization: "Bearer owner_a", "content-type": "application/json" },
      body: JSON.stringify({}),
    })).status).toBe(400)
    const bundledError = await fixture.app.request("/owner", {
      method: "DELETE",
      headers: { authorization: "Bearer owner_a", "content-type": "application/json" },
      body: JSON.stringify({ operationId: "bundled_owner_deletion_error" }),
    })
    expect(bundledError.status).toBe(503)
    expect(await bundledError.json()).toMatchObject({ error: { reason: "cleanup_failed", retryable: true } })

    const request = {
      method: "DELETE",
      headers: { authorization: "Bearer owner_a", "content-type": "application/json" },
      body: JSON.stringify({ operationId: "delete_owner_a" }),
    }
    const deleted = await fixture.app.request("/owner", request)
    expect(deleted.status).toBe(200)
    const result = await deleted.json()
    expect(result).toMatchObject({ deleted: true, recordCount: expect.any(Number), workspaceCount: 0 })
    expect(await (await fixture.app.request("/owner", request)).json()).toEqual(result)
    expect(await (await fixture.app.request("/snapshot", fixture.auth("owner_b"))).json()).toMatchObject({
      records: [expect.objectContaining({ title: "Keep me" })],
    })
  })

  it("validates commands and keeps cross-owner identifiers undiscoverable", async () => {
    const fixture = createFixture()
    const malformed = await fixture.command("owner_a", {
      operationId: "operation_1",
      command: { version: 1, type: "create_stream", title: "" },
    })
    expect(malformed.status).toBe(400)

    const created = await fixture.command("owner_a", createStream("operation_2", "Private stream"))
    const body = await created.json() as { value: { streamId: string } }
    expect((await fixture.app.request(`/streams/${body.value.streamId}`, fixture.auth("owner_b"))).status).toBe(404)

    const mutation = await fixture.command("owner_b", {
      operationId: "operation_3",
      command: {
        version: 1,
        type: "update_stream",
        streamId: body.value.streamId,
        expectedVersion: 1,
        title: "Take over",
      },
    })
    expect(mutation.status).toBe(404)
    expect(await mutation.json()).toMatchObject({ error: { code: "not_found" } })
  })

  it("returns the exact same status, body, and cursor for an exact retry", async () => {
    const fixture = createFixture()
    const request = createStream("operation_1", "Ship Cloud")

    const first = await fixture.command("owner_a", request)
    const retry = await fixture.command("owner_a", request)

    expect(retry.status).toBe(first.status)
    expect(await retry.json()).toEqual(await first.json())
  })

  // The ordered change feed is no longer client-facing (plan 2026-07-17-004): the
  // `/changes` route is deleted in favour of the `workgraph.changed` bus doorbell.
  // The `wg_v2_changes` log itself is unchanged and stays covered at the store
  // level by the conformance suite (`conformance/index.ts`), which asserts
  // ordering, exactly-once delivery after a snapshot cursor, and owner isolation.

})

function createFixture(options?: Readonly<{ reportError?: (report: WorkGraphHttpErrorReport) => void }>) {
  const streams = new Map<StreamID, StreamDto>()
  let attentionFailure: Error | undefined
  const changes = new Map<OwnerUserID, ChangeEnvelope[]>()
  const streamSequences = new Map<StreamID, number>()
  const operations = new Map<string, Readonly<{ fingerprint: string; result: CommandResult }>>()
  const deletionResults = new Map<string, WorkGraphOwnerDeletionResult>()
  const attentionAcknowledgements: Array<{ owner: string; operation: string }> = []
  const resolvedContexts: WorkGraphContext[] = []
  const executionContexts: WorkGraphContext[] = []
  const executionReadInputs: Array<{ directory?: string }> = []
  let nextId = 0
  let now = 1_000
  const execute: WorkGraphCommandHandler = async (context, request) => {
    const operationKey = `${context.ownerUserId}:${request.operationId}`
    const fingerprint = JSON.stringify(request.command)
    const previous = operations.get(operationKey)
    if (previous?.fingerprint === fingerprint) return previous.result
    if (previous) return failure(request.operationId, "idempotency_conflict", "Operation ID already used")
    if (request.command.type !== "create_stream" && request.command.type !== "update_stream") {
      return failure(request.operationId, "internal_error", "Unsupported test command")
    }

    const existing = request.command.type === "update_stream" ? streams.get(request.command.streamId) : undefined
    if (request.command.type === "update_stream" && existing?.ownerUserId !== context.ownerUserId) {
      return failure(request.operationId, "not_found", "Stream not found")
    }
    if (request.command.type === "update_stream" && existing?.version !== request.command.expectedVersion) {
      return failure(request.operationId, "version_conflict", "Stream version changed")
    }

    const streamId = request.command.type === "create_stream" ? branded<StreamID>(`stream_${++nextId}`) : request.command.streamId
    const timestamp = now++
    const stream = {
      recordType: "stream",
      schemaVersion: 1,
      id: streamId,
      ownerUserId: context.ownerUserId,
      version: existing ? existing.version + 1 : 1,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      provenance: { actor: context.actor, operationId: request.operationId },
      title: request.command.title ?? existing?.title ?? "Untitled",
      description: existing?.description,
      lifecycleState: "active",
      visibility: "visible",
      pinned: false,
      executionDefaults: {},
      activityGranularity: request.command.activityGranularity ?? existing?.activityGranularity ?? "progress",
      activity: { lastActivityAt: timestamp },
      durableEffectCount: 0,
      sourceRevisionRefs: [],
    } satisfies StreamDto
    streams.set(streamId, stream)

    const ownerChanges = changes.get(context.ownerUserId) ?? []
    const cursor = createChangeCursor({ organizationId: context.organizationId, ownerUserId: context.ownerUserId, position: ownerChanges.length + 1 })
    const type = request.command.type === "create_stream" ? "stream_created" : "stream_updated"
    const sequence = (streamSequences.get(streamId) ?? 0) + 1
    streamSequences.set(streamId, sequence)
    ownerChanges.push({
      cursor,
      ownerUserId: context.ownerUserId,
      resource: { type: "stream", id: streamId },
      event: {
        schemaVersion: 1,
        id: branded<WorkGraphEventID>(`event_${context.ownerUserId}_${cursor}`),
        ownerUserId: context.ownerUserId,
        streamId,
        sequence,
        type,
        payload: { streamId },
        provenance: { actor: context.actor, operationId: request.operationId, requestId: context.requestId },
        occurredAt: timestamp,
      },
    })
    changes.set(context.ownerUserId, ownerChanges)
    const result = { ok: true, operationId: request.operationId, cursor, value: { streamId } } satisfies CommandResult
    operations.set(operationKey, { fingerprint, result })
    return result
  }

  const commands = Object.fromEntries([
    "create_work_source", "revise_work_source", "create_stream", "update_stream", "create_outcome", "update_outcome",
    "create_work_item", "update_work_item", "propose_admission", "retry_admission_planning", "dismiss_admission",
    "reopen_admission", "confirm_admission", "set_stream_lifecycle",
    "set_stream_visibility", "approve_work_item", "reject_work_item", "approve_work_items", "cancel_attempt", "retry_work_item",
    "propose_decision", "answer_decision", "dismiss_decision", "record_attempt_checkpoint", "complete_attempt",
    "record_evidence", "close_outcome", "reopen_outcome",
    "close_stream", "delete_stream",
  ].map((type) => [type, execute])) as WorkGraphCommandHandlers

  const store = defineAtomicWorkGraphStore({
    commands,
    queries: {
      defaults: {
        read: async (context: WorkGraphContext) => ({
          recordType: "workgraph" as const,
          schemaVersion: 1 as const,
          id: "workgraph_default" as never,
          ownerUserId: context.ownerUserId,
          version: 1,
          createdAt: 0,
          updatedAt: 0,
          provenance: { actor: { type: "system" as const, id: "workgraph_defaults" as never } },
          defaults: { execution: {} },
        }),
      },
      snapshot: {
        page: async (
          context: WorkGraphContext,
          input: Readonly<{ after?: SnapshotResumeCursor; limit: number }>,
        ): Promise<WorkGraphSnapshotPage> => {
          if (input.after === "bundled_cursor_error") {
            const error = new Error("canonical error from a separately bundled entrypoint")
            error.name = "SnapshotResumeCursorError"
            throw Object.assign(error, { code: "cursor_invalid" as const, reason: "owner_mismatch" as const })
          }
          const ownerChanges = changes.get(context.ownerUserId) ?? []
          const records = Array.from(streams.values()).filter((stream) => stream.ownerUserId === context.ownerUserId)
          return {
            snapshotCursor: createChangeCursor({ organizationId: context.organizationId, ownerUserId: context.ownerUserId, position: ownerChanges.length }),
            records,
            references: records.map((stream, index) => ({ sequence: index + 1, resource: { type: "stream", id: stream.id }, version: stream.version })),
            hasMore: false,
            capturedAt: now,
          }
        },
      },
      attention: { list: async () => {
        if (attentionFailure) throw attentionFailure
        return { items: [], total: 0, hasMore: false }
      } },
      streams: { read: async (context: WorkGraphContext, input: Readonly<{ streamId: StreamID }>) => {
        const stream = streams.get(input.streamId)
        return stream?.ownerUserId === context.ownerUserId ? stream : undefined
      } },
      proposals: { read: async () => undefined, replacementReview: async () => undefined },
      attempts: { read: async () => undefined },
      decisions: { read: async () => undefined },
      workItems: {
        readDetail: async () => undefined,
        listAttempts: async () => ({ attempts: [], hasMore: false }),
        listActivity: async () => ({ entries: [], hasMore: false }),
      },
      sources: {
        list: async () => ({ sources: [], hasMore: false }),
        read: async () => undefined,
        readRevision: async () => undefined,
      },
      evidence: {
        read: async () => undefined,
        list: async () => ({ evidence: [], hasMore: false }),
      },
      changes: { list: async (context: WorkGraphContext, input: Readonly<{ after?: ChangeCursor; limit: number }>) =>
        (changes.get(context.ownerUserId) ?? []).filter((change) => !input.after ||
          readChangeCursor(change.cursor, context.organizationId, context.ownerUserId) >
            readChangeCursor(input.after, context.organizationId, context.ownerUserId)).slice(0, input.limit) },
    },
  })
  const service = createWorkGraphService(store)
  const app = createWorkGraphHttpRouter({
    service,
    attentionAcknowledgements: createAttentionAcknowledgementService({
      async markAllRead(owner) {
        attentionAcknowledgements.push({ owner: owner.ownerUserId, operation: "mark_all_read" })
        return { ownerUserId: owner.ownerUserId, readAt: 100 }
      },
      async clear(owner) {
        attentionAcknowledgements.push({ owner: owner.ownerUserId, operation: "clear" })
        return { ownerUserId: owner.ownerUserId, readAt: 200, clearedAt: 200 }
      },
    }),
    executionCapabilities: {
      read: async (owner, request) => {
        executionContexts.push(owner)
        executionReadInputs.push(request)
        return {
          schemaVersion: 1,
          organizationId: owner.organizationId,
          ownerUserId: owner.ownerUserId,
          catalogRevision: "a".repeat(64),
          observedAt: now,
          expiresAt: now + 300_000,
          environments: [{
            kind: "local_worktree" as const,
            repositoryRequired: true,
            remoteUrlInput: false,
            baseRevisionInput: true,
          }],
          harnesses: [{ id: "opencode" }],
          agents: [{ harnessId: "opencode", id: "build", label: "build", mode: "primary" as const }],
          models: [],
          tools: [{ harnessId: "opencode", id: "terminal" }],
          repository: { baseRevisions: ["HEAD"] },
          connections: [],
        }
      },
      refresh: async () => {
        throw new ExecutionCapabilitiesUnavailableError(
          "catalog_workspace",
          "catalog_workspace_unavailable",
          "The capability catalog is unavailable",
          false,
        )
      },
    },
    now: () => now,
    archive: {
      export: async (owner) => archive(owner.organizationId, owner.ownerUserId),
      restore: async (owner, input) => {
        if (input.operationId === "operation_bundled_archive_error") {
          const error = new Error("canonical error from a separately bundled entrypoint")
          error.name = "WorkGraphArchiveRestoreError"
          throw Object.assign(error, { reason: "dependency_unavailable" as const })
        }
        if (input.archive.ownerUserId !== owner.ownerUserId) throw new WorkGraphArchiveRestoreError("cross_owner")
        return {
          restored: true,
          recordCount: input.archive.records.length,
          baselineCursor: createChangeCursor({ organizationId: owner.organizationId, ownerUserId: owner.ownerUserId, position: 0 }),
        }
      },
    },
    deletion: {
      deleteOwner: async (owner, input) => {
        if (owner.access.mode !== "owner") throw new WorkGraphOwnerDeletionError("forbidden")
        if (input.operationId === "bundled_owner_deletion_error") {
          const error = new Error("canonical error from a separately bundled entrypoint")
          error.name = "WorkGraphOwnerDeletionError"
          throw Object.assign(error, { reason: "cleanup_failed" as const })
        }
        const key = `${owner.ownerUserId}:${input.operationId}`
        const replay = deletionResults.get(key)
        if (replay) return replay
        const ownedStreams = [...streams.values()].filter((stream) => stream.ownerUserId === owner.ownerUserId)
        ownedStreams.forEach((stream) => streams.delete(stream.id))
        const recordCount = ownedStreams.length + (changes.get(owner.ownerUserId)?.length ?? 0)
        changes.delete(owner.ownerUserId)
        ;[...operations.keys()].filter((operation) => operation.startsWith(`${owner.ownerUserId}:`))
          .forEach((operation) => operations.delete(operation))
        const result = { deleted: true as const, recordCount, workspaceCount: 0, completedAt: now++ }
        deletionResults.set(key, result)
        return result
      },
    },
    resolveContext: (request) => {
      const match = /^Bearer (shared_)?(owner_[ab])$/.exec(request.headers.get("authorization") ?? "")
      if (!match) return undefined
      const resolved = context(match[2]!, match[1] ? "shared_read" : "owner")
      resolvedContexts.push(resolved)
      return resolved
    },
    ...(options?.reportError ? { reportError: options.reportError } : {}),
  })

  return {
    app,
    failAttention: (error: Error) => { attentionFailure = error },
    attentionAcknowledgements,
    resolvedContexts,
    executionContexts,
    executionReadInputs,
    auth: (owner: string) => ({ headers: { authorization: `Bearer ${owner}` } }),
    command: (owner: string, body: unknown) => app.request("/commands", {
      method: "POST",
      headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  }
}

function archive(organizationId: WorkGraphContext["organizationId"], ownerUserId: OwnerUserID): WorkGraphArchive {
  return {
    version: 1,
    organizationId,
    ownerUserId,
    exportedAt: 1,
    records: [{
      kind: "workgraph",
      id: "workgraph_default",
      value: {
        schemaVersion: 1,
        version: 1,
        createdAt: 0,
        updatedAt: 0,
        provenance: { actor: { type: "system", id: "workgraph_defaults" } },
        defaults: { execution: {} },
      },
    }],
  }
}

function createStream(operationId: string, title: string) {
  return { operationId, command: { version: 1, type: "create_stream", title } }
}

function context(ownerUserId: string, mode: "owner" | "shared_read" = "owner"): WorkGraphContext {
  return {
    organizationId: branded("organization"),
    ownerUserId: branded<OwnerUserID>(ownerUserId),
    actor: { type: "user", id: branded(`actor_${ownerUserId}`) },
    requestId: branded<RequestID>(`request_${ownerUserId}`),
    access: { mode },
  }
}

function failure(operationId: OperationID, code: CommandErrorCode, message: string): CommandResult {
  return { ok: false, operationId, error: { code, message, retryable: false } }
}
import { testExecutionCapabilities } from "../../test/test-execution-capabilities"
