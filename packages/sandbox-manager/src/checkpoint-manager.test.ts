import { describe, expect, test, vi } from "vitest"
import { createSandboxManager, type SandboxCheckpointRuntime, type SandboxDriver } from "."
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
    expect(await manager.stop("ws_1", { runtime: control, idleBefore: 1_000, expectedEpoch: 1 })).toEqual({ ok: true, status: "stopped", checkpoint: "snapshot-1" })
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

  test("a stop for a lease generation that was replaced touches nothing", async () => {
    const next = driver({ stop: vi.fn(async () => {}) })
    const manager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver: next })
    await manager.ensure("ws_1", { homeRegion: "us-east" })
    const control = runtime()
    expect(await manager.stop("ws_1", { runtime: control, expectedEpoch: 2 })).toEqual({ ok: false, reason: "runtime_lease_changed" })
    expect(control.freeze).not.toHaveBeenCalled()
    expect(next.stop).not.toHaveBeenCalled()
  })

  test("a host that stops itself is not stopped by the manager, and its retry after a failed self-stop names the committed snapshot", async () => {
    const store = createMemoryLeaseStore()
    const next = driver({ stop: vi.fn(async () => {}) })
    const manager = createSandboxManager({ leaseStore: store, driver: next })
    await manager.ensure("ws_1", { homeRegion: "us-east" })
    const control = runtime()
    const request = { runtime: control, idleBefore: 1_000, expectedEpoch: 1, hostStopsItself: true }
    expect(await manager.stop("ws_1", request)).toEqual({ ok: true, status: "stopped", checkpoint: "snapshot-1" })
    expect(next.stop).not.toHaveBeenCalled()
    expect(control.resume).not.toHaveBeenCalled()
    expect(await manager.stop("ws_1", request)).toEqual({ ok: true, status: "stopped", checkpoint: "snapshot-1" })
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

  test("a snapshot deletion failure keeps retirement retryable instead of declaring cleanup complete", async () => {
    const store = createMemoryLeaseStore()
    const deleteSnapshot = vi.fn().mockRejectedValueOnce(new Error("snapshot deletion failed")).mockResolvedValue(undefined)
    const manager = createSandboxManager({ leaseStore: store, driver: driver({ deleteSnapshot, destroy: vi.fn(async () => {}) }) })
    await manager.ensure("ws_1", { homeRegion: "us-east" })
    await manager.checkpoint("ws_1", { runtime: runtime() })
    await expect(manager.destroy("ws_1", { retireLease: { homeRegion: "us-east" } })).rejects.toThrow("snapshot deletion failed")
    expect((await store.get("ws_1"))?.status).toBe("retiring")
    expect(await manager.destroy("ws_1")).toEqual({ ok: true, status: "destroyed" })
    expect((await store.get("ws_1"))?.status).toBe("retired")
    expect(deleteSnapshot).toHaveBeenCalledTimes(2)
  })
})
