import Database from "better-sqlite3"
import { describe, expect, test, vi } from "vitest"
import type { RecoveryRequest } from "@claxedo/agent-runtime-contract"
import { DaemonOperationStore } from "./daemon-operation-store"
import { servedDuringMachineRecovery } from "./daemon-admission"
import {
  createLocalDaemonLifecycle,
  localDaemonOwners,
  localDaemonResidencyPins,
  localDaemonScopePreview,
  localDaemonScopeRevision,
  type LocalDaemonOwner,
  type ReconciledLaunch,
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

    const hold = after.recovery.ingressClosed()
    expect(hold?.kind === "operation" && hold.operationId).toBe(operationId)
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

describe("releasing a drain", () => {
  const owner = (id: string, state = "retiring"): LocalDaemonOwner => ({
    id,
    kind: "workspace_runtime",
    generation: `${state}#1`,
    state,
    pins: state !== "serving",
  })

  function held(store?: DaemonOperationStore) {
    const lifecycle = createLocalDaemonLifecycle({
      activity: (): LocalDaemonWorkActivity => ({
        ...empty(),
        owners: [owner("workspace:ws_a"), owner("workspace:ws_b")],
        residencyPins: 2,
        replacementBlockers: 2,
      }),
      onStop() {},
      machine: { ...machine, ...(store ? { operations: () => store } : {}), budgets: { drainMs: 10_000 } },
      pollIntervalMs: 5,
    })
    lifecycle.start()
    const submitted = lifecycle.recovery.submit(
      drain(lifecycle.recovery.inspect().scopeRevision),
      { callerId: "desktop", authority: "machine" },
    )
    if (submitted.kind !== "operation") throw new Error("the drain was refused")
    return { lifecycle, drainId: submitted.operation.operationId }
  }

  function releaseOf(lifecycle: ReturnType<typeof createLocalDaemonLifecycle>, operationId: string) {
    return lifecycle.recovery.submit(
      drain(lifecycle.recovery.inspect().scopeRevision, {
        requestId: `release-${operationId}`,
        action: "release_drain",
        linkedOperationId: operationId,
      }),
      { callerId: "desktop", authority: "machine" },
    )
  }

  test("reopens exactly the gates the named drain took, and the drain is history", async () => {
    const store = new DaemonOperationStore(new Database(":memory:"))
    const { lifecycle, drainId } = held(store)
    expect(store.gates(drainId).map((gate) => gate.ownerId))
      .toEqual(["workspace:ws_a", "workspace:ws_b"])

    const released = releaseOf(lifecycle, drainId)

    if (released.kind !== "operation") throw new Error("the release was refused")
    expect(released.operation.action).toBe("release_drain")
    expect(released.operation.state).toBe("succeeded")
    await lifecycle.recovery.launchesReconciled()
    expect(lifecycle.recovery.ingressClosed()).toBeUndefined()
    expect(store.gates(drainId)).toEqual([])
    // A lease can hold the daemon open again, which is what reopening means.
    expect(lifecycle.acquire()).toBeDefined()

    const drained = lifecycle.recovery.read(drainId)
    if (drained.kind !== "operation") throw new Error("the drain was not retained")
    expect(drained.operation.state, "a withdrawn attempt is history, not a success").toBe("failed")
    expect(drained.operation.initiatingError?.code).toBe("authority_lost")
    await lifecycle.recovery.settled()
    lifecycle.stop()
  })

  test("a release during a stop is refused, naming the operation that is tearing the machine down", () => {
    const { lifecycle, drainId } = held()
    const stopped = lifecycle.recovery.submit(
      drain(lifecycle.recovery.inspect().scopeRevision, { requestId: "stop-1", action: "stop_daemon" }),
      { callerId: "desktop", authority: "machine" },
    )
    if (stopped.kind !== "operation") throw new Error("the stop was refused")

    const released = releaseOf(lifecycle, drainId)

    expect(released.kind).toBe("refused")
    if (released.kind !== "refused" || released.refusal.kind !== "scope_changed") throw new Error("expected scope_changed")
    expect(released.refusal.message).toContain(stopped.operation.operationId)
    expect(lifecycle.recovery.ingressClosed(), "the fence is still held").toBeDefined()
    lifecycle.stop()
  })

  test("a release is refused once another operation has taken the fence, even a settled one", async () => {
    let pins = 2
    const lifecycle = createLocalDaemonLifecycle({
      activity: (): LocalDaemonWorkActivity => ({
        ...empty(),
        owners: pins > 0 ? [owner("workspace:ws_a")] : [],
        residencyPins: pins,
        replacementBlockers: pins,
      }),
      onStop() {},
      machine: { ...machine, budgets: { drainMs: 10_000 } },
      // Long enough that the drain's own poll never fires during this test.
      pollIntervalMs: 10_000,
    })
    lifecycle.start()
    const drained = lifecycle.recovery.submit(
      drain(lifecycle.recovery.inspect().scopeRevision),
      { callerId: "desktop", authority: "machine" },
    )
    if (drained.kind !== "operation") throw new Error("the drain was refused")

    pins = 0
    const stopped = lifecycle.recovery.submit(
      drain(lifecycle.recovery.inspect().scopeRevision, { requestId: "stop-settled", action: "stop_daemon" }),
      { callerId: "desktop", authority: "machine" },
    )
    if (stopped.kind !== "operation") throw new Error("the stop was refused")
    await lifecycle.recovery.settled()
    const settled = lifecycle.recovery.read(stopped.operation.operationId)
    if (settled.kind !== "operation") throw new Error("the stop was not retained")
    expect(settled.operation.state, "the stop is over, so it is not a destructive phase in progress").toBe("succeeded")

    const released = releaseOf(lifecycle, drained.operation.operationId)

    expect(released.kind).toBe("refused")
    if (released.kind !== "refused" || released.refusal.kind !== "scope_changed") throw new Error("expected scope_changed")
    expect(released.refusal.message).toContain(stopped.operation.operationId)
    const fenced = lifecycle.recovery.ingressClosed()
    expect(fenced?.kind === "operation" && fenced.operationId).toBe(stopped.operation.operationId)
    lifecycle.stop()
  })

  test("a release naming another operation's gates reopens nothing", async () => {
    const { lifecycle, drainId } = held()

    const other = releaseOf(lifecycle, "op-somebody-else")
    expect(other.kind).toBe("refused")
    if (other.kind === "refused") expect(other.refusal.kind).toBe("unavailable")

    const itself = releaseOf(lifecycle, drainId)
    if (itself.kind !== "operation") throw new Error("the release of its own drain was refused")
    // Releasing the one it does hold still works, so the refusal above was
    // about the id and not about the release path being closed.
    await lifecycle.recovery.launchesReconciled()
    expect(lifecycle.recovery.ingressClosed()).toBeUndefined()
    lifecycle.stop()
  })

  test("a release that names no drain is refused before anything is reopened", () => {
    const { lifecycle } = held()

    const released = lifecycle.recovery.submit(
      drain(lifecycle.recovery.inspect().scopeRevision, { requestId: "release-none", action: "release_drain" }),
      { callerId: "desktop", authority: "machine" },
    )

    expect(released.kind).toBe("refused")
    if (released.kind === "refused") expect(released.refusal.kind).toBe("unavailable")
    expect(lifecycle.recovery.ingressClosed()).toBeDefined()
    lifecycle.stop()
  })

  test("a released drain no longer re-fences the machine after a restart", async () => {
    const store = new DaemonOperationStore(new Database(":memory:"))
    const { lifecycle, drainId } = held(store)
    releaseOf(lifecycle, drainId)
    lifecycle.stop()

    const restarted = createLocalDaemonLifecycle({
      activity: empty,
      onStop() {},
      machine: { ...machine, operations: () => store },
    })
    restarted.start()
    await restarted.recovery.launchesReconciled()

    expect(restarted.recovery.ingressClosed()).toBeUndefined()
    restarted.stop()
  })
})

describe("what the inventory names", () => {
  const runtimeOwners = (
    turns: Array<{ sessionId: string; turnId: string; ownerGeneration: string }>,
  ): LocalDaemonWorkActivity["runtime"] => ({
    hosts: 1,
    activeTurns: turns.length,
    activeWrites: 0,
    checkpointing: 0,
    owners: [{ workspaceId: "ws_a", generation: "mount-1", state: "serving", attempt: 0, turns }],
  })

  test("every admitted turn is an owner of its own, with the lease that fences it", () => {
    const owners = localDaemonOwners([], runtimeOwners([
      { sessionId: "ses_1", turnId: "turn_1", ownerGeneration: "lease-7" },
      { sessionId: "ses_2", turnId: "turn_9", ownerGeneration: "lease-8" },
    ]))

    expect(owners).toEqual([
      { id: "turn:ws_a:ses_1:turn_1", kind: "turn", generation: "lease-7", state: "running", pins: true },
      { id: "turn:ws_a:ses_2:turn_9", kind: "turn", generation: "lease-8", state: "running", pins: true },
      { id: "workspace:ws_a", kind: "workspace_runtime", generation: "mount-1", state: "serving", pins: false },
    ])
  })

  test("the preview names the sessions a stop would interrupt, not a count of them", () => {
    const work: LocalDaemonWorkActivity = {
      ...empty(),
      runtime: runtimeOwners([{ sessionId: "ses_1", turnId: "turn_1", ownerGeneration: "lease-7" }]),
      owners: localDaemonOwners([], runtimeOwners([{ sessionId: "ses_1", turnId: "turn_1", ownerGeneration: "lease-7" }])),
      residencyPins: 1,
      replacementBlockers: 1,
    }

    const preview = localDaemonScopePreview(work)
    expect(preview.sessions).toEqual(["ses_1"])
    expect(preview.resources).toEqual(["turn:ws_a:ses_1:turn_1 (running)", "workspace:ws_a (serving)"])
    expect(preview.summary).toBe("2 named owners")
  })

  test("a turn admitted after the preview changes the scope revision", () => {
    const before = localDaemonOwners([], runtimeOwners([]))
    const after = localDaemonOwners([], runtimeOwners([
      { sessionId: "ses_1", turnId: "turn_1", ownerGeneration: "lease-7" },
    ]))
    const revisionOf = (owners: LocalDaemonOwner[]) =>
      localDaemonScopeRevision({ ...empty(), owners, residencyPins: owners.length, replacementBlockers: owners.length })

    expect(revisionOf(after)).not.toBe(revisionOf(before))
  })

  test("a remounted workspace is a different owner, so a gate for the old mount does not carry", () => {
    const first = localDaemonOwners([], runtimeOwners([]))
    const remounted = localDaemonOwners([], {
      ...runtimeOwners([]),
      owners: [{ workspaceId: "ws_a", generation: "mount-2", state: "serving", attempt: 0, turns: [] }],
    })

    expect(first[0]!.generation).toBe("mount-1")
    expect(remounted[0]!.generation).toBe("mount-2")
  })
})

describe("startup launch reconciliation", () => {
  const record = (launchId: string, over: Record<string, unknown> = {}) => ({
    launchId,
    role: "harness" as const,
    protocol: "gate" as const,
    scope: { workspaceId: "ws_a" },
    preparedAt: 1,
    ...over,
  })

  test("admission is closed until every unsettled launch has been reported", async () => {
    const reported: ReconciledLaunch[] = []
    let release = () => {}
    const reading = new Promise<void>((resolve) => { release = resolve })
    const lifecycle = createLocalDaemonLifecycle({
      activity: empty,
      onStop() {},
      machine: {
        ...machine,
        ownership: async () => {
          await reading
          return [{
            workspaceId: "ws_a",
            generation: "mount-1",
            state: "serving",
            attempt: 0,
            turns: [],
            // Prepared and never activated: the gate protocol establishes that
            // no payload ran, so this one reconciles as no execution.
            launches: [record("launch-never")],
          }]
        },
        onLaunchReconciled: (row) => reported.push(row),
      },
    })

    lifecycle.start()
    expect(lifecycle.recovery.ingressClosed()).toEqual({ kind: "launch_reconciliation" })
    expect(reported, "nothing is reported before the records are read").toEqual([])

    release()
    await lifecycle.recovery.launchesReconciled()

    expect(lifecycle.recovery.ingressClosed()).toBeUndefined()
    expect(reported).toEqual([{
      workspaceId: "ws_a",
      launchId: "launch-never",
      role: "harness",
      execution: "none",
      because: reported[0]!.because,
    }])
    lifecycle.stop()
  })

  test("a daemon that has not started fences nothing, however reachable its listener is", () => {
    const lifecycle = createLocalDaemonLifecycle({
      activity: empty,
      onStop() {},
      machine: { ...machine, ownership: async () => [] },
    })

    // The listener accepts connections before the entrypoint calls start(). A
    // hold here would refuse work for an owner that has not taken the machine.
    expect(lifecycle.snapshot().state).toBe("created")
    expect(lifecycle.recovery.ingressClosed()).toBeUndefined()

    lifecycle.start()
    expect(lifecycle.recovery.ingressClosed()).toEqual({ kind: "launch_reconciliation" })
    lifecycle.stop()
  })

  test("a store that could not be read is reported rather than treated as empty", async () => {
    const unreadable: Array<[string | undefined, string]> = []
    const lifecycle = createLocalDaemonLifecycle({
      activity: empty,
      onStop() {},
      machine: {
        ...machine,
        ownership: async () => [{
          workspaceId: "ws_b",
          generation: "mount-1",
          state: "serving",
          attempt: 0,
          turns: [],
          launchesUnreadable: "database is locked",
        }],
        onLaunchesUnreadable: (workspaceId, reason) => unreadable.push([workspaceId, reason]),
      },
    })

    lifecycle.start()
    await lifecycle.recovery.launchesReconciled()

    expect(unreadable).toEqual([["ws_b", "database is locked"]])
    lifecycle.stop()
  })

  test("an ownership read that throws is reported, reopens admission, and never rejects", async () => {
    const reported: ReconciledLaunch[] = []
    const unreadable: Array<[string | undefined, string]> = []
    const lifecycle = createLocalDaemonLifecycle({
      activity: empty,
      onStop() {},
      machine: {
        ...machine,
        ownership: async () => { throw new Error("no workspace store") },
        onLaunchReconciled: (row) => reported.push(row),
        onLaunchesUnreadable: (workspaceId, reason) => unreadable.push([workspaceId, reason]),
      },
    })

    lifecycle.start()
    // Nothing at the entrypoint awaits this, so a rejection here would take the
    // daemon down over a read that only decides whether admission may reopen.
    await expect(lifecycle.recovery.launchesReconciled()).resolves.toEqual([])

    expect(unreadable).toEqual([[undefined, "no workspace store"]])
    expect(lifecycle.recovery.ingressClosed()).toBeUndefined()
    expect(reported, "nothing is claimed about records that were never read").toEqual([])
    lifecycle.stop()
  })
})
