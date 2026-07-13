import BetterSqlite3 from "better-sqlite3"
import { describe, expect, test } from "vitest"
import type { CommandResult, OperationID, WorkGraphContext } from "../src/contracts"
import { createSqliteWorkGraphService } from "../src/adapters/sqlite/store"

describe("SQLite targeted WorkGraph details", () => {
  test("keeps exact reads owner-scoped and paginates immutable Attempt details", async () => {
    const database = new BetterSqlite3(":memory:")
    const owner = context("owner_a")
    const other = context("owner_b")
    const service = createSqliteWorkGraphService({ database }).service
    try {
      const streamId = resultId(await service.execute(owner, request("stream", { version: 1, type: "create_stream", title: "Ship" })), "streamId")
      const workItemId = resultId(await service.execute(owner, request("item", {
        version: 1,
        type: "create_work_item",
        streamId,
        title: "Verify",
        completionContract: {
          version: 1,
          mode: "all",
          requirements: [{ id: "verified", kind: "verification", description: "Verified", instructions: "Run tests" }],
        },
      })), "workItemId")
      const execution = JSON.stringify({
        environment: { kind: "local_worktree" },
        harness: "codex",
        agent: "developer",
        model: { providerId: "openai", modelId: "gpt-5" },
        effort: "high",
        tools: [],
        connectionIds: [],
        isolation: "stream",
        cleanup: "retain",
        integration: "manual",
      })
      const insert = database.prepare(`
        INSERT INTO wg_v2_attempts (
          owner_user_id, id, stream_id, work_item_id, attempt_number, lifecycle,
          resolved_execution_profile_json, envelope_id, child_workspace_id, session_id,
          row_version, schema_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, 1, 2, ?, ?)
      `)
      insert.run(owner.ownerUserId, "attempt_1", streamId, workItemId, 1, execution, "workspace_1", null, "session_1", 10, 10)
      insert.run(owner.ownerUserId, "attempt_2", streamId, workItemId, 2, execution, null, null, null, 20, 20)

      expect(await service.queries.workItems.readDetail(owner, { workItemId: workItemId as never })).toMatchObject({ id: workItemId })
      expect(await service.queries.workItems.readDetail(other, { workItemId: workItemId as never })).toBeUndefined()
      expect(await service.queries.attempts.read(owner, { attemptId: "attempt_1" as never })).toMatchObject({
        attempt: { id: "attempt_1", workItemId },
        executionReferences: { sessionId: "session_1", workspaceId: "workspace_1" },
      })
      expect(await service.queries.attempts.read(owner, { attemptId: "attempt_2" as never })).not.toHaveProperty("executionReferences")
      expect(await service.queries.attempts.read(other, { attemptId: "attempt_1" as never })).toBeUndefined()

      const first = await service.queries.workItems.listAttempts(owner, { workItemId: workItemId as never, limit: 1 })
      expect(first).toMatchObject({ attempts: [{ attempt: { id: "attempt_1" } }], hasMore: true })
      expect(first.nextCursor).toMatch(/^wgat1:/)
      await expect(service.queries.workItems.listAttempts(owner, { workItemId: workItemId as never, limit: 1, after: first.nextCursor! }))
        .resolves.toMatchObject({ attempts: [{ attempt: { id: "attempt_2" } }], hasMore: false })
      await expect(service.queries.workItems.listAttempts(other, { workItemId: workItemId as never, limit: 1, after: first.nextCursor! }))
        .rejects.toMatchObject({ reason: "owner_mismatch" })
    } finally {
      database.close()
    }
  })
})

function context(ownerUserId: string): WorkGraphContext {
  return {
    ownerUserId: ownerUserId as never,
    actor: { type: "user", id: ownerUserId as never },
    requestId: `request_${ownerUserId}` as never,
    access: { mode: "owner" },
  }
}

function request(operation: string, command: Record<string, unknown>) {
  return { operationId: `operation_${operation}` as OperationID, command } as never
}

function resultId(result: CommandResult, field: string) {
  if (!result.ok || !result.value || typeof result.value !== "object" || Array.isArray(result.value)) throw new Error(`Missing ${field}`)
  const value = result.value as Record<string, unknown>
  const id = value[field]
  if (typeof id !== "string") throw new Error(`Missing ${field}`)
  return id
}
