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

import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test"
import type { Sandbox } from "@daytonaio/sdk"
import { claxedoBus, type ClaxedoEvent } from "../bus"

// ── Helpers ──────────────────────────────────────────────────────────────

function captureProvisionEvents() {
  const events: ClaxedoEvent[] = []
  const unsub = claxedoBus.subscribe((e) => {
    if (e.type === "provision") events.push(e)
  })
  return { events, cleanup: unsub }
}

function makeExecuteResult(result: string) {
  return { result, code: 0 }
}

function createMockSandbox(overrides?: Record<string, any>): Sandbox {
  return {
    id: "sb-test-123",
    state: "started",
    process: {
      executeCommand: mock(() => Promise.resolve(makeExecuteResult("exists"))),
      createSession: mock(() => Promise.resolve()),
      executeSessionCommand: mock(() => Promise.resolve()),
      deleteSession: mock(() => Promise.resolve()),
    },
    fs: {
      uploadFile: mock(() => Promise.resolve()),
    },
    getSignedPreviewUrl: mock(() =>
      Promise.resolve({ url: "https://sandbox.example.com" }),
    ),
    getPreviewLink: mock(() =>
      Promise.resolve({ url: "https://sandbox.example.com" }),
    ),
    refreshActivity: mock(() => Promise.resolve()),
    start: mock(() => Promise.resolve()),
    stop: mock(() => Promise.resolve()),
    setLabels: mock(() => Promise.resolve({})),
    ...overrides,
  } as unknown as Sandbox
}

// ── Shared mock state ────────────────────────────────────────────────────

let activeSandbox = createMockSandbox()

const mockGetWorkspace = mock((id: string) =>
  Promise.resolve({
    id,
    project_id: "proj-1",
    directory: "/workspace",
    kind: "cloud" as const,
    repo_url: "https://github.com/test/repo.git",
    remote_directory: "/workspace",
    created_at: Date.now(),
    updated_at: Date.now(),
  }),
)

const mockAcquire = mock(() => Promise.resolve(activeSandbox))

const mockLoadUserConfig = mock(() =>
  Promise.resolve({ mcp: {}, auth: {} }),
)

// ── Module mocks (must be before import) ─────────────────────────────────

mock.module("../workspace-store", () => ({
  getWorkspace: (...args: any[]) => mockGetWorkspace(...args),
}))

mock.module("./sandbox-pool", () => ({
  acquire: (...args: any[]) => mockAcquire(...args),
  release: mock(() => Promise.resolve()),
  initPool: mock(() => Promise.resolve()),
  startPoolMonitor: mock(() => {}),
  shutdown: mock(() => {}),
}))

mock.module("../agent-config", () => ({
  loadUserConfig: (...args: any[]) => mockLoadUserConfig(...args),
  defaultRunner: mock(() => ({})),
}))

// Mock fs for runtime bundle reads
mock.module("fs", () => {
  const actual = require("node:fs")
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: mock(() => Buffer.from("// mock runtime")),
      existsSync: mock(() => true),
    },
    readFileSync: mock(() => Buffer.from("// mock runtime")),
    existsSync: mock(() => true),
  }
})

// Mock fetch for health checks + config push
globalThis.fetch = mock((url: string | URL | Request) => {
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

// ── Tests ────────────────────────────────────────────────────────────────

describe("workspace-supervisor", () => {
  beforeEach(() => {
    activeSandbox = createMockSandbox()
    mockAcquire.mockImplementation(() => Promise.resolve(activeSandbox))
    mockGetWorkspace.mockImplementation((id: string) =>
      Promise.resolve({
        id,
        project_id: "proj-1",
        directory: "/workspace",
        kind: "cloud" as const,
        repo_url: "https://github.com/test/repo.git",
        remote_directory: "/workspace",
        created_at: Date.now(),
        updated_at: Date.now(),
      }),
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
      const call = mockAcquire.mock.calls.find((c) => c[0] === "ws-pool-1")
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
        process: {
          executeCommand: mock(() => Promise.resolve(makeExecuteResult("missing"))),
          createSession: mock(() => Promise.resolve()),
          executeSessionCommand: mock(() => Promise.resolve()),
          deleteSession: mock(() => Promise.resolve()),
        },
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
        "uploading_runtime",
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
      expect(steps).not.toContain("uploading_runtime")
      expect(steps).toContain("acquiring_sandbox")
      expect(steps).toContain("starting_runtime")
      expect(steps).toContain("ready")

      tracker.cleanup()
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
      expect(steps).not.toContain("uploading_runtime")
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

      expect(activeSandbox.process.deleteSession).toHaveBeenCalledWith("wr-ws-stop-1")
    })

    test("sets status to stopped and clears url", async () => {
      const entry = await supervisor.ensureWorkspaceRuntime("ws-stop-2")
      expect(entry.status).toBe("ready")
      expect(entry.url).toBeTruthy()

      await supervisor.stopRuntime("ws-stop-2", "test")

      expect(entry.status).toBe("stopped")
      expect(entry.url).toBeUndefined()
      expect(entry.port).toBeUndefined()
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
      const acquireCalls = mockAcquire.mock.calls.filter(
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
    expect(steps).not.toContain("uploading_runtime")
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
