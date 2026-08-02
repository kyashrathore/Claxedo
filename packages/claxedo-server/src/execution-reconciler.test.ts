import { describe, expect, it } from "vitest"
import { reconcileWorkGraphRun } from "./execution-reconciler"
import type { WorkspaceExecutionPort } from "@claxedo/workgraph"
import type { WorkGraphContext } from "@claxedo/workgraph/contracts"

describe("WorkGraph execution reconciler", () => {
  it("does not infer completion from an idle or running Session", async () => {
    const writes: unknown[] = []
    const result = await reconcileWorkGraphRun(owner(), ids, execution({ state: "running" }), {
      recordResult: async (_context, input) => { writes.push(input); return true },
    })
    expect(result).toEqual({ settled: false })
    expect(writes).toEqual([])
  })

  it("does not infer completion from a successful provider turn", async () => {
    const writes: unknown[] = []
    const result = await reconcileWorkGraphRun(owner(), ids, execution({ state: "succeeded", summary: "Implemented", artifacts: ["commit:abc"] }), {
      recordResult: async (_context, input) => { writes.push(input); return true },
    })
    expect(result).toEqual({ settled: false, awaitingExplicitCompletion: true })
    expect(writes).toEqual([])
  })

  it("routes an interrupted provider step through resumable parking", async () => {
    const writes: unknown[] = []
    const result = await reconcileWorkGraphRun(
      owner(),
      ids,
      execution({ state: "parked", message: "Session stopped before settlement" }),
      {
        park: async (_context, input) => {
          writes.push(input)
          return { state: "parked", retryAfterMs: 1_000 }
        },
        recordResult: async () => false,
      },
    )
    expect(result).toEqual({ settled: false, parked: true, retryAfterMs: 1_000 })
    expect(writes).toEqual([{
      runId: ids.runId,
      workItemId: ids.workItemId,
      sessionId: ids.sessionId,
      leaseEpoch: ids.leaseEpoch,
      reason: "Session stopped before settlement",
    }])
  })
})

const ids = { runId: "attempt_1" as never, workItemId: "item_1" as never, sessionId: "session_1" as never, leaseEpoch: 1 }
function execution(result: Awaited<ReturnType<WorkspaceExecutionPort["result"]>>): WorkspaceExecutionPort {
  return {
    provisionOrAdopt: async () => { throw new Error("unused") },
    launch: async () => { throw new Error("unused") },
    cancel: async () => undefined,
    result: async () => result,
    cleanup: async () => undefined,
  }
}
function owner(): WorkGraphContext {
  return { organizationId: "org" as never, ownerUserId: "owner" as never, actor: { type: "system", id: "reconciler" as never }, requestId: "request" as never, access: { mode: "owner" } }
}
