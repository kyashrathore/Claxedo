/**
 * Cross-driver SandboxLeasePatch equivalence: the memory, SQLite, and Convex lease
 * stores must apply identical merge semantics — absent/`undefined` keeps the
 * stored value, explicit `null` clears it (plan §8). The ready transition in
 * the SandboxManager relies on this to clear `nextRetryAt`/`lastError`
 * identically regardless of which driver backs the control plane.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { getFunctionName } from "convex/server"
import type { SandboxLeaseStore, SandboxLease } from "@claxedo/sandbox-manager"
import { createMemoryLeaseStore } from "@claxedo/sandbox-manager/stores/memory"
import { createConvexLeaseStore } from "./convex"
import { createSqliteLeaseStore } from "./sqlite"
import { ClaxedoDB } from "../../platform/db/db"
import { deleteLease, getLease, upsertLease } from "./lease.sql"
import * as convexSandboxLeases from "../../../../../convex/sandboxLeases"

const root = path.join(realpathSync(os.tmpdir()), `lease-store-equivalence-${randomUUID().slice(0, 8)}`)
const prev = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
  CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN,
}

// ClaxedoDB opens lazily on first use, so setting the env vars at module load
// (before any test body runs) is enough to keep the database in the temp dir.
process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")
process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"

beforeAll(async () => {
  await fs.mkdir(root, { recursive: true })
})

afterAll(async () => {
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true })
  process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_STATE_DIR = prev.CLAXEDO_STATE_DIR
  if (prev.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN === undefined) {
    delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
  } else {
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = prev.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
  }
})

type Row = Record<string, unknown> & { _id: string; workspace_id: string }

function fakeConvexDb(seed: Row[] = []) {
  const rows = new Map(seed.map((row) => [row._id, { ...row }]))
  const byWorkspaceId = (workspaceId: string) => [...rows.values()].find((row) => row.workspace_id === workspaceId) ?? null
  return {
    query: vi.fn(() => ({
      withIndex: vi.fn((_name: string, build: (q: unknown) => { value: string }) => {
        const query = { eq: vi.fn((_field: string, value: string) => ({ value })) }
        const result = build(query)
        return {
          first: vi.fn(async () => byWorkspaceId(result.value)),
        }
      }),
      collect: vi.fn(async () => [...rows.values()]),
    })),
    insert: vi.fn(async (_table: string, value: Record<string, unknown>) => {
      const id = `lease_${rows.size + 1}`
      rows.set(id, { _id: id, ...value } as Row)
      return id
    }),
    patch: vi.fn(async (id: string, value: Record<string, unknown>) => {
      rows.set(id, { ...rows.get(id), ...value } as Row)
    }),
    replace: vi.fn(async (id: string, value: Record<string, unknown>) => {
      rows.set(id, { _id: id, ...value } as Row)
    }),
    delete: vi.fn(async (id: string) => {
      rows.delete(id)
    }),
  }
}

function createConvexBackedStore(): SandboxLeaseStore {
  const db = fakeConvexDb()
  const handlers = new Map<string, (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>>(
    Object.entries(convexSandboxLeases).map(([name, fn]) => [
      `sandboxLeases:${name}`,
      (fn as unknown as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler,
    ]),
  )
  const run = (fn: unknown, args: Record<string, unknown>) => {
    const handler = handlers.get(getFunctionName(fn as never))
    if (!handler) throw new Error(`unknown convex function: ${getFunctionName(fn as never)}`)
    return handler({ db }, args)
  }
  return createConvexLeaseStore({
    token: "svc_secret",
    executor: { query: run, mutation: run },
  })
}

function sqliteLease(input: Partial<Parameters<typeof upsertLease>[0]> & { workspace_id: string }): Parameters<typeof upsertLease>[0] {
  return {
    workspace_id: input.workspace_id,
    lease_id: input.lease_id ?? `${input.workspace_id}:1`,
    home_region: input.home_region ?? "us-east",
    epoch: input.epoch ?? 1,
    status: input.status ?? "ready",
    driver: input.driver ?? "daytona",
    driver_resource_id: input.driver_resource_id ?? null,
    driver_snapshot_id: input.driver_snapshot_id ?? null,
    sandbox_id: input.sandbox_id ?? null,
    url: input.url ?? null,
    retry_count: input.retry_count ?? 0,
    next_retry_at: input.next_retry_at ?? null,
    last_heartbeat_at: input.last_heartbeat_at ?? null,
    last_activity_at: input.last_activity_at ?? null,
    last_health_failure_at: input.last_health_failure_at ?? null,
    last_error: input.last_error ?? null,
    compute_class: input.compute_class ?? null,
    accel_base_image_id: input.accel_base_image_id ?? null,
    accel_prepared_image_id: input.accel_prepared_image_id ?? null,
    accel_snapshot_id: input.accel_snapshot_id ?? null,
    labels: input.labels ?? null,
    checkpoint: input.checkpoint ?? null,
    persistence: input.persistence ?? null,
    restore: input.restore ?? null,
    created_at: input.created_at ?? 1_000,
    updated_at: input.updated_at ?? 1_000,
  }
}

/**
 * The fields the SandboxLeasePatch fix is about. `hostId` is intentionally excluded:
 * the SQLite driver back-fills it from the legacy `lease_id` column before the
 * manager assigns one, which is a known mapping difference, not a patch
 * semantics difference.
 */
function project(lease: SandboxLease | undefined) {
  if (!lease) return undefined
  return {
    workspaceId: lease.workspaceId,
    status: lease.status,
    epoch: lease.epoch,
    retryCount: lease.retryCount,
    sandboxId: lease.sandboxId,
    url: lease.url,
    nextRetryAt: lease.nextRetryAt,
    lastError: lease.lastError,
    lastHeartbeatAt: lease.lastHeartbeatAt,
    lastActivityAt: lease.lastActivityAt,
    labels: lease.labels,
    checkpoint: lease.checkpoint,
    persistence: lease.persistence,
    restore: lease.restore,
  }
}

function resumeProject(lease: SandboxLease | undefined) {
  if (!lease) return undefined
  return {
    ...project(lease),
    url: lease.url,
    hostId: lease.hostId,
    driverResourceId: lease.driverResourceId,
  }
}

async function runScenario(store: SandboxLeaseStore) {
  const acquired = await store.acquire("ws_eq", {
    homeRegion: "us-east",
    driver: "test-driver",
    staleAfterMs: 60_000,
    now: 1_000,
  })
  const failed = await store.recordFailure("ws_eq", 1, "driver exploded", 9_000)
  // Patch omitting nextRetryAt/lastError: both must be KEPT.
  const kept = await store.update("ws_eq", 1, { status: "acquiring" })
  // Ready transition with explicit null: both must be CLEARED.
  const cleared = await store.update("ws_eq", 1, {
    status: "ready",
    sandboxId: "sandbox_eq",
    url: "https://runtime.test/eq",
    hostId: "host_eq",
    retryCount: 0,
    nextRetryAt: null,
    lastError: null,
    lastHeartbeatAt: 12_000,
    lastActivityAt: 12_000,
    labels: { image: "runtime:test", runtimeVersion: "0.6.0" },
  })
  const final = await store.get("ws_eq")
  return {
    acquired: acquired.acquired,
    acquiredLease: project(acquired.lease),
    failed: project(failed),
    kept: project(kept),
    cleared: project(cleared),
    final: project(final),
  }
}

/**
 * Failure → retry-cap cooldown → re-acquire: the epoch bump must build a FRESH
 * lease in every driver. Convex used to patch over the previous row, retaining
 * stale sandbox_id/url/next_retry_at/last_error from the dead epoch.
 */
async function runEpochBumpScenario(store: SandboxLeaseStore) {
  await store.acquire("ws_bump", {
    homeRegion: "us-east",
    driver: "test-driver",
    staleAfterMs: 60_000,
    now: 1_000,
  })
  await store.update("ws_bump", 1, {
    status: "ready",
    sandboxId: "sandbox_old",
    url: "https://runtime.test/old",
    hostId: "host_old",
    retryCount: 0,
    nextRetryAt: null,
    lastError: null,
  })
  // The serving runtime fails; the manager records the retry-cap cooldown.
  const failed = await store.recordFailure("ws_bump", 1, "driver exploded", 600_000)
  // Cooldown elapsed: re-acquire bumps the epoch.
  const reacquired = await store.acquire("ws_bump", {
    homeRegion: "us-east",
    driver: "test-driver",
    staleAfterMs: 60_000,
    now: 700_000,
  })
  const final = await store.get("ws_bump")
  return {
    failed: project(failed),
    reacquired: reacquired.acquired,
    reacquiredLease: project(reacquired.lease),
    final: project(final),
  }
}

async function runStoppedResumeScenario(store: SandboxLeaseStore) {
  await store.acquire("ws_resume", {
    homeRegion: "us-east",
    driver: "test-driver",
    staleAfterMs: 60_000,
    now: 1_000,
  })
  await store.update("ws_resume", 1, {
    status: "ready",
    sandboxId: "sandbox_resume",
    url: "https://runtime.test/resume",
    hostId: "host_resume",
    driverResourceId: "driver_resource_resume",
    retryCount: 0,
    nextRetryAt: null,
    lastError: null,
    lastHeartbeatAt: 2_000,
    lastActivityAt: 2_000,
  })
  await store.update("ws_resume", 1, { status: "stopped" })
  const reacquired = await store.acquire("ws_resume", {
    homeRegion: "us-east",
    driver: "test-driver",
    staleAfterMs: 60_000,
    now: 5_000,
  })
  const final = await store.get("ws_resume")
  return {
    reacquired: reacquired.acquired,
    reacquiredLease: resumeProject(reacquired.lease),
    final: resumeProject(final),
  }
}

async function runPersistenceScenario(store: SandboxLeaseStore) {
  const persistence = {
    resume: "replacement-restore",
    capture: "filesystem",
    clone: false,
    captureSource: "preserved",
    retention: "explicit",
    restoreMount: "new-resource",
  } as const
  const checkpoint = {
    id: "checkpoint_1",
    providerReference: "provider_snapshot_1",
    sourceEpoch: 4,
    capturedAt: 10_000,
    metadata: {
      scope: "filesystem",
      sourceBehavior: "preserved",
      retentionExpiresAt: 90_000,
      restoreMount: "new-resource",
    },
  } as const
  const restore = {
    state: "pending",
    checkpointId: checkpoint.id,
    sourceEpoch: checkpoint.sourceEpoch,
    requestedAt: 11_000,
  } as const
  const acquired = await store.acquire("ws_persistence", {
    homeRegion: "us-east",
    driver: "test-driver",
    staleAfterMs: 60_000,
    now: 1_000,
  })
  await store.update("ws_persistence", acquired.lease.epoch, {
    status: "ready",
    checkpoint,
    persistence,
    restore,
  })
  await store.update("ws_persistence", acquired.lease.epoch, { status: "unavailable" })
  const reacquired = await store.acquire("ws_persistence", {
    homeRegion: "us-east",
    driver: "test-driver",
    staleAfterMs: 60_000,
    now: 70_000,
  })
  return project(reacquired.lease)
}

describe("lease store SandboxLeasePatch equivalence", () => {
  test("memory, sqlite, and convex drivers keep on absent and clear on null identically", async () => {
    const memory = await runScenario(createMemoryLeaseStore())
    const sqlite = await runScenario(createSqliteLeaseStore())
    const convex = await runScenario(createConvexBackedStore())

    // The intermediate failure state is preserved by a patch that omits the
    // retry fields…
    expect(memory.kept).toMatchObject({
      status: "acquiring",
      nextRetryAt: 9_000,
      lastError: "driver exploded",
      retryCount: 1,
    })
    // …and explicitly cleared by the ready transition.
    expect(memory.final).toMatchObject({
      status: "ready",
      sandboxId: "sandbox_eq",
      retryCount: 0,
      labels: { image: "runtime:test", runtimeVersion: "0.6.0" },
    })
    expect(memory.final?.nextRetryAt).toBeUndefined()
    expect(memory.final?.lastError).toBeUndefined()

    expect(sqlite).toEqual(memory)
    expect(convex).toEqual(memory)
  })

  test("an epoch bump after failure → retry-cap cooldown builds an identical FRESH lease in all drivers", async () => {
    const memory = await runEpochBumpScenario(createMemoryLeaseStore())
    const sqlite = await runEpochBumpScenario(createSqliteLeaseStore())
    const convex = await runEpochBumpScenario(createConvexBackedStore())

    // The demoted epoch-1 lease carries the failure state and the old target…
    expect(memory.failed).toMatchObject({
      status: "unavailable",
      epoch: 1,
      retryCount: 1,
      sandboxId: "sandbox_old",
      url: "https://runtime.test/old",
      nextRetryAt: 600_000,
      lastError: "driver exploded",
    })
    // …and the re-acquired epoch-2 lease is FRESH: no stale runtime identity,
    // no stale retry timing or error from the dead epoch.
    expect(memory.reacquired).toBe(true)
    expect(memory.final).toMatchObject({ status: "acquiring", epoch: 2, retryCount: 1 })
    for (const projection of [memory.reacquiredLease, memory.final]) {
      expect(projection?.sandboxId).toBeUndefined()
      expect(projection?.url).toBeUndefined()
      expect(projection?.nextRetryAt).toBeUndefined()
      expect(projection?.lastError).toBeUndefined()
    }

    expect(sqlite).toEqual(memory)
    expect(convex).toEqual(memory)
  })

  test("an epoch bump from stopped preserves the target identity for driver resume", async () => {
    const memory = await runStoppedResumeScenario(createMemoryLeaseStore())
    const sqlite = await runStoppedResumeScenario(createSqliteLeaseStore())
    const convex = await runStoppedResumeScenario(createConvexBackedStore())

    expect(memory.reacquired).toBe(true)
    for (const projection of [memory.reacquiredLease, memory.final]) {
      expect(projection).toMatchObject({
        status: "acquiring",
        epoch: 2,
        sandboxId: "sandbox_resume",
        url: "https://runtime.test/resume",
        hostId: "host_resume",
        driverResourceId: "driver_resource_resume",
        lastHeartbeatAt: 2_000,
        lastActivityAt: 2_000,
      })
      expect(projection?.nextRetryAt).toBeUndefined()
      expect(projection?.lastError).toBeUndefined()
    }

    expect(sqlite).toEqual(memory)
    expect(convex).toEqual(memory)
  })

  test("checkpoint and persistence state survive replacement epoch acquisition identically", async () => {
    const memory = await runPersistenceScenario(createMemoryLeaseStore())
    const sqlite = await runPersistenceScenario(createSqliteLeaseStore())
    const convex = await runPersistenceScenario(createConvexBackedStore())

    expect(memory).toMatchObject({
      epoch: 2,
      status: "acquiring",
      checkpoint: {
        id: "checkpoint_1",
        providerReference: "provider_snapshot_1",
        sourceEpoch: 4,
        metadata: {
          scope: "filesystem",
          retentionExpiresAt: 90_000,
        },
      },
      persistence: {
        resume: "replacement-restore",
        capture: "filesystem",
      },
      restore: {
        state: "pending",
        checkpointId: "checkpoint_1",
        sourceEpoch: 4,
      },
    })
    expect(sqlite).toEqual(memory)
    expect(convex).toEqual(memory)
  })

  test("sqlite updates host-owned fields without clearing driver acceleration metadata", async () => {
    const workspaceId = "ws_sqlite_preserve"
    deleteLease(workspaceId)
    upsertLease(sqliteLease({
      workspace_id: workspaceId,
      lease_id: "lease_original",
      epoch: 3,
      status: "ready",
      driver: "daytona",
      driver_resource_id: "driver_resource_old",
      driver_snapshot_id: "snapshot_old",
      sandbox_id: "sandbox_old",
      url: "https://runtime.test/old",
      last_health_failure_at: 123,
      compute_class: "small",
      accel_base_image_id: "base_image",
      accel_prepared_image_id: "prepared_image",
      accel_snapshot_id: "runtime_snapshot",
    }))

    await createSqliteLeaseStore().update(workspaceId, 3, {
      status: "ready",
      sandboxId: "sandbox_new",
      url: "https://runtime.test/new",
      hostId: "host_new",
      driverResourceId: "driver_resource_new",
      lastHeartbeatAt: 2_000,
      lastActivityAt: 2_000,
    })

    expect(getLease(workspaceId)).toMatchObject({
      lease_id: "host_new",
      driver_resource_id: "driver_resource_new",
      driver_snapshot_id: "snapshot_old",
      sandbox_id: "sandbox_new",
      url: "https://runtime.test/new",
      last_heartbeat_at: 2_000,
      last_activity_at: 2_000,
      last_health_failure_at: 123,
      compute_class: "small",
      accel_base_image_id: "base_image",
      accel_prepared_image_id: "prepared_image",
      accel_snapshot_id: "runtime_snapshot",
    })
  })

  test("sqlite persists retryable failures as backoff and terminal failures as failed", async () => {
    const workspaceId = "ws_sqlite_backoff"
    deleteLease(workspaceId)
    const store = createSqliteLeaseStore()
    await store.acquire(workspaceId, {
      homeRegion: "us-east",
      driver: "test-driver",
      staleAfterMs: 60_000,
      now: 1_000,
    })

    await store.recordFailure(workspaceId, 1, "driver unavailable", 30_000)
    expect(getLease(workspaceId)).toMatchObject({
      status: "backoff",
      retry_count: 1,
      next_retry_at: 30_000,
      last_error: "driver unavailable",
      last_health_failure_at: expect.any(Number),
    })

    await store.recordFailure(workspaceId, 1, "driver disabled")
    expect(getLease(workspaceId)).toMatchObject({
      status: "failed",
      retry_count: 2,
      next_retry_at: null,
      last_error: "driver disabled",
      last_health_failure_at: expect.any(Number),
    })
  })

  test("memory, sqlite, and convex preserve the destroyed terminal state", async () => {
    const stores = [createMemoryLeaseStore(), createSqliteLeaseStore(), createConvexBackedStore()]
    const states = await Promise.all(stores.map(async (store, index) => {
      const workspaceId = `ws_destroyed_${index}`
      const acquired = await store.acquire(workspaceId, {
        homeRegion: "us-east",
        driver: "test-driver",
        staleAfterMs: 60_000,
        now: 1_000,
      })
      await store.update(workspaceId, acquired.lease.epoch, { status: "destroyed" })
      return (await store.get(workspaceId))?.status
    }))

    expect(states).toEqual(["destroyed", "destroyed", "destroyed"])
  })
})
