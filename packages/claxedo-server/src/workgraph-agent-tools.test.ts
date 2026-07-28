import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { describe, expect, test, vi } from "vitest"
import { createLocalWorkGraphAgentTools, localSessionContext } from "./workgraph-agent-tools"
import { createLocalEmbeddedWorkGraph } from "./server-workgraph"
import type { WorkspaceExecutionPort } from "@claxedo/workgraph"

describe("embedded WorkGraph agent tools", () => {
  test("invoke the process-owned service with trusted owner context and no HTTP transport", async () => {
    const execute = vi.fn(async (_context, request) => ({
      ok: true as const,
      operationId: request.operationId,
      cursor: "cursor-1",
      value: { streamId: "stream-1" },
    }))
    const tools = await createLocalWorkGraphAgentTools(embedded(execute) as never, {
      organizationId: "organization-a",
      ownerUserId: "owner-a",
    })

    await expect(
      tools.workgraph_create_stream!.execute(
        {
          operation_id: "operation-1",
          title: "Ship direct tools",
        },
        {
          sessionID: "session-1",
          agent: "build",
          assistantMessageID: "message-1",
          toolCallID: "call-1",
        },
      ),
    ).resolves.toMatchObject({ ok: true, value: { streamId: "stream-1" } })

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "organization-a",
        ownerUserId: "owner-a",
        actor: { type: "agent", id: "session-1" },
        access: { mode: "owner" },
        requestId: expect.stringMatching(/^agent_tool_call-1_/),
      }),
      {
        operationId: "operation-1",
        command: { version: 1, type: "create_stream", title: "Ship direct tools" },
      },
    )

    const source = fs.readFileSync(path.resolve(import.meta.dirname, "workgraph-agent-tools.ts"), "utf8")
    expect(source).not.toContain("fetch(")
    expect(source).not.toContain("/api/workgraph")
    expect(source).not.toContain("127.0.0.1")
  })

  test("does not expose organization or owner selectors in a tool input", async () => {
    const tools = await createLocalWorkGraphAgentTools(embedded(vi.fn()) as never, {
      organizationId: "organization-a",
      ownerUserId: "owner-a",
    })
    await expect(
      tools.workgraph_create_stream!.execute(
        {
          operation_id: "operation-2",
          title: "Invalid selector",
          organization_id: "organization-b",
        },
        {
          sessionID: "session-1",
          agent: "build",
          assistantMessageID: "message-1",
          toolCallID: "call-2",
        },
      ),
    ).rejects.toThrow()
  })

  test("ledger creation is owner-directed from a plain Session and discovered work stays agent-staged", async () => {
    const execute = vi.fn(async (_context, request) => ({
      ok: true as const,
      operationId: request.operationId,
      cursor: "cursor-1",
      value: { workItemId: request.command.type === "create_work_item" ? request.operationId : "unused" },
    }))
    const base = embedded(execute)
    const tools = await createLocalWorkGraphAgentTools({
      ...base,
      sessionBindings: { readForSession: async () => undefined },
    } as never, {
      organizationId: "organization-a",
      ownerUserId: "owner-a",
      // Owner-direction is a positive fact: only a top-level interactive
      // Session confers user authority.
      sessionOwnerDirected: async (sessionId) => sessionId === "session-1",
    })
    const invoke = (action: "create_task" | "file_discovered", sessionID = "session-1") => tools.workgraph_ledger!.execute({
      action,
      operation_id: `ledger-${action}-${sessionID}`,
      stream_id: "stream-1",
      title: action === "create_task" ? "Requested directly" : "Follow-up discovered",
      completion_contract: completion("proof"),
    }, {
      sessionID,
      agent: "build",
      assistantMessageID: "message-1",
      toolCallID: `call-${action}-${sessionID}`,
    })

    await invoke("create_task")
    await invoke("file_discovered")
    // A subagent child session (no binding, but not owner-directed) never
    // fabricates user authority — its Task stays agent-staged.
    await invoke("create_task", "child-session-2")
    expect(execute.mock.calls.map(([context]) => context.actor)).toEqual([
      { type: "user", id: "owner-a" },
      { type: "agent", id: "session-1" },
      { type: "agent", id: "child-session-2" },
    ])
  })

  test("call_master resolves the invoking Session binding and appends to that Stream", async () => {
    const execute = vi.fn(async (_context, request) => ({
      ok: true as const,
      operationId: request.operationId,
      cursor: "cursor-1",
      value: { streamId: "stream-1", mailboxMessageId: "message-1" },
    }))
    const base = embedded(execute)
    const tools = await createLocalWorkGraphAgentTools({
      ...base,
      service: {
        ...base.service,
        queries: {
          ...base.service.queries,
          streams: { read: async () => ({ id: "stream-1", version: 3 }) },
        },
      },
      sessionBindings: { readForSession: async () => binding("session-1", "project-1") },
    } as never, { organizationId: "organization-a", ownerUserId: "owner-a" })

    await expect(tools.call_master!.execute(
      { message: "Rebase and land the completed task." },
      { sessionID: "session-1", agent: "build", assistantMessageID: "message-1", toolCallID: "call-master" },
    )).resolves.toEqual({ streamId: "stream-1", mailboxMessageId: "message-1" })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ actor: { type: "agent", id: "session-1" } }), {
      operationId: expect.stringMatching(/^call_master_call-master_/),
      command: {
        version: 1,
        type: "call_master",
        streamId: "stream-1",
        expectedVersion: 3,
        message: "Rebase and land the completed task.",
      },
    })
  })

  test("restricts structured notes updates to the exact bound Stream master", async () => {
    const execute = vi.fn(async (_context, request) => ({
      ok: true as const,
      operationId: request.operationId,
      cursor: "cursor-1",
      value: { streamId: "stream-1" },
    }))
    const base = embedded(execute)
    const tools = await createLocalWorkGraphAgentTools({
      ...base,
      service: {
        ...base.service,
        queries: { ...base.service.queries, streams: { read: async () => ({ id: "stream-1", version: 4 }) } },
      },
      sessionBindings: { readForSession: async () => binding("ses_master_stream-1", "project-1") },
    } as never, { organizationId: "organization-a", ownerUserId: "owner-a" })
    await expect(tools.workgraph_update_stream_notes!.execute(
      { status: ["Ready"], learnings: [], external_references: [] },
      { sessionID: "ses_master_stream-1", agent: "build", assistantMessageID: "message-1", toolCallID: "notes-1" },
    )).resolves.toEqual({ streamId: "stream-1" })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ actor: { type: "agent", id: "ses_master_stream-1" } }), {
      operationId: expect.stringMatching(/^update_stream_notes_notes-1_/),
      command: {
        version: 1,
        type: "update_stream_notes",
        streamId: "stream-1",
        expectedVersion: 4,
        status: ["Ready"],
        learnings: [],
        externalReferences: [],
      },
    })
    await expect(tools.workgraph_update_stream_notes!.execute(
      { status: [], learnings: [], external_references: [] },
      { sessionID: "worker-1", agent: "build", assistantMessageID: "message-1", toolCallID: "notes-2" },
    )).rejects.toThrow("restricted to the bound Stream master")
  })

  test("notifies only from the exact Stream master and records an integration receipt", async () => {
    const execute = vi.fn(async (_context, request) => ({
      ok: true as const,
      operationId: request.operationId,
      cursor: "cursor-1",
      value: { evidenceId: "evidence-notify", durableEffectReceiptId: "receipt-notify" },
    }))
    const notifyOwner = vi.fn(async () => ({
      channel: "slack",
      threadKey: "slack:team:channel:thread",
      reference: "channel:slack:slack:team:channel:thread",
      duplicate: false,
    }))
    const base = embedded(execute)
    const tools = await createLocalWorkGraphAgentTools({
      ...base,
      sessionBindings: { readForSession: async () => binding("ses_master_stream-1", "project-1") },
    } as never, { organizationId: "organization-a", ownerUserId: "owner-a", notifyOwner })

    await expect(tools.workgraph_notify_owner!.execute(
      { message: "Stream is ready" },
      { sessionID: "ses_master_stream-1", agent: "build", assistantMessageID: "message-1", toolCallID: "notify-1" },
    )).resolves.toMatchObject({ receipt: { evidenceId: "evidence-notify" } })
    expect(notifyOwner).toHaveBeenCalledWith({ idempotencyKey: "notify_owner_notify-1", text: "Stream is ready" })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ actor: { type: "agent", id: "ses_master_stream-1" } }), {
      operationId: "notify_owner_notify-1",
      command: {
        version: 1,
        type: "record_evidence",
        subject: { type: "stream", streamId: "stream-1" },
        evidence: {
          kind: "integration",
          summary: "Notified the Stream owner through slack",
          effect: "published",
          reference: "channel:slack:slack:team:channel:thread",
        },
      },
    })
    await expect(tools.workgraph_notify_owner!.execute(
      { message: "No" },
      { sessionID: "worker-1", agent: "build", assistantMessageID: "message-1", toolCallID: "notify-2" },
    )).rejects.toThrow("restricted to the bound Stream master")
  })

  test("infers a new Stream's local execution target from the invoking Session", async () => {
    const execute = vi.fn(async (_context, request) => ({
      ok: true as const,
      operationId: request.operationId,
      cursor: "cursor-1",
      value: { streamId: "stream-1" },
    }))
    const tools = await createLocalWorkGraphAgentTools(embedded(execute) as never, {
      organizationId: "organization-a",
      ownerUserId: "owner-a",
      sessionExecution: async (sessionId) => ({
        environment: { kind: "local_worktree", directory: `/projects/${sessionId}` },
        repository: { baseRevision: "HEAD" },
      }),
    })

    await tools.workgraph_create_stream!.execute(
      { operation_id: "operation-session", title: "Session-owned Stream" },
      { sessionID: "session-1", agent: "build", assistantMessageID: "message-1", toolCallID: "call-session" },
    )

    expect(execute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      command: expect.objectContaining({
        execution: {
          environment: { kind: "local_worktree", directory: "/projects/session-1" },
          repository: { baseRevision: "HEAD" },
        },
      }),
    }))
  })

  test("derives trusted Session, project, and execution identity for ledger tools", async () => {
    const context = await localSessionContext(async (request) => {
      const pathname = new URL(request.url).pathname
      if (pathname.endsWith("/config")) return Response.json({
        harness: { id: "codex-app-server", access: "native" },
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: "high",
        agent: "build",
      })
      return Response.json({ id: "session-1", projectID: "project-1", directory: "/projects/repo" })
    }, "session-1")
    expect(context).toEqual({
      sessionId: "session-1",
      projectId: "project-1",
      resolvedExecution: {
        environment: { kind: "local_worktree", directory: "/projects/repo" },
        repository: { baseRevision: "HEAD" },
        harness: "codex-app-server",
        agent: "build",
        model: { providerId: "openai", modelId: "gpt-5" },
        effort: "high",
        tools: [],
        connectionIds: [],
      },
    })
  })

  test("retains trusted Session and project identity when selection config is unavailable", async () => {
    const context = await localSessionContext(async (request) => {
      if (new URL(request.url).pathname.endsWith("/config")) {
        return new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } })
      }
      return Response.json({ id: "session-1", projectID: "project-1", directory: "/projects/repo" })
    }, "session-1")

    expect(context).toEqual({
      sessionId: "session-1",
      projectId: "project-1",
    })
  })

  test("derives Pi ledger execution without requiring provider configuration", async () => {
    const context = await localSessionContext(async (request) => {
      if (new URL(request.url).pathname.endsWith("/config")) {
        return Response.json({ harness: { id: "pi", access: "native" }, agent: "build" })
      }
      return Response.json({ id: "session-pi", projectID: "project-1", directory: "/projects/repo" })
    }, "session-pi")
    expect(context?.resolvedExecution).toMatchObject({
      harness: "pi",
      model: { providerId: "pi", modelId: "virtual" },
    })
  })

  test("binds the invoking Session without exposing Session or project selectors", async () => {
    const bind = vi.fn(async (_context, input) => binding(input.sessionId, input.projectId))
    const tools = await createLocalWorkGraphAgentTools({
      ...embedded(vi.fn()),
      sessionBindings: {
        bind,
        readForSession: vi.fn(),
        attachTask: vi.fn(),
        recordCheckpoint: vi.fn(),
        release: vi.fn(),
      },
    } as never, {
      organizationId: "organization-a",
      ownerUserId: "owner-a",
      sessionContext: async (sessionId) => ({
        sessionId,
        projectId: "project-1",
      }),
    })

    await tools.workgraph_bind_session!.execute(
      { operation_id: "operation-bind", stream_id: "stream-1" },
      { sessionID: "session-1", agent: "build", assistantMessageID: "message-1", toolCallID: "call-bind" },
    )
    expect(bind).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: "organization-a",
      ownerUserId: "owner-a",
      actor: { type: "agent", id: "session-1" },
    }), {
      operationId: "operation-bind",
      streamId: "stream-1",
      sessionId: "session-1",
      projectId: "project-1",
    })
  })

  test("keeps one real Session across Task checkpoints, completion, and the next ready Task", async () => {
    const database = new Database(":memory:")
    try {
      const workgraph = await createLocalEmbeddedWorkGraph({
        database,
        execution: terminalExecution(),
        executionCapabilities: {
          read: async (context) => ({
            schemaVersion: 1,
            organizationId: context.organizationId,
            ownerUserId: context.ownerUserId,
            catalogRevision: "a".repeat(64),
            observedAt: Date.now(),
            expiresAt: Date.now() + 300_000,
            environments: [{
              kind: "local_worktree",
              repositoryRequired: true,
              remoteUrlInput: false,
              baseRevisionInput: true,
            }],
            harnesses: [{ id: "codex" }],
            agents: [{ harnessId: "codex", id: "build", label: "Build" }],
            models: [{
              harnessId: "codex",
              providerId: "codex-app-server",
              modelId: "gpt-5.5",
              label: "GPT-5.5",
              efforts: ["high"],
            }],
            tools: [{ harnessId: "codex", id: "terminal" }],
            repository: { baseRevisions: ["HEAD"] },
            connections: [],
          }),
        },
      })
      const session = {
        sessionId: "session-ledger",
        projectId: "/projects/repo",
        resolvedExecution: {
          environment: { kind: "local_worktree" as const, directory: "/projects/repo" },
          repository: { baseRevision: "HEAD" },
          harness: "codex",
          agent: "build",
          model: { providerId: "codex-app-server", modelId: "gpt-5.5" },
          effort: "high",
          tools: [],
          connectionIds: [],
        },
      }
      const tools = await createLocalWorkGraphAgentTools(workgraph, {
        organizationId: "local",
        ownerUserId: "local",
        sessionExecution: async () => session.resolvedExecution,
        sessionContext: async () => session,
        sessionOwnerDirected: async () => true,
      })
      const invoke = (name: keyof typeof tools, input: Record<string, unknown>) =>
        tools[name]!.execute(input, {
          sessionID: session.sessionId,
          agent: "build",
          assistantMessageID: "message-ledger",
          toolCallID: `${String(name)}-${String(input.operation_id ?? "read")}`,
        })
      const streamId = resultId(await invoke("workgraph_create_stream", {
        operation_id: "ledger-stream",
        title: "Ledger journey",
      }), "streamId")
      const outcomeId = resultId(await invoke("workgraph_create_outcome", {
        operation_id: "ledger-outcome",
        stream_id: streamId,
        title: "Journey verified",
        success_criteria: ["Both Tasks completed"],
      }), "outcomeId")
      await invoke("workgraph_pause", {
        operation_id: "ledger-pause",
        stream_id: streamId,
        expected_version: 1,
        reason: "Attach the current Session before execution",
      })
      const firstTaskId = resultId(await invoke("workgraph_create_task", {
        operation_id: "ledger-task-first",
        stream_id: streamId,
        outcome_id: outcomeId,
        title: "Verify first boundary",
        completion_contract: completion("first-proof"),
      }), "workItemId")
      const secondTaskId = resultId(await invoke("workgraph_create_task", {
        operation_id: "ledger-task-second",
        stream_id: streamId,
        outcome_id: outcomeId,
        title: "Verify second boundary",
        dependency_ids: [firstTaskId],
        completion_contract: completion("second-proof"),
      }), "workItemId")

      await invoke("workgraph_bind_session", { operation_id: "ledger-bind", stream_id: streamId })
      await invoke("workgraph_select_work", { operation_id: "ledger-select-first", work_item_id: firstTaskId })
      const checkpoint = await invoke("workgraph_record_progress", {
        operation_id: "ledger-checkpoint",
        level: "progress",
        summary: "First logical boundary verified",
      })
      expect(await invoke("workgraph_record_progress", {
        operation_id: "ledger-checkpoint",
        level: "progress",
        summary: "First logical boundary verified",
      })).toEqual(checkpoint)
      const completionResult = await invoke("workgraph_complete_current_work", {
        operation_id: "ledger-complete-first",
        summary: "First Task complete",
        evidence: [{
          requirement_id: "first-proof",
          evidence: { kind: "test_result", summary: "Focused test passed", passed: true },
        }],
      })
      expect(await invoke("workgraph_complete_current_work", {
        operation_id: "ledger-complete-first",
        summary: "First Task complete",
        evidence: [{
          requirement_id: "first-proof",
          evidence: { kind: "test_result", summary: "Focused test passed", passed: true },
        }],
      })).toEqual(completionResult)

      const next = await invoke("workgraph_select_work", {
        operation_id: "ledger-select-second",
        work_item_id: secondTaskId,
      }) as { sessionId?: string; currentWorkItemId?: string }
      expect(next).toMatchObject({ sessionId: session.sessionId, currentWorkItemId: secondTaskId })
      expect(await invoke("workgraph_current_work", {})).toMatchObject({
        binding: { sessionId: session.sessionId, currentWorkItemId: secondTaskId },
      })
      expect(await invoke("workgraph_activity", { work_item_id: firstTaskId })).toMatchObject({
        entries: expect.arrayContaining([
          expect.objectContaining({ category: "checkpoint", summary: "First logical boundary verified" }),
          expect.objectContaining({ category: "run", summary: expect.stringContaining("result") }),
        ]),
      })
    } finally {
      database.close()
    }
  })
})

function resultId(result: unknown, key: string) {
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("value" in result)) {
    throw new Error(`Expected successful ${key} result: ${JSON.stringify(result)}`)
  }
  const value = result.value && typeof result.value === "object" && key in result.value
    ? result.value[key as keyof typeof result.value]
    : undefined
  if (typeof value !== "string") throw new Error(`Expected ${key}`)
  return value
}

function completion(id: string) {
  return {
    version: 1,
    mode: "all",
    requirements: [{ id, kind: "test", description: "The focused test passes" }],
  }
}

function terminalExecution(): WorkspaceExecutionPort {
  return {
    provisionOrAdopt: async (_context, input) => ({
      id: "envelope-ledger" as never,
      streamId: input.streamId,
      environment: input.environment,
      repository: input.repository,
      workspaceId: "/projects/repo",
    }),
    launch: async (_context, input) => ({
      sessionId: "managed-session" as never,
      envelopeId: input.envelopeId,
      projectId: "/projects/repo",
    }),
    cancel: async () => undefined,
    result: async () => ({ state: "running" }),
    cleanup: async () => undefined,
  }
}

function binding(sessionId: string, projectId: string) {
  return {
    recordType: "session_binding",
    schemaVersion: 1,
    ownerUserId: "owner-a",
    id: "binding-1",
    version: 1,
    streamId: "stream-1",
    sessionId,
    projectId,
    state: "active",
    boundAt: 1,
    createdAt: 1,
    updatedAt: 1,
    provenance: { actor: { type: "agent", id: sessionId }, operationId: "operation-bind" },
  }
}

function embedded(execute: ReturnType<typeof vi.fn>) {
  const empty = async () => undefined
  return {
    service: {
      execute,
      queries: {
        defaults: { read: empty },
        snapshot: {
          page: async () => ({ records: [], references: [], snapshotCursor: "cursor", hasMore: false, capturedAt: 1 }),
        },
        attention: { list: empty },
        streams: { read: empty },
        sources: { list: empty, read: empty, readRevision: empty },
        proposals: { read: empty },
        workItems: { readDetail: empty, listRuns: empty, listActivity: empty },
        attempts: { read: empty },
        decisions: { read: empty },
        evidence: { read: empty, list: empty },
      },
    },
  }
}
