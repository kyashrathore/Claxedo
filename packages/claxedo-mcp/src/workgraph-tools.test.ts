import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { McpHttpError } from "./http-error"
import {
  WORKGRAPH_CAPABILITY_MAP,
  WORKGRAPH_TOOL_SCHEMAS,
  WorkGraphRecordNotFoundError,
  callWorkGraph,
  registerWorkGraphTools,
  toCommandRequest,
} from "./workgraph-tools"

describe("WorkGraph MCP parity", () => {
  it("gives UI source and Stream creation exact agent equivalents", () => {
    expect(WORKGRAPH_CAPABILITY_MAP).toEqual(expect.arrayContaining([
      expect.objectContaining({ uiAction: "Read personal WorkGraph defaults", tool: "workgraph_get_defaults" }),
      expect.objectContaining({ uiAction: "Update personal WorkGraph defaults", tool: "workgraph_update_defaults" }),
      expect.objectContaining({ uiAction: "Create or revise a Work Source", tool: "workgraph_source" }),
      expect.objectContaining({ uiAction: "Create a Stream", tool: "workgraph_create_stream" }),
      expect.objectContaining({ uiAction: "Update Stream execution defaults", tool: "workgraph_update_execution" }),
      expect.objectContaining({ uiAction: "Retry a Work Item", tool: "workgraph_retry" }),
    ]))
  })

  it("uses the app's exact execution-default and retry commands", () => {
    expect(toCommandRequest("workgraph_update_defaults", {
      operation_id: "operation-defaults",
      expected_version: 1,
      defaults: {
        execution: { effort: "high" },
        recap: { quietHours: 12 },
      },
    })).toEqual({
      operationId: "operation-defaults",
      command: {
        version: 1,
        type: "update_workgraph_defaults",
        expectedVersion: 1,
        defaults: {
          execution: { effort: "high" },
          recap: { quietHours: 12 },
        },
      },
    })
    expect(toCommandRequest("workgraph_update_execution", {
      operation_id: "operation-update",
      stream_id: "stream-1",
      expected_version: 3,
      execution: {
        environment: { kind: "hosted_workspace" },
        model: { providerId: "openai", modelId: "gpt-5" },
        effort: "high",
        tools: ["connection_work_source_list"],
        connectionIds: ["connection-1"],
      },
    })).toEqual({
      operationId: "operation-update",
      command: {
        version: 1,
        type: "update_stream",
        streamId: "stream-1",
        expectedVersion: 3,
        execution: {
          environment: { kind: "hosted_workspace" },
          model: { providerId: "openai", modelId: "gpt-5" },
          effort: "high",
          tools: ["connection_work_source_list"],
          connectionIds: ["connection-1"],
        },
      },
    })
    expect(toCommandRequest("workgraph_retry", {
      operation_id: "operation-retry",
      work_item_id: "item-1",
      expected_version: 4,
    })).toEqual({
      operationId: "operation-retry",
      command: { version: 1, type: "retry_work_item", workItemId: "item-1", expectedVersion: 4 },
    })
  })

  it("confirms only the exact reviewed admission proposal version", () => {
    expect(z.object(WORKGRAPH_TOOL_SCHEMAS.workgraph_admit).safeParse({
      operation_id: "operation-admit",
      proposal_id: "proposal-1",
      source: { work_source_id: "source-1", revision_id: "revision-1", content_hash: "a".repeat(64) },
      disposition: "create",
      stream_title: "Launch",
    }).success).toBe(false)
    expect(toCommandRequest("workgraph_admit", {
      operation_id: "operation-admit",
      proposal_id: "proposal-1",
      expected_version: 2,
      source: { work_source_id: "source-1", revision_id: "revision-1", content_hash: "a".repeat(64) },
      disposition: "create",
      stream_title: "Launch",
    })).toEqual({
      operationId: "operation-admit",
      command: {
        version: 1,
        type: "confirm_admission",
        proposalId: "proposal-1",
        expectedVersion: 2,
        source: { workSourceId: "source-1", revisionId: "revision-1", contentHash: "a".repeat(64) },
        selection: { mode: "create", streamTitle: "Launch" },
      },
    })
  })

  it("never accepts an owner identity or credentials from tool arguments", () => {
    Object.values(WORKGRAPH_TOOL_SCHEMAS).forEach((schema) => {
      expect(Object.keys(schema)).not.toEqual(expect.arrayContaining(["owner", "owner_id", "owner_user_id", "credentials", "token"]))
    })
  })

  it("rejects nested credential material in Source View filters", () => {
    expect(z.object(WORKGRAPH_TOOL_SCHEMAS.workgraph_configure_source_view).safeParse({
      team_connection_id: "connection-1",
      provider: "github",
      provider_user_id: "octocat",
      filters: { metadata: { token: "github_pat_1234567890abcdef" } },
    }).success).toBe(false)
  })

  it("forwards atomic input unchanged and returns the service cursor", async () => {
    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>()
    const request = vi.fn(async (_path: string, init?: RequestInit) => ({ cursor: "42", command: JSON.parse(String(init?.body)) }))
    registerWorkGraphTools((name, _config, handler) => handlers.set(name, handler), request, false)
    const result = await handlers.get("workgraph_create_stream")?.({ operation_id: "op-1", title: "Launch" })
    expect(request).toHaveBeenCalledWith("/api/workgraph/commands", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ operationId: "op-1", command: { version: 1, type: "create_stream", title: "Launch" } }),
    }))
    expect(result).toMatchObject({ content: [{ text: expect.stringContaining('"cursor": "42"') }] })
  })

  it("uses the exact create Stream command payload and result cursor as the UI HTTP boundary", async () => {
    const input = { operation_id: "operation-1", title: "Launch", description: "Ship cloud" }
    const mcpCommand = toCommandRequest("workgraph_create_stream", input)
    const uiCommand = { operationId: "operation-1", command: { version: 1, type: "create_stream", title: "Launch", description: "Ship cloud" } }
    expect(mcpCommand).toEqual(uiCommand)

    const execute = vi.fn(async (payload: unknown) => ({ ok: true, operationId: "operation-1", cursor: "7", value: { streamId: "stream-1" }, payload }))
    const uiResult = await execute(uiCommand)
    const request = async (_path: string, init?: RequestInit) => execute(JSON.parse(String(init?.body)))
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
    registerWorkGraphTools((name, _config, handler) => handlers.set(name, handler), request, false)
    const mcpResult = await handlers.get("workgraph_create_stream")?.(input) as { content: Array<{ text: string }> }
    expect(JSON.parse(mcpResult.content[0]!.text)).toEqual(uiResult)
    expect(JSON.parse(mcpResult.content[0]!.text)).toMatchObject({ cursor: "7", value: { streamId: "stream-1" } })
  })

  it("calls an injected embedded service directly without an HTTP hop", async () => {
    const execute = vi.fn(async () => ({ ok: true, cursor: "9", value: { streamId: "stream-9" } }))
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
    registerWorkGraphTools((name, _config, handler) => handlers.set(name, handler), {
      execute,
      snapshot: async () => ({ records: [] }),
      readStream: async () => undefined,
    }, false)
    const result = await handlers.get("workgraph_create_stream")?.({ operation_id: "op-9", title: "Embedded" }) as { content: Array<{ text: string }> }
    expect(execute).toHaveBeenCalledWith({ operationId: "op-9", command: { version: 1, type: "create_stream", title: "Embedded" } })
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ cursor: "9", value: { streamId: "stream-9" } })
  })

  it("lists and reads Work Sources through their canonical public routes", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ sources: [] })
      .mockResolvedValueOnce({
        id: "source-1",
        ownerUserId: "user_1",
        title: "Launch source",
        latestRevisionId: "revision-1",
        revisionCount: 1,
        createdAt: 1,
        updatedAt: 1,
      })
    await callWorkGraph(request, "workgraph_list", { kind: "sources", cursor: "sqlite:2", limit: 10 })
    await callWorkGraph(request, "workgraph_get", { record_type: "source", id: "source-1" })
    expect(request).toHaveBeenNthCalledWith(1, "/api/workgraph/sources?after=sqlite%3A2&limit=10", { method: "GET" })
    expect(request).toHaveBeenNthCalledWith(2, "/api/workgraph/sources/source-1", { method: "GET" })
  })

  it("validates direct reads and reports missing embedded Stream and Source records", async () => {
    const transport = {
      execute: async () => ({}),
      snapshot: async () => snapshotPage([], "change_empty", 1),
      readStream: async () => undefined,
      readSource: async () => undefined,
    }

    await expect(callWorkGraph(transport, "workgraph_get", { record_type: "stream", id: "stream_missing" }))
      .rejects.toMatchObject({ code: "not_found", status: 404, recordType: "stream", recordId: "stream_missing" })
    await expect(callWorkGraph(transport, "workgraph_get", { record_type: "source", id: "source_missing" }))
      .rejects.toMatchObject({ code: "not_found", status: 404, recordType: "source", recordId: "source_missing" })
  })

  it("turns HTTP 404 Stream and Source reads into typed MCP not_found errors", async () => {
    const request = vi.fn(async () => {
      throw new McpHttpError(404, "not_found", "record-secret-response")
    })
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>()
    registerWorkGraphTools((name, _config, handler) => handlers.set(name, handler), request, false)

    for (const [recordType, id] of [["stream", "stream_missing"], ["source", "source_missing"]] as const) {
      const result = await handlers.get("workgraph_get")!({ record_type: recordType, id })
      const body = result.content[0]!.text

      expect(result.isError).toBe(true)
      expect(JSON.parse(body)).toMatchObject({
        error: { code: "not_found", status: 404, recordType, recordId: id },
      })
      expect(body).not.toContain("record-secret-response")
    }
  })

  it("preserves typed non-not-found HTTP failures without exposing their messages", async () => {
    const request = vi.fn(async () => {
      throw new McpHttpError(429, "connection_provider_rate_limited", "provider-secret-response", true)
    })
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>()
    registerWorkGraphTools((name, _config, handler) => handlers.set(name, handler), request, false)

    const result = await handlers.get("workgraph_list")!({ kind: "sources" })
    const body = result.content[0]!.text

    expect(result.isError).toBe(true)
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "connection_provider_rate_limited",
        status: 429,
        message: "WorkGraph request failed",
        retryable: true,
      },
    })
    expect(body).not.toContain("provider-secret-response")
  })

  it("aggregates more than one hundred snapshot records for list tools", async () => {
    const pages = [
      snapshotPage(streams(0, 100), "change_101", 5, "resume_100"),
      snapshotPage(streams(100, 1), "change_101", 5, undefined, 101),
    ]
    const request = vi.fn(async () => pages.shift())

    const result = await callWorkGraph(request, "workgraph_list", { kind: "streams" }) as { records: unknown[] }
    expect(result.records).toHaveLength(101)
    expect(request.mock.calls).toEqual([
      ["/api/workgraph/snapshot?limit=100", { method: "GET" }],
      ["/api/workgraph/snapshot?limit=100&after=resume_100", { method: "GET" }],
    ])
  })

  it("preserves an explicitly empty list as a successful validated snapshot", async () => {
    const result = await callWorkGraph(
      vi.fn(async () => snapshotPage([], "change_empty", 5)),
      "workgraph_list",
      { kind: "work" },
    ) as { records: unknown[]; snapshotCursor: string }

    expect(result).toMatchObject({ records: [], snapshotCursor: "change_empty" })
  })

  it("throws typed not_found when a requested snapshot record does not exist", async () => {
    const request = vi.fn(async () => snapshotPage(streams(0, 1), "change_1", 5))

    await expect(callWorkGraph(request, "workgraph_get", { record_type: "outcome", id: "outcome_missing" }))
      .rejects.toEqual(expect.objectContaining({
        code: "not_found",
        status: 404,
        recordType: "outcome",
        recordId: "outcome_missing",
      }))
    await expect(callWorkGraph(request, "workgraph_get", { record_type: "outcome", id: "outcome_missing" }))
      .rejects.toBeInstanceOf(WorkGraphRecordNotFoundError)
  })

  it("throws typed not_found when a Stream has no requested Recap", async () => {
    await expect(callWorkGraph(
      vi.fn(async () => snapshotPage([], "change_empty", 5)),
      "workgraph_recap",
      { stream_id: "stream_1", recap_id: "recap_missing" },
    )).rejects.toMatchObject({
      code: "not_found",
      status: 404,
      recordType: "recap",
      recordId: "recap_missing",
    })
  })

  it("returns only the latest Recap for the requested Stream when no Recap ID is supplied", async () => {
    const records = [
      recap("recap_old", "stream_1", 10),
      recap("recap_other", "stream_2", 30),
      recap("recap_latest", "stream_1", 20),
      invalidatedRecap("recap_retired", "stream_1", 40),
    ]
    const result = await callWorkGraph(
      vi.fn(async () => snapshotPage(records, "change_recaps", 30)),
      "workgraph_recap",
      { stream_id: "stream_1" },
    ) as { records: Array<{ id: string }>; references: Array<{ resource: { id: string } }> }

    expect(result.records.map((record) => record.id)).toEqual(["recap_latest"])
    expect(result.references.map((reference) => reference.resource.id)).toEqual(["recap_latest"])
  })

  it("returns a typed MCP error instead of a successful empty record array", async () => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>()
    registerWorkGraphTools((name, _config, handler) => handlers.set(name, handler), async () => snapshotPage([], "change_empty", 5), false)

    const result = await handlers.get("workgraph_get")!({ record_type: "decision", id: "decision_missing" })

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      error: {
        code: "not_found",
        status: 404,
        message: "WorkGraph decision 'decision_missing' was not found",
        recordType: "decision",
        recordId: "decision_missing",
      },
    })
  })

  it("rejects an invalid snapshot before evaluating a requested record", async () => {
    await expect(callWorkGraph(
      vi.fn(async () => ({ records: [] })),
      "workgraph_get",
      { record_type: "decision", id: "decision_missing" },
    )).rejects.toMatchObject({ name: "ZodError" })
  })

  it("restarts one invalidated embedded snapshot without merging stale records", async () => {
    let call = 0
    const snapshot = vi.fn(async () => {
      call++
      if (call === 1) return snapshotPage(streams(0, 100), "change_stale", 5, "stale_resume")
      if (call === 2) throw { code: "cursor_invalid" }
      if (call === 3) return snapshotPage(streams(100, 100), "change_fresh", 6, "fresh_resume")
      return snapshotPage(streams(200, 1), "change_fresh", 6, undefined, 101)
    })
    const transport = { execute: async () => ({}), snapshot, readStream: async () => undefined }

    const result = await callWorkGraph(transport, "workgraph_list", { kind: "streams" }) as { snapshotCursor: string; records: Array<{ id: string }> }
    expect(snapshot).toHaveBeenCalledTimes(4)
    expect(result.snapshotCursor).toBe("change_fresh")
    expect(result.records[0]?.id).toBe("stream_101")
    expect(result.records).toHaveLength(101)
  })

  it("fails permanent snapshot invalidation after one full restart", async () => {
    let call = 0
    const request = vi.fn(async () => {
      call++
      if (call % 2 === 1) return snapshotPage(streams(0, 100), `change_${call}`, call, `resume_${call}`)
      throw new Error("cursor_invalid")
    })

    await expect(callWorkGraph(request, "workgraph_list", { kind: "streams" })).rejects.toThrow("cursor_invalid")
    expect(request).toHaveBeenCalledTimes(4)
  })

  it("reads personal WorkGraph defaults through HTTP and embedded transports", async () => {
    const request = vi.fn(async () => ({ id: "workgraph_default", version: 2 }))
    await callWorkGraph(request, "workgraph_get_defaults", {})
    expect(request).toHaveBeenCalledWith("/api/workgraph/defaults", { method: "GET" })

    const readDefaults = vi.fn(async () => ({ id: "workgraph_default", version: 3 }))
    expect(await callWorkGraph({
      execute: async () => ({}),
      snapshot: async () => ({}),
      readStream: async () => undefined,
      readDefaults,
    }, "workgraph_get_defaults", {})).toEqual({ id: "workgraph_default", version: 3 })
    expect(readDefaults).toHaveBeenCalledOnce()
  })

  it("uses the same Connections-backed Source View and intake routes as the UI", async () => {
    const request = vi.fn(async () => ({}))
    await callWorkGraph(request, "workgraph_source_views", {})
    await callWorkGraph(request, "workgraph_configure_source_view", {
      team_connection_id: "connection-1",
      provider: "github",
      provider_user_id: "octocat",
      filters: { repo: "claxedo/claxedo" },
    })
    await callWorkGraph(request, "workgraph_refresh_source_view", { source_view_id: "view/1" })
    await callWorkGraph(request, "workgraph_intake", { source_view_id: "view/1" })
    await callWorkGraph(request, "workgraph_stage_candidate", { candidate_id: "candidate/1" })
    await callWorkGraph(request, "workgraph_sync_candidate", { candidate_id: "candidate/1", idempotency_key: "sync-1", summary: "Shipped", status: "done" })

    expect(request.mock.calls).toEqual([
      ["/api/workgraph/source-views", { method: "GET" }],
      ["/api/workgraph/source-views", { method: "POST", body: JSON.stringify({ teamConnectionId: "connection-1", provider: "github", providerUserId: "octocat", filters: { repo: "claxedo/claxedo" }, syncPolicy: "silent" }) }],
      ["/api/workgraph/source-views/view%2F1/refresh", { method: "POST", body: "{}" }],
      ["/api/workgraph/intake?sourceViewId=view%2F1", { method: "GET" }],
      ["/api/workgraph/intake/candidate%2F1/stage", { method: "POST", body: "{}" }],
      ["/api/workgraph/intake/candidate%2F1/sync", { method: "POST", body: JSON.stringify({ idempotencyKey: "sync-1", summary: "Shipped", status: "done" }) }],
    ])
  })

  it("dispatches Connections-backed intake in process and hides unsupported embedded capabilities", async () => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
    const embedded = {
      execute: vi.fn(async () => ({})),
      snapshot: vi.fn(async () => ({ records: [] })),
      readStream: vi.fn(async () => undefined),
      listSourceViews: vi.fn(async () => ({ sourceViews: [] })),
      stageCandidate: vi.fn(async (id: string) => ({ id, state: "staged" })),
    }
    registerWorkGraphTools((name, _config, handler) => handlers.set(name, handler), embedded, false)
    expect(handlers.has("workgraph_source_views")).toBe(true)
    expect(handlers.has("workgraph_stage_candidate")).toBe(true)
    expect(handlers.has("workgraph_place_candidate")).toBe(false)
    expect(handlers.has("workgraph_configure_source_view")).toBe(false)
    await callWorkGraph(embedded, "workgraph_source_views", {})
    await callWorkGraph(embedded, "workgraph_stage_candidate", { candidate_id: "candidate-1" })
    expect(embedded.listSourceViews).toHaveBeenCalledOnce()
    expect(embedded.stageCandidate).toHaveBeenCalledWith("candidate-1")
  })

  it("keeps reads and removes mutations in read-only mode", () => {
    const names: string[] = []
    registerWorkGraphTools((name) => names.push(name), async () => ({}), true)
    expect(names).toEqual(["workgraph_get_defaults", "workgraph_list", "workgraph_get", "workgraph_source_views", "workgraph_intake", "workgraph_recap"])
  })
})

const actor = { type: "user" as const, id: "user_1" }

function streams(start: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    recordType: "stream" as const,
    schemaVersion: 1 as const,
    ownerUserId: "user_1",
    version: 1,
    createdAt: start + index + 1,
    updatedAt: start + index + 1,
    provenance: { actor },
    id: `stream_${start + index + 1}`,
    title: `Stream ${start + index + 1}`,
    lifecycleState: "active" as const,
    visibility: "visible" as const,
    pinned: false,
    executionDefaults: {},
    recapDefaults: {},
    activity: { lastActivityAt: 1, recapDueAt: 2 },
    durableEffectCount: 0,
    sourceRevisionRefs: [],
  }))
}

function recap(id: string, streamId: string, updatedAt: number) {
  return {
    recordType: "recap" as const,
    schemaVersion: 1 as const,
    ownerUserId: "user_1",
    version: 1,
    createdAt: updatedAt,
    updatedAt,
    provenance: { actor },
    id,
    streamId,
    activityRange: { fromSequence: 1, toSequence: 1, quietSince: updatedAt },
    summary: `Recap ${id}`,
    actionableReferences: [],
    generation: {
      state: "succeeded" as const,
      model: { providerId: "openai", modelId: "gpt-5" },
      effort: "medium",
      generatedAt: updatedAt,
      method: "agent_session" as const,
      sessionId: `session_${id}`,
    },
    sourceRevisionRefs: [],
  }
}

function invalidatedRecap(id: string, streamId: string, updatedAt: number) {
  return {
    ...recap(id, streamId, updatedAt),
    generation: {
      state: "invalidated" as const,
      model: { providerId: "openai", modelId: "gpt-5" },
      effort: "medium",
      reason: "Retired non-session generation",
      source: "retired_non_session_generation" as const,
    },
  }
}

type SnapshotRecordFixture = ReturnType<typeof streams>[number] | ReturnType<typeof recap> | ReturnType<typeof invalidatedRecap>

function snapshotPage(
  records: SnapshotRecordFixture[],
  snapshotCursor: string,
  capturedAt: number,
  nextCursor?: string,
  sequenceStart = 1,
) {
  return {
    snapshotCursor,
    records,
    references: records.map((record, index) => ({
      sequence: sequenceStart + index,
      resource: { type: record.recordType, id: record.id },
      version: record.version,
    })),
    hasMore: !!nextCursor,
    ...(nextCursor ? { nextCursor } : {}),
    capturedAt,
  }
}
