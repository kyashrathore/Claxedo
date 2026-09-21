import { describe, expect, test, vi } from "vitest"
import { applySandboxRuntimeSnapshot, type SandboxRuntimeLivenessPolicy } from "./runtime-snapshot"
import { createMemoryLeaseStore, sandboxLease } from "./stores/memory"

const SERVING = {
  workspaceId: "ws_1",
  status: "ready" as const,
  epoch: 3,
  sandboxId: "sandbox_1",
  url: "https://runtime.test/ws_1",
  hostId: "host_1",
}

/** The budget a supervisor that also runs its own health monitor spends. */
const retryBudget: SandboxRuntimeLivenessPolicy = {
  kind: "retry-budget",
  nextRetryAt: ({ retryCount, now }) => (retryCount > 2 ? undefined : now + 1_000 * retryCount),
}

function serving(overrides: Parameters<typeof sandboxLease>[0] = { workspaceId: "ws_1" }) {
  return createMemoryLeaseStore([sandboxLease({ ...SERVING, ...overrides })])
}

describe("applySandboxRuntimeSnapshot", () => {
  test("demote leaves the retry budget to whoever owns provisioning", async () => {
    const leaseStore = serving({ workspaceId: "ws_1", retryCount: 2 })

    await expect(
      applySandboxRuntimeSnapshot({ leaseStore, workspaceId: "ws_1", snapshot: { ok: false, epoch: 3, now: 7_000 } }),
    ).resolves.toEqual({ ok: true, status: "unavailable" })

    await expect(leaseStore.get("ws_1")).resolves.toMatchObject({
      status: "unavailable",
      retryCount: 2,
      lastHeartbeatAt: 7_000,
      sandboxId: "sandbox_1",
      url: "https://runtime.test/ws_1",
    })
  })

  test("retry-budget spends the budget on an unhealthy report and hands it back on a serving one", async () => {
    const leaseStore = serving()

    await expect(applySandboxRuntimeSnapshot({
      leaseStore,
      workspaceId: "ws_1",
      snapshot: { ok: false, epoch: 3, now: 7_000 },
      liveness: retryBudget,
    })).resolves.toEqual({ ok: true, status: "unavailable" })

    await expect(leaseStore.get("ws_1")).resolves.toMatchObject({
      status: "unavailable",
      retryCount: 1,
      nextRetryAt: 8_000,
      lastError: "runtime_unhealthy",
      lastHeartbeatAt: 7_000,
    })

    await expect(applySandboxRuntimeSnapshot({
      leaseStore,
      workspaceId: "ws_1",
      snapshot: { ok: true, epoch: 3, now: 9_000, active: true },
      liveness: retryBudget,
    })).resolves.toEqual({ ok: true, status: "ready" })

    // Handing the budget back is what keeps a flapping runtime out of a
    // terminal state it could never leave on its own.
    await expect(leaseStore.get("ws_1")).resolves.toMatchObject({
      status: "ready",
      retryCount: 0,
      nextRetryAt: undefined,
      lastError: undefined,
      lastActivityAt: 9_000,
    })
  })

  test("a spent retry budget leaves the lease unavailable with no retry to wait for", async () => {
    const leaseStore = serving({ workspaceId: "ws_1", retryCount: 2 })

    await expect(applySandboxRuntimeSnapshot({
      leaseStore,
      workspaceId: "ws_1",
      snapshot: { ok: false, epoch: 3, now: 7_000 },
      liveness: retryBudget,
    })).resolves.toEqual({ ok: true, status: "unavailable" })

    await expect(leaseStore.get("ws_1")).resolves.toMatchObject({
      status: "unavailable",
      retryCount: 3,
      nextRetryAt: undefined,
    })
  })

  test.each(["stopped", "destroyed"] as const)("a %s landing between the read and the write is refused", async (status) => {
    const leaseStore = serving()
    const update = leaseStore.update.bind(leaseStore)
    // The decision lands after the guards have read a serving lease, so only
    // the fenced write can still see it.
    vi.spyOn(leaseStore, "update").mockImplementationOnce(async (workspaceId, epoch, patch, expectedStatus) => {
      await update(workspaceId, epoch, { status })
      return update(workspaceId, epoch, patch, expectedStatus)
    })

    await expect(applySandboxRuntimeSnapshot({
      leaseStore,
      workspaceId: "ws_1",
      snapshot: { ok: true, epoch: 3, now: 7_000 },
      liveness: retryBudget,
    })).resolves.toEqual({ ok: false, reason: "runtime_lease_not_serving" })

    await expect(leaseStore.get("ws_1")).resolves.toMatchObject({ status, lastHeartbeatAt: undefined })
  })

  test("a replacement epoch between the read and the write is named as the stale epoch it is", async () => {
    const leaseStore = serving({ workspaceId: "ws_1", epoch: 1 })
    const update = leaseStore.update.bind(leaseStore)
    vi.spyOn(leaseStore, "update").mockImplementationOnce(async (workspaceId, epoch, patch, expectedStatus) => {
      await update(workspaceId, epoch, { status: "stopped" })
      await leaseStore.acquire(workspaceId, { homeRegion: "us-east", driver: "test", staleAfterMs: 1_000 })
      return update(workspaceId, epoch, patch, expectedStatus)
    })

    await expect(applySandboxRuntimeSnapshot({
      leaseStore,
      workspaceId: "ws_1",
      snapshot: { ok: true, epoch: 1, now: 7_000 },
      liveness: retryBudget,
    })).resolves.toEqual({ ok: false, reason: "runtime_lease_epoch_mismatch" })

    await expect(leaseStore.get("ws_1")).resolves.toMatchObject({
      epoch: 2,
      status: "acquiring",
      lastHeartbeatAt: undefined,
    })
  })

  test("a report on a lease that holds no target cannot publish one", async () => {
    const leaseStore = createMemoryLeaseStore([
      sandboxLease({ workspaceId: "ws_1", status: "acquiring", epoch: 3 }),
    ])

    await expect(applySandboxRuntimeSnapshot({
      leaseStore,
      workspaceId: "ws_1",
      snapshot: { ok: true, epoch: 3 },
      liveness: retryBudget,
    })).resolves.toEqual({ ok: false, reason: "runtime_lease_not_provisioned" })

    await expect(leaseStore.get("ws_1")).resolves.toMatchObject({ status: "acquiring" })
  })
})
