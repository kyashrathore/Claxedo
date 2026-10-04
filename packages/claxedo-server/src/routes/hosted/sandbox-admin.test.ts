import { describe, expect, test, vi } from "vitest"
import { HostedSandboxAdminRoutes } from "./sandbox-admin"
import { createSandboxManager, type SandboxDriver, type SandboxManager } from "@claxedo/sandbox-manager"
import { createMemoryLeaseStore, sandboxLease } from "@claxedo/sandbox-manager/stores/memory"

function fakeDriver(overrides: Partial<SandboxDriver> = {}): SandboxDriver {
  return {
    id: "test-provider",
    metadata: {
      driverRunsIn: ["node"],
      hostStopBehavior: "suspends-host", hostResumeBehavior: "same-host",
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
    ...overrides,
  }
}

function request(path: string, init: RequestInit & { token?: string } = {}) {
  const { token, ...rest } = init
  return new Request(`http://cp.test${path}`, {
    method: "POST",
    ...rest,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rest.body ? { "content-type": "application/json" } : {}),
    },
  })
}

describe("hosted sandbox admin routes", () => {
  test("release rejects missing, wrong, and unconfigured admin tokens", async () => {
    const store = createMemoryLeaseStore([sandboxLease({ workspaceId: "ws_1", status: "unavailable", retryCount: 9 })])
    const sandboxManager = createSandboxManager({ leaseStore: store, driver: fakeDriver() })
    const app = HostedSandboxAdminRoutes({ adminToken: "admin_secret", sandboxManager })

    const missing = await app.fetch(
      request("/internal/sandbox-manager/release", { body: JSON.stringify({ workspaceId: "ws_1" }) }),
    )
    expect(missing.status).toBe(401)
    const wrong = await app.fetch(
      request("/internal/sandbox-manager/release", {
        token: "wrong",
        body: JSON.stringify({ workspaceId: "ws_1" }),
      }),
    )
    expect(wrong.status).toBe(401)

    // Fail closed: no configured admin token means no caller is authorized.
    const unconfigured = HostedSandboxAdminRoutes({ sandboxManager })
    const denied = await unconfigured.fetch(
      request("/internal/sandbox-manager/release", {
        token: "anything",
        body: JSON.stringify({ workspaceId: "ws_1" }),
      }),
    )
    expect(denied.status).toBe(401)

    // The capped lease was never touched.
    await expect(store.get("ws_1")).resolves.toMatchObject({ status: "unavailable", retryCount: 9 })
  })

  test("release resets a single capped workspace lease so the next ensure starts fresh", async () => {
    const store = createMemoryLeaseStore([
      sandboxLease({
        workspaceId: "ws_capped",
        status: "unavailable",
        epoch: 2,
        retryCount: 9,
        lastError: "provider quota exhausted",
      }),
      sandboxLease({
        workspaceId: "ws_other",
        status: "ready",
        sandboxId: "sandbox_other",
        url: "https://runtime.test/other",
        hostId: "host_other",
      }),
    ])
    const sandboxManager = createSandboxManager({ leaseStore: store, driver: fakeDriver(), maxRetryCount: 3 })
    const telemetry = { capture: vi.fn() }
    const app = HostedSandboxAdminRoutes({ adminToken: "admin_secret", sandboxManager, telemetry })

    const res = await app.fetch(
      request("/internal/sandbox-manager/release", {
        token: "admin_secret",
        body: JSON.stringify({ workspaceId: "ws_capped" }),
      }),
    )
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ released: true })
    await expect(store.get("ws_capped")).resolves.toBeUndefined()
    // Only the requested workspace is released.
    await expect(store.get("ws_other")).resolves.toMatchObject({ status: "ready" })
    expect(telemetry.capture).toHaveBeenCalledWith("system", "sandbox.release", {
      workspaceId: "ws_capped",
      released: true,
    })

    // The workspace can provision again from a clean slate.
    await expect(sandboxManager.ensure("ws_capped", { homeRegion: "us-east" })).resolves.toMatchObject({
      status: "ready",
      epoch: 1,
    })

    const absent = await app.fetch(
      request("/internal/sandbox-manager/release", {
        token: "admin_secret",
        body: JSON.stringify({ workspaceId: "ws_missing" }),
      }),
    )
    await expect(absent.json()).resolves.toEqual({ released: false })
  })

  test("release validates the workspaceId and reports a missing sandbox manager", async () => {
    const sandboxManager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver: fakeDriver() })
    const app = HostedSandboxAdminRoutes({ adminToken: "admin_secret", sandboxManager })

    const noBody = await app.fetch(request("/internal/sandbox-manager/release", { token: "admin_secret" }))
    expect(noBody.status).toBe(400)
    const blank = await app.fetch(
      request("/internal/sandbox-manager/release", {
        token: "admin_secret",
        body: JSON.stringify({ workspaceId: "   " }),
      }),
    )
    expect(blank.status).toBe(400)

    const unwired = HostedSandboxAdminRoutes({ adminToken: "admin_secret" })
    const res = await unwired.fetch(
      request("/internal/sandbox-manager/release", {
        token: "admin_secret",
        body: JSON.stringify({ workspaceId: "ws_1" }),
      }),
    )
    expect(res.status).toBe(501)
  })

  test("GC on a listing-incapable driver fails loudly instead of 200-ing an empty sweep", async () => {
    // Positive control. `fakeDriver` has no `list()` — the shape of the
    // real Cloudflare driver. Before the fix this returned 200 with four empty
    // arrays, which reads to an operator (and to the cron) as "swept, nothing
    // orphaned" when in fact nothing was ever looked at.
    const sandboxManager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver: fakeDriver() })
    const telemetry = { capture: vi.fn() }
    const app = HostedSandboxAdminRoutes({ adminToken: "admin_secret", sandboxManager, telemetry })

    const res = await app.fetch(request("/internal/sandbox-manager/gc", { token: "admin_secret" }))

    expect(res.ok).toBe(false)
    expect(res.status).toBe(501)
    await expect(res.json()).resolves.toMatchObject({
      error: "sandbox_gc_listing_unsupported",
      listingUnsupported: true,
      driver: "test-provider",
    })
    expect(telemetry.capture).toHaveBeenCalledWith(
      "system",
      "sandbox.garbage_collect",
      expect.objectContaining({ listingUnsupported: true, driver: "test-provider" }),
    )
  })

  test("GC on a listing-capable driver 200s and destroys the orphan", async () => {
    const orphan = {
      sandboxId: "sandbox_orphan",
      url: "https://runtime.test/orphan",
      hostId: "host_orphan",
      labels: { app: "claxedo", workspaceId: "ws_orphan", epoch: "1" },
    }
    const destroy = vi.fn(async () => {})
    const sandboxManager = createSandboxManager({
      leaseStore: createMemoryLeaseStore(),
      driver: fakeDriver({ list: vi.fn(async () => [orphan]), destroy }),
    })
    const app = HostedSandboxAdminRoutes({ adminToken: "admin_secret", sandboxManager })

    const res = await app.fetch(request("/internal/sandbox-manager/gc", { token: "admin_secret" }))

    expect(res.status).toBe(200)
    const body = await res.json() as { destroyed: Array<{ sandboxId: string }>; listingUnsupported?: boolean }
    expect(body.destroyed.map((target) => target.sandboxId)).toEqual(["sandbox_orphan"])
    expect(body.listingUnsupported).toBeUndefined()
    expect(destroy).toHaveBeenCalled()
  })

  test("a sweep over several keys closes what it destroyed and counts the keys it could not open, even when one account could not be listed", async () => {
    const orphan = { workspaceId: "ws_orphan", sandboxId: "sandbox_orphan", url: "https://runtime.test/orphan", hostId: "host_orphan", driver: { id: "boat", resourceId: "r" } }
    const sandboxManager = {
      garbageCollect: async () => ({
        destroyed: [orphan], kept: [], skipped: [], failed: [],
        listingUnsupported: true as const, driver: "cloudflare",
        unreachable: [{ driver: "vercel", error: "The sandbox provider key this workspace was created with has been removed" }],
      }),
    } as unknown as SandboxManager
    const telemetry = { capture: vi.fn() }
    const app = HostedSandboxAdminRoutes({ adminToken: "admin_secret", sandboxManager, telemetry })

    const res = await app.fetch(request("/internal/sandbox-manager/gc", { token: "admin_secret" }))

    expect(res.status).toBe(501)
    expect(telemetry.capture).toHaveBeenCalledWith("system", "sandbox.garbage_collect", expect.objectContaining({ destroyed: 1, unreachable: 1 }))
    expect(telemetry.capture).toHaveBeenCalledWith("system", "sandbox.lease_closed", expect.objectContaining({ workspace_id: "ws_orphan", driver: "boat", reason: "gc" }))
  })

  test("idle stop is authorized by its own token alone and answers a refused stop as a conflict", async () => {
    const idleStop = vi.fn(async (_workspaceId: string, epoch: number, _idleBefore: number) =>
      epoch === 7 ? { ok: true as const, status: "stopped" as const } : { ok: false as const, reason: "runtime_lease_changed" })
    const app = HostedSandboxAdminRoutes({ adminToken: "admin_secret", idleStopToken: "idle_secret", idleStop })
    const body = (epoch: number) => JSON.stringify({ workspaceId: "ws_1", epoch, idleBefore: 1_000 })
    expect((await app.fetch(request("/internal/sandbox/idle-stop", { token: "admin_secret", body: body(7) }))).status).toBe(401)
    expect((await app.fetch(request("/internal/sandbox/idle-stop", { body: body(7) }))).status).toBe(401)
    expect(idleStop).not.toHaveBeenCalled()
    expect((await app.fetch(request("/internal/sandbox/idle-stop", { token: "idle_secret", body: "{}" }))).status).toBe(400)
    expect((await app.fetch(request("/internal/sandbox/idle-stop", { token: "idle_secret", body: body(7) }))).status).toBe(200)
    expect(idleStop).toHaveBeenCalledWith("ws_1", 7, 1_000)
    expect((await app.fetch(request("/internal/sandbox/idle-stop", { token: "idle_secret", body: body(6) }))).status).toBe(409)
  })
})
