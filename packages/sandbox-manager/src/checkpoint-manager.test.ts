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
      retentionExpiresAt: 9_000,
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
          retentionExpiresAt: 9_000,
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
