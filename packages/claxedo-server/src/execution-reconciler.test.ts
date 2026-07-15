import { describe, expect, it } from "vitest"
import { reconcileWorkGraphAttempt } from "./execution-reconciler"
import type { WorkspaceExecutionPort } from "@claxedo/workgraph"
import type { WorkGraphContext } from "@claxedo/workgraph/contracts"

describe("WorkGraph execution reconciler", () => {
  it("does not infer completion from an idle or running Session", async () => {
    const writes: unknown[] = []
    const result = await reconcileWorkGraphAttempt(owner(), ids, execution({ state: "running" }), {
      recordResult: async (_context, input) => { writes.push(input); return true },
    })
    expect(result).toEqual({ settled: false })
    expect(writes).toEqual([])
  })

  it("persists an explicit semantic result and leaves evidence-based completion pending", async () => {
    const writes: unknown[] = []
    const result = await reconcileWorkGraphAttempt(owner(), ids, execution({ state: "succeeded", summary: "Implemented", artifacts: ["commit:abc"] }), {
      recordResult: async (_context, input) => { writes.push(input); return true },
    })
    expect(result).toEqual({ settled: true, workItemState: "result_ready" })
    expect(writes).toEqual([expect.objectContaining({ state: "result", summary: "Implemented", artifacts: ["commit:abc"] })])
  })
})

const ids = { attemptId: "attempt_1" as never, workItemId: "item_1" as never, sessionId: "session_1" as never, leaseEpoch: 1 }
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
