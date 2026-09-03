import { describe, expect, test, vi } from "vitest"
import { createSandboxManager, type SandboxDriver } from "."
import { createMemoryLeaseStore, sandboxLease } from "./stores/memory"

function fakeDriver(overrides: Partial<SandboxDriver> = {}): SandboxDriver {
  return {
    id: "test-driver",
    ensureHost: vi.fn(async (input) => ({
      sandboxId: `sandbox_${input.workspaceId}`,
      url: `https://runtime.test/${input.workspaceId}`,
      hostId: `host_${input.workspaceId}`,
      labels: input.labels,
    })),
    ...overrides,
    metadata: {
      driverRunsIn: ["node"],
      hostStopBehavior: "suspends-host", hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "native",
      egressControl: "hosts-and-cidrs",
      persistence: {
        resume: "same-sandbox",
        capture: "none",
        clone: false,
        captureSource: "not-applicable",
        retention: "not-applicable",
        restoreMount: "not-applicable",
      },
      ...overrides.metadata,
    },
  }
}

describe("sandbox manager", () => {
  test("concurrent ensure calls share a fresh acquiring lease", async () => {
    let now = 1_000
    const store = createMemoryLeaseStore()
    const driver = fakeDriver({
      ensureHost: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return {
          sandboxId: "sandbox_1",
          url: "https://runtime.test/ws_1",
          hostId: "host_1",
        }
      }),
    })
    const manager = createSandboxManager({
      leaseStore: store,
      driver,
      now: () => now,
      staleAfterMs: 60_000,
    })

    const first = manager.ensure("ws_1", { homeRegion: "us-east" })
    await Promise.resolve()
    now += 10
    const second = await manager.ensure("ws_1", { homeRegion: "us-east" })

    expect(second).toMatchObject({ status: "provisioning", retryAfterMs: 59_990, epoch: 1 })
    expect(await first).toMatchObject({ status: "ready", sandboxId: "sandbox_1", hostId: "host_1", epoch: 1 })
    expect(driver.ensureHost).toHaveBeenCalledTimes(1)
  })

  test("stale acquiring leases are recovered with a new epoch", async () => {
    const store = createMemoryLeaseStore([
      sandboxLease({
        workspaceId: "ws_1",
        status: "acquiring",
        epoch: 2,
        updatedAt: 1_000,
        createdAt: 1_000,
      }),
    ])
    const manager = createSandboxManager({
      leaseStore: store,
      driver: fakeDriver(),
      now: () => 70_000,
      staleAfterMs: 60_000,
    })

    await expect(manager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({
      status: "ready",
      epoch: 3,
      sandboxId: "sandbox_ws_1",
    })
  })

  test("ensure forwards workspace materialization and boot inputs to the sandbox driver", async () => {
    const store = createMemoryLeaseStore()
    const driver = fakeDriver()
    const manager = createSandboxManager({ leaseStore: store, driver })

    await expect(
      manager.ensure("ws_1", {
        homeRegion: "eu-west",
        hostId: "custom-host",
        labels: { projectId: "proj_1" },
        bootSource: { kind: "driver-snapshot", snapshotId: "snap_1" },
        workspaceRoot: "/work",
        runtimeCwd: "/runtime",
        workspaceRuntimePort: 2593,
        env: { TOKEN: "secret" },
        source: { kind: "git", repoUrl: "https://repo.test/app.git", branch: "dev" },
        exposure: { kind: "relay" },
        net: { mode: "restricted", hosts: ["api.test"] },
        snapshot: "driver-base",
      }),
    ).resolves.toMatchObject({
      status: "ready",
      hostId: "host_ws_1",
      epoch: 1,
    })

    expect(driver.ensureHost).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_1",
        hostId: "custom-host",
        homeRegion: "eu-west",
        epoch: 1,
        labels: expect.objectContaining({
          app: "claxedo",
          workspaceId: "ws_1",
          epoch: "1",
          homeRegion: "eu-west",
          projectId: "proj_1",
        }),
        bootSource: { kind: "driver-snapshot", snapshotId: "snap_1" },
        workspaceRoot: "/work",
        runtimeCwd: "/runtime",
        workspaceRuntimePort: 2593,
        env: { TOKEN: "secret" },
        source: { kind: "git", repoUrl: "https://repo.test/app.git", branch: "dev" },
        exposure: { kind: "relay" },
        net: { mode: "restricted", hosts: ["api.test"] },
        snapshot: "driver-base",
      }),
    )
  })

  test("ordinary ensure of a ready lease does not roll back to its latest checkpoint", async () => {
    const store = createMemoryLeaseStore([
      sandboxLease({
        workspaceId: "ws_1",
        status: "ready",
        sandboxId: "sandbox_1",
        url: "https://runtime.test/ws_1",
        hostId: "host_1",
        checkpoint: {
          id: "checkpoint_1",
          providerReference: "snapshot_old",
          sourceEpoch: 1,
          capturedAt: 1_000,
          metadata: {
            scope: "filesystem",
            sourceBehavior: "preserved",
            restoreMount: "new-resource",
          },
        },
      }),
    ])
    const driver = fakeDriver({
      metadata: {
        ...fakeDriver().metadata,
        hostStopBehavior: "terminates-host",
        hostResumeBehavior: "replacement-host",
        persistence: {
          resume: "replacement-restore",
          capture: "filesystem",
          clone: false,
          captureSource: "preserved",
          retention: "provider-managed",
          restoreMount: "new-resource",
        },
      },
    })

    await createSandboxManager({ leaseStore: store, driver })
      .ensure("ws_1", { homeRegion: "us-east" })

    expect(driver.ensureHost).toHaveBeenCalledWith(expect.objectContaining({
      bootSource: { kind: "default" },
    }))
  })

  test("stop and destroy retries are idempotent after their terminal state is stored", async () => {
    const store = createMemoryLeaseStore()
    const driver = fakeDriver({
      stop: vi.fn(async () => {}),
      destroy: vi.fn(async () => {}),
    })
    const manager = createSandboxManager({ leaseStore: store, driver })
    await manager.ensure("ws_stop", { homeRegion: "us-east" })
    await manager.ensure("ws_destroy", { homeRegion: "us-east" })

    expect(await manager.stop("ws_stop")).toEqual({ ok: true, status: "stopped" })
    expect(await manager.stop("ws_stop")).toEqual({ ok: true, status: "stopped" })
    expect(await manager.destroy("ws_destroy")).toEqual({ ok: true, status: "destroyed" })
    expect(await manager.destroy("ws_destroy")).toEqual({ ok: true, status: "destroyed" })
    expect(driver.stop).toHaveBeenCalledTimes(1)
    expect(driver.destroy).toHaveBeenCalledTimes(1)
  })

  test("stale epoch writes are rejected by the lease store", async () => {
    const store = createMemoryLeaseStore([sandboxLease({ workspaceId: "ws_1", epoch: 4, status: "acquiring" })])

    await expect(store.update("ws_1", 3, { status: "ready", hostId: "host_1" })).resolves.toBeUndefined()
    await expect(store.get("ws_1")).resolves.toMatchObject({ status: "acquiring", epoch: 4 })
  })

  test("failed attempts record retry state and block paid retries until next_retry_at", async () => {
    let now = 10_000
    const store = createMemoryLeaseStore()
    const driver = fakeDriver({
      ensureHost: vi.fn(async () => {
        throw new Error("driver quota exhausted")
      }),
    })
    const manager = createSandboxManager({
      leaseStore: store,
      driver,
      now: () => now,
      retryDelayMs: () => 30_000,
    })

    await expect(manager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({
      status: "unavailable",
      retryAfterMs: 30_000,
      error: "driver quota exhausted",
      epoch: 1,
    })
    now += 1_000
    await expect(manager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({
      status: "unavailable",
      retryAfterMs: 29_000,
      epoch: 1,
    })
    expect(driver.ensureHost).toHaveBeenCalledTimes(1)
  })

  test("driver-side provisioning retry interval is preserved on the acquiring lease", async () => {
    let now = 10_000
    const store = createMemoryLeaseStore()
    const driver = fakeDriver({
      ensureHost: vi.fn(async () => ({ provisioning: true as const, retryAfterMs: 2_000 })),
    })
    const manager = createSandboxManager({
      leaseStore: store,
      driver,
      now: () => now,
      staleAfterMs: 60_000,
    })

    await expect(manager.ensure("ws_1", { homeRegion: "eu-west" })).resolves.toMatchObject({
      status: "provisioning",
      retryAfterMs: 2_000,
      epoch: 1,
      homeRegion: "eu-west",
      // A fresh lease with no snapshot and no resumable resource is honestly a
      // cold start — the connect UI renders exactly this word.
      bootMode: "cold-start",
    })
    now += 500
    await expect(manager.ensure("ws_1", { homeRegion: "eu-west" })).resolves.toMatchObject({
      status: "provisioning",
      retryAfterMs: 1_500,
      epoch: 1,
      homeRegion: "eu-west",
      // The still-waiting branch answers from the lease row without touching
      // the driver, and must keep the same honest label as the first poll.
      bootMode: "cold-start",
    })
    expect(driver.ensureHost).toHaveBeenCalledTimes(1)
  })

  test("provisioning from a lease checkpoint reports bootMode restore", async () => {
    const store = createMemoryLeaseStore()
    const driver = fakeDriver({
      metadata: {
        driverRunsIn: ["node"],
        hostStopBehavior: "suspends-host",
        hostResumeBehavior: "same-host",
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
      ensureHost: vi.fn(async () => ({ provisioning: true as const, retryAfterMs: 2_000 })),
    })
    const manager = createSandboxManager({ leaseStore: store, driver, staleAfterMs: 60_000 })
    // Seed a lease that carries a checkpoint but is not ready — the shape a
    // stopped-and-snapshotted workspace wakes from. `nextRetryAt` in the past
    // puts this poll on the in-flight-provision path (which re-runs the
    // driver); the follow-up poll below lands on the still-waiting path, which
    // derives the same mode from the lease row alone.
    await manager.ensure("ws_1", { homeRegion: "eu-west" })
    await store.update("ws_1", 1, {
      status: "acquiring",
      checkpoint: {
        id: "chk_1",
        providerReference: "snap_1",
        sourceEpoch: 1,
        capturedAt: 1,
        metadata: { scope: "filesystem", sourceBehavior: "preserved", restoreMount: "new-resource" },
      },
      nextRetryAt: 1,
    })

    const ensured = await manager.ensure("ws_1", { homeRegion: "eu-west" })
    expect(ensured).toMatchObject({ status: "provisioning", bootMode: "restore" })
    expect(driver.ensureHost).toHaveBeenLastCalledWith(
      expect.objectContaining({ bootSource: { kind: "driver-snapshot", snapshotId: "snap_1" } }),
    )

    // The ensure above pushed nextRetryAt into the future, so this poll takes
    // the still-waiting early return — most of what a connecting client sees.
    // It must NOT drop back to an unlabeled (or cold-start) provisioning body.
    const waiting = await manager.ensure("ws_1", { homeRegion: "eu-west" })
    expect(waiting).toMatchObject({ status: "provisioning", bootMode: "restore" })
    expect(driver.ensureHost).toHaveBeenCalledTimes(2)
  })

  test("ready lease still re-ensures with the driver so auto-stopped runtimes resume on the same epoch", async () => {
    const store = createMemoryLeaseStore([
      sandboxLease({
        workspaceId: "ws_1",
        status: "ready",
        epoch: 3,
        sandboxId: "sandbox_1",
        url: "https://runtime.test/old",
        hostId: "host_1",
      }),
    ])
    const driver = fakeDriver({
      // The driver reports an auto-stopped sandbox; ensure resumes it at a new URL.
      ensureHost: vi.fn(async () => ({
        sandboxId: "sandbox_1",
        url: "https://runtime.test/resumed",
        hostId: "host_1",
      })),
    })
    const manager = createSandboxManager({ leaseStore: store, driver })

    await expect(manager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({
      status: "ready",
      sandboxId: "sandbox_1",
      url: "https://runtime.test/resumed",
      epoch: 3,
    })
    expect(driver.ensureHost).toHaveBeenCalledTimes(1)
    expect(driver.ensureHost).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws_1", epoch: 3 }))
    // Same epoch, no second sandbox: the lease was never re-acquired.
    await expect(store.get("ws_1")).resolves.toMatchObject({
      status: "ready",
      epoch: 3,
    })
  })

  test("stopped lease keeps sandbox identity and restarts on the next epoch", async () => {
    const store = createMemoryLeaseStore([
      sandboxLease({
        workspaceId: "ws_stopped",
        status: "stopped",
        epoch: 3,
        sandboxId: "sandbox_stopped",
        url: "https://runtime.test/stopped",
        hostId: "host_stopped",
        driverResourceId: "driver_resource_stopped",
        lastHeartbeatAt: 2_000,
      }),
    ])
    const driver = fakeDriver({
      resumeHost: vi.fn(async (input) => ({
        sandboxId: input.lease.sandboxId!,
        url: "https://runtime.test/restarted",
        hostId: input.lease.hostId!,
        driverResourceId: input.lease.driverResourceId,
        labels: input.ensure.labels,
      })),
    })
    const manager = createSandboxManager({ leaseStore: store, driver })

    await expect(manager.ensure("ws_stopped", { homeRegion: "us-east" })).resolves.toMatchObject({
      status: "ready",
      epoch: 4,
      sandboxId: "sandbox_stopped",
      url: "https://runtime.test/restarted",
      hostId: "host_stopped",
      driverResourceId: "driver_resource_stopped",
    })

    expect(driver.resumeHost).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: expect.objectContaining({
          status: "acquiring",
          epoch: 4,
          sandboxId: "sandbox_stopped",
          url: "https://runtime.test/stopped",
          hostId: "host_stopped",
          driverResourceId: "driver_resource_stopped",
        }),
      }),
    )
    expect(driver.ensureHost).not.toHaveBeenCalled()
  })

  test("ready lease with an unchanged driver target stays ready on the same epoch", async () => {
    const store = createMemoryLeaseStore([
      sandboxLease({
        workspaceId: "ws_1",
        status: "ready",
        epoch: 2,
        sandboxId: "sandbox_1",
        url: "https://runtime.test/ws_1",
        hostId: "host_1",
      }),
    ])
    const driver = fakeDriver({
      ensureHost: vi.fn(async () => ({
        sandboxId: "sandbox_1",
        url: "https://runtime.test/ws_1",
        hostId: "host_1",
      })),
    })
    const manager = createSandboxManager({ leaseStore: store, driver })

    await expect(manager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({
      status: "ready",
      sandboxId: "sandbox_1",
      url: "https://runtime.test/ws_1",
      epoch: 2,
    })
    await expect(manager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({
      status: "ready",
      epoch: 2,
    })
    expect(driver.ensureHost).toHaveBeenCalledTimes(2)
    await expect(store.get("ws_1")).resolves.toMatchObject({ status: "ready", epoch: 2 })
  })

  test("a transient resume failure keeps a ready lease serving instead of demoting it", async () => {
    const store = createMemoryLeaseStore([
      sandboxLease({
        workspaceId: "ws_1",
        status: "ready",
        epoch: 3,
        retryCount: 0,
        sandboxId: "sandbox_1",
        url: "https://runtime.test/ws_1",
        hostId: "host_1",
      }),
    ])
    const driver = fakeDriver({
      ensureHost: vi.fn(async () => {
        throw new Error("driver hiccup")
      }),
    })
    const manager = createSandboxManager({ leaseStore: store, driver })

    // The lazy-resume blip returns the existing ready target instead of 409ing.
    await expect(manager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({
      status: "ready",
      sandboxId: "sandbox_1",
      url: "https://runtime.test/ws_1",
      hostId: "host_1",
      epoch: 3,
    })
    // The lease stays ready — the error is recorded for observability only.
    const lease = await store.get("ws_1")
    expect(lease).toMatchObject({
      status: "ready",
      epoch: 3,
      retryCount: 0,
      lastError: "driver hiccup",
    })
    expect(lease?.nextRetryAt).toBeUndefined()
    // Relay target resolution keeps resolving for everyone.
    await expect(manager.target("ws_1")).resolves.toMatchObject({
      status: "ready",
      url: "https://runtime.test/ws_1",
      hostId: "host_1",
    })
    // A resumed driver clears the recorded error on the next ensure.
    driver.ensureHost = vi.fn(async () => ({
      sandboxId: "sandbox_1",
      url: "https://runtime.test/ws_1",
      hostId: "host_1",
    }))
    await expect(manager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({
      status: "ready",
      epoch: 3,
    })
    expect((await store.get("ws_1"))?.lastError).toBeUndefined()
  })

  test("a driver failure during an in-flight acquiring provision still demotes the lease", async () => {
    const now = 10_000
    const store = createMemoryLeaseStore([
      sandboxLease({
        workspaceId: "ws_1",
        status: "acquiring",
        epoch: 2,
        nextRetryAt: 9_000,
        updatedAt: 9_000,
        createdAt: 1_000,
      }),
    ])
    const driver = fakeDriver({
      ensureHost: vi.fn(async () => {
        throw new Error("driver exploded")
      }),
    })
    const manager = createSandboxManager({
      leaseStore: store,
      driver,
      now: () => now,
      staleAfterMs: 60_000,
      retryDelayMs: () => 30_000,
    })

    await expect(manager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({
      status: "unavailable",
      retryAfterMs: 30_000,
      error: "driver exploded",
      epoch: 2,
    })
    await expect(store.get("ws_1")).resolves.toMatchObject({
      status: "unavailable",
      epoch: 2,
      retryCount: 1,
      lastError: "driver exploded",
      nextRetryAt: 40_000,
    })
  })

  test("polls past nextRetryAt continue an in-flight provision on the same epoch with exactly one sandbox", async () => {
    let now = 0
    let createdSandboxes = 0
    let provisionStartedAt: number | undefined
    const driver = fakeDriver({
      ensureHost: vi.fn(async () => {
        if (provisionStartedAt === undefined) {
          provisionStartedAt = now
          createdSandboxes += 1
        }
        if (now - provisionStartedAt < 12_000) {
          return { provisioning: true as const, retryAfterMs: 2_000 }
        }
        return {
          sandboxId: "sandbox_1",
          url: "https://runtime.test/ws_1",
          hostId: "host_1",
        }
      }),
    })
    const manager = createSandboxManager({
      leaseStore: createMemoryLeaseStore(),
      driver,
      now: () => now,
      staleAfterMs: 60_000,
    })

    const observed: string[] = []
    for (; now <= 12_000; now += 2_000) {
      const result = await manager.ensure("ws_1", { homeRegion: "us-east" })
      observed.push(result.status)
      expect(result.epoch).toBe(1)
      if (result.status === "ready") break
    }

    expect(observed).toEqual([
      "provisioning",
      "provisioning",
      "provisioning",
      "provisioning",
      "provisioning",
      "provisioning",
      "ready",
    ])
    expect(createdSandboxes).toBe(1)
    expect(driver.ensureHost).toHaveBeenCalledTimes(7)
  })

  test("max retry count blocks repeated paid driver attempts", async () => {
    const store = createMemoryLeaseStore()
    const driver = fakeDriver({
      ensureHost: vi.fn(async () => {
        throw new Error("driver quota exhausted")
      }),
    })
    const manager = createSandboxManager({
      leaseStore: store,
      driver,
      retryDelayMs: () => 30_000,
      maxRetryCount: 1,
    })

    await expect(manager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({
      status: "unavailable",
      error: "driver quota exhausted",
      epoch: 1,
    })
    await expect(manager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({
      status: "unavailable",
      error: "driver quota exhausted",
      epoch: 1,
    })
    expect(driver.ensureHost).toHaveBeenCalledTimes(1)
  })

  test("capped lease allows one fresh attempt after the retry-cap cooldown", async () => {
    let now = 100_000
    const store = createMemoryLeaseStore()
    let fail = true
    const driver = fakeDriver({
      ensureHost: vi.fn(async (input) => {
        if (fail) throw new Error("driver quota exhausted")
        return {
          sandboxId: "sandbox_fresh",
          url: "https://runtime.test/fresh",
          hostId: "host_fresh",
          labels: input.labels,
        }
      }),
    })
    const manager = createSandboxManager({
      leaseStore: store,
      driver,
      now: () => now,
      maxRetryCount: 1,
      retryCapCooldownMs: 10_000,
    })

    await expect(manager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({
      status: "unavailable",
      retryAfterMs: 10_000,
      error: "driver quota exhausted",
      epoch: 1,
    })
    // Inside the cooldown: no paid driver attempt.
    now += 5_000
    await expect(manager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({
      status: "unavailable",
      retryAfterMs: 5_000,
      epoch: 1,
    })
    expect(driver.ensureHost).toHaveBeenCalledTimes(1)
    // Cooldown elapsed: one fresh attempt is allowed and succeeds.
    now += 5_001
    fail = false
    await expect(manager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({
      status: "ready",
      sandboxId: "sandbox_fresh",
      epoch: 2,
    })
    expect(driver.ensureHost).toHaveBeenCalledTimes(2)
  })

  test("legacy capped lease without a cooldown timestamp stays unavailable until released", async () => {
    const store = createMemoryLeaseStore([
      sandboxLease({
        workspaceId: "ws_1",
        status: "unavailable",
        epoch: 2,
        retryCount: 5,
        lastError: "driver quota exhausted",
      }),
    ])
    const driver = fakeDriver()
    const manager = createSandboxManager({
      leaseStore: store,
      driver,
      maxRetryCount: 1,
    })

    await expect(manager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({
      status: "unavailable",
      error: "driver quota exhausted",
      epoch: 2,
    })
    expect(driver.ensureHost).not.toHaveBeenCalled()

    await expect(manager.release("ws_1")).resolves.toEqual({ released: true })
    await expect(manager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({
      status: "ready",
      epoch: 1,
    })
    expect(driver.ensureHost).toHaveBeenCalledTimes(1)
  })

  test("target resolves only from a ready lease with host and runtime URL", async () => {
    const store = createMemoryLeaseStore([
      sandboxLease({
        workspaceId: "ws_ready",
        status: "ready",
        sandboxId: "sandbox_ready",
        url: "https://runtime.test/ws_ready",
        hostId: "host_ready",
      }),
      sandboxLease({
        workspaceId: "ws_partial",
        status: "ready",
        sandboxId: "sandbox_partial",
      }),
    ])
    const manager = createSandboxManager({ leaseStore: store, driver: fakeDriver() })

    await expect(manager.target("ws_ready")).resolves.toMatchObject({
      status: "ready",
      url: "https://runtime.test/ws_ready",
      hostId: "host_ready",
    })
    await expect(manager.target("ws_partial")).resolves.toMatchObject({
      status: "unavailable",
      reason: "runtime_lease_not_ready",
    })
  })

  test("register records the sandbox target and heartbeat timestamps on the current epoch", async () => {
    const store = createMemoryLeaseStore([
      sandboxLease({
        workspaceId: "ws_1",
        status: "acquiring",
        epoch: 3,
      }),
    ])
    const manager = createSandboxManager({
      leaseStore: store,
      driver: fakeDriver(),
      now: () => 50_000,
    })

    await expect(
      manager.register("ws_1", {
        ok: true,
        status: "ready",
        epoch: 3,
        sandboxId: "sandbox_1",
        url: "https://runtime.test/ws_1",
        active: true,
        now: 12_345,
      }),
    ).resolves.toEqual({ ok: true, status: "ready" })

    await expect(manager.target("ws_1")).resolves.toMatchObject({
      status: "ready",
      sandboxId: "sandbox_1",
      url: "https://runtime.test/ws_1",
      hostId: "sandbox_1",
      epoch: 3,
    })
    await expect(store.get("ws_1")).resolves.toMatchObject({
      status: "ready",
      lastHeartbeatAt: 12_345,
      lastActivityAt: 12_345,
    })
  })

  test("register only accepts canonical url input", async () => {
    const store = createMemoryLeaseStore([
      sandboxLease({
        workspaceId: "ws_url",
        status: "acquiring",
        epoch: 3,
      }),
    ])
    const manager = createSandboxManager({ leaseStore: store, driver: fakeDriver() })

    await expect(
      manager.register("ws_url", {
        ok: true,
        status: "ready",
        epoch: 3,
        sandboxId: "sandbox_url",
        url: "https://runtime.test/canonical",
      }),
    ).resolves.toEqual({ ok: true, status: "ready" })

    await expect(manager.target("ws_url")).resolves.toMatchObject({
      status: "ready",
      sandboxId: "sandbox_url",
      url: "https://runtime.test/canonical",
    })
    await expect(store.get("ws_url")).resolves.not.toHaveProperty("runtimeUrl")
  })

  test("heartbeat rejects stale epochs without mutating the serving target", async () => {
    const store = createMemoryLeaseStore([
      sandboxLease({
        workspaceId: "ws_1",
        status: "ready",
        epoch: 4,
        sandboxId: "sandbox_1",
        url: "https://runtime.test/ws_1",
        hostId: "host_1",
        lastHeartbeatAt: 1_000,
      }),
    ])
    const manager = createSandboxManager({ leaseStore: store, driver: fakeDriver() })

    await expect(
      manager.heartbeat("ws_1", {
        ok: true,
        epoch: 3,
        url: "https://runtime.test/stale",
        now: 9_999,
      }),
    ).resolves.toEqual({ ok: false, reason: "runtime_lease_epoch_mismatch" })

    await expect(store.get("ws_1")).resolves.toMatchObject({
      epoch: 4,
      lastHeartbeatAt: 1_000,
    })
  })

  test("stop and destroy call the driver and update the current lease epoch", async () => {
    const store = createMemoryLeaseStore([
      sandboxLease({
        workspaceId: "ws_stop",
        status: "ready",
        epoch: 4,
        sandboxId: "sandbox_stop",
        url: "https://runtime.test/stop",
        hostId: "host_stop",
      }),
      sandboxLease({
        workspaceId: "ws_destroy",
        status: "ready",
        epoch: 9,
        sandboxId: "sandbox_destroy",
        url: "https://runtime.test/destroy",
        hostId: "host_destroy",
      }),
    ])
    const driver = fakeDriver({
      stop: vi.fn(async () => {}),
      destroy: vi.fn(async () => {}),
    })
    const manager = createSandboxManager({ leaseStore: store, driver })

    await expect(manager.stop("ws_stop")).resolves.toEqual({ ok: true, status: "stopped" })
    await expect(manager.destroy("ws_destroy")).resolves.toEqual({ ok: true, status: "destroyed" })

    expect(driver.stop).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sandbox_stop",
        hostId: "host_stop",
        epoch: 4,
      }),
    )
    expect(driver.destroy).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sandbox_destroy",
        hostId: "host_destroy",
        epoch: 9,
      }),
    )
    await expect(store.get("ws_stop")).resolves.toMatchObject({ status: "stopped", epoch: 4 })
    await expect(store.get("ws_destroy")).resolves.toMatchObject({ status: "destroyed", epoch: 9 })
  })

  test("snapshot resolves the canonical ready target before calling the driver", async () => {
    const store = createMemoryLeaseStore([
      sandboxLease({
        workspaceId: "ws_1",
        status: "ready",
        epoch: 3,
        sandboxId: "sandbox_1",
        url: "https://runtime.test/ws_1",
        hostId: "host_1",
      }),
    ])
    const driver = fakeDriver({
      snapshot: vi.fn(async () => ({ snapshotId: "snap_1" })),
    })
    const manager = createSandboxManager({ leaseStore: store, driver })

    await expect(manager.snapshot("ws_1")).resolves.toEqual({ ok: true, snapshotId: "snap_1" })
    expect(driver.snapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_1",
        sandboxId: "sandbox_1",
        url: "https://runtime.test/ws_1",
        hostId: "host_1",
        epoch: 3,
      }),
    )
  })

  test("custom appLabel stamps provisioned sandboxes and scopes garbage collection", async () => {
    const store = createMemoryLeaseStore()
    const claxedoLabeled = {
      sandboxId: "sandbox_claxedo",
      url: "https://runtime.test/claxedo",
      hostId: "host_claxedo",
      labels: { app: "claxedo", workspaceId: "ws_other", epoch: "1" },
    }
    let ensured: { labels?: Record<string, string> } | undefined
    const driver = fakeDriver({
      ensureHost: vi.fn(async (input) => {
        ensured = input
        return {
          sandboxId: `sandbox_${input.workspaceId}`,
          url: `https://runtime.test/${input.workspaceId}`,
          hostId: `host_${input.workspaceId}`,
          labels: input.labels,
        }
      }),
      list: vi.fn(async () => [claxedoLabeled]),
      destroy: vi.fn(async () => {}),
    })
    const manager = createSandboxManager({
      leaseStore: store,
      driver,
      appLabel: "acme",
    })

    await manager.ensure("ws_1", { homeRegion: "us-east" })
    expect(ensured?.labels?.app).toBe("acme")

    // GC under a custom app label must never touch another product's sandboxes
    // — even ones carrying the historical default label.
    await expect(manager.garbageCollect()).resolves.toMatchObject({
      destroyed: [],
      skipped: [{ target: claxedoLabeled, reason: "unmanaged_app_label" }],
    })
    expect(driver.destroy).not.toHaveBeenCalled()
  })

  test("garbage collection destroys driver runtimes whose labels do not match live leases", async () => {
    const live = {
      sandboxId: "sandbox_live",
      url: "https://runtime.test/live",
      hostId: "host_live",
      labels: { app: "claxedo", workspaceId: "ws_live", epoch: "2" },
    }
    const stale = {
      sandboxId: "sandbox_stale",
      url: "https://runtime.test/stale",
      hostId: "host_stale",
      labels: { app: "claxedo", workspaceId: "ws_live", epoch: "1" },
    }
    const orphan = {
      sandboxId: "sandbox_orphan",
      url: "https://runtime.test/orphan",
      hostId: "host_orphan",
      labels: { app: "claxedo", workspaceId: "ws_orphan", epoch: "1" },
    }
    const foreign = {
      sandboxId: "sandbox_foreign",
      url: "https://runtime.test/foreign",
      hostId: "host_foreign",
      labels: { app: "other", workspaceId: "ws_live", epoch: "2" },
    }
    const unlabeled = {
      sandboxId: "sandbox_unlabeled",
      url: "https://runtime.test/unlabeled",
      hostId: "host_unlabeled",
      labels: { app: "claxedo" },
    }
    const failing = {
      sandboxId: "sandbox_failing",
      url: "https://runtime.test/failing",
      hostId: "host_failing",
      labels: { app: "claxedo", workspaceId: "ws_failing", epoch: "3" },
    }
    const driver = fakeDriver({
      list: vi.fn(async () => [live, stale, orphan, foreign, unlabeled, failing]),
      destroy: vi.fn(async (target) => {
        if (target.sandboxId === "sandbox_failing") throw new Error("driver delete failed")
      }),
    })
    const manager = createSandboxManager({
      leaseStore: createMemoryLeaseStore([
        sandboxLease({
          workspaceId: "ws_live",
          epoch: 2,
          status: "ready",
          sandboxId: "sandbox_live",
          url: "https://runtime.test/live",
          hostId: "host_live",
          labels: live.labels,
        }),
      ]),
      driver,
    })

    await expect(manager.garbageCollect()).resolves.toMatchObject({
      kept: [live],
      destroyed: [stale, orphan],
      skipped: [
        { target: foreign, reason: "unmanaged_app_label" },
        { target: unlabeled, reason: "missing_runtime_labels" },
      ],
      failed: [{ target: failing, error: "driver delete failed" }],
    })
    expect(driver.destroy).toHaveBeenCalledWith(stale)
    expect(driver.destroy).toHaveBeenCalledWith(orphan)
    expect(driver.destroy).not.toHaveBeenCalledWith(live)
  })

  test("garbage collection keeps in-flight provisioning runtimes for the current acquiring epoch", async () => {
    const provisioning = {
      sandboxId: "sandbox_provisioning",
      url: "https://runtime.test/provisioning",
      hostId: "host_provisioning",
      labels: { app: "claxedo", workspaceId: "ws_acquiring", epoch: "3" },
    }
    const previousEpoch = {
      sandboxId: "sandbox_previous",
      url: "https://runtime.test/previous",
      hostId: "host_previous",
      labels: { app: "claxedo", workspaceId: "ws_acquiring", epoch: "2" },
    }
    const driver = fakeDriver({
      list: vi.fn(async () => [provisioning, previousEpoch]),
      destroy: vi.fn(async () => {}),
    })
    const manager = createSandboxManager({
      leaseStore: createMemoryLeaseStore([
        sandboxLease({
          workspaceId: "ws_acquiring",
          epoch: 3,
          status: "acquiring",
          // No sandbox/host identity yet: the driver is still provisioning.
          sandboxId: undefined,
          hostId: undefined,
        }),
      ]),
      driver,
    })

    await expect(manager.garbageCollect()).resolves.toMatchObject({
      kept: [provisioning],
      destroyed: [previousEpoch],
      skipped: [],
      failed: [],
    })
    expect(driver.destroy).not.toHaveBeenCalledWith(provisioning)
  })

  test("brokered secrets fail closed on a driver that cannot broker (none)", async () => {
    const driver = fakeDriver({ metadata: { secretBrokering: "none" } as never })
    const manager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })

    const result = await manager.ensure("ws_1", {
      homeRegion: "us-east",
      secrets: [{ name: "NOTION_TOKEN", value: "ntn-secret", hosts: ["api.notion.com"] }],
    })

    expect(result).toMatchObject({ status: "unavailable", error: "secret_brokering_unsupported" })
    // The driver was never asked to provision — no chance to leak the secret.
    expect(driver.ensureHost).not.toHaveBeenCalled()
  })

  test("brokered secrets are passed through for both native and proxy drivers", async () => {
    for (const brokering of ["native", "proxy"] as const) {
      const driver = fakeDriver({ metadata: { secretBrokering: brokering } as never })
      const manager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })
      const result = await manager.ensure("ws_1", {
        homeRegion: "us-east",
        secrets: [{ name: "NOTION_TOKEN", value: "ntn-secret", hosts: ["api.notion.com"], header: "Authorization" }],
      })
      expect(result.status).toBe("ready")
      expect(driver.ensureHost).toHaveBeenCalled()
    }
  })

  test("brokered secrets reach the driver on its own channel, never in env or labels", async () => {
    let seen: Parameters<SandboxDriver["ensureHost"]>[0] | undefined
    const driver = fakeDriver({
      ensureHost: vi.fn(async (input) => {
        seen = input
        return {
          sandboxId: `sandbox_${input.workspaceId}`,
          url: `https://runtime.test/${input.workspaceId}`,
          hostId: `host_${input.workspaceId}`,
          labels: input.labels,
        }
      }),
    })
    const manager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })

    await manager.ensure("ws_1", {
      homeRegion: "us-east",
      env: { MODEL_KEY: "sk-model" },
      secrets: [{ name: "NOTION_TOKEN", value: "ntn-secret", hosts: ["api.notion.com"], header: "Authorization" }],
      labels: { team: "acme" },
    })

    expect(seen?.secrets).toEqual([
      { name: "NOTION_TOKEN", value: "ntn-secret", hosts: ["api.notion.com"], header: "Authorization" },
    ])
    // Secret value never leaks into the readable env map or the labels.
    expect(JSON.stringify(seen?.env)).not.toContain("ntn-secret")
    expect(JSON.stringify(seen?.labels)).not.toContain("ntn-secret")
    expect(JSON.stringify(seen?.labels)).not.toContain("NOTION_TOKEN")
    expect(seen?.env).toEqual({ MODEL_KEY: "sk-model" })
  })
})

describe("sandbox garbage collection visibility (W1)", () => {
  // POSITIVE CONTROL for the whole W1 workstream: the reaper's job is to see a
  // sandbox the lease table has no record of and destroy it. A driver that
  // cannot enumerate provider state cannot do that, which is the defect this
  // suite exists to hold shut.
  test("a driver sandbox with NO lease at all is destroyed", async () => {
    const orphan = {
      sandboxId: "sandbox_no_lease",
      url: "https://runtime.test/no-lease",
      hostId: "host_no_lease",
      labels: { app: "claxedo", workspaceId: "ws_no_lease", epoch: "1" },
    }
    const driver = fakeDriver({
      list: vi.fn(async () => [orphan]),
      destroy: vi.fn(async () => {}),
    })
    const manager = createSandboxManager({
      // Empty lease store: nothing in the lease store ever knew about this sandbox.
      leaseStore: createMemoryLeaseStore(),
      driver,
    })

    const result = await manager.garbageCollect()

    expect(result.destroyed).toEqual([orphan])
    expect(result.listingUnsupported).toBeUndefined()
    expect(driver.destroy).toHaveBeenCalledWith(orphan)
  })

  test("a driver that cannot list reports listingUnsupported instead of empty success", async () => {
    // No `list` — the pre-W1 Daytona and Cloudflare drivers. Four empty arrays
    // are indistinguishable from "swept, found nothing", which is exactly the
    // silent success finding B1 is about.
    const driver = fakeDriver({ destroy: vi.fn(async () => {}) })
    const manager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })

    const result = await manager.garbageCollect()

    expect(result.listingUnsupported).toBe(true)
    expect(result.driver).toBe("test-driver")
    expect(result).toMatchObject({ destroyed: [], kept: [], skipped: [], failed: [] })
  })

  test("a driver that can list never claims listingUnsupported", async () => {
    const driver = fakeDriver({ list: vi.fn(async () => []) })
    const manager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })

    await expect(manager.garbageCollect()).resolves.not.toHaveProperty("listingUnsupported", true)
  })
})
