import Database from "better-sqlite3"
import { describe, expect, test, vi } from "vitest"
import type { RecoveryRequest } from "@claxedo/agent-runtime-contract"
import { DaemonOperationStore } from "./daemon-operation-store"
import { servedDuringMachineRecovery } from "./daemon-admission"
import {
  createLocalDaemonLifecycle,
  localDaemonResidencyPins,
  type LocalDaemonOwner,
  type LocalDaemonWorkActivity,
} from "./local-daemon-lifecycle"

const empty = (): LocalDaemonWorkActivity => ({
  pty: { running: 0, committed: 0, provisional: 0, managed: 0, subscribers: 0 },
  runtime: { hosts: 0, activeTurns: 0, activeWrites: 0, checkpointing: 0, owners: [] },
  owners: [],
  residencyPins: 0,
  replacementBlockers: 0,
})

const machine = { machineId: "local", generation: "gen-1" }

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function drain(scopeRevision: string, overrides: Partial<RecoveryRequest> = {}): RecoveryRequest {
  return {
    requestId: `req-${Math.random().toString(16).slice(2)}`,
    action: "drain_daemon",
    target: { scope: "machine", machineId: "local", ownerGeneration: "gen-1" },
    scopeRevision,
    attempt: 1,
    ...overrides,
  }
}

describe("local daemon lifecycle", () => {
  test("counts active sessions, terminals, and managed processes as daemon work", () => {
    const cases: Array<[string, LocalDaemonWorkActivity["pty"], LocalDaemonWorkActivity["runtime"]]> = [
      ["agent session", empty().pty, { ...empty().runtime, activeTurns: 1 }],
      ["session write", empty().pty, { ...empty().runtime, activeWrites: 1 }],
      ["session checkpoint", empty().pty, { ...empty().runtime, checkpointing: 1 }],
      ["terminal", { ...empty().pty, running: 1, committed: 1 }, empty().runtime],
      ["managed process", { ...empty().pty, running: 1, managed: 1 }, empty().runtime],
    ]

    for (const [label, pty, runtime] of cases) {
      expect(localDaemonResidencyPins(pty, runtime), label).toBe(1)
    }
  })

  test("an ordinary lease release keeps one 180-second crash and restart handoff window", async () => {
    vi.useFakeTimers()
    try {
      const onIdle = vi.fn()
      const lifecycle = createLocalDaemonLifecycle({ activity: empty, onStop: onIdle, machine })
      lifecycle.start()
      const lease = lifecycle.acquire()!

      lifecycle.release(lease.id)
      await vi.advanceTimersByTimeAsync(179_999)
      expect(onIdle).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(onIdle).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test("a replacement app lease acquired inside the handoff window cancels idle shutdown", async () => {
    vi.useFakeTimers()
    try {
      const onIdle = vi.fn()
      const lifecycle = createLocalDaemonLifecycle({ activity: empty, onStop: onIdle, machine })
      lifecycle.start()
      const lease = lifecycle.acquire()!

      lifecycle.release(lease.id)
      await vi.advanceTimersByTimeAsync(179_999)
      lifecycle.acquire()
      await vi.advanceTimersByTimeAsync(180_001)

      expect(onIdle).not.toHaveBeenCalled()
      lifecycle.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  test("a drain holds the daemon until its owners are gone, then stops it without the handoff grace", async () => {
    vi.useFakeTimers()
    try {
      const onIdle = vi.fn()
      let pins = 1
      const activity = () => ({ ...empty(), residencyPins: pins, replacementBlockers: pins })
      const lifecycle = createLocalDaemonLifecycle({ activity, onStop: onIdle, machine })
      lifecycle.start()
      const lease = lifecycle.acquire()!
      lifecycle.release(lease.id)

      const submitted = lifecycle.recovery.submit(
        drain(lifecycle.recovery.inspect().scopeRevision),
        { callerId: "desktop", authority: "machine" },
      )
      expect(submitted.kind).toBe("operation")
      await vi.advanceTimersByTimeAsync(360_000)
      expect(onIdle).not.toHaveBeenCalled()

      pins = 0
      lifecycle.reconcile()
      await vi.advanceTimersByTimeAsync(1)
      expect(onIdle).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test("a pre-start state snapshot cannot consume lifecycle startup", () => {
    vi.useFakeTimers()
    try {
      const lifecycle = createLocalDaemonLifecycle({ activity: empty, onStop() {}, machine })
      expect(lifecycle.snapshot().state).toBe("created")
      expect(vi.getTimerCount()).toBe(0)

      lifecycle.start()
      expect(lifecycle.snapshot().state).toBe("idle")
      expect(vi.getTimerCount()).toBe(1)
      lifecycle.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  test("lease changes retain exactly one lifecycle timer", () => {
    vi.useFakeTimers()
    try {
      const lifecycle = createLocalDaemonLifecycle({ activity: empty, onStop() {}, machine })
      lifecycle.start()
      expect(vi.getTimerCount()).toBe(1)

      const lease = lifecycle.acquire()!
      expect(vi.getTimerCount()).toBe(1)
      expect(lifecycle.renew(lease.id)).toBeDefined()
      expect(vi.getTimerCount()).toBe(1)
      expect(lifecycle.release(lease.id)).toBe(true)
      expect(vi.getTimerCount()).toBe(1)

      lifecycle.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  test("expires a crashed desktop lease and exits after one idle grace", async () => {
    const onIdle = vi.fn()
    const lifecycle = createLocalDaemonLifecycle({ activity: empty, onStop: onIdle, machine, leaseTtlMs: 20, idleGraceMs: 20, pollIntervalMs: 2 })
    lifecycle.start()
    lifecycle.acquire()

    await wait(30)
    expect(onIdle).not.toHaveBeenCalled()
    await wait(20)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  test("renewal keeps the daemon resident and release starts a fresh grace", async () => {
    vi.useFakeTimers()
    try {
      const onIdle = vi.fn()
      const lifecycle = createLocalDaemonLifecycle({ activity: empty, onStop: onIdle, machine, leaseTtlMs: 30, idleGraceMs: 15, pollIntervalMs: 2 })
      lifecycle.start()
      const lease = lifecycle.acquire()!
      await vi.advanceTimersByTimeAsync(20)
      expect(lifecycle.renew(lease.id)).toBeDefined()
      await vi.advanceTimersByTimeAsync(20)
      expect(onIdle).not.toHaveBeenCalled()
      expect(lifecycle.release(lease.id)).toBe(true)
      await vi.advanceTimersByTimeAsync(20)
      expect(onIdle).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test("authoritative work survives every client lease", async () => {
    const onIdle = vi.fn()
    let pins = 1
    const activity = () => ({ ...empty(), residencyPins: pins, replacementBlockers: pins })
    const lifecycle = createLocalDaemonLifecycle({ activity, onStop: onIdle, machine, leaseTtlMs: 20, idleGraceMs: 15, pollIntervalMs: 2 })
    lifecycle.start()

    await wait(50)
    expect(onIdle).not.toHaveBeenCalled()
    pins = 0
    lifecycle.reconcile()
    await wait(20)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  test("an expired lease cannot be renewed", async () => {
    const lifecycle = createLocalDaemonLifecycle({ activity: empty, onStop() {}, machine, leaseTtlMs: 15, idleGraceMs: 100, pollIntervalMs: 2 })
    lifecycle.start()
    const lease = lifecycle.acquire()!
    await wait(20)
    expect(lifecycle.renew(lease.id)).toBeUndefined()
    lifecycle.stop()
  })
})

describe("machine recovery operations", () => {
  const owner = (id: string, generation: string, state = "serving"): LocalDaemonOwner => ({
    id,
    kind: "workspace_runtime",
    generation,
    state,
    pins: state !== "serving",
  })

  function machineWork(owners: LocalDaemonOwner[], pins = owners.filter((each) => each.pins).length) {
    return (): LocalDaemonWorkActivity => ({
      ...empty(),
      owners,
      runtime: { ...empty().runtime, owners: [] },
      residencyPins: pins,
      replacementBlockers: pins,
    })
  }

  function operations() {
    return new DaemonOperationStore(new Database(":memory:"))
  }

  test("a caller without machine authority is refused, whatever it names itself", () => {
    const lifecycle = createLocalDaemonLifecycle({ activity: empty, onStop() {}, machine })
    lifecycle.start()

    for (const authority of ["session", "workspace"] as const) {
      const outcome = lifecycle.recovery.submit(
        drain(lifecycle.recovery.inspect().scopeRevision),
        { callerId: "child-agent", authority },
      )
      expect(outcome.kind, authority).toBe("refused")
      if (outcome.kind === "refused") expect(outcome.refusal.kind).toBe("unauthorized")
    }
  })

  test("a request naming another daemon generation is a generation conflict", () => {
    const lifecycle = createLocalDaemonLifecycle({ activity: empty, onStop() {}, machine })
    lifecycle.start()

    const outcome = lifecycle.recovery.submit(
      drain(lifecycle.recovery.inspect().scopeRevision, {
        target: { scope: "machine", machineId: "local", ownerGeneration: "gen-0" },
      }),
      { callerId: "desktop", authority: "machine" },
    )

    expect(outcome.kind).toBe("refused")
    if (outcome.kind === "refused") expect(outcome.refusal.kind).toBe("generation_conflict")
  })

  test("a drain that runs out of time names what still held the machine", async () => {
    const held = [owner("workspace:ws_a", "retire_failed#2", "retire_failed")]
    const lifecycle = createLocalDaemonLifecycle({
      activity: machineWork(held, 3),
      onStop() {},
      machine: { ...machine, budgets: { drainMs: 30 } },
      pollIntervalMs: 5,
    })
    lifecycle.start()

    const submitted = lifecycle.recovery.submit(
      drain(lifecycle.recovery.inspect().scopeRevision),
      { callerId: "desktop", authority: "machine" },
    )
    if (submitted.kind !== "operation") throw new Error("the drain was refused")
    await lifecycle.recovery.settled()

    const read = lifecycle.recovery.read(submitted.operation.operationId)
    if (read.kind !== "operation") throw new Error("the operation was not held")
    expect(read.operation.state).toBe("needs_action")
    expect(read.operation.initiatingError?.code).toBe("deadline_exceeded")
    expect(read.operation.initiatingError?.message).toContain("workspace:ws_a (retire_failed)")
    expect(read.operation.nextActions.map((next) => next.action)).toEqual(["drain_daemon", "stop_daemon"])
    expect(read.operation.facts.execution.value).toBe("running")
  })

  test("a stop authorized against a scope that has since changed is refused with a fresh preview", () => {
    let owners = [owner("workspace:ws_a", "serving#0")]
    const lifecycle = createLocalDaemonLifecycle({
      activity: () => machineWork(owners)(),
      onStop() {},
      machine,
    })
    lifecycle.start()
    const shown = lifecycle.recovery.inspect().scopeRevision

    // A child admitted between the preview and the authorization.
    owners = [...owners, owner("terminal:t1", "91", "running")]
    const outcome = lifecycle.recovery.submit(
      drain(shown, { action: "stop_daemon", requestId: "stop-1" }),
      { callerId: "desktop", authority: "machine" },
    )

    expect(outcome.kind).toBe("refused")
    if (outcome.kind !== "refused" || outcome.refusal.kind !== "scope_changed") throw new Error("expected scope_changed")
    expect(outcome.refusal.scopeRevision).not.toBe(shown)
    expect(outcome.refusal.preview.resources).toContain("terminal:t1 (running)")
  })

  test("an owner's generation changing after the preview changes the scope revision", () => {
    let owners = [owner("workspace:ws_a", "serving#0")]
    const lifecycle = createLocalDaemonLifecycle({ activity: () => machineWork(owners)(), onStop() {}, machine })
    lifecycle.start()
    const shown = lifecycle.recovery.inspect().scopeRevision

    owners = [owner("workspace:ws_a", "retiring#1", "retiring")]

    expect(lifecycle.recovery.inspect().scopeRevision).not.toBe(shown)
  })

  test("a crash after three of five owners acknowledged keeps the fence and reconstructs exactly those three", async () => {
    const store = operations()
    const five = ["ws_a", "ws_b", "ws_c", "ws_d", "ws_e"].map((id) => owner(`workspace:${id}`, "serving#0"))
    const before = createLocalDaemonLifecycle({
      activity: machineWork(five, 5),
      onStop() {},
      machine: { ...machine, operations: () => store, budgets: { drainMs: 10 } },
      pollIntervalMs: 5,
    })
    before.start()
    const submitted = before.recovery.submit(
      drain(before.recovery.inspect().scopeRevision),
      { callerId: "desktop", authority: "machine" },
    )
    if (submitted.kind !== "operation") throw new Error("the drain was refused")
    await before.recovery.settled()
    before.stop()

    // The crash: two of the five gates were never written.
    const operationId = submitted.operation.operationId
    for (const id of ["workspace:ws_d", "workspace:ws_e"]) {
      store.prune(0)
      expect(store.gates(operationId).some((gate) => gate.ownerId === id)).toBe(true)
    }
    const partial = new Database(":memory:")
    const crashed = new DaemonOperationStore(partial)
    crashed.record(submitted.operation, { callerId: "desktop" }, drain(submitted.operation.scopeRevision))
    for (const id of ["workspace:ws_a", "workspace:ws_b", "workspace:ws_c"]) {
      crashed.acknowledgeGate({ operationId, ownerId: id, ownerGeneration: "serving#0", acknowledgedAt: 1 })
    }

    // A sixth owner appeared while this daemon was down.
    const six = [...five, owner("workspace:ws_f", "serving#0")]
    const after = createLocalDaemonLifecycle({
      activity: machineWork(six, 6),
      onStop() {},
      machine: { ...machine, operations: () => crashed },
    })
    after.start()

    expect(after.recovery.ingressClosed()?.operationId).toBe(operationId)
    expect(crashed.gates(operationId).map((gate) => gate.ownerId))
      .toEqual(["workspace:ws_a", "workspace:ws_b", "workspace:ws_c"])
    const resumed = after.recovery.read(operationId)
    if (resumed.kind !== "operation") throw new Error("the operation was not reconstructed")
    expect(resumed.operation.state).toBe("needs_action")
    expect(resumed.operation.initiatingError?.message).toContain("owners changed")
    expect(resumed.operation.initiatingError?.message).toContain("3 gates are retained")
    after.stop()
  })

  test("machine ingress stays closed for an outstanding operation and reopens for nothing else", () => {
    const store = operations()
    const first = createLocalDaemonLifecycle({
      activity: machineWork([owner("workspace:ws_a", "serving#0", "retiring")], 1),
      onStop() {},
      machine: { ...machine, operations: () => store, budgets: { drainMs: 5 } },
      pollIntervalMs: 5,
    })
    first.start()
    first.recovery.submit(drain(first.recovery.inspect().scopeRevision), { callerId: "desktop", authority: "machine" })
    first.stop()

    const replacement = createLocalDaemonLifecycle({
      activity: machineWork([owner("workspace:ws_a", "serving#0", "retiring")], 1),
      onStop() {},
      machine: { ...machine, operations: () => store },
    })
    replacement.start()

    // Nothing may be admitted, and no lease may pin the daemon open, until the
    // operation that closed the machine is resolved.
    expect(replacement.recovery.ingressClosed()).toBeDefined()
    expect(replacement.acquire()).toBeUndefined()
    replacement.stop()
  })

  test("a receipt this daemon never held is not an expired one", () => {
    const lifecycle = createLocalDaemonLifecycle({ activity: empty, onStop() {}, machine })
    lifecycle.start()

    const read = lifecycle.recovery.read("op-nobody-holds")
    expect(read.kind).toBe("refused")
    if (read.kind === "refused") expect(read.refusal.kind).toBe("receipt_expired")
  })

  test("a second drain joins the one already holding the gate", () => {
    const lifecycle = createLocalDaemonLifecycle({
      activity: machineWork([owner("workspace:ws_a", "retiring#1", "retiring")], 1),
      onStop() {},
      machine: { ...machine, budgets: { drainMs: 10_000 } },
      pollIntervalMs: 5,
    })
    lifecycle.start()
    const revision = lifecycle.recovery.inspect().scopeRevision
    const first = lifecycle.recovery.submit(drain(revision), { callerId: "desktop", authority: "machine" })
    const second = lifecycle.recovery.submit(drain(revision, { requestId: "req-2" }), { callerId: "cli", authority: "machine" })

    if (first.kind !== "operation" || second.kind !== "operation") throw new Error("a drain was refused")
    expect(second.operation.operationId).toBe(first.operation.operationId)
  })

  test("the same request id from one caller with a different intent is a conflict", () => {
    const store = operations()
    const lifecycle = createLocalDaemonLifecycle({
      activity: machineWork([owner("workspace:ws_a", "retiring#1", "retiring")], 1),
      onStop() {},
      machine: { ...machine, operations: () => store, budgets: { drainMs: 10_000 } },
      pollIntervalMs: 5,
    })
    lifecycle.start()
    const revision = lifecycle.recovery.inspect().scopeRevision
    lifecycle.recovery.submit(drain(revision, { requestId: "req-same" }), { callerId: "desktop", authority: "machine" })

    const conflicting = lifecycle.recovery.submit(
      drain(revision, { requestId: "req-same", linkedOperationId: "somewhere-else" }),
      { callerId: "desktop", authority: "machine" },
    )

    expect(conflicting.kind).toBe("refused")
    if (conflicting.kind === "refused") expect(conflicting.refusal.kind).toBe("intent_conflict")
  })

  test("a store that refuses the receipt still accepts the operation, marked volatile", () => {
    const lifecycle = createLocalDaemonLifecycle({
      activity: machineWork([owner("workspace:ws_a", "retiring#1", "retiring")], 1),
      onStop() {},
      machine: {
        ...machine,
        operations: () => {
          throw new Error("claxedo.db is locked")
        },
        budgets: { drainMs: 10_000 },
      },
      pollIntervalMs: 5,
    })
    lifecycle.start()

    const outcome = lifecycle.recovery.submit(
      drain(lifecycle.recovery.inspect().scopeRevision),
      { callerId: "desktop", authority: "machine" },
    )

    if (outcome.kind !== "operation") throw new Error("the drain was refused")
    expect(outcome.operation.receipt).toBe("volatile")
    expect(outcome.operation.cleanupErrors[0]?.code).toBe("persistence_unavailable")
  })
})

describe("what a closed machine still answers", () => {
  test("recovery and inspection are served; new session work is not", () => {
    expect(servedDuringMachineRecovery("GET", "/api/claxedo/projects")).toBe(true)
    expect(servedDuringMachineRecovery("POST", "/api/claxedo/daemon/recovery")).toBe(true)
    // A Stop submitted during a machine drain is a narrower authorization the
    // caller already holds, so it is served rather than queued behind the drain.
    expect(servedDuringMachineRecovery("POST", "/session/ses_1/recovery")).toBe(true)
    expect(servedDuringMachineRecovery("POST", "/workspaces/ws_1/session/ses_1/recovery")).toBe(true)
    expect(servedDuringMachineRecovery("GET", "/session/ses_1/recovery/operations/op_1")).toBe(true)

    expect(servedDuringMachineRecovery("POST", "/session/ses_1/prompt")).toBe(false)
    expect(servedDuringMachineRecovery("POST", "/session")).toBe(false)
    expect(servedDuringMachineRecovery("DELETE", "/api/claxedo/projects/p1")).toBe(false)
  })
})
