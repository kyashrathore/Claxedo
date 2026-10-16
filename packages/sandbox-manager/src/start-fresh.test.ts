import { describe, expect, test, vi } from "vitest"
import {
  createSandboxManager,
  SandboxCheckpointUnusableError,
  sandboxRuntimeBootFailure,
  sandboxStartFailureReason,
  type SandboxDriver,
  type SandboxLifecycleEvent,
  type SandboxPersistenceCapabilities,
} from "."
import { createMemoryLeaseStore } from "./stores/memory"

const EXPIRED = "This workspace's saved files expired after 30 days unused; choose Start fresh."

const FILESYSTEM: SandboxPersistenceCapabilities = {
  resume: "replacement-restore",
  capture: "filesystem",
  clone: false,
  captureSource: "preserved",
  retention: "provider-managed",
  restoreMount: "new-resource",
}

const CHECKPOINT = {
  id: "chk_1",
  providerReference: "snap_expired",
  sourceEpoch: 1,
  capturedAt: 1,
  metadata: { scope: "filesystem", sourceBehavior: "preserved", restoreMount: "new-resource" },
} as const

function snapshotDriver(persistence: SandboxPersistenceCapabilities = FILESYSTEM) {
  const driver = {
    id: "test-snapshots",
    metadata: {
      driverRunsIn: ["node"],
      hostStopBehavior: "terminates-host",
      hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "native",
      egressControl: "hosts-and-cidrs",
      persistence,
    },
    ensureHost: vi.fn(async (input) => {
      if (input.bootSource?.kind === "driver-snapshot") throw new SandboxCheckpointUnusableError("expired", EXPIRED)
      return { sandboxId: "sandbox_1", url: "https://runtime.test/fresh", hostId: "host_1", labels: input.labels }
    }),
    stop: vi.fn(async () => {}),
  } satisfies SandboxDriver
  return driver
}

async function expiredWorkspace(persistence?: SandboxPersistenceCapabilities) {
  let now = 10_000
  const store = createMemoryLeaseStore()
  const driver = snapshotDriver(persistence)
  const events: SandboxLifecycleEvent[] = []
  const manager = createSandboxManager({ leaseStore: store, driver, now: () => now, retryDelayMs: () => 5_000, onLifecycle: (event) => events.push(event) })
  await manager.ensure("ws_1", { homeRegion: "us-east" })
  await store.update("ws_1", 1, { status: "stopped", checkpoint: CHECKPOINT })
  return { store, driver, manager, events, advance: (ms: number) => { now += ms } }
}

describe("a workspace whose checkpoint the provider no longer holds", () => {
  test("its wake is refused in the driver's one line, as a boot that cannot heal by retrying, and never boots the image in its place", async () => {
    const { store, driver, manager, events, advance } = await expiredWorkspace()

    const refused = await manager.ensure("ws_1", { homeRegion: "us-east" })
    expect(refused).toMatchObject({ status: "unavailable", error: `checkpoint_unusable:expired: ${EXPIRED}` })
    expect(sandboxStartFailureReason(`checkpoint_unusable:expired: ${EXPIRED}`)).toBe(EXPIRED)
    expect(sandboxRuntimeBootFailure(`checkpoint_unusable:expired: ${EXPIRED}`)).toBe(EXPIRED)
    await expect(manager.target("ws_1")).resolves.toMatchObject({
      status: "unavailable",
      failure: { kind: "checkpoint_unusable", cause: "expired", message: EXPIRED, retrying: false },
    })
    expect(driver.stop).toHaveBeenCalledTimes(1)
    expect(events.at(-1)).toMatchObject({ kind: "failed", bootFailed: true, checkpointUnusable: "expired", retrying: false })

    advance(5_001)
    await expect(manager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({ status: "unavailable", error: `checkpoint_unusable:expired: ${EXPIRED}` })
    expect(driver.ensureHost.mock.calls.slice(1).map(([input]) => input.bootSource)).toEqual([
      { kind: "driver-snapshot", snapshotId: "snap_expired" },
      { kind: "driver-snapshot", snapshotId: "snap_expired" },
    ])
    await expect(store.get("ws_1")).resolves.toMatchObject({ checkpoint: { id: "chk_1" } })
  })

  test("Start fresh drops the checkpoint and the failure it caused, and the next start boots the image", async () => {
    const { store, driver, manager, events } = await expiredWorkspace()
    await manager.ensure("ws_1", { homeRegion: "us-east" })

    await expect(manager.startFresh("ws_1")).resolves.toEqual({ ok: true, status: "stopped" })
    const lease = await store.get("ws_1")
    expect(lease).toMatchObject({ status: "stopped", retryCount: 0 })
    expect(lease?.checkpoint).toBeUndefined()
    expect(lease?.restore).toBeUndefined()
    expect(lease?.lastError).toBeUndefined()
    expect(lease?.nextRetryAt).toBeUndefined()
    expect(events.at(-1)).toMatchObject({ kind: "startedFresh", workspaceId: "ws_1", driver: "test-snapshots", checkpointUnusable: "expired" })

    await expect(manager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({ status: "ready", url: "https://runtime.test/fresh" })
    expect(driver.ensureHost).toHaveBeenLastCalledWith(expect.objectContaining({ bootSource: { kind: "default" } }))
  })

  test("Start fresh on a stopped workspace whose checkpoint is still held drops it too, and names no cause", async () => {
    const { store, manager, events } = await expiredWorkspace()

    await expect(manager.startFresh("ws_1")).resolves.toEqual({ ok: true, status: "stopped" })
    expect((await store.get("ws_1"))?.checkpoint).toBeUndefined()
    expect(events.at(-1)).toMatchObject({ kind: "startedFresh" })
    expect(events.at(-1)).not.toHaveProperty("checkpointUnusable")
  })

  test("Start fresh is refused while the workspace runs or boots, and keeps its checkpoint", async () => {
    const { store, manager, events } = await expiredWorkspace()
    await store.update("ws_1", 1, { status: "ready" })
    await expect(manager.startFresh("ws_1")).resolves.toEqual({ ok: false, reason: "workspace_running" })
    await store.update("ws_1", 1, { status: "acquiring" })
    await expect(manager.startFresh("ws_1")).resolves.toEqual({ ok: false, reason: "workspace_running" })
    await expect(store.get("ws_1")).resolves.toMatchObject({ checkpoint: { id: "chk_1" } })
    expect(events.some((event) => event.kind === "startedFresh")).toBe(false)
  })

  test("Start fresh is refused while a provider failure's retry is still ahead, since that start is still running", async () => {
    const { store, manager } = await expiredWorkspace()
    await store.update("ws_1", 1, { status: "unavailable", lastError: "provider_failed: test-snapshots: 502", nextRetryAt: 70_000 })
    await expect(manager.startFresh("ws_1")).resolves.toEqual({ ok: false, reason: "workspace_running" })
  })

  test("Start fresh is refused where a checkpoint is the host itself or there is none to drop", async () => {
    const boat = await expiredWorkspace({ resume: "same-sandbox", capture: "none", clone: false, captureSource: "not-applicable", retention: "provider-managed", restoreMount: "same-resource" })
    await expect(boat.manager.startFresh("ws_1")).resolves.toEqual({ ok: false, reason: "start_fresh_unsupported" })
    const docker = await expiredWorkspace({ resume: "replacement-restore", capture: "same-resource", clone: false, captureSource: "preserved", retention: "provider-managed", restoreMount: "same-resource" })
    await expect(docker.manager.startFresh("ws_1")).resolves.toEqual({ ok: false, reason: "start_fresh_unsupported" })
    await expect(docker.store.get("ws_1")).resolves.toMatchObject({ checkpoint: { id: "chk_1" } })
  })

  test("Start fresh on a workspace with no lease is refused", async () => {
    const { manager } = await expiredWorkspace()
    await expect(manager.startFresh("ws_other")).resolves.toEqual({ ok: false, reason: "runtime_lease_missing" })
  })
})
