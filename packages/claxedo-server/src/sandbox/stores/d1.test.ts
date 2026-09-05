import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test, vi } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import { createSandboxManager, type SandboxDriver } from "@claxedo/sandbox-manager"
import type {
  SandboxCheckpointReference,
  SandboxPersistenceCapabilities,
  SandboxRestoreStatus,
} from "@claxedo/sandbox-manager"

import { createD1SandboxLeaseStore } from "./d1"

// Only the lease table: `sandbox_leases` references nothing, so the real
// migration is the whole schema this store needs.
const MIGRATIONS = ["0022_sandbox_leases.sql"]

const NOW = 1_900_000_000_000
const STALE_AFTER_MS = 30_000
const ACQUIRE = { homeRegion: "us-east", driver: "test", staleAfterMs: STALE_AFTER_MS }

const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function database(): Promise<D1Database> {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const target = await instance.getD1Database("CONTROL_PLANE_DB")
  for (const name of MIGRATIONS) {
    const path = fileURLToPath(new URL(`../../../migrations/control-plane/${name}`, import.meta.url))
    const migration = (await readFile(path, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      await target.prepare(statement).run()
    }
  }
  return target
}

async function store(now: () => number = () => NOW) {
  const target = await database()
  return { target, leaseStore: createD1SandboxLeaseStore({ database: target, now }) }
}

const checkpoint: SandboxCheckpointReference = {
  id: "cp_1",
  providerReference: "provider/cp_1",
  sourceEpoch: 1,
  capturedAt: NOW,
  metadata: { scope: "filesystem", sourceBehavior: "preserved", restoreMount: "new-resource" },
}

const persistence: SandboxPersistenceCapabilities = {
  resume: "same-sandbox",
  capture: "filesystem",
  clone: false,
  captureSource: "preserved",
  retention: "provider-managed",
  restoreMount: "new-resource",
}

const restore: SandboxRestoreStatus = {
  checkpointId: "cp_1",
  sourceEpoch: 1,
  state: "ready",
  requestedAt: NOW,
  startedAt: NOW + 1,
  completedAt: NOW + 2,
}

/**
 * Wraps a D1 database so the FIRST guarded write (`update ...`) runs only after
 * a competing writer has already bumped the row's epoch.
 *
 * That interleaving is the only way to reach the statement's own
 * `and epoch = ?` guard: on every other path the store's pre-read already sees
 * the moved epoch and returns before writing. Without this the SQL guard is
 * untested, and D1 has no transaction to fall back on — the statement IS the
 * concurrency control.
 */
function raceBeforeFirstWrite(target: D1Database, competitor: () => Promise<unknown>): D1Database {
  let armed = true
  const wrapBound = (bound: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(bound, {
      get(source, property) {
        if (property !== "run") return Reflect.get(source, property).bind(source)
        return async () => {
          if (armed) {
            armed = false
            await competitor()
          }
          return await source.run()
        }
      },
    })
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(source, property) {
        if (property !== "bind") return Reflect.get(source, property).bind(source)
        return (...values: unknown[]) => wrapBound(source.bind(...values))
      },
    })
  return new Proxy(target, {
    get(source, property) {
      if (property !== "prepare") return Reflect.get(source, property).bind(source)
      return (query: string) => {
        const statement = source.prepare(query)
        return query.trimStart().startsWith("update ") ? wrapStatement(statement) : statement
      }
    },
  })
}

function fakeDriver(): SandboxDriver {
  return {
    id: "test-provider",
    metadata: {
      driverRunsIn: ["node"],
      hostStopBehavior: "suspends-host",
      hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "none",
      egressControl: "hosts-and-cidrs",
      persistence: {
        resume: "same-sandbox",
        capture: "none",
        clone: false,
        captureSource: "not-applicable",
        retention: "not-applicable",
        restoreMount: "not-applicable",
      },
    },
    ensureHost: vi.fn(async (input) => ({
      sandboxId: `sandbox_${input.workspaceId}`,
      url: `https://runtime.test/${input.workspaceId}`,
      hostId: `host_${input.workspaceId}`,
      labels: input.labels,
    })),
  }
}

describe("d1 sandbox lease store", () => {
  test("first acquire creates epoch 1 and a second within the stale window is refused", async () => {
    const { leaseStore } = await store()

    const first = await leaseStore.acquire("ws_1", { ...ACQUIRE, now: NOW })
    expect(first).toMatchObject({ acquired: true, lease: { epoch: 1, status: "acquiring", retryCount: 0 } })
    expect(first.lease.createdAt).toBe(NOW)

    const second = await leaseStore.acquire("ws_1", { ...ACQUIRE, now: NOW + 5_000 })
    expect(second).toMatchObject({ acquired: false, retryAfterMs: 25_000, lease: { epoch: 1 } })

    // The refusal did not write: the row is still the first acquire's.
    await expect(leaseStore.get("ws_1")).resolves.toMatchObject({ epoch: 1, updatedAt: NOW })
  })

  test("a re-acquire past the stale window bumps the epoch and drops the sandbox identity", async () => {
    const { leaseStore } = await store()
    await leaseStore.acquire("ws_1", { ...ACQUIRE, now: NOW })
    await leaseStore.update("ws_1", 1, {
      sandboxId: "sandbox_a",
      url: "https://runtime.test/a",
      hostId: "host_a",
      driverResourceId: "res_a",
      lastHeartbeatAt: NOW,
      labels: { tier: "gold" },
      checkpoint,
    })

    const again = await leaseStore.acquire("ws_1", { ...ACQUIRE, now: NOW + STALE_AFTER_MS })
    expect(again.acquired).toBe(true)
    expect(again.lease).toMatchObject({ epoch: 2, status: "acquiring", createdAt: NOW })
    expect(again.lease.sandboxId).toBeUndefined()
    expect(again.lease.url).toBeUndefined()
    expect(again.lease.driverResourceId).toBeUndefined()
    expect(again.lease.lastHeartbeatAt).toBeUndefined()
    expect(again.lease.labels).toBeUndefined()
    // Checkpoint/persistence/restore are always carried, unlike the sandbox identity.
    expect(again.lease.checkpoint).toEqual(checkpoint)

    const persisted = await leaseStore.get("ws_1")
    expect(persisted).toMatchObject({ epoch: 2, checkpoint })
    expect(persisted?.sandboxId).toBeUndefined()
    expect(persisted?.labels).toBeUndefined()
  })

  test("a stopped lease resumes its sandbox identity on the next acquire", async () => {
    const { leaseStore } = await store()
    await leaseStore.acquire("ws_1", { ...ACQUIRE, now: NOW })
    await leaseStore.update("ws_1", 1, {
      status: "stopped",
      sandboxId: "sandbox_a",
      url: "https://runtime.test/a",
      hostId: "host_a",
      lastActivityAt: NOW,
      labels: { tier: "gold" },
    })

    const resumed = await leaseStore.acquire("ws_1", { ...ACQUIRE, now: NOW + 1 })
    expect(resumed).toMatchObject({
      acquired: true,
      lease: {
        epoch: 2,
        status: "acquiring",
        sandboxId: "sandbox_a",
        url: "https://runtime.test/a",
        hostId: "host_a",
        lastActivityAt: NOW,
        labels: { tier: "gold" },
      },
    })
    await expect(leaseStore.get("ws_1")).resolves.toMatchObject({ sandboxId: "sandbox_a", hostId: "host_a" })
  })

  test("a ready lease refuses with retryAfterMs 0 however long it has been ready", async () => {
    const { leaseStore } = await store()
    await leaseStore.acquire("ws_1", { ...ACQUIRE, now: NOW })
    await leaseStore.update("ws_1", 1, { status: "ready", sandboxId: "sandbox_a", url: "https://runtime.test/a" })

    const refused = await leaseStore.acquire("ws_1", { ...ACQUIRE, now: NOW + STALE_AFTER_MS * 10 })
    expect(refused).toMatchObject({ acquired: false, retryAfterMs: 0, lease: { status: "ready", epoch: 1 } })
  })

  test("update is an epoch compare-and-set: a stale epoch changes nothing", async () => {
    const { leaseStore } = await store()
    await leaseStore.acquire("ws_1", { ...ACQUIRE, now: NOW })
    await leaseStore.update("ws_1", 1, { status: "unavailable", sandboxId: "sandbox_a" })
    await leaseStore.acquire("ws_1", { ...ACQUIRE, now: NOW + STALE_AFTER_MS * 10 })

    const before = await leaseStore.get("ws_1")
    expect(before?.epoch).toBe(2)

    await expect(leaseStore.update("ws_1", 1, { status: "ready", sandboxId: "loser" })).resolves.toBeUndefined()
    await expect(leaseStore.get("ws_1")).resolves.toEqual(before)
    // An unknown workspace is a miss, not a write.
    await expect(leaseStore.update("ws_missing", 1, { status: "ready" })).resolves.toBeUndefined()
    await expect(leaseStore.get("ws_missing")).resolves.toBeUndefined()
  })

  test("update null-clears exactly the fields the patch nulls", async () => {
    const { leaseStore } = await store()
    await leaseStore.acquire("ws_1", { ...ACQUIRE, now: NOW })
    await leaseStore.update("ws_1", 1, {
      status: "unavailable",
      nextRetryAt: NOW + 1_000,
      lastError: "boom",
      checkpoint,
      persistence,
    })
    await expect(leaseStore.get("ws_1")).resolves.toMatchObject({
      nextRetryAt: NOW + 1_000,
      lastError: "boom",
      checkpoint,
      persistence,
    })

    const cleared = await leaseStore.update("ws_1", 1, { nextRetryAt: null, lastError: null, checkpoint: null })
    expect(cleared?.nextRetryAt).toBeUndefined()
    expect(cleared?.lastError).toBeUndefined()
    expect(cleared?.checkpoint).toBeUndefined()

    const persisted = await leaseStore.get("ws_1")
    expect(persisted?.nextRetryAt).toBeUndefined()
    expect(persisted?.lastError).toBeUndefined()
    expect(persisted?.checkpoint).toBeUndefined()
    // Absent keys are untouched.
    expect(persisted?.persistence).toEqual(persistence)
    expect(persisted?.status).toBe("unavailable")
  })

  test("recordFailure marks the lease unavailable, counts the retry, and stamps the health failure", async () => {
    const failedAt = NOW + 7_000
    const { target, leaseStore } = await store(() => failedAt)
    await leaseStore.acquire("ws_1", { ...ACQUIRE, now: NOW })

    const failed = await leaseStore.recordFailure("ws_1", 1, "provider quota exhausted", NOW + 60_000)
    expect(failed).toMatchObject({
      status: "unavailable",
      retryCount: 1,
      lastError: "provider quota exhausted",
      nextRetryAt: NOW + 60_000,
      updatedAt: failedAt,
    })

    // Round-trips through the stored row: `unavailable` + a retry time is `backoff`.
    const row = await target
      .prepare("select status, retry_count, last_error, last_health_failure_at from sandbox_leases where workspace_id = ?")
      .bind("ws_1")
      .first<{ status: string; retry_count: number; last_error: string; last_health_failure_at: number }>()
    expect(row).toEqual({
      status: "backoff",
      retry_count: 1,
      last_error: "provider quota exhausted",
      last_health_failure_at: failedAt,
    })
    await expect(leaseStore.get("ws_1")).resolves.toMatchObject({ status: "unavailable", retryCount: 1 })

    // No retry time stores `failed`, and still reads back as `unavailable`.
    const again = await leaseStore.recordFailure("ws_1", 1, "gone")
    expect(again).toMatchObject({ status: "unavailable", retryCount: 2 })
    expect(again?.nextRetryAt).toBeUndefined()
    await expect(
      target.prepare("select status from sandbox_leases where workspace_id = ?").bind("ws_1").first<{ status: string }>(),
    ).resolves.toEqual({ status: "failed" })

    // A stale epoch is refused.
    await expect(leaseStore.recordFailure("ws_1", 99, "stale")).resolves.toBeUndefined()
    await expect(leaseStore.get("ws_1")).resolves.toMatchObject({ retryCount: 2, lastError: "gone" })
  })

  test("release deletes the row and list returns every lease", async () => {
    const { leaseStore } = await store()
    await leaseStore.acquire("ws_1", { ...ACQUIRE, now: NOW })
    await leaseStore.acquire("ws_2", { ...ACQUIRE, now: NOW })

    await expect(leaseStore.list()).resolves.toHaveLength(2)
    await leaseStore.release("ws_1")
    await expect(leaseStore.get("ws_1")).resolves.toBeUndefined()
    const remaining = await leaseStore.list()
    expect(remaining.map((lease) => lease.workspaceId)).toEqual(["ws_2"])
    // Releasing an absent workspace is a no-op, not a failure.
    await expect(leaseStore.release("ws_missing")).resolves.toBeUndefined()
  })

  test("labels, checkpoint, persistence and restore round-trip through their json columns", async () => {
    const { leaseStore } = await store()
    await leaseStore.acquire("ws_1", { ...ACQUIRE, now: NOW })
    await leaseStore.update("ws_1", 1, {
      status: "ready",
      labels: { tier: "gold", region: "us-east" },
      checkpoint,
      persistence,
      restore,
    })

    const read = await leaseStore.get("ws_1")
    expect(read?.labels).toEqual({ tier: "gold", region: "us-east" })
    expect(read?.checkpoint).toEqual(checkpoint)
    expect(read?.persistence).toEqual(persistence)
    expect(read?.restore).toEqual(restore)
    expect((await leaseStore.list())[0]).toEqual(read)
  })

  test("concurrent acquires on a fresh workspace produce exactly one winner", async () => {
    const { leaseStore } = await store()

    const results = await Promise.all([
      leaseStore.acquire("ws_race", { ...ACQUIRE, now: NOW }),
      leaseStore.acquire("ws_race", { ...ACQUIRE, now: NOW }),
      leaseStore.acquire("ws_race", { ...ACQUIRE, now: NOW }),
    ])

    expect(results.filter((result) => result.acquired)).toHaveLength(1)
    for (const result of results.filter((result) => !result.acquired)) {
      expect(result).toMatchObject({ acquired: false, lease: { epoch: 1, status: "acquiring" } })
      if (!result.acquired) expect(result.retryAfterMs).toBe(STALE_AFTER_MS)
    }
    // One row, one epoch bump.
    await expect(leaseStore.list()).resolves.toMatchObject([{ workspaceId: "ws_race", epoch: 1 }])
  })

  test("a write that loses the epoch between its read and its statement is rejected by the statement", async () => {
    const target = await database()
    const winner = createD1SandboxLeaseStore({ database: target, now: () => NOW })
    await winner.acquire("ws_1", { ...ACQUIRE, now: NOW })

    // The loser reads epoch 1, then the winner re-acquires past the stale
    // window and moves the row to epoch 2 before the loser's statement runs.
    const loser = createD1SandboxLeaseStore({
      database: raceBeforeFirstWrite(target, () =>
        winner.acquire("ws_1", { ...ACQUIRE, now: NOW + STALE_AFTER_MS }),
      ),
      now: () => NOW,
    })

    await expect(loser.update("ws_1", 1, { status: "ready", sandboxId: "loser" })).resolves.toBeUndefined()
    const after = await winner.get("ws_1")
    expect(after).toMatchObject({ epoch: 2, status: "acquiring" })
    expect(after?.sandboxId).toBeUndefined()

    // The same guard on recordFailure.
    const failing = createD1SandboxLeaseStore({
      database: raceBeforeFirstWrite(target, () =>
        winner.acquire("ws_1", { ...ACQUIRE, now: NOW + STALE_AFTER_MS * 2 }),
      ),
      now: () => NOW,
    })
    await expect(failing.recordFailure("ws_1", 2, "boom")).resolves.toBeUndefined()
    const final = await winner.get("ws_1")
    expect(final).toMatchObject({ epoch: 3, status: "acquiring", retryCount: 0 })
    expect(final?.lastError).toBeUndefined()
  })

  test("a sandbox manager provisions and lists a workspace against this store", async () => {
    const { leaseStore } = await store(() => NOW)
    const manager = createSandboxManager({ leaseStore, driver: fakeDriver() })

    const ensured = await manager.ensure("ws_1", { homeRegion: "us-east", labels: { tier: "gold" } })
    expect(ensured).toMatchObject({
      status: "ready",
      epoch: 1,
      sandboxId: "sandbox_ws_1",
      url: "https://runtime.test/ws_1",
      hostId: "host_ws_1",
    })

    // `list` reads the row back — the manager stamps its own labels onto the
    // caller's, and every one of them survives `labels_json`.
    await expect(manager.list()).resolves.toMatchObject([
      {
        workspaceId: "ws_1",
        status: "ready",
        epoch: 1,
        sandboxId: "sandbox_ws_1",
        url: "https://runtime.test/ws_1",
        hostId: "host_ws_1",
        labels: { tier: "gold", workspaceId: "ws_1", epoch: "1", homeRegion: "us-east" },
      },
    ])

    // The ready lease is DURABLE, which is the whole point of this store: a
    // second manager built over the same rows (the hosted control plane builds
    // one per request) finds the existing lease rather than acquiring a new
    // one, so the epoch does not move.
    const second = createSandboxManager({ leaseStore, driver: fakeDriver() })
    await expect(second.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({
      status: "ready",
      epoch: 1,
      sandboxId: "sandbox_ws_1",
    })
  })
})
