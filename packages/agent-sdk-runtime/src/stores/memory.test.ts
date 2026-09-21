import { describe, expect, test } from "bun:test"
import type { RecoveryOperation, RecoveryTurnTarget } from "@claxedo/agent-runtime-contract"
import { MemoryRuntimeStore } from "./memory"
import { AgentRuntimeStaleTurnError } from "../harnesses/shared/runtime-store"
import type { AgentRuntimeTurnFinishInput } from "../harnesses/shared/runtime-store"

function store() {
  const rows = new MemoryRuntimeStore()
  rows.bindSession({ sessionId: "ses", directory: "/repo", workspaceId: "ws", agentSessionId: "ses" })
  return rows
}

function startTurn(rows: ReturnType<typeof store>, turnId: string, assistantMessageId: string) {
  rows.startTurn({
    sessionId: "ses",
    userMessageId: turnId,
    assistantMessageId,
    agent: "build",
    model: { providerID: "pi", modelID: "default" },
    parts: [{ type: "text", text: turnId }],
  })
}

const target = (turnId: string, ownerGeneration: string): RecoveryTurnTarget =>
  ({ scope: "turn", workspaceId: "ws", sessionId: "ses", turnId, ownerGeneration })

function operation(requestId: string, overrides: Partial<RecoveryOperation> = {}): RecoveryOperation {
  const evidence = { source: "test", observedAt: 1, generation: "gen" }
  return {
    operationId: `rop_${requestId}`,
    requestId,
    target: target("msg_a", "lease"),
    action: "cancel_turn",
    scopeRevision: "1",
    attempt: 1,
    state: "accepted",
    phase: "ack",
    phaseDeadlineAt: 2,
    facts: {
      execution: { value: "running", ...evidence },
      cleanup: { value: "owned", ...evidence },
      persistence: { value: "pending", ...evidence },
    },
    cleanupErrors: [],
    nextActions: [],
    receipt: "durable",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe("MemoryRuntimeStore turn authority", () => {
  test("a finish carrying a lease the session no longer holds is refused", () => {
    const rows = store()
    const first = rows.acquireTurnLease("ses")!
    startTurn(rows, "msg_a", "asst_a")
    rows.releaseTurnLease("ses", first)
    const second = rows.acquireTurnLease("ses")!
    expect(second).not.toBe(first)
    startTurn(rows, "msg_b", "asst_b")

    expect(() => rows.finishTurn({
      sessionId: "ses",
      assistantMessageId: "asst_a",
      outcome: { status: "cancelled", completedAt: 5, reason: "abort" },
      leaseId: first,
    })).toThrow(AgentRuntimeStaleTurnError)

    // The replacement turn is untouched, and its own holder can still end it.
    expect(rows.getSession("ses")?.status).toBe("busy")
    rows.finishTurn({
      sessionId: "ses",
      assistantMessageId: "asst_b",
      outcome: { status: "completed", completedAt: 6 },
      leaseId: second,
    })
    expect(rows.getSession("ses")?.lastTurn).toMatchObject({ status: "completed", assistantMessageId: "asst_b" })
  })

  test("a finish carrying a lease on a session that holds none is refused", () => {
    const rows = store()
    startTurn(rows, "msg_a", "asst_a")

    expect(() => rows.finishTurn({
      sessionId: "ses",
      outcome: { status: "cancelled", completedAt: 5, reason: "abort" },
      leaseId: "a-lease-from-a-previous-process",
    })).toThrow(AgentRuntimeStaleTurnError)
    expect(rows.getSession("ses")?.status).toBe("busy")
  })

  test("the held lease is readable and disappears when it is released", () => {
    const rows = store()
    expect(rows.readTurnAuthority("ses")).toBeUndefined()
    const leaseId = rows.acquireTurnLease("ses")!

    expect(rows.readTurnAuthority("ses")).toMatchObject({ leaseId })
    expect(rows.readTurnAuthority("ses")!.acquiredAt).toBeGreaterThan(0)

    rows.releaseTurnLease("ses", leaseId)
    expect(rows.readTurnAuthority("ses")).toBeUndefined()
  })
})

describe("MemoryRuntimeStore turn evidence", () => {
  test("a turn nobody started, a turn still running, and a turn with a recorded outcome", () => {
    const rows = store()
    expect(rows.turnEvidence("ses", "msg_a")).toEqual({ started: false, finished: false })

    const leaseId = rows.acquireTurnLease("ses")!
    startTurn(rows, "msg_a", "asst_a")
    expect(rows.turnEvidence("ses", "msg_a")).toEqual({ started: true, finished: false })

    rows.finishTurn({ sessionId: "ses", assistantMessageId: "asst_a", outcome: { status: "completed", completedAt: 7 }, leaseId })
    expect(rows.turnEvidence("ses", "msg_a")).toMatchObject({
      started: true,
      finished: true,
      outcome: { status: "completed", assistantMessageId: "asst_a" },
    })
  })

  test("a turn that the replacement superseded is still reported against its own id", () => {
    const rows = store()
    startTurn(rows, "msg_a", "asst_a")
    startTurn(rows, "msg_b", "asst_b")

    // The first turn's producer never finished it and no outcome names it, so
    // the store says so rather than inferring an end from the newer turn.
    expect(rows.turnEvidence("ses", "msg_a")).toEqual({ started: true, finished: false })
    expect(rows.turnEvidence("ses", "msg_b")).toEqual({ started: true, finished: false })
  })
})

describe("MemoryRuntimeStore recovery receipts", () => {
  test("one caller's request id creates one operation and reads it back", () => {
    const rows = store()
    const first = operation("req_1")

    expect(rows.recordRecoveryOperation(first, { callerId: "ui" })).toEqual({ created: true })
    expect(rows.recordRecoveryOperation(operation("req_1", { operationId: "rop_other" }), { callerId: "ui" }))
      .toEqual({ created: false, existing: first })
    expect(rows.readRecoveryOperation(first.operationId, { callerId: "ui" })).toEqual(first)
    // The receipt is what authorizes the read, so another caller gets nothing.
    expect(rows.readRecoveryOperation(first.operationId, { callerId: "cli" })).toBeUndefined()
    expect(rows.readRecoveryOperation("rop_other", { callerId: "ui" })).toBeUndefined()
  })

  test("request ids are scoped to the caller, and listing is scoped to the session", () => {
    const rows = store()
    const mine = operation("req_1")
    const theirs = operation("req_1", { operationId: "rop_theirs" })
    const elsewhere = operation("req_2", {
      operationId: "rop_elsewhere",
      target: { scope: "turn", workspaceId: "ws", sessionId: "other", turnId: "msg_z", ownerGeneration: "lease" },
    })

    rows.recordRecoveryOperation(mine, { callerId: "ui" })
    expect(rows.recordRecoveryOperation(theirs, { callerId: "cli" })).toEqual({ created: true })
    rows.recordRecoveryOperation(elsewhere, { callerId: "ui" })

    expect(rows.listRecoveryOperations({ sessionId: "ses" })).toEqual([mine, theirs])
    expect(rows.listRecoveryOperations({}).length).toBe(3)
  })

  test("an update replaces the stored operation without creating a second receipt", () => {
    const rows = store()
    const first = operation("req_1")
    rows.recordRecoveryOperation(first, { callerId: "ui" })

    const settled: RecoveryOperation = { ...first, state: "needs_action", updatedAt: 9 }
    rows.updateRecoveryOperation(settled)

    expect(rows.readRecoveryOperation(first.operationId, { callerId: "ui" })).toEqual(settled)
    expect(rows.listRecoveryOperations({ sessionId: "ses" })).toEqual([settled])
  })

  test("a caller that joined an operation reads it back; one that never did cannot", () => {
    const rows = store()
    const first = operation("req_1")
    rows.recordRecoveryOperation(first, { callerId: "ui" })

    rows.addRecoveryOperationCaller(first.operationId, { callerId: "cli" })
    // An operation nobody recorded takes no callers, so a join cannot invent a
    // receipt for one.
    rows.addRecoveryOperationCaller("rop_never_recorded", { callerId: "cli" })

    expect(rows.readRecoveryOperation(first.operationId, { callerId: "cli" })).toEqual(first)
    expect(rows.readRecoveryOperation(first.operationId, { callerId: "mcp" })).toBeUndefined()
    expect(rows.readRecoveryOperation("rop_never_recorded", { callerId: "cli" })).toBeUndefined()
  })
})

describe("MemoryRuntimeStore write authority", () => {
  // The lease is required by the type, so these casts are what a caller that
  // reaches this store from outside its own typecheck looks like. The store is
  // the last thing between such a caller and an unfenced write.
  const unfenced = { sessionId: "ses", assistantMessageId: "asst_a", outcome: { status: "completed" as const, completedAt: 5 } }

  test("a finish carrying no lease is refused while the session holds one", () => {
    const rows = store()
    rows.acquireTurnLease("ses")
    startTurn(rows, "msg_a", "asst_a")

    expect(() => rows.finishTurn(unfenced as unknown as AgentRuntimeTurnFinishInput)).toThrow(AgentRuntimeStaleTurnError)
    expect(rows.getSession("ses")?.status).toBe("busy")
  })

  test("a finish carrying no lease is refused even when the session granted none", () => {
    const rows = store()
    startTurn(rows, "msg_a", "asst_a")

    // Two absent leases are not a match. A writer holding nothing has no more
    // authority over a session that granted nothing than over one that did.
    expect(() => rows.finishTurn(unfenced as unknown as AgentRuntimeTurnFinishInput)).toThrow(AgentRuntimeStaleTurnError)
    expect(rows.getSession("ses")?.status).toBe("busy")
    expect(rows.getSession("ses")?.lastTurn).toBeUndefined()
  })
})

describe("MemoryRuntimeStore snapshots", () => {
  test("a restored snapshot keeps the lease, and the writer that lost it is still fenced out", () => {
    const rows = store()
    const leaseId = rows.acquireTurnLease("ses")!
    startTurn(rows, "msg_a", "asst_a")

    const restored = new MemoryRuntimeStore()
    restored.importSnapshot(new MemoryRuntimeStore().exportSnapshot())
    restored.importSnapshot(rows.exportSnapshot())

    // The lease outlives the reload, so the writer that holds it can still
    // finish its turn and the session refuses to grant a second one.
    expect(restored.readTurnAuthority("ses")).toMatchObject({ leaseId })
    expect(restored.acquireTurnLease("ses")).toBeUndefined()
    expect(() => restored.finishTurn({
      sessionId: "ses",
      assistantMessageId: "asst_a",
      outcome: { status: "cancelled", completedAt: 5, reason: "abort" },
      leaseId: "a-lease-from-somewhere-else",
    })).toThrow(AgentRuntimeStaleTurnError)
    restored.finishTurn({
      sessionId: "ses",
      assistantMessageId: "asst_a",
      outcome: { status: "cancelled", completedAt: 6, reason: "abort" },
      leaseId,
    })
    expect(restored.getSession("ses")?.lastTurn).toMatchObject({ status: "cancelled" })
  })

  test("a snapshot naming no leases restores a session that holds none", () => {
    const rows = store()
    rows.acquireTurnLease("ses")

    // Not a merge: whatever this reducer was holding is not evidence about the
    // snapshot being restored over it.
    rows.importSnapshot({ sessions: [], seq: [] })

    expect(rows.readTurnAuthority("ses")).toBeUndefined()
  })
})
