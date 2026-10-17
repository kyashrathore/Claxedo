import { describe, expect, test, vi } from "vitest"
import { createSandboxManager, type SandboxCheckpointRuntime, type SandboxDriver, type SandboxLifecycleEvent } from "."
import { sandboxDriverCatalog } from "./driver-catalog"
import { createMemoryLeaseStore } from "./stores/memory"

function runtime(order: string[] = []): SandboxCheckpointRuntime {
  return {
    freeze: vi.fn(async () => { order.push("freeze") }),
    flush: vi.fn(async () => { order.push("flush") }),
    scrub: vi.fn(async () => { order.push("scrub") }),
    resume: vi.fn(async () => { order.push("resume") }),
    reconcile: vi.fn(async () => { order.push("reconcile") }),
  }
}

function driver(overrides: Partial<SandboxDriver> = {}): SandboxDriver {
  return {
    id: "checkpoint-test",
    metadata: {
      driverRunsIn: ["node"],
      hostStopBehavior: "terminates-host",
      hostResumeBehavior: "replacement-host",
      targetAccess: "relay",
      secretBrokering: "native",
      egressControl: "hosts-and-cidrs",
      persistence: {
        resume: "replacement-restore",
        capture: "filesystem",
        clone: false,
        captureSource: "preserved",
        retention: "provider-managed",
        restoreMount: "new-resource",
      },
    },
    ensureHost: vi.fn(async (input) => ({
      sandboxId: `sandbox-g${input.epoch}`,
      url: `https://runtime.test/g${input.epoch}`,
      hostId: `host-g${input.epoch}`,
      labels: input.labels,
    })),
    snapshot: vi.fn(async () => ({ snapshotId: "snapshot-1" })),
    ...overrides,
  }
}

describe("sandbox checkpoint manager", () => {
  test("freezes, flushes, and scrubs before capturing a consistent checkpoint", async () => {
    const order: string[] = []
    const next = driver({
      snapshot: vi.fn(async () => {
        order.push("capture")
        return { snapshotId: "snapshot-consistent" }
      }),
    })
    const manager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver: next, now: () => 1_000 })
    await manager.ensure("ws_1", { homeRegion: "us-east" })

    const result = await manager.checkpoint("ws_1", {
      runtime: runtime(order),
    })

    expect(order).toEqual(["freeze", "flush", "scrub", "capture", "resume"])
    expect(result).toMatchObject({
      status: "ready",
      checkpoint: {
        providerReference: "snapshot-consistent",
        sourceEpoch: 1,
        capturedAt: 1_000,
        metadata: {
          scope: "filesystem",
          sourceBehavior: "preserved",
          restoreMount: "new-resource",
        },
      },
    })
  })

  test("resumes a still-live runtime when capture fails before the provider stops it", async () => {
    const order: string[] = []
    const base = driver()
    const manager = createSandboxManager({
      leaseStore: createMemoryLeaseStore(),
      driver: driver({
        metadata: {
          ...base.metadata,
          persistence: {
            ...base.metadata.persistence,
            captureSource: "stopped",
          },
        },
        snapshot: vi.fn(async () => {
          order.push("capture")
          throw new Error("provider snapshot failed")
        }),
      }),
    })
    await manager.ensure("ws_1", { homeRegion: "us-east" })

    await expect(manager.checkpoint("ws_1", { runtime: runtime(order) }))
      .rejects.toThrow("provider snapshot failed")
    expect(order).toEqual(["freeze", "flush", "scrub", "capture", "resume"])
  })

  test("coalesces concurrent checkpoint requests for one workspace", async () => {
    let release = () => {}
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const next = driver({
      snapshot: vi.fn(async () => {
        await wait
        return { snapshotId: "snapshot-coalesced" }
      }),
    })
    const manager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver: next })
    await manager.ensure("ws_1", { homeRegion: "us-east" })

    const first = manager.checkpoint("ws_1", { runtime: runtime() })
    const second = manager.checkpoint("ws_1", { runtime: runtime() })
    release()
    const [a, b] = await Promise.all([first, second])

    expect(a.checkpoint.id).toBe(b.checkpoint.id)
    expect(next.snapshot).toHaveBeenCalledTimes(1)
  })

  test("restores through exactly one new epoch and makes exact retries idempotent", async () => {
    let now = 1_000
    const next = driver()
    const manager = createSandboxManager({
      leaseStore: createMemoryLeaseStore(),
      driver: next,
      now: () => ++now,
    })
    await manager.ensure("ws_1", { homeRegion: "us-east" })
    const captured = await manager.checkpoint("ws_1", { runtime: runtime() })
    const restoredRuntime = runtime()

    const restored = await manager.restore("ws_1", {
      runtime: restoredRuntime,
      checkpointId: captured.checkpoint.id,
    })
    const retry = await manager.restore("ws_1", {
      runtime: restoredRuntime,
      checkpointId: captured.checkpoint.id,
    })

    expect(restored.lease.epoch).toBe(2)
    expect(retry.lease.epoch).toBe(2)
    expect(restoredRuntime.reconcile).toHaveBeenCalledTimes(1)
    expect(next.ensureHost).toHaveBeenLastCalledWith(expect.objectContaining({
      epoch: 2,
      bootSource: { kind: "driver-snapshot", snapshotId: "snapshot-1" },
    }))
  })

  test("persists provisioning restore state and retries on the same epoch", async () => {
    const next = driver({
      ensureHost: vi.fn()
        .mockResolvedValueOnce({
          sandboxId: "source",
          url: "https://runtime.test/source",
          hostId: "source",
        })
        .mockResolvedValueOnce({ provisioning: true, retryAfterMs: 5 })
        .mockResolvedValueOnce({
          sandboxId: "replacement",
          url: "https://runtime.test/replacement",
          hostId: "replacement",
        }),
    })
    let now = 1_000
    const manager = createSandboxManager({
      leaseStore: createMemoryLeaseStore(),
      driver: next,
      now: () => now,
    })
    await manager.ensure("ws_1", { homeRegion: "us-east" })
    const checkpoint = await manager.checkpoint("ws_1", { runtime: runtime() })
    const first = await manager.restore("ws_1", { runtime: runtime(), checkpointId: checkpoint.checkpoint.id })
    now += 5
    const recovered = await manager.restore("ws_1", { runtime: runtime(), checkpointId: checkpoint.checkpoint.id })

    expect(first).toMatchObject({ status: "provisioning", lease: { epoch: 2, restore: { state: "restoring" } } })
    expect(recovered).toMatchObject({ status: "ready", lease: { epoch: 2, restore: { state: "ready" } } })
  })
})

describe("checkpoint lifecycle", () => {
  test("a committed checkpoint deletes the snapshot it replaced, and a fenced capture deletes its own", async () => {
    const deleted: string[] = []
    let taken = 0
    const store = createMemoryLeaseStore()
    const next = driver({
      snapshot: vi.fn(async () => ({ snapshotId: `snapshot-${++taken}` })),
      deleteSnapshot: vi.fn(async (_target, snapshotId: string) => { deleted.push(snapshotId) }),
    })
    const manager = createSandboxManager({ leaseStore: store, driver: next })
    await manager.ensure("ws_1", { homeRegion: "us-east" })
    await manager.checkpoint("ws_1", { runtime: runtime() })
    expect(deleted).toEqual([])
    await manager.checkpoint("ws_1", { runtime: runtime() })
    expect(deleted).toEqual(["snapshot-1"])
    const update = store.update.bind(store)
    store.update = vi.fn(async () => undefined)
    await expect(manager.checkpoint("ws_1", { runtime: runtime() })).rejects.toThrow()
    store.update = update
    expect(deleted).toEqual(["snapshot-1", "snapshot-3"])
    expect((await store.get("ws_1"))?.checkpoint?.providerReference).toBe("snapshot-2")
  })

  test("an idle stop commits the capture and the stopped lease together, keeps the runtime frozen, then stops the host", async () => {
    const order: string[] = []
    const store = createMemoryLeaseStore()
    const next = driver({ stop: vi.fn(async (target) => { order.push(`stop:${target.epoch}:${target.checkpoint}:${(await store.get("ws_1"))?.status}`) }) })
    const manager = createSandboxManager({ leaseStore: store, driver: next })
    await manager.ensure("ws_1", { homeRegion: "us-east" })
    const control = runtime(order)
    expect(await manager.stop("ws_1", { runtime: control, idleBefore: 1_000, expectedEpoch: 1 })).toEqual({ ok: true, status: "stopped" })
    expect(control.freeze).toHaveBeenCalledWith("drain", { idleBefore: 1_000 })
    expect(order).toEqual(["freeze", "flush", "scrub", "stop:1:snapshot-1:stopped"])
    expect((await store.get("ws_1"))?.checkpoint?.providerReference).toBe("snapshot-1")
  })

  test("a refused idle freeze thaws the runtime, captures nothing and leaves the lease running", async () => {
    const store = createMemoryLeaseStore()
    const next = driver({ stop: vi.fn(async () => {}) })
    const manager = createSandboxManager({ leaseStore: store, driver: next })
    await manager.ensure("ws_1", { homeRegion: "us-east" })
    const control = runtime()
    control.freeze = vi.fn(async () => { throw new Error("workspace_not_idle") })
    await expect(manager.stop("ws_1", { runtime: control, idleBefore: 1_000 })).rejects.toThrow("workspace_not_idle")
    expect(next.snapshot).not.toHaveBeenCalled()
    expect(next.stop).not.toHaveBeenCalled()
    expect(control.resume).toHaveBeenCalledOnce()
    expect((await store.get("ws_1"))?.status).toBe("ready")
  })

  test("a stop whose runtime does not answer captures the container unfrozen, and the wake boots from that capture", async () => {
    const store = createMemoryLeaseStore()
    const events: SandboxLifecycleEvent[] = []
    const snapshots = ["snapshot-1", "snapshot-unfrozen"]
    const next = driver({ stop: vi.fn(async () => {}), snapshot: vi.fn(async () => ({ snapshotId: snapshots.shift() ?? "snapshot-extra" })) })
    const manager = createSandboxManager({ leaseStore: store, driver: next, onLifecycle: (event) => events.push(event) })
    await manager.ensure("ws_1", { homeRegion: "us-east" })
    await manager.checkpoint("ws_1", { runtime: runtime() })
    const dead = runtime()
    dead.freeze = vi.fn(async () => { throw new Error("the runtime is unreachable") })
    dead.resume = vi.fn(async () => { throw new Error("the runtime is unreachable") })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(await manager.stop("ws_1", { runtime: dead })).toEqual({ ok: true, status: "stopped" })
    warn.mockRestore()
    expect(dead.flush).not.toHaveBeenCalled()
    expect(next.stop).toHaveBeenCalledWith(expect.objectContaining({ epoch: 1, checkpoint: "snapshot-unfrozen" }))
    expect(await store.get("ws_1")).toMatchObject({
      status: "stopped",
      checkpoint: { providerReference: "snapshot-unfrozen", metadata: { unfrozen: true } },
    })
    const stops = events.filter((event) => event.kind === "stopped")
    expect(stops).toEqual([expect.objectContaining({ kind: "stopped", cause: "explicit", unfrozen: true })])
    expect(stops[0]).not.toHaveProperty("unsaved")

    await manager.ensure("ws_1", { homeRegion: "us-east" })
    expect(next.ensureHost).toHaveBeenLastCalledWith(expect.objectContaining({ epoch: 2, bootSource: { kind: "driver-snapshot", snapshotId: "snapshot-unfrozen" } }))
  })

  test("a stop whose runtime does not answer and whose provider takes no snapshot either stops on the last good checkpoint, and says the latest changes were not saved", async () => {
    const store = createMemoryLeaseStore()
    const events: SandboxLifecycleEvent[] = []
    const next = driver({ stop: vi.fn(async () => {}) })
    const manager = createSandboxManager({ leaseStore: store, driver: next, onLifecycle: (event) => events.push(event) })
    await manager.ensure("ws_1", { homeRegion: "us-east" })
    await manager.checkpoint("ws_1", { runtime: runtime() })
    next.snapshot = vi.fn(async () => { throw new Error("The workspace container is not running") })
    const dead = runtime()
    dead.freeze = vi.fn(async () => { throw new Error("the runtime is unreachable") })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(await manager.stop("ws_1", { runtime: dead })).toEqual({ ok: true, status: "stopped", unsaved: true })
    warn.mockRestore()
    expect(next.stop).toHaveBeenCalledWith(expect.objectContaining({ epoch: 1, checkpoint: "snapshot-1" }))
    expect(await store.get("ws_1")).toMatchObject({ status: "stopped", checkpoint: { providerReference: "snapshot-1" } })
    expect(events.filter((event) => event.kind === "stopped")).toEqual([expect.objectContaining({ kind: "stopped", cause: "explicit", unsaved: true })])
  })

  test("a stop for a runtime that answered nothing through its failure budget is recorded as unresponsive, with that reason on the stopped lease until the next start", async () => {
    const store = createMemoryLeaseStore()
    const events: SandboxLifecycleEvent[] = []
    const next = driver({ stop: vi.fn(async () => {}) })
    const manager = createSandboxManager({ leaseStore: store, driver: next, onLifecycle: (event) => events.push(event) })
    await manager.ensure("ws_1", { homeRegion: "us-east" })
    const dead = runtime()
    dead.freeze = vi.fn(async () => { throw new Error("the runtime is unreachable") })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(await manager.stop("ws_1", { runtime: dead, expectedEpoch: 1, unresponsiveForMs: 600_000 })).toEqual({ ok: true, status: "stopped" })
    warn.mockRestore()
    expect(events.filter((event) => event.kind === "stopped")).toEqual([expect.objectContaining({ kind: "stopped", cause: "unresponsive", unfrozen: true })])
    expect(await manager.target("ws_1")).toMatchObject({
      status: "unavailable",
      leaseStatus: "stopped",
      stopReason: "The workspace's runtime stopped answering; it was stopped after 10 minutes.",
    })

    await manager.ensure("ws_1", { homeRegion: "us-east" })
    expect(await store.get("ws_1")).toMatchObject({ status: "ready", epoch: 2 })
    expect((await store.get("ws_1"))?.lastError).toBeUndefined()
  })

  test("on a provider whose stopped machine keeps its disk, a stop for a runtime that died asks the runtime nothing, loses nothing, and the wake resumes that same machine", async () => {
    const store = createMemoryLeaseStore()
    const events: SandboxLifecycleEvent[] = []
    const resumeHost = vi.fn(async (input: { lease: { sandboxId?: string } }) => ({ sandboxId: input.lease.sandboxId ?? "", url: "https://runtime.test/resumed", hostId: "host-g1", labels: {} }))
    const next = driver({ metadata: sandboxDriverCatalog.boat.metadata, stop: vi.fn(async () => {}), resumeHost })
    const manager = createSandboxManager({ leaseStore: store, driver: next, onLifecycle: (event) => events.push(event) })
    await manager.ensure("ws_1", { homeRegion: "us-east" })
    const dead = runtime()
    dead.freeze = vi.fn(async () => { throw new Error("the runtime is unreachable") })

    expect(await manager.stop("ws_1", { runtime: dead, expectedEpoch: 1, unresponsiveForMs: 600_000 })).toEqual({ ok: true, status: "stopped" })
    expect(dead.freeze).not.toHaveBeenCalled()
    expect(next.snapshot).not.toHaveBeenCalled()
    expect(next.stop).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: "sandbox-g1", epoch: 1 }))
    expect(events.filter((event) => event.kind === "stopped")).toEqual([expect.objectContaining({ cause: "unresponsive" })])
    expect(events.find((event) => event.kind === "stopped")).not.toHaveProperty("unsaved")

    await manager.ensure("ws_1", { homeRegion: "us-east" })
    expect(resumeHost).toHaveBeenCalledWith(expect.objectContaining({ lease: expect.objectContaining({ sandboxId: "sandbox-g1" }) }))
    expect(await store.get("ws_1")).toMatchObject({ status: "ready", epoch: 2, sandboxId: "sandbox-g1" })
  })

  test("a failed capture whose thaw fails too answers the capture's own failure", async () => {
    const manager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver: driver() })
    await manager.ensure("ws_1", { homeRegion: "us-east" })
    const control = runtime()
    control.freeze = vi.fn(async () => { throw new Error("freeze refused") })
    control.resume = vi.fn(async () => { throw new Error("resume refused") })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(manager.checkpoint("ws_1", { runtime: control })).rejects.toThrow("freeze refused")
    warn.mockRestore()
  })

  test("a stop for a lease generation that was replaced touches nothing", async () => {
    const next = driver({ stop: vi.fn(async () => {}) })
    const manager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver: next })
    await manager.ensure("ws_1", { homeRegion: "us-east" })
    const control = runtime()
    expect(await manager.stop("ws_1", { runtime: control, expectedEpoch: 2 })).toEqual({ ok: false, reason: "runtime_lease_changed" })
    expect(control.freeze).not.toHaveBeenCalled()
    expect(next.stop).not.toHaveBeenCalled()
  })

  test("a host that stops itself is not stopped by the manager, and its retry after a failed self-stop answers stopped again", async () => {
    const store = createMemoryLeaseStore()
    const next = driver({ stop: vi.fn(async () => {}) })
    const manager = createSandboxManager({ leaseStore: store, driver: next })
    await manager.ensure("ws_1", { homeRegion: "us-east" })
    const control = runtime()
    const request = { runtime: control, idleBefore: 1_000, expectedEpoch: 1, hostStopsItself: true }
    expect(await manager.stop("ws_1", request)).toEqual({ ok: true, status: "stopped" })
    expect(next.stop).not.toHaveBeenCalled()
    expect(control.resume).not.toHaveBeenCalled()
    expect(await manager.stop("ws_1", request)).toEqual({ ok: true, status: "stopped" })
    expect(next.snapshot).toHaveBeenCalledOnce()
  })

  test("a capture names the committed snapshot to the driver, and deletes one committed while it ran", async () => {
    const deleted: string[] = []
    const store = createMemoryLeaseStore()
    const committedMeanwhile = { id: "cp_meanwhile", providerReference: "snapshot-meanwhile", sourceEpoch: 1, capturedAt: 1,
      metadata: { scope: "filesystem" as const, sourceBehavior: "preserved" as const, restoreMount: "new-resource" as const } }
    const next = driver({
      snapshot: vi.fn(async (_target, committed?: string) => {
        expect(committed).toBeUndefined()
        await store.update("ws_1", 1, { checkpoint: committedMeanwhile })
        return { snapshotId: "snapshot-new" }
      }),
      deleteSnapshot: vi.fn(async (_target, snapshotId: string) => { deleted.push(snapshotId) }),
    })
    const manager = createSandboxManager({ leaseStore: store, driver: next })
    await manager.ensure("ws_1", { homeRegion: "us-east" })
    await manager.checkpoint("ws_1", { runtime: runtime() })
    expect(deleted).toEqual(["snapshot-meanwhile"])
  })

  test("destroying a workspace deletes the snapshot its lease referenced", async () => {
    const deleteSnapshot = vi.fn(async () => {})
    const manager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver: driver({ deleteSnapshot, destroy: vi.fn(async () => {}) }) })
    await manager.ensure("ws_1", { homeRegion: "us-east" })
    await manager.checkpoint("ws_1", { runtime: runtime() })
    expect(await manager.destroy("ws_1")).toEqual({ ok: true, status: "destroyed" })
    expect(deleteSnapshot).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws_1" }), "snapshot-1")
  })
})
