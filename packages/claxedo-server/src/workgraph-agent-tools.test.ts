import fs from "node:fs"
import path from "node:path"
import { describe, expect, test, vi } from "vitest"
import { createLocalWorkGraphAgentTools } from "./workgraph-agent-tools"

describe("embedded WorkGraph agent tools", () => {
  test("invoke the process-owned service with trusted owner context and no HTTP transport", async () => {
    const execute = vi.fn(async (_context, request) => ({
      ok: true as const,
      operationId: request.operationId,
      cursor: "cursor-1",
      value: { streamId: "stream-1" },
    }))
    const tools = await createLocalWorkGraphAgentTools(embedded(execute), {
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
    const tools = await createLocalWorkGraphAgentTools(embedded(vi.fn()), {
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

  test("infers a new Stream's local execution target from the invoking Session", async () => {
    const execute = vi.fn(async (_context, request) => ({
      ok: true as const,
      operationId: request.operationId,
      cursor: "cursor-1",
      value: { streamId: "stream-1" },
    }))
    const tools = await createLocalWorkGraphAgentTools(embedded(execute), {
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
})

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
        workItems: { readDetail: empty, listAttempts: empty },
        attempts: { read: empty },
        decisions: { read: empty },
        recaps: { read: empty },
        evidence: { read: empty, list: empty },
      },
    },
    notifications: { list: empty, markRead: empty },
  } as never
}
