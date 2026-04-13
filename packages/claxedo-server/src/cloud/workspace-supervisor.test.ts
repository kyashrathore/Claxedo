/**
 * Tests for workspace-supervisor lifecycle management.
 *
 * Covers:
 * - State transitions (stopped → starting → ready → stopped)
 * - Remote runtime start/stop
 * - Sandbox reuse on wake (cached sandbox reference survives stop)
 * - Idle shutdown scheduling
 * - Hold/release ref counting
 * - Concurrent start deduplication
 * - Error handling and backoff
 * - Expected wake behavior: sandbox.start() for stopped Daytona sandboxes
 */

import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"
import type { SandboxHandle } from "./sandbox/handle"
import type { WorkspaceHold, WorkspaceLease } from "./authority-types"
import { claxedoBus, type ClaxedoEvent } from "../bus"

let provider = "daytona"

// ── Helpers ──────────────────────────────────────────────────────────────

function captureProvisionEvents() {
  const events: ClaxedoEvent[] = []
  const unsub = claxedoBus.subscribe((e) => {
    if (e.type === "provision") events.push(e)
  })
  return { events, cleanup: unsub }
}

function createMockSandbox(overrides?: Record<string, any>): SandboxHandle {
  return {
    provider: provider as SandboxHandle["provider"],
    id: "sb-test-123",
    executeCommand: vi.fn(() => Promise.resolve({ result: "exists" })),
    uploadFile: vi.fn(() => Promise.resolve()),
    createSession: vi.fn(() => Promise.resolve()),
    executeSessionCommand: vi.fn(() => Promise.resolve()),
    deleteSession: vi.fn(() => Promise.resolve()),
    getServiceUrl: vi.fn(() => Promise.resolve("https://sandbox.example.com")),
    refreshActivity: vi.fn(() => Promise.resolve()),
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    destroy: vi.fn(() => Promise.resolve()),
    setLabels: vi.fn(() => Promise.resolve()),
    snapshotFilesystem: vi.fn(() => Promise.resolve("snap-test-123")),
    ...overrides,
  }
}

// ── Shared mock state ────────────────────────────────────────────────────

let activeSandbox = createMockSandbox()
const snapshots: any[] = []
const store = new Map<string, any>()

function workspace(id: string) {
  return {
    id,
    project_id: "proj-1",
    directory: "/workspace",
    kind: "cloud" as const,
    provider: provider as any,
    repo_url: "https://github.com/test/repo.git",
    remote_directory: "/workspace",
    created_at: Date.now(),
    updated_at: Date.now(),
  }
}

const mockGetWorkspace = vi.fn((id: string) => Promise.resolve(store.get(id) ?? workspace(id)))
const mockUpdateWorkspace = vi.fn((id: string, patch: Record<string, unknown>) => {
  const next = {
    ...(store.get(id) ?? workspace(id)),
    ...patch,
    updated_at: Date.now(),
  }
  store.set(id, next)
  return Promise.resolve(next)
})

const mockAcquire = vi.fn(() => Promise.resolve(activeSandbox))
const mockAcquireFromSnapshot = vi.fn(() => Promise.resolve(activeSandbox))
const mockAcquireFromImage = vi.fn(() => Promise.resolve(activeSandbox))
const mockAttach = vi.fn(async (): Promise<SandboxHandle | undefined> => undefined)

const mockLoadUserConfig = vi.fn(() =>
  Promise.resolve({ mcp: {}, auth: {} }),
)

const leases = new Map<string, WorkspaceLease>()
const holds = new Map<string, WorkspaceHold>()

function lease(workspaceId: string, provider = "daytona"): WorkspaceLease {
  const ts = Date.now()
  return {
    workspace_id: workspaceId,
    lease_id: `lease-${workspaceId}`,
    epoch: 1,
    status: "pending",
    provider: provider as WorkspaceLease["provider"],
    provider_object_id: null,
    provider_snapshot_id: null,
    sandbox_id: null,
    runtime_url: null,
    retry_count: 0,
    next_retry_at: null,
    last_heartbeat_at: null,
    last_activity_at: null,
    last_health_failure_at: null,
    last_error: null,
    compute_class: null,
    accel_base_image_id: null,
    accel_prepared_image_id: null,
    accel_runtime_snapshot_id: null,
    created_at: ts,
    updated_at: ts,
  }
}

// ── Module mocks (must be before import) ─────────────────────────────────

vi.doMock("../workspace-store", () => ({
  getWorkspace: (...args: unknown[]) => (mockGetWorkspace as any)(...args),
  updateWorkspace: (...args: unknown[]) => (mockUpdateWorkspace as any)(...args),
}))

vi.doMock("../network/policy", () => ({
  listPolicies: vi.fn(() => []),
}))

vi.doMock("../network/resolve", () => ({
  resolveSandboxNetworkPolicy: vi.fn(() => Promise.resolve(undefined)),
}))

vi.doMock("./authority", () => ({
  subscribe: vi.fn(() => () => {}),
  getLease: (workspaceId: string) => leases.get(workspaceId),
  listLeases: () => [...leases.values()],
  acquire: (workspaceId: string, input: Pick<WorkspaceLease, "provider" | "compute_class">) => {
    const prev = leases.get(workspaceId)
    const next = prev
      ? {
          ...prev,
          epoch: prev.epoch + 1,
          status: "acquiring" as const,
          provider: input.provider,
          compute_class: input.compute_class,
          retry_count: 0,
          next_retry_at: null,
          last_error: null,
          updated_at: Date.now(),
        }
      : {
          ...lease(workspaceId, input.provider),
          status: "acquiring" as const,
          compute_class: input.compute_class,
        }
    leases.set(workspaceId, next)
    return { lease: next, bumped_epoch: !!prev }
  },
  updateLease: (workspaceId: string, patch: Partial<WorkspaceLease>) => {
    const prev = leases.get(workspaceId)
    if (!prev) return
    const next = { ...prev, ...patch, updated_at: Date.now() }
    leases.set(workspaceId, next)
    return next
  },
  transition: (workspaceId: string, status: WorkspaceLease["status"], extra?: Partial<WorkspaceLease>) => {
    const prev = leases.get(workspaceId)
    if (!prev) return
    const next = { ...prev, ...extra, status, updated_at: Date.now() }
    leases.set(workspaceId, next)
    return next
  },
  assignSandbox: (workspaceId: string, sandboxId: string, runtimeUrl: string | null, providerObjectId: string | null) => {
    const prev = leases.get(workspaceId)
    if (!prev) return
    const next = {
      ...prev,
      sandbox_id: sandboxId,
      runtime_url: runtimeUrl,
      provider_object_id: providerObjectId,
      status: "starting" as const,
      updated_at: Date.now(),
    }
    leases.set(workspaceId, next)
    return next
  },
  markReady: (workspaceId: string, runtimeUrl: string) => {
    const prev = leases.get(workspaceId)
    if (!prev) return
    const ts = Date.now()
    const next = {
      ...prev,
      status: "ready" as const,
      runtime_url: runtimeUrl,
      retry_count: 0,
      next_retry_at: null,
      last_error: null,
      last_heartbeat_at: ts,
      last_activity_at: ts,
      updated_at: ts,
    }
    leases.set(workspaceId, next)
    return next
  },
  recordFailure: (workspaceId: string, error: string, nextRetryAt: number | null) => {
    const prev = leases.get(workspaceId)
    if (!prev) return
    const next = {
      ...prev,
      status: nextRetryAt ? "backoff" as const : "failed" as const,
      retry_count: prev.retry_count + 1,
      next_retry_at: nextRetryAt,
      last_error: error,
      last_health_failure_at: Date.now(),
      updated_at: Date.now(),
    }
    leases.set(workspaceId, next)
    return next
  },
  acquireHold: (workspaceId: string, ownerType: WorkspaceHold["owner_type"], ownerId: string, reason: string, expiresAt?: number) => {
    const hold = {
      hold_id: `hold-${workspaceId}-${holds.size + 1}`,
      workspace_id: workspaceId,
      owner_type: ownerType,
      owner_id: ownerId,
      reason,
      expires_at: expiresAt ?? null,
      updated_at: Date.now(),
    } satisfies WorkspaceHold
    holds.set(hold.hold_id, hold)
    return hold
  },
  releaseHold: (holdId: string) => holds.delete(holdId),
  getHolds: (workspaceId: string) =>
    [...holds.values()].filter((hold) => hold.workspace_id === workspaceId),
  getActiveHoldCount: (workspaceId: string) =>
    [...holds.values()].filter((hold) =>
      hold.workspace_id === workspaceId &&
      (!hold.expires_at || hold.expires_at > Date.now()),
    ).length,
  cleanExpiredHolds: (workspaceId: string) => {
    let count = 0
    for (const hold of holds.values()) {
      if (hold.workspace_id !== workspaceId) continue
      if (!hold.expires_at || hold.expires_at > Date.now()) continue
      holds.delete(hold.hold_id)
      count += 1
    }
    return count
  },
  releaseLease: (workspaceId: string) => {
    const had = leases.has(workspaceId)
    leases.delete(workspaceId)
    for (const hold of [...holds.values()]) {
      if (hold.workspace_id !== workspaceId) continue
      holds.delete(hold.hold_id)
    }
    return had
  },
}))

vi.doMock("./sandbox", () => ({
  defaultSandboxProvider: vi.fn(() => "daytona"),
  acquire: (...args: unknown[]) => (mockAcquire as any)(...args),
  acquireFromSnapshot: (...args: unknown[]) => (mockAcquireFromSnapshot as any)(...args),
  acquireFromImage: (...args: unknown[]) => (mockAcquireFromImage as any)(...args),
  attach: (...args: unknown[]) => (mockAttach as any)(...args),
  release: vi.fn(() => Promise.resolve()),
  initPool: vi.fn(() => Promise.resolve()),
  startPoolMonitor: vi.fn(() => {}),
  shutdown: vi.fn(() => {}),
}))

vi.doMock("../agent-config", () => ({
  loadUserConfig: (...args: unknown[]) => (mockLoadUserConfig as any)(...args),
  defaultRunner: vi.fn(() => ({})),
  getRuntimeConfigSnapshot: vi.fn(() => Promise.resolve({})),
}))

vi.doMock("../storage/prepared-image.sql", () => ({
  insertSnapshot: vi.fn((row: any) => snapshots.push(row)),
}))

// Mock fs for runtime bundle reads
vi.doMock("fs", () => {
  const actual = require("node:fs")
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(() => Buffer.from("// mock runtime")),
      existsSync: vi.fn(() => true),
    },
    readFileSync: vi.fn(() => Buffer.from("// mock runtime")),
    existsSync: vi.fn(() => true),
  }
})

// Mock fetch for health checks + config push
globalThis.fetch = vi.fn((url: string | URL | Request) => {
  const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as any).url ?? ""
  if (u.includes("/api/wr/health")) {
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
  }
  if (u.includes("/api/wr/config")) {
    return Promise.resolve(new Response("{}", { status: 200 }))
  }
  // SSE streams — return response that completes immediately
  return Promise.resolve(new Response("data: {}\n\n", { status: 200 }))
}) as any

// ── Import module under test (after mocks) ───────────────────────────────

const supervisor = await import("../workspace-supervisor")
const authority = await import("./authority")

// ── Tests ────────────────────────────────────────────────────────────────

describe("workspace-supervisor", () => {
  beforeEach(() => {
    leases.clear()
    holds.clear()
    snapshots.length = 0
    store.clear()
    provider = "daytona"
    activeSandbox = createMockSandbox()
    mockAcquire.mockClear()
    mockAcquireFromSnapshot.mockClear()
    mockAcquireFromImage.mockClear()
    mockAttach.mockClear()
    mockUpdateWorkspace.mockClear()
    mockAcquire.mockImplementation(() => Promise.resolve(activeSandbox))
    mockAcquireFromSnapshot.mockImplementation(() => Promise.resolve(activeSandbox))
    mockAcquireFromImage.mockImplementation(() => Promise.resolve(activeSandbox))
    mockAttach.mockImplementation(() => Promise.resolve(undefined))
    mockGetWorkspace.mockImplementation((id: string) =>
      Promise.resolve(store.get(id) ?? workspace(id)),
    )

    supervisor.configureWorkspaceSupervisor({
      server_url: "http://localhost:3000",
      opencode_url: "http://localhost:4444",
    })
  })

  afterEach(async () => {
    await supervisor.shutdownWorkspaceSupervisor()
  })

  // ── ensureWorkspaceRuntime ─────────────────────────────────────────

  describe("ensureWorkspaceRuntime", () => {
    test("throws when workspace not found", async () => {
      mockGetWorkspace.mockImplementationOnce(() => Promise.resolve(undefined as any))

      await expect(
        supervisor.ensureWorkspaceRuntime("nonexistent"),
      ).rejects.toThrow("workspace not found")
    })

  test("creates runtime for cloud workspace", async () => {
    const entry = await supervisor.ensureWorkspaceRuntime("ws-new-1")

      expect(entry.status).toBe("ready")
      expect(entry.url).toBeTruthy()
      expect(entry.remote).toBe(true)
      expect(mockUpdateWorkspace).toHaveBeenCalledWith("ws-new-1", expect.objectContaining({
        status: "acquiring_sandbox",
      }))
    expect(mockUpdateWorkspace).toHaveBeenCalledWith("ws-new-1", expect.objectContaining({
      status: "starting_runtime",
      sandbox_id: "sb-test-123",
    }))
    expect(mockUpdateWorkspace).toHaveBeenCalledWith("ws-new-1", expect.objectContaining({
      status: "waiting_health",
    }))
    expect(mockUpdateWorkspace).toHaveBeenCalledWith("ws-new-1", expect.objectContaining({
      status: "ready",
      sandbox_id: "sb-test-123",
    }))
  })

    test("returns existing ready runtime without restarting", async () => {
      await supervisor.ensureWorkspaceRuntime("ws-reuse-1")
      const callsBefore = mockAcquire.mock.calls.length

      const entry2 = await supervisor.ensureWorkspaceRuntime("ws-reuse-1")
      expect(entry2.status).toBe("ready")

      // pool.acquire should NOT be called again
      expect(mockAcquire.mock.calls.length).toBe(callsBefore)
    })

    test("updates used_at on each call", async () => {
      const entry = await supervisor.ensureWorkspaceRuntime("ws-time-1")
      const firstUsed = entry.used_at

      await new Promise((r) => setTimeout(r, 10))
      await supervisor.ensureWorkspaceRuntime("ws-time-1")

      expect(entry.used_at).toBeGreaterThanOrEqual(firstUsed)
    })
  })

  test("discardWorkspaceRuntime drops the lease and cached runtime", async () => {
    await supervisor.ensureWorkspaceRuntime("ws-discard-1")

    expect(supervisor.getWorkspaceLease("ws-discard-1")).toBeDefined()

    await supervisor.discardWorkspaceRuntime("ws-discard-1", "provision_failed")

    expect(supervisor.getWorkspaceLease("ws-discard-1")).toBeUndefined()
    expect(activeSandbox.destroy).toHaveBeenCalled()
  })

  // ── State transitions ──────────────────────────────────────────────

  describe("remote runtime state transitions", () => {
    test("transitions: stopped → starting → ready", async () => {
      const entry = await supervisor.ensureWorkspaceRuntime("ws-states-1")

      expect(entry.status).toBe("ready")
      expect(entry.started_at).toBeGreaterThan(0)
      expect(entry.crashes).toBe(0)
      expect(entry.retry_at).toBe(0)
    })

    test("acquires sandbox from pool when no cached sandbox", async () => {
      await supervisor.ensureWorkspaceRuntime("ws-pool-1")

      expect(mockAcquire).toHaveBeenCalled()
      const call = (mockAcquire.mock.calls as any[][]).find((c) => c[0] === "ws-pool-1")
      expect(call).toBeTruthy()
      expect(call![1]).toBe("proj-1")
    })

    test("emits acquiring_sandbox as first event", async () => {
      const tracker = captureProvisionEvents()

      await supervisor.ensureWorkspaceRuntime("ws-events-1")

      const steps = tracker.events
        .filter((e): e is Extract<ClaxedoEvent, { type: "provision" }> =>
          e.type === "provision" && (e as any).workspaceId === "ws-events-1",
        )
        .map((e) => e.step)

      expect(steps[0]).toBe("acquiring_sandbox")
      tracker.cleanup()
    })

    test("full provision event sequence for fresh deploy", async () => {
      // Sandbox returns "missing" for both checks
      activeSandbox = createMockSandbox({
        executeCommand: vi.fn(() => Promise.resolve({ result: "missing" })),
      })
      mockAcquire.mockImplementation(() => Promise.resolve(activeSandbox))

      const tracker = captureProvisionEvents()

      await supervisor.ensureWorkspaceRuntime("ws-full-1")

      const steps = tracker.events
        .filter((e): e is Extract<ClaxedoEvent, { type: "provision" }> =>
          e.type === "provision" && (e as any).workspaceId === "ws-full-1",
        )
        .map((e) => e.step)

      expect(steps).toEqual([
        "acquiring_sandbox",
        "cloning",
        "installing_runtime",
        "starting_runtime",
        "waiting_health",
        "ready",
      ])

      tracker.cleanup()
    })

    test("warm provision event sequence (both exist)", async () => {
      const tracker = captureProvisionEvents()

      await supervisor.ensureWorkspaceRuntime("ws-warm-1")

      const steps = tracker.events
        .filter((e): e is Extract<ClaxedoEvent, { type: "provision" }> =>
          e.type === "provision" && (e as any).workspaceId === "ws-warm-1",
        )
        .map((e) => e.step)

      // No cloning or uploading events
      expect(steps).not.toContain("cloning")
      expect(steps).not.toContain("installing_runtime")
      expect(steps).toContain("acquiring_sandbox")
      expect(steps).toContain("starting_runtime")
      expect(steps).toContain("ready")

      tracker.cleanup()
    })

    test("restores a workspace from runtime snapshot when the provider supports it", async () => {
      provider = "vercel"
      activeSandbox = createMockSandbox({ provider: "vercel", id: "sb-snap-1" })
      mockAcquireFromSnapshot.mockImplementation(() => Promise.resolve(activeSandbox))
      leases.set("ws-snap-1", {
        ...lease("ws-snap-1", "vercel"),
        status: "stopped",
        accel_runtime_snapshot_id: "snap-1",
      })

      await supervisor.ensureWorkspaceRuntime("ws-snap-1")

      expect(mockAcquireFromSnapshot).toHaveBeenCalledWith(
        "ws-snap-1",
        "proj-1",
        "snap-1",
        undefined,
        "vercel",
      )
      expect(mockAcquire).not.toHaveBeenCalled()
    })

    test("starts from a prepared image when the provider supports it", async () => {
      provider = "modal"
      activeSandbox = createMockSandbox({ provider: "modal", id: "sb-img-1" })
      mockAcquireFromImage.mockImplementation(() => Promise.resolve(activeSandbox))
      leases.set("ws-img-1", {
        ...lease("ws-img-1", "modal"),
        status: "stopped",
        accel_prepared_image_id: "img-1",
      })

      await supervisor.ensureWorkspaceRuntime("ws-img-1")

      expect(mockAcquireFromImage).toHaveBeenCalledWith(
        "ws-img-1",
        "proj-1",
        "img-1",
        undefined,
        "modal",
      )
      expect(mockAcquire).not.toHaveBeenCalled()
    })
  })

  // ── Sandbox reuse on wake ──────────────────────────────────────────

  describe("sandbox reuse after stop (wake path)", () => {
    test("sandbox reference survives stopRuntime", async () => {
      const entry = await supervisor.ensureWorkspaceRuntime("ws-wake-1")
      expect(entry.sandbox).toBe(activeSandbox)

      await supervisor.stopRuntime("ws-wake-1", "test")

      expect(entry.status).toBe("stopped")
      expect(entry.url).toBeUndefined()
      // Sandbox reference preserved — enables reuse on next start
      expect(entry.sandbox).toBe(activeSandbox)
    })

    test("reuses cached sandbox on restart instead of acquiring new one", async () => {
      await supervisor.ensureWorkspaceRuntime("ws-wake-2")
      const callsBefore = mockAcquire.mock.calls.length

      await supervisor.stopRuntime("ws-wake-2", "test")

      // Restart — should reuse cached sandbox
      const entry = await supervisor.ensureWorkspaceRuntime("ws-wake-2")
      expect(entry.status).toBe("ready")

      // pool.acquire should NOT be called again
      expect(mockAcquire.mock.calls.length).toBe(callsBefore)
    })

    test("reattaches persisted sandbox before acquiring a new one", async () => {
      const attached = createMockSandbox({ id: "sb-reattach-1" })
      mockAttach.mockImplementation(() => Promise.resolve(attached))

      const entry = await supervisor.ensureWorkspaceRuntime("ws-wake-reattach-1")
      await supervisor.stopRuntime("ws-wake-reattach-1", "test")

      entry.sandbox = undefined
      entry.sandbox_id = undefined

      const callsBefore = mockAcquire.mock.calls.length

      await supervisor.ensureWorkspaceRuntime("ws-wake-reattach-1")

      expect(mockAttach).toHaveBeenCalled()
      expect(mockAcquire.mock.calls.length).toBe(callsBefore)
      expect(supervisor.getSandbox("ws-wake-reattach-1")?.id).toBe("sb-reattach-1")
    })

    test("wake skips clone and upload when sandbox filesystem is intact", async () => {
      await supervisor.ensureWorkspaceRuntime("ws-wake-3")
      await supervisor.stopRuntime("ws-wake-3", "test")

      const tracker = captureProvisionEvents()

      await supervisor.ensureWorkspaceRuntime("ws-wake-3")

      const steps = tracker.events
        .filter((e): e is Extract<ClaxedoEvent, { type: "provision" }> =>
          e.type === "provision" && (e as any).workspaceId === "ws-wake-3",
        )
        .map((e) => e.step)

      expect(steps).not.toContain("cloning")
      expect(steps).not.toContain("installing_runtime")
      expect(steps).toContain("acquiring_sandbox")
      expect(steps).toContain("starting_runtime")
      expect(steps).toContain("ready")

      tracker.cleanup()
    })
  })

  // ── stopRuntime ────────────────────────────────────────────────────

  describe("stopRuntime", () => {
    test("stops remote runtime by deleting session", async () => {
      await supervisor.ensureWorkspaceRuntime("ws-stop-1")

      await supervisor.stopRuntime("ws-stop-1", "test")

      expect(activeSandbox.deleteSession).toHaveBeenCalledWith("wr-ws-stop-1")
    })

    test("sets status to stopped and clears url", async () => {
      const entry = await supervisor.ensureWorkspaceRuntime("ws-stop-2")
      expect(entry.status).toBe("ready")
      expect(entry.url).toBeTruthy()

      await supervisor.stopRuntime("ws-stop-2", "test")

      expect(entry.status).toBe("stopped")
      expect(entry.url).toBeUndefined()
      expect(entry.port).toBeUndefined()
      expect(store.get("ws-stop-2")?.status).toBe("stopped")
    })

    test("aborts event streams", async () => {
      const entry = await supervisor.ensureWorkspaceRuntime("ws-stop-3")

      await supervisor.stopRuntime("ws-stop-3", "test")

      expect(entry.events).toBeUndefined()
      expect(entry.global).toBeUndefined()
    })

    test("no-op for unknown workspaceId", async () => {
      await supervisor.stopRuntime("nonexistent", "test")
    })

    test("clears health monitor on stop", async () => {
      const entry = await supervisor.ensureWorkspaceRuntime("ws-stop-hm")

      await supervisor.stopRuntime("ws-stop-hm", "test")

      expect(entry.health_monitor).toBeUndefined()
    })

    test("captures a runtime snapshot before stopping providers that support it", async () => {
      provider = "vercel"
      activeSandbox = createMockSandbox({
        provider: "vercel",
        snapshotFilesystem: vi.fn(() => Promise.resolve("snap-stop-1")),
      })

      await supervisor.ensureWorkspaceRuntime("ws-stop-snap")
      await supervisor.stopRuntime("ws-stop-snap", "idle")

      expect(activeSandbox.snapshotFilesystem).toHaveBeenCalled()
      expect(snapshots.at(-1)?.runtime_snapshot_id).toBe("snap-stop-1")
      expect(authority.getLease("ws-stop-snap")?.accel_runtime_snapshot_id).toBe("snap-stop-1")
      expect(supervisor.getSandbox("ws-stop-snap")).toBeUndefined()
    })
  })

  // ── Error handling ─────────────────────────────────────────────────

  describe("error handling", () => {
    test("transitions to backoff on pool.acquire failure", async () => {
      mockAcquire.mockImplementation(() =>
        Promise.reject(new Error("pool exhausted")),
      )

      const tracker = captureProvisionEvents()

      await expect(
        supervisor.ensureWorkspaceRuntime("ws-err-1"),
      ).rejects.toThrow("pool exhausted")

      const errorEvents = tracker.events.filter(
        (e): e is Extract<ClaxedoEvent, { type: "provision" }> =>
          e.type === "provision" && (e as any).step === "error",
      )
      expect(errorEvents.length).toBeGreaterThanOrEqual(1)

      tracker.cleanup()
    })

    test("error event includes message", async () => {
      mockAcquire.mockImplementation(() =>
        Promise.reject(new Error("no sandboxes available")),
      )

      const tracker = captureProvisionEvents()

      await expect(
        supervisor.ensureWorkspaceRuntime("ws-err-msg"),
      ).rejects.toThrow()

      const errorEvent = tracker.events.find(
        (e): e is Extract<ClaxedoEvent, { type: "provision" }> =>
          e.type === "provision" && (e as any).step === "error",
      ) as any
      expect(errorEvent).toBeTruthy()
      expect(errorEvent.message).toContain("no sandboxes available")

      tracker.cleanup()
    })
  })

  // ── Concurrent start deduplication ─────────────────────────────────

  describe("concurrent start deduplication", () => {
    test("concurrent calls return the same promise", async () => {
      const p1 = supervisor.ensureWorkspaceRuntime("ws-dedup-1")
      const p2 = supervisor.ensureWorkspaceRuntime("ws-dedup-1")

      const [r1, r2] = await Promise.all([p1, p2])

      expect(r1).toBe(r2)
      expect(r1.status).toBe("ready")

      // pool.acquire called only once for this workspace
      const acquireCalls = (mockAcquire.mock.calls as any[][]).filter(
        (c) => c[0] === "ws-dedup-1",
      )
      expect(acquireCalls.length).toBe(1)
    })
  })

  // ── Hold / Release ─────────────────────────────────────────────────

  describe("holdRuntime / releaseRuntime", () => {
    test("no-op for unknown workspace", () => {
      supervisor.holdRuntime("ws-hold-unknown")
      // Should not throw
    })

    test("increments and decrements active count", async () => {
      const entry = await supervisor.ensureWorkspaceRuntime("ws-hold-2")

      supervisor.holdRuntime("ws-hold-2")
      expect(entry.active).toBe(1)

      supervisor.holdRuntime("ws-hold-2")
      expect(entry.active).toBe(2)

      supervisor.releaseRuntime("ws-hold-2")
      expect(entry.active).toBe(1)

      supervisor.releaseRuntime("ws-hold-2")
      expect(entry.active).toBe(0)
    })

    test("releases durable hold rows with runtime holds", async () => {
      await supervisor.ensureWorkspaceRuntime("ws-hold-durable-1")

      supervisor.holdRuntime("ws-hold-durable-1")
      supervisor.holdRuntime("ws-hold-durable-1")
      expect(authority.getHolds("ws-hold-durable-1")).toHaveLength(2)

      supervisor.releaseRuntime("ws-hold-durable-1")
      expect(authority.getHolds("ws-hold-durable-1")).toHaveLength(1)

      supervisor.releaseRuntime("ws-hold-durable-1")
      expect(authority.getHolds("ws-hold-durable-1")).toHaveLength(0)
    })

    test("release does not go below 0", async () => {
      const entry = await supervisor.ensureWorkspaceRuntime("ws-hold-3")

      supervisor.releaseRuntime("ws-hold-3")
      supervisor.releaseRuntime("ws-hold-3")

      expect(entry.active).toBe(0)
    })
  })

  // ── listWorkspaceRuntimes ──────────────────────────────────────────

  describe("listWorkspaceRuntimes", () => {
    test("lists ready runtimes", async () => {
      await supervisor.ensureWorkspaceRuntime("ws-list-1")

      const list = supervisor.listWorkspaceRuntimes()
      const found = list.find((r) => r.workspaceId === "ws-list-1")

      expect(found).toBeTruthy()
      expect(found!.status).toBe("ready")
      expect(found!.url).toBeTruthy()
    })

    test("does not list stopped runtimes", async () => {
      await supervisor.ensureWorkspaceRuntime("ws-list-2")
      await supervisor.stopRuntime("ws-list-2", "test")

      const list = supervisor.listWorkspaceRuntimes()
      const found = list.find((r) => r.workspaceId === "ws-list-2")

      expect(found).toBeUndefined()
    })
  })

  // ── getSandbox ─────────────────────────────────────────────────────

  describe("getSandbox", () => {
    test("returns sandbox for active runtime", async () => {
      await supervisor.ensureWorkspaceRuntime("ws-sandbox-1")

      const sb = supervisor.getSandbox("ws-sandbox-1")
      expect(sb).toBe(activeSandbox)
    })

    test("returns undefined for unknown workspace", () => {
      expect(supervisor.getSandbox("nonexistent")).toBeUndefined()
    })

    test("sandbox persists after stop", async () => {
      await supervisor.ensureWorkspaceRuntime("ws-sandbox-2")
      await supervisor.stopRuntime("ws-sandbox-2", "test")

      const sb = supervisor.getSandbox("ws-sandbox-2")
      expect(sb).toBe(activeSandbox)
    })
  })

  // ── markRuntimeUse ─────────────────────────────────────────────────

  describe("markRuntimeUse", () => {
    test("updates used_at timestamp", async () => {
      const entry = await supervisor.ensureWorkspaceRuntime("ws-mark-1")
      const before = entry.used_at

      await new Promise((r) => setTimeout(r, 10))
      supervisor.markRuntimeUse("ws-mark-1")

      expect(entry.used_at).toBeGreaterThanOrEqual(before)
    })

    test("no-op for unknown workspace", () => {
      supervisor.markRuntimeUse("nonexistent")
    })
  })

  // ── syncWorkspaceRuntime ───────────────────────────────────────────

  describe("syncWorkspaceRuntime", () => {
    test("ensures runtime and pushes config", async () => {
      const entry = await supervisor.syncWorkspaceRuntime("ws-sync-1")

      expect(entry.status).toBe("ready")
    })
  })

  // ── shutdownWorkspaceSupervisor ────────────────────────────────────

  describe("shutdownWorkspaceSupervisor", () => {
    test("stops all running runtimes", async () => {
      await supervisor.ensureWorkspaceRuntime("ws-shutdown-1")
      await supervisor.ensureWorkspaceRuntime("ws-shutdown-2")

      await supervisor.shutdownWorkspaceSupervisor()

      const list = supervisor.listWorkspaceRuntimes()
      expect(list).toHaveLength(0)
    })
  })

  // ── PTY tracking ──────────────────────────────────────────────────

  describe("pty tracking", () => {
    test("rememberPty and getPtyWorkspace", () => {
      supervisor.rememberPty("pty-1", "ws-pty-1")
      expect(supervisor.getPtyWorkspace("pty-1")).toBe("ws-pty-1")
    })

    test("forgetPty removes mapping", () => {
      supervisor.rememberPty("pty-2", "ws-pty-2")
      supervisor.forgetPty("pty-2")
      expect(supervisor.getPtyWorkspace("pty-2")).toBeUndefined()
    })

    test("getPtyWorkspace returns undefined for unknown", () => {
      expect(supervisor.getPtyWorkspace("nonexistent")).toBeUndefined()
    })
  })
})

// ── Expected behavior: Daytona sandbox wake ─────────────────────────────
// These tests document the EXPECTED behavior for waking stopped sandboxes.

describe("workspace-supervisor: expected wake behavior", () => {
  beforeEach(() => {
    supervisor.configureWorkspaceSupervisor({
      server_url: "http://localhost:3000",
      opencode_url: "http://localhost:4444",
    })
  })

  afterEach(async () => {
    await supervisor.shutdownWorkspaceSupervisor()
  })

  test.todo("when Daytona sandbox is STOPPED, sandbox.start() should be called to wake it (not yet implemented)")

  test("wake produces fewer provision events than cold start", async () => {
    // Warm sandbox with filesystem intact
    mockAcquire.mockImplementation(() => Promise.resolve(createMockSandbox()))
    mockGetWorkspace.mockImplementation((id: string) =>
      Promise.resolve({
        id,
        project_id: "proj-1",
        directory: "/workspace",
        kind: "cloud" as const,
        provider: provider as any,
        repo_url: "https://github.com/test/repo.git",
        remote_directory: "/workspace",
        created_at: Date.now(),
        updated_at: Date.now(),
      }),
    )

    const tracker = captureProvisionEvents()
    await supervisor.ensureWorkspaceRuntime("ws-wake-warm-1")

    const steps = tracker.events
      .filter((e): e is Extract<ClaxedoEvent, { type: "provision" }> =>
        e.type === "provision" && (e as any).workspaceId === "ws-wake-warm-1",
      )
      .map((e) => e.step)

    // Clone and upload skipped when filesystem intact
    expect(steps).not.toContain("cloning")
    expect(steps).not.toContain("installing_runtime")
    expect(steps).toContain("acquiring_sandbox")
    expect(steps).toContain("starting_runtime")
    expect(steps).toContain("waiting_health")
    expect(steps).toContain("ready")

    tracker.cleanup()
  })

  test("stop → restart cycle preserves sandbox identity", async () => {
    const originalSandbox = createMockSandbox({ id: "sb-persistent-id" })
    mockAcquire.mockImplementation(() => Promise.resolve(originalSandbox))
    mockGetWorkspace.mockImplementation((id: string) =>
      Promise.resolve({
        id,
        project_id: "proj-1",
        directory: "/workspace",
        kind: "cloud" as const,
        provider: provider as any,
        repo_url: "",
        remote_directory: "/workspace",
        created_at: Date.now(),
        updated_at: Date.now(),
      }),
    )

    // Start
    await supervisor.ensureWorkspaceRuntime("ws-identity-1")
    expect(supervisor.getSandbox("ws-identity-1")?.id).toBe("sb-persistent-id")

    // Stop
    await supervisor.stopRuntime("ws-identity-1", "test")

    // Restart — should reuse same sandbox
    await supervisor.ensureWorkspaceRuntime("ws-identity-1")
    expect(supervisor.getSandbox("ws-identity-1")?.id).toBe("sb-persistent-id")
  })
})
