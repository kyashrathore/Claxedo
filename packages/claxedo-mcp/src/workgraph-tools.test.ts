import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { McpHttpError } from "./http-error"
import {
  WORKGRAPH_CAPABILITY_MAP,
  WORKGRAPH_TOOL_SCHEMAS,
  WorkGraphRecordNotFoundError,
  WorkGraphSessionAttachmentDeniedError,
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
      expect.objectContaining({ uiAction: "Create an Outcome", tool: "workgraph_create_outcome" }),
      expect.objectContaining({ uiAction: "Create a Task", tool: "workgraph_create_task" }),
      expect.objectContaining({ uiAction: "Update a Stream, Outcome, or Task", tool: "workgraph_update" }),
      expect.objectContaining({ uiAction: "Update Stream execution defaults", tool: "workgraph_update_execution" }),
      expect.objectContaining({ uiAction: "Retry a Work Item", tool: "workgraph_retry" }),
    ]))
  })

  it("requires canonical Outcome success criteria and Task completion contracts at the tool boundary", () => {
    expect(z.strictObject(WORKGRAPH_TOOL_SCHEMAS.workgraph_create_outcome).safeParse({
      operation_id: "operation-outcome",
      stream_id: "stream-1",
      title: "Launch",
    }).success).toBe(false)
    expect(z.strictObject(WORKGRAPH_TOOL_SCHEMAS.workgraph_create_task).safeParse({
      operation_id: "operation-task",
      stream_id: "stream-1",
      title: "Verify launch",
    }).success).toBe(false)
    expect(toCommandRequest("workgraph_create_outcome", {
      operation_id: "operation-outcome",
      stream_id: "stream-1",
      title: "Launch",
      success_criteria: ["Production is healthy"],
    })).toEqual({
      operationId: "operation-outcome",
      command: {
        version: 1,
        type: "create_outcome",
        streamId: "stream-1",
        title: "Launch",
        successCriteria: ["Production is healthy"],
      },
    })
    expect(toCommandRequest("workgraph_create_task", {
      operation_id: "operation-task",
      stream_id: "stream-1",
      title: "Verify launch",
      completion_contract: {
        version: 1,
        mode: "all",
        requirements: [{ id: "tests", kind: "test", description: "Tests pass" }],
      },
    })).toMatchObject({
      command: {
        type: "create_work_item",
        completionContract: {
          requirements: [{ id: "tests", kind: "test", description: "Tests pass" }],
        },
      },
    })
  })

  it("maps general edits to the exact versioned Stream, Outcome, and Task commands", () => {
    expect(toCommandRequest("workgraph_update", {
      operation_id: "operation-stream-update",
      target_type: "stream",
      target_id: "stream-1",
      expected_version: 2,
      title: "Launch safely",
      activity_granularity: "detailed",
    })).toEqual({
      operationId: "operation-stream-update",
      command: {
        version: 1,
        type: "update_stream",
        streamId: "stream-1",
        expectedVersion: 2,
        title: "Launch safely",
        activityGranularity: "detailed",
      },
    })
    expect(toCommandRequest("workgraph_update", {
      operation_id: "operation-outcome-update",
      target_type: "outcome",
      target_id: "outcome-1",
      expected_version: 3,
      success_criteria: ["SLO holds"],
    })).toEqual({
      operationId: "operation-outcome-update",
      command: {
        version: 1,
        type: "update_outcome",
        outcomeId: "outcome-1",
        expectedVersion: 3,
        successCriteria: ["SLO holds"],
      },
    })
    expect(toCommandRequest("workgraph_update", {
      operation_id: "operation-task-update",
      target_type: "work_item",
      target_id: "task-1",
      expected_version: 4,
      outcome_id: null,
      dependency_ids: ["task-0"],
      priority: 2,
    })).toEqual({
      operationId: "operation-task-update",
      command: {
        version: 1,
        type: "update_work_item",
        workItemId: "task-1",
        expectedVersion: 4,
        outcomeId: null,
        dependencyIds: ["task-0"],
        priority: 2,
      },
    })
  })

  it("denies standalone MCP Session attachment without trusted embedded identity", async () => {
    await expect(callWorkGraph(vi.fn(), "workgraph_bind_session", {
      operation_id: "operation-bind",
      stream_id: "stream-1",
    })).rejects.toBeInstanceOf(WorkGraphSessionAttachmentDeniedError)
  })

  it("binds, selects, checkpoints, and completes through trusted current-Session identity", async () => {
    const unselected = sessionBinding()
    const selected = sessionBinding({ currentWorkItemId: "task-1", currentAttemptId: "attempt-1", version: 2 })
    const transport = {
      execute: vi.fn(async (request) => ({ ok: true, operationId: request.operationId, cursor: "cursor-1", value: { workItemId: "task-1" } })),
      snapshot: vi.fn(),
      readStream: vi.fn(),
      readWorkItem: vi.fn(async () => ({ id: "task-1" })),
      readAttempt: vi.fn(async () => ({ id: "attempt-1" })),
      bindSession: vi.fn(async () => unselected),
      readSessionBinding: vi.fn(async () => unselected),
      attachSessionTask: vi.fn(async () => selected),
      recordSessionCheckpoint: vi.fn(async () => ({ recordType: "agent_checkpoint" })),
      releaseSessionBinding: vi.fn(async () => ({ ...selected, state: "released", releasedAt: 2, version: 3 })),
    }
    const context = {
      session: {
        sessionId: "session-1",
        projectId: "project-1",
        resolvedExecution: {
          environment: { kind: "local_worktree" as const, directory: "/repo" },
          repository: { baseRevision: "HEAD" },
          harness: "opencode",
          agent: "build",
          model: { providerId: "openai", modelId: "gpt-5" },
          effort: "high",
          tools: [],
          connectionIds: [],
        },
      },
    }
    await callWorkGraph(transport, "workgraph_bind_session", {
      operation_id: "operation-bind",
      stream_id: "stream-1",
    }, context)
    expect(transport.bindSession).toHaveBeenCalledWith({
      operationId: "operation-bind",
      streamId: "stream-1",
      sessionId: "session-1",
      projectId: "project-1",
    })
    await callWorkGraph(transport, "workgraph_select_work", {
      operation_id: "operation-select",
      work_item_id: "task-1",
    }, context)
    expect(transport.attachSessionTask).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "operation-select",
      bindingId: "binding-1",
      workItemId: "task-1",
      expectedVersion: 1,
      resolvedExecution: context.session.resolvedExecution,
    }))
    transport.readSessionBinding.mockResolvedValue(selected)
    await callWorkGraph(transport, "workgraph_record_progress", {
      operation_id: "operation-progress",
      level: "progress",
      summary: "Core flow is working",
    }, context)
    expect(transport.recordSessionCheckpoint).toHaveBeenCalledWith({
      operationId: "operation-progress",
      bindingId: "binding-1",
      level: "progress",
      summary: "Core flow is working",
      evidenceIds: [],
    })
    await callWorkGraph(transport, "workgraph_complete_current_work", {
      operation_id: "operation-complete",
      summary: "Implemented and verified",
      evidence: [{ requirement_id: "tests", evidence: { kind: "test_result", summary: "Tests pass", passed: true } }],
    }, context)
    expect(transport.execute).toHaveBeenCalledWith({
      operationId: "operation-complete",
      command: {
        version: 1,
        type: "complete_attempt",
        attemptId: "attempt-1",
        sessionId: "session-1",
        workspaceId: "project-1",
        summary: "Implemented and verified",
        artifacts: [],
        evidence: [{ requirementId: "tests", evidence: { kind: "test_result", summary: "Tests pass", passed: true } }],
      },
    })
  })

  it("uses the app's exact execution-default and retry commands", () => {
    expect(z.object(WORKGRAPH_TOOL_SCHEMAS.workgraph_execute).safeParse({
      operation_id: "operation-execute",
      target_type: "stream",
      target_id: "stream-1",
    }).success).toBe(false)
    expect(toCommandRequest("workgraph_execute", {
      operation_id: "operation-execute",
      target_type: "stream",
      target_id: "stream-1",
      mode: "supervised",
    })).toEqual({
      operationId: "operation-execute",
      command: {
        version: 1,
        type: "execute_stream",
        streamId: "stream-1",
        executionMode: "supervised",
      },
    })
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

  it("uses canonical proposal lifecycle, nested execution, and Task cancellation commands", () => {
    expect(toCommandRequest("workgraph_review_proposal", {
      operation_id: "operation-proposal",
      action: "retry",
      proposal_id: "proposal-1",
      expected_version: 0,
    })).toEqual({
      operationId: "operation-proposal",
      command: { version: 1, type: "retry_admission_planning", proposalId: "proposal-1", expectedVersion: 0 },
    })
    expect(toCommandRequest("workgraph_update_execution", {
      operation_id: "operation-outcome",
      target_type: "outcome",
      target_id: "outcome-1",
      expected_version: 2,
      execution: { effort: "high" },
    })).toEqual({
      operationId: "operation-outcome",
      command: { version: 1, type: "update_outcome", outcomeId: "outcome-1", expectedVersion: 2, execution: { effort: "high" } },
    })
    expect(toCommandRequest("workgraph_cancel_work", {
      operation_id: "operation-cancel",
      work_item_id: "item-1",
      expected_version: 4,
      reason: "Replanned",
    })).toEqual({
      operationId: "operation-cancel",
      command: { version: 1, type: "cancel_work_item", workItemId: "item-1", expectedVersion: 4, reason: "Replanned" },
    })
    expect(toCommandRequest("workgraph_stream_lifecycle", {
      operation_id: "operation-reopen",
      stream_id: "stream-1",
      expected_version: 5,
      state: "reopened",
      reason: "Continue the launch",
    })).toEqual({
      operationId: "operation-reopen",
      command: { version: 1, type: "set_stream_lifecycle", streamId: "stream-1", expectedVersion: 5, state: "reopened", reason: "Continue the launch" },
    })
  })

  it("reads and explicitly refreshes owner-scoped execution capabilities without selectors", async () => {
    const request = vi.fn(async () => executionCapabilities())
    await expect(callWorkGraph(request, "workgraph_execution_capabilities", {})).resolves.toEqual(executionCapabilities())
    await expect(callWorkGraph(request, "workgraph_refresh_execution_capabilities", {})).resolves.toEqual(executionCapabilities())
    expect(request.mock.calls).toEqual([
      ["/api/workgraph/execution-capabilities", { method: "GET" }],
      ["/api/workgraph/execution-capabilities/refresh", { method: "POST", body: "{}" }],
    ])
  })

  it("uses stable cursor pages for Attention, notifications, candidates, and changes", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ items: [], total: 0, hasMore: false })
      .mockResolvedValueOnce({ notifications: [], hasMore: false })
      .mockResolvedValueOnce({ candidates: [], hasMore: false })
      .mockResolvedValueOnce({ changes: [], cursor: "change-1", timedOut: true })
    await callWorkGraph(request, "workgraph_attention", { cursor: "attention-1", limit: 25 })
    await callWorkGraph(request, "workgraph_notifications", { cursor: "notification-1", limit: 20, state: "unread" })
    await callWorkGraph(request, "workgraph_intake", { cursor: "candidate-1", limit: 15 })
    await callWorkGraph(request, "workgraph_changes", { cursor: "change-1", limit: 10, wait_ms: 500 })
    expect(request.mock.calls).toEqual([
      ["/api/workgraph/attention?limit=25&after=attention-1", { method: "GET" }],
      ["/api/workgraph/notifications?limit=20&after=notification-1&state=unread", { method: "GET" }],
      ["/api/workgraph/intake?limit=15&after=candidate-1", { method: "GET" }],
      ["/api/workgraph/changes?limit=10&after=change-1&waitMs=500", { method: "GET" }],
    ])
  })

  it("reads bounded Task activity with progress granularity by default", async () => {
    const request = vi.fn(async () => ({ entries: [], hasMore: false }))
    await expect(callWorkGraph(request, "workgraph_activity", {
      work_item_id: "task-1",
      cursor: "activity-1",
      limit: 20,
    })).resolves.toEqual({ entries: [], hasMore: false })
    expect(request).toHaveBeenCalledWith(
      "/api/workgraph/work-items/task-1/activity?limit=20&after=activity-1&granularity=progress",
      { method: "GET" },
    )
  })

  it("marks actionable Recap notifications read with optimistic concurrency", async () => {
    const notification = {
      id: "notification-1",
      ownerUserId: "user_1",
      version: 2,
      kind: "actionable_recap" as const,
      state: "read" as const,
      streamId: "stream-1",
      recapId: "recap-1",
      createdAt: 1,
      updatedAt: 2,
      readAt: 2,
    }
    const request = vi.fn(async () => notification)
    await expect(callWorkGraph(request, "workgraph_mark_notification_read", {
      notification_id: "notification-1",
      expected_version: 1,
    })).resolves.toEqual(notification)
    expect(request).toHaveBeenCalledWith("/api/workgraph/notifications/notification-1/read", {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1 }),
    })
  })

  it("confirms only the exact reviewed admission proposal version and replacement Work Item set", () => {
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

    const replace = {
      operation_id: "operation-replace",
      proposal_id: "proposal-2",
      expected_version: 3,
      source: { work_source_id: "source-1", revision_id: "revision-2", content_hash: "b".repeat(64) },
      disposition: "replace",
      stream_id: "stream-1",
      replace_work_items: [
        { work_item_id: "work-item-1", expected_version: 4 },
        { work_item_id: "work-item-2", expected_version: 7 },
      ],
    }
    expect(z.object(WORKGRAPH_TOOL_SCHEMAS.workgraph_admit).safeParse(replace).success).toBe(true)
    expect(toCommandRequest("workgraph_admit", replace)).toEqual({
      operationId: "operation-replace",
      command: {
        version: 1,
        type: "confirm_admission",
        proposalId: "proposal-2",
        expectedVersion: 3,
        source: { workSourceId: "source-1", revisionId: "revision-2", contentHash: "b".repeat(64) },
        selection: {
          mode: "replace",
          streamId: "stream-1",
          workItems: [
            { workItemId: "work-item-1", expectedVersion: 4 },
            { workItemId: "work-item-2", expectedVersion: 7 },
          ],
        },
      },
    })
    expect(() => toCommandRequest("workgraph_admit", { ...replace, replace_work_items: undefined }))
      .toThrow()
    expect(z.object(WORKGRAPH_TOOL_SCHEMAS.workgraph_admit).safeParse({
      ...replace,
      replace_work_items: [
        { work_item_id: "work-item-1", expected_version: 4 },
        { work_item_id: "work-item-1", expected_version: 4 },
      ],
    }).success).toBe(false)
    expect(() => toCommandRequest("workgraph_admit", {
      ...replace,
      disposition: "keep",
      replace_work_items: [{ work_item_id: "work-item-1", expected_version: 4 }],
    })).toThrow("replace_work_items is only valid for replace admission")
  })

  it("never exposes tenant identity or credentials in tool schemas", () => {
    Object.values(WORKGRAPH_TOOL_SCHEMAS).forEach((schema) => {
      expect(Object.keys(schema)).not.toEqual(expect.arrayContaining([
        "owner",
        "owner_id",
        "owner_user_id",
        "organization",
        "organization_id",
        "org_id",
        "tenant_id",
        "user_id",
        "credentials",
        "token",
      ]))
    })
  })

  it("rejects caller-selected organization and user identity before transport", async () => {
    const request = vi.fn(async () => ({}))
    for (const selector of [
      "owner",
      "owner_id",
      "ownerUserId",
      "organization",
      "organization_id",
      "organizationId",
      "org_id",
      "tenantId",
      "user_id",
    ]) {
      await expect(callWorkGraph(request, "workgraph_create_stream", {
        operation_id: `operation-${selector}`,
        title: "Launch",
        [selector]: "caller-selected-tenant",
      })).rejects.toThrow("organization and user come from trusted request context")
    }
    expect(request).not.toHaveBeenCalled()
  })

  it("keeps identical same-user calls isolated by trusted organization-bound transports", async () => {
    const calls: Array<{ organizationId: string; userId: string; path: string; body: unknown }> = []
    const transport = (organizationId: string, userId: string) => async (path: string, init?: RequestInit) => {
      calls.push({ organizationId, userId, path, body: JSON.parse(String(init?.body)) })
      return {
        ok: true as const,
        operationId: "operation-launch",
        cursor: `cursor-${organizationId}`,
        value: { streamId: `stream-${organizationId}` },
      }
    }
    const input = { operation_id: "operation-launch", title: "Launch" }

    const first = await callWorkGraph(transport("organization-a", "user-1"), "workgraph_create_stream", input)
    const second = await callWorkGraph(transport("organization-b", "user-1"), "workgraph_create_stream", input)

    expect(first).toMatchObject({ value: { streamId: "stream-organization-a" } })
    expect(second).toMatchObject({ value: { streamId: "stream-organization-b" } })
    expect(calls).toEqual([
      expect.objectContaining({ organizationId: "organization-a", userId: "user-1", path: "/api/workgraph/commands" }),
      expect.objectContaining({ organizationId: "organization-b", userId: "user-1", path: "/api/workgraph/commands" }),
    ])
    expect(calls[0]!.body).toEqual(calls[1]!.body)
    expect(JSON.stringify(calls.map((call) => call.body))).not.toMatch(/organization|ownerUser|tenant/i)
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
    const request = vi.fn(async (_path: string, init?: RequestInit) => ({
      ok: true as const,
      operationId: JSON.parse(String(init?.body)).operationId,
      cursor: "42",
      value: { streamId: "stream-42" },
    }))
    registerWorkGraphTools((name, _config, handler) => handlers.set(name, handler), request, false)
    const result = await handlers.get("workgraph_create_stream")?.({ operation_id: "op-1", title: "Launch" })
    expect(request).toHaveBeenCalledWith("/api/workgraph/commands", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ operationId: "op-1", command: { version: 1, type: "create_stream", title: "Launch" } }),
    }))
    expect(result).toMatchObject({ content: [{ text: expect.stringContaining('"cursor": "42"') }] })
  })

  it("resolves the invoking project target when an agent creates a Stream", async () => {
    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>()
    const request = vi.fn(async (_path: string, init?: RequestInit) => ({
      ok: true as const,
      operationId: JSON.parse(String(init?.body)).operationId,
      cursor: "43",
      value: { streamId: "stream-43" },
    }))
    const context = vi.fn(async () => ({
      execution: {
        environment: { kind: "hosted_workspace" as const, repositoryUrl: "https://github.com/acme/project.git" },
        repository: { baseRevision: "HEAD" },
      },
    }))
    registerWorkGraphTools((name, _config, handler) => handlers.set(name, handler), request, false, context)

    await handlers.get("workgraph_create_stream")?.({ operation_id: "op-context", title: "Cloud project" })

    expect(context).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith("/api/workgraph/commands", expect.objectContaining({
      body: JSON.stringify({
        operationId: "op-context",
        command: {
          version: 1,
          type: "create_stream",
          title: "Cloud project",
          execution: {
            environment: { kind: "hosted_workspace", repositoryUrl: "https://github.com/acme/project.git" },
            repository: { baseRevision: "HEAD" },
          },
        },
      }),
    }))
  })

  it("uses the exact create Stream command payload and result cursor as the UI HTTP boundary", async () => {
    const input = { operation_id: "operation-1", title: "Launch", description: "Ship cloud" }
    const mcpCommand = toCommandRequest("workgraph_create_stream", input)
    const uiCommand = { operationId: "operation-1", command: { version: 1, type: "create_stream", title: "Launch", description: "Ship cloud" } }
    expect(mcpCommand).toEqual(uiCommand)

    const execute = vi.fn(async () => ({ ok: true as const, operationId: "operation-1", cursor: "7", value: { streamId: "stream-1" } }))
    const uiResult = await execute(uiCommand)
    const request = async (_path: string, init?: RequestInit) => execute(JSON.parse(String(init?.body)))
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
    registerWorkGraphTools((name, _config, handler) => handlers.set(name, handler), request, false)
    const mcpResult = await handlers.get("workgraph_create_stream")?.(input) as { content: Array<{ text: string }> }
    expect(JSON.parse(mcpResult.content[0]!.text)).toEqual(uiResult)
    expect(JSON.parse(mcpResult.content[0]!.text)).toMatchObject({ cursor: "7", value: { streamId: "stream-1" } })
  })

  it("calls an injected embedded service directly without an HTTP hop", async () => {
    const execute = vi.fn(async () => ({ ok: true as const, operationId: "op-9", cursor: "9", value: { streamId: "stream-9" } }))
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

  it("reads exact source revisions and detailed records from canonical resources", async () => {
    const revision = {
      id: "revision-1",
      workSourceId: "source-1",
      revisionNumber: 1,
      content: "Exact source content",
      contentHash: "a".repeat(64),
      origin: { kind: "manual" as const },
      createdAt: 1,
      createdBy: actor,
    }
    const revisionRequest = vi.fn(async () => revision)
    await expect(callWorkGraph(revisionRequest, "workgraph_source_revision", {
      work_source_id: "source-1",
      revision_id: "revision-1",
    })).resolves.toEqual(revision)
    expect(revisionRequest).toHaveBeenCalledWith(
      "/api/workgraph/sources/source-1/revisions/revision-1",
      { method: "GET" },
    )

    for (const [recordType, path] of [
      ["proposal", "/api/workgraph/proposals/missing"],
      ["work_item", "/api/workgraph/work-items/missing"],
      ["attempt", "/api/workgraph/attempts/missing"],
      ["decision", "/api/workgraph/decisions/missing"],
      ["recap", "/api/workgraph/recaps/missing"],
    ] as const) {
      const request = vi.fn(async () => { throw new McpHttpError(404, "not_found", "missing") })
      await expect(callWorkGraph(request, "workgraph_get", { record_type: recordType, id: "missing" }))
        .rejects.toMatchObject({ code: "not_found", status: 404, recordType, recordId: "missing" })
      expect(request).toHaveBeenCalledWith(path, { method: "GET" })
    }
  })

  it("uses canonical detail pages for Attempts and evidence", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ attempts: [], hasMore: false })
      .mockResolvedValueOnce({ evidence: [], hasMore: false })
    await callWorkGraph(request, "workgraph_attempts", { work_item_id: "item-1", cursor: "attempt-1", limit: 10 })
    await callWorkGraph(request, "workgraph_evidence", {
      action: "list",
      subject: { type: "work_item", workItemId: "item-1" },
      cursor: "evidence-1",
      limit: 20,
    })
    expect(request.mock.calls).toEqual([
      ["/api/workgraph/work-items/item-1/attempts?limit=10&after=attempt-1", { method: "GET" }],
      ["/api/workgraph/evidence?limit=20&after=evidence-1&subjectType=work_item&workItemId=item-1", { method: "GET" }],
    ])
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

  it("filters snapshot lists by the requested noun and rejects misleading pagination", async () => {
    const result = await callWorkGraph(
      vi.fn(async () => snapshotPage([streams(0, 1)[0]!, recap("recap-1", "stream_1", 2)], "change-2", 2)),
      "workgraph_list",
      { kind: "streams" },
    ) as { records: Array<{ recordType: string }> }
    expect(result.records.map((record) => record.recordType)).toEqual(["stream"])
    await expect(callWorkGraph(
      vi.fn(async () => snapshotPage([], "change-2", 2)),
      "workgraph_list",
      { kind: "streams", limit: 10 },
    )).rejects.toThrow("cursor and limit apply only to Work Source pages")
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
      vi.fn(async () => { throw new McpHttpError(404, "not_found", "Recap not found") }),
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
    ) as { id: string }

    expect(result.id).toBe("recap_latest")
  })

  it("returns a typed MCP error instead of a successful empty record array", async () => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>()
    registerWorkGraphTools((name, _config, handler) => handlers.set(name, handler), async () => {
      throw new McpHttpError(404, "not_found", "Decision not found")
    }, false)

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
    const request = vi.fn()
      .mockResolvedValueOnce({ sourceViews: [sourceView()] })
      .mockResolvedValueOnce(sourceView())
      .mockResolvedValueOnce({ created: 1, updated: 0, candidates: [candidate("unorganized")] })
      .mockResolvedValueOnce({ candidates: [candidate("unorganized")], hasMore: false })
      .mockResolvedValueOnce(candidate("staged"))
      .mockResolvedValueOnce({ ok: true })
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
      ["/api/workgraph/intake?limit=50&sourceViewId=view%2F1", { method: "GET" }],
      ["/api/workgraph/intake/candidate%2F1/stage", { method: "POST", body: "{}" }],
      ["/api/workgraph/intake/candidate%2F1/sync", { method: "POST", body: JSON.stringify({ idempotencyKey: "sync-1", summary: "Shipped", status: "done" }) }],
    ])
  })

  it("passes only the team Connection reference to organization-bound Source View transports", async () => {
    const calls: Array<{ organizationId: string; body: unknown }> = []
    const transport = (organizationId: string) => async (_path: string, init?: RequestInit) => {
      calls.push({ organizationId, body: JSON.parse(String(init?.body)) })
      return { ...sourceView(), id: `view-${organizationId}` }
    }
    const input = {
      team_connection_id: "shared-team-connection-id",
      provider: "github" as const,
      provider_user_id: "octocat",
      filters: { repo: "claxedo/claxedo" },
    }

    await callWorkGraph(transport("organization-a"), "workgraph_configure_source_view", input)
    await callWorkGraph(transport("organization-b"), "workgraph_configure_source_view", input)

    expect(calls.map((call) => call.organizationId)).toEqual(["organization-a", "organization-b"])
    expect(calls[0]!.body).toEqual(calls[1]!.body)
    expect(calls[0]!.body).toEqual({
      teamConnectionId: "shared-team-connection-id",
      provider: "github",
      providerUserId: "octocat",
      filters: { repo: "claxedo/claxedo" },
      syncPolicy: "silent",
    })
    expect(JSON.stringify(calls.map((call) => call.body))).not.toMatch(/organization|ownerUser|tenant/i)
  })

  it("dispatches Connections-backed intake in process and hides unsupported embedded capabilities", async () => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
    const embedded = {
      execute: vi.fn(async () => ({})),
      snapshot: vi.fn(async () => ({ records: [] })),
      readStream: vi.fn(async () => undefined),
      listSourceViews: vi.fn(async () => ({ sourceViews: [] })),
      stageCandidate: vi.fn(async () => candidate("staged")),
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

  it("reads, dismisses, and restores independent-session candidates through canonical routes", async () => {
    const sessionCandidate = (state: "unorganized" | "dismissed") => ({
      id: "session-candidate",
      ownerUserId: "user_1",
      version: state === "dismissed" ? 2 : 3,
      title: "Independent session",
      body: "Meaningful AI work",
      state,
      candidateKind: "session" as const,
      sessionId: "session-1",
      createdAt: 1,
      updatedAt: state === "dismissed" ? 2 : 3,
    })
    const request = vi.fn()
      .mockResolvedValueOnce(sessionCandidate("unorganized"))
      .mockResolvedValueOnce(sessionCandidate("dismissed"))
      .mockResolvedValueOnce(sessionCandidate("unorganized"))
    await callWorkGraph(request, "workgraph_get_candidate", { candidate_id: "session-candidate" })
    await callWorkGraph(request, "workgraph_update_candidate", { action: "dismiss", candidate_id: "session-candidate", expected_version: 1 })
    await callWorkGraph(request, "workgraph_update_candidate", { action: "restore", candidate_id: "session-candidate", expected_version: 2 })
    expect(request.mock.calls).toEqual([
      ["/api/workgraph/intake/session-candidate", { method: "GET" }],
      ["/api/workgraph/intake/session-candidate/dismiss", { method: "POST", body: JSON.stringify({ expectedVersion: 1 }) }],
      ["/api/workgraph/intake/session-candidate/restore", { method: "POST", body: JSON.stringify({ expectedVersion: 2 }) }],
    ])
  })

  it("keeps reads and removes mutations in read-only mode", () => {
    const names: string[] = []
    registerWorkGraphTools((name) => names.push(name), async () => ({}), true)
    expect(names).toEqual([
      "workgraph_get_defaults",
      "workgraph_execution_capabilities",
      "workgraph_attention",
      "workgraph_notifications",
      "workgraph_list",
      "workgraph_get",
      "workgraph_source_revision",
      "workgraph_changes",
      "workgraph_current_work",
      "workgraph_refresh_context",
      "workgraph_source_views",
      "workgraph_intake",
      "workgraph_get_candidate",
      "workgraph_evidence",
      "workgraph_attempts",
      "workgraph_activity",
      "workgraph_recap",
    ])
  })
})

const actor = { type: "user" as const, id: "user_1" }

function sourceView() {
  return {
    id: "view/1",
    ownerUserId: "user_1",
    version: 1,
    teamConnectionId: "connection-1",
    provider: "github" as const,
    providerUserId: "octocat",
    filters: { repo: "claxedo/claxedo" },
    syncPolicy: "silent" as const,
    status: "active" as const,
    createdAt: 1,
    updatedAt: 1,
  }
}

function candidate(state: "unorganized" | "staged") {
  return {
    id: "candidate/1",
    ownerUserId: "user_1",
    version: state === "staged" ? 2 : 1,
    title: "Issue 1",
    body: "Ship it",
    state,
    candidateKind: "external_issue" as const,
    sourceViewId: "view/1",
    provider: "github" as const,
    externalId: "1",
    externalStatus: "open",
    createdAt: 1,
    updatedAt: state === "staged" ? 2 : 1,
  }
}

function executionCapabilities() {
  return {
    schemaVersion: 1 as const,
    organizationId: "organization-1",
    ownerUserId: "user_1",
    catalogRevision: "a".repeat(64),
    observedAt: 1,
    expiresAt: 300_001,
    environments: [{
      kind: "local_worktree" as const,
      repositoryRequired: true,
      remoteUrlInput: true,
      baseRevisionInput: true,
    }],
    harnesses: [{ id: "opencode" }],
    agents: [{ harnessId: "opencode", id: "build", label: "Build" }],
    models: [],
    tools: [{ harnessId: "opencode", id: "read" }],
    repository: { baseRevisions: ["dev"] },
    connections: [],
  }
}

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

function sessionBinding(overrides: Record<string, unknown> = {}) {
  return {
    recordType: "session_binding" as const,
    schemaVersion: 1 as const,
    ownerUserId: "user_1",
    id: "binding-1",
    version: 1,
    streamId: "stream-1",
    sessionId: "session-1",
    projectId: "project-1",
    state: "active" as const,
    boundAt: 1,
    createdAt: 1,
    updatedAt: 1,
    provenance: { actor: { type: "agent" as const, id: "session-1" }, operationId: "operation-bind" },
    ...overrides,
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
