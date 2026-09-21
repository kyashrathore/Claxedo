import Database from "better-sqlite3"
import { describe, expect, test } from "vitest"
import {
  DEFAULT_RECOVERY_BUDGETS,
  type RecoveryFacts,
  type RecoveryMachineTarget,
  type RecoveryOperation,
  type RecoveryRequest,
} from "@claxedo/agent-runtime-contract"
import { DaemonOperationStore } from "./daemon-operation-store"

const MACHINE: RecoveryMachineTarget = { scope: "machine", machineId: "m1", ownerGeneration: "gen-1" }

function facts(at = 1_000): RecoveryFacts {
  return {
    execution: { value: "running", source: "local-daemon", observedAt: at, generation: "gen-1" },
    cleanup: { value: "owned", source: "local-daemon", observedAt: at, generation: "gen-1" },
    persistence: { value: "committed", source: "local-daemon", observedAt: at, generation: "gen-1" },
  }
}

function request(overrides: Partial<RecoveryRequest> = {}): RecoveryRequest {
  return {
    requestId: "req-1",
    action: "drain_daemon",
    target: MACHINE,
    scopeRevision: "rev-1",
    attempt: 1,
    ...overrides,
  }
}

function operation(overrides: Partial<RecoveryOperation> & { from?: RecoveryRequest } = {}): RecoveryOperation {
  const { from, ...rest } = overrides
  const base = from ?? request()
  return {
    operationId: "op-1",
    requestId: base.requestId,
    target: base.target,
    action: base.action,
    scopeRevision: base.scopeRevision,
    attempt: 1,
    state: "accepted",
    phase: "drain",
    phaseDeadlineAt: 1_000 + DEFAULT_RECOVERY_BUDGETS.drainMs,
    facts: facts(),
    cleanupErrors: [],
    nextActions: [],
    receipt: "durable",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...rest,
  }
}

function store() {
  return new DaemonOperationStore(new Database(":memory:"))
}

describe("the machine recovery operation store", () => {
  test("a redelivered request id joins the operation that won the insert", () => {
    const operations = store()
    expect(operations.record(operation(), { callerId: "desktop" }, request())).toEqual({ created: true })

    const second = operations.record(
      operation({ operationId: "op-2" }),
      { callerId: "desktop" },
      request(),
    )
    expect(second.created).toBe(false)
    if (second.created) throw new Error("the second record claimed the request id")
    expect(second.existing.operationId).toBe("op-1")
    expect(second.intent).toEqual({ action: "drain_daemon", scopeRevision: "rev-1", target: MACHINE })
  })

  test("the same request id from another caller is another operation", () => {
    const operations = store()
    operations.record(operation(), { callerId: "desktop" }, request())

    expect(operations.record(operation({ operationId: "op-2" }), { callerId: "cli" }, request()))
      .toEqual({ created: true })
    expect(operations.read("op-2")?.operationId).toBe("op-2")
  })

  test("an operation nothing recorded cannot be updated into existence", () => {
    expect(() => store().update(operation({ state: "succeeded" })))
      .toThrow(/is not recorded on this machine/)
  })

  test("outstanding lists every operation nothing settled, oldest first", () => {
    const operations = store()
    for (const [operationId, requestId, at] of [["op-done", "r-done", 1], ["op-open", "r-open", 2]] as const) {
      const pending = request({ requestId })
      operations.record(operation({ from: pending, operationId, createdAt: at }), { callerId: "a" }, pending)
    }
    const needs = request({ requestId: "r-needs" })
    operations.record(
      operation({ from: needs, operationId: "op-needs", createdAt: 3, state: "needs_action" }),
      { callerId: "a" },
      needs,
    )
    const done = request({ requestId: "r-done" })
    operations.update(operation({ from: done, operationId: "op-done", state: "succeeded", updatedAt: 5 }))

    expect(operations.outstanding().map((found) => found.operationId)).toEqual(["op-open", "op-needs"])
  })

  test("a store reopened over the same file reconstructs the outstanding operation and its gates", () => {
    const file = new Database(":memory:")
    const before = new DaemonOperationStore(file)
    before.record(operation(), { callerId: "desktop" }, request())
    for (const owner of ["ws-a", "ws-b", "pty-1"]) {
      before.acknowledgeGate({ operationId: "op-1", ownerId: owner, ownerGeneration: `${owner}-g1`, acknowledgedAt: 2_000 })
    }

    const after = new DaemonOperationStore(file)
    expect(after.outstanding().map((found) => found.operationId)).toEqual(["op-1"])
    expect(after.gates("op-1").map((gate) => gate.ownerId)).toEqual(["pty-1", "ws-a", "ws-b"])
  })

  test("an owner id reappearing at a new generation keeps the gate the earlier one took", () => {
    const operations = store()
    operations.record(operation(), { callerId: "desktop" }, request())
    operations.acknowledgeGate({ operationId: "op-1", ownerId: "ws-a", ownerGeneration: "g1", acknowledgedAt: 2_000 })

    const replayed = operations.acknowledgeGate({
      operationId: "op-1",
      ownerId: "ws-a",
      ownerGeneration: "g2",
      acknowledgedAt: 3_000,
    })
    expect(replayed.accepted).toBe(false)
    expect(replayed.existing).toEqual({
      operationId: "op-1",
      ownerId: "ws-a",
      ownerGeneration: "g1",
      acknowledgedAt: 2_000,
    })
  })

  test("repeating an owner's own gate is the same gate, not a second one", () => {
    const operations = store()
    operations.record(operation(), { callerId: "desktop" }, request())
    const first = operations.acknowledgeGate({ operationId: "op-1", ownerId: "ws-a", ownerGeneration: "g1", acknowledgedAt: 2_000 })
    const again = operations.acknowledgeGate({ operationId: "op-1", ownerId: "ws-a", ownerGeneration: "g1", acknowledgedAt: 9_000 })

    expect([first.accepted, again.accepted]).toEqual([true, true])
    expect(operations.gates("op-1")).toHaveLength(1)
    expect(again.existing.acknowledgedAt).toBe(2_000)
  })

  test("releasing one operation's gates leaves every other operation's alone", () => {
    const operations = store()
    const first = request({ requestId: "r-first" })
    const second = request({ requestId: "r-second" })
    operations.record(operation({ from: first, operationId: "op-first" }), { callerId: "a" }, first)
    operations.record(operation({ from: second, operationId: "op-second" }), { callerId: "a" }, second)
    // The same owner, gated by both: a release must reopen one claim on it and
    // leave the other holding.
    for (const operationId of ["op-first", "op-second"]) {
      operations.acknowledgeGate({ operationId, ownerId: "workspace:ws_a", ownerGeneration: "g1", acknowledgedAt: 1 })
    }
    operations.acknowledgeGate({ operationId: "op-second", ownerId: "terminal:t1", ownerGeneration: "77", acknowledgedAt: 1 })

    expect(operations.releaseGates("op-first")).toEqual(["workspace:ws_a"])

    expect(operations.gates("op-first")).toEqual([])
    expect(operations.gates("op-second").map((gate) => gate.ownerId)).toEqual(["terminal:t1", "workspace:ws_a"])
  })

  test("gates that survived a release are still there for the next owner to reconstruct", () => {
    const file = new Database(":memory:")
    const before = new DaemonOperationStore(file)
    const first = request({ requestId: "r-first" })
    const second = request({ requestId: "r-second" })
    before.record(operation({ from: first, operationId: "op-first" }), { callerId: "a" }, first)
    before.record(operation({ from: second, operationId: "op-second" }), { callerId: "a" }, second)
    before.acknowledgeGate({ operationId: "op-first", ownerId: "workspace:ws_a", ownerGeneration: "g1", acknowledgedAt: 1 })
    before.acknowledgeGate({ operationId: "op-second", ownerId: "workspace:ws_a", ownerGeneration: "g1", acknowledgedAt: 1 })
    before.releaseGates("op-first")

    const after = new DaemonOperationStore(file)
    expect(after.gates("op-second").map((gate) => gate.ownerId)).toEqual(["workspace:ws_a"])
    expect(after.gates("op-first")).toEqual([])
  })

  test("pruning drops settled operations and keeps an outstanding one with its gates", () => {
    const operations = store()
    const done = request({ requestId: "r-done" })
    const open = request({ requestId: "r-open" })
    operations.record(operation({ from: done, operationId: "op-done" }), { callerId: "a" }, done)
    operations.record(operation({ from: open, operationId: "op-open" }), { callerId: "a" }, open)
    operations.acknowledgeGate({ operationId: "op-done", ownerId: "ws-a", ownerGeneration: "g1", acknowledgedAt: 1 })
    operations.acknowledgeGate({ operationId: "op-open", ownerId: "ws-b", ownerGeneration: "g1", acknowledgedAt: 1 })
    operations.update(operation({ from: done, operationId: "op-done", state: "failed", updatedAt: 10 }))

    operations.prune(1_000)

    expect(operations.read("op-done")).toBeUndefined()
    expect(operations.gates("op-done")).toEqual([])
    expect(operations.read("op-open")?.operationId).toBe("op-open")
    expect(operations.gates("op-open").map((gate) => gate.ownerId)).toEqual(["ws-b"])
  })
})
