/**
 * Tests for sandbox-pool: acquire, release, initPool, startPoolMonitor, shutdown.
 *
 * Uses vi.doMock to replace external dependencies (@daytonaio/sdk, agent-config,
 * sandbox/image, provider) so the REAL pool logic is exercised.
 */

import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"

// ── Mock state ────────────────────────────────────────────────────────────

function makeSandbox(id: string, state: string, labels: Record<string, string> = {}) {
  return {
    id,
    state,
    labels: { ...labels },
    setLabels: vi.fn((newLabels: Record<string, string>) => {
      Object.assign(labels, newLabels)
      return Promise.resolve(labels)
    }),
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
  }
}

let warmSandboxes: ReturnType<typeof makeSandbox>[] = []
let createdSandboxes: ReturnType<typeof makeSandbox>[] = []
let deletedIds: string[] = []
let createCount = 0
let provider = "daytona"
let auth: { api_key: string } | undefined = { api_key: "test-key" }

const mockDaytona = {
  create: vi.fn((opts: any) => {
    const sb = makeSandbox(`sb-new-${createCount++}`, "started", opts.labels ?? {})
    createdSandboxes.push(sb)
    return Promise.resolve(sb)
  }),
  list: vi.fn((_labels: Record<string, string>) => {
    return Promise.resolve({
      items: [...warmSandboxes],
    })
  }),
  get: vi.fn((id: string) => {
    const sb = [...warmSandboxes, ...createdSandboxes].find((s) => s.id === id)
    if (!sb) throw new Error(`sandbox not found: ${id}`)
    return Promise.resolve(sb)
  }),
  delete: vi.fn((sb: any) => {
    deletedIds.push(sb.id)
    return Promise.resolve()
  }),
}

// ── Module mocks (before import) ──────────────────────────────────────────

vi.doMock("@daytonaio/sdk", () => ({
  Daytona: class {
    constructor() {
      return mockDaytona
    }
  },
  SandboxState: { STARTED: "started", STOPPED: "stopped", ERROR: "error" },
}))

vi.doMock("../agent-config", () => ({
  loadUserConfig: vi.fn(() =>
    Promise.resolve({
      sandbox: {
        ...(provider ? { default_provider: provider } : {}),
        auth: auth ? { daytona: { api_key: auth.api_key } } : {},
      },
    }),
  ),
}))

vi.doMock("./sandbox/image", () => ({
  ensureSnapshot: vi.fn(() => Promise.resolve("test-snapshot")),
  RUNTIME_PORT: 4318,
  RUNTIME_DIR: "/opt/workspace-runtime",
  WORKSPACE_DIR: "/workspace",
  SANDBOX_IMAGE: "ghcr.io/claxedo/test:latest",
}))

vi.doMock("../credentials/registry", () => ({
  getCredentialByProvider: vi.fn(() => undefined),
  resolveSecret: vi.fn(() => Promise.resolve(undefined)),
}))

vi.doMock("../network/resolve", () => ({
  formatDaytonaAllowList: vi.fn((cidrs: string[]) => cidrs),
}))

vi.doMock("../log", () => ({
  Log: {
    create: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  },
}))

// ── Import real module under test ─────────────────────────────────────────

const pool = await import("./sandbox")

// ── Tests ─────────────────────────────────────────────────────────────────

describe("sandbox-pool", () => {
  beforeEach(() => {
    warmSandboxes = []
    createdSandboxes = []
    deletedIds = []
    createCount = 0
    provider = "daytona"
    auth = { api_key: "test-key" }
    ;(mockDaytona.create as any).mockClear()
    ;(mockDaytona.list as any).mockClear()
    ;(mockDaytona.delete as any).mockClear()
    ;(mockDaytona.get as any).mockClear()
  })

  afterEach(() => {
    pool.shutdown()
  })

  // ── acquire ──────────────────────────────────────────────────────

  describe("acquire", () => {
    test("returns warm sandbox when one is available (STARTED state)", async () => {
      const warm = makeSandbox("sb-warm-1", "started", { app: "claxedo", pool: "warm", snapshot: "" })
      warmSandboxes = [warm]

      const result = await pool.acquire("ws-1", "proj-1")

      expect(result.id).toBe("sb-warm-1")
      expect(warm.setLabels).toHaveBeenCalledWith({
        app: "claxedo",
        pool: "assigned",
        workspace_id: "ws-1",
        project_id: "proj-1",
      })
      // Should NOT cold-create
      expect(mockDaytona.create).not.toHaveBeenCalled()
    })

    test("cold-creates sandbox when warm pool is exhausted", async () => {
      warmSandboxes = []

      const result = await pool.acquire("ws-1", "proj-1")

      expect(result.id).toContain("sb-new")
      expect(mockDaytona.create).toHaveBeenCalled()
    })

    test("fails when warm lookup hangs", async () => {
      ;(mockDaytona.list as any).mockImplementationOnce(() => new Promise(() => {}))

      await expect(pool.acquire("ws-timeout-1", "proj-1")).rejects.toThrow(
        /daytona warm lookup timed out|daytona list warm sandboxes timed out/,
      )
    }, 65_000)

    test("fails when cold create hangs", async () => {
      warmSandboxes = []
      ;(mockDaytona.create as any).mockImplementationOnce(() => new Promise(() => {}))

      await expect(pool.acquire("ws-timeout-2", "proj-1")).rejects.toThrow(
        /daytona create sandbox timed out/,
      )
    }, 65_000)

    test("skips non-STARTED sandboxes in warm pool", async () => {
      const stopped = makeSandbox("sb-stopped-1", "stopped", { app: "claxedo", pool: "warm", snapshot: "" })
      const started = makeSandbox("sb-started-1", "started", { app: "claxedo", pool: "warm", snapshot: "" })
      warmSandboxes = [stopped, started]

      const result = await pool.acquire("ws-1", "proj-1")

      expect(result.id).toBe("sb-started-1")
    })

    test("relabels acquired sandbox as 'assigned'", async () => {
      const warm = makeSandbox("sb-warm-2", "started", { app: "claxedo", pool: "warm", snapshot: "" })
      warmSandboxes = [warm]

      await pool.acquire("ws-test", "proj-test")

      expect(warm.setLabels).toHaveBeenCalledWith(
        expect.objectContaining({
          pool: "assigned",
          workspace_id: "ws-test",
          project_id: "proj-test",
        }),
      )
    })

    test("creates a sandbox from an explicit snapshot", async () => {
      await pool.acquireFromSnapshot("ws-snap", "proj-1", "snap-1")

      expect(mockDaytona.create).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshot: "snap-1",
          labels: expect.objectContaining({
            workspace_id: "ws-snap",
            project_id: "proj-1",
          }),
        }),
      )
    })

    test("creates a sandbox from an explicit image", async () => {
      await pool.acquireFromImage("ws-img", "proj-1", "img-1")

      expect(mockDaytona.create).toHaveBeenCalledWith(
        expect.objectContaining({
          image: "img-1",
          labels: expect.objectContaining({
            workspace_id: "ws-img",
            project_id: "proj-1",
          }),
        }),
      )
    })
  })

  // ── release ──────────────────────────────────────────────────────

  describe("release", () => {
    test("deletes sandbox on release", async () => {
      const destroy = vi.fn(() => Promise.resolve())

      await pool.release({
        provider: "daytona",
        id: "sb-release-1",
        executeCommand: vi.fn(),
        uploadFile: vi.fn(),
        createSession: vi.fn(),
        executeSessionCommand: vi.fn(),
        deleteSession: vi.fn(),
        getServiceUrl: vi.fn(),
        refreshActivity: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        destroy,
        setLabels: vi.fn(),
      })

      expect(destroy).toHaveBeenCalled()
    })

    test("release does NOT call sandbox.stop() — deletes entirely", async () => {
      const stop = vi.fn(() => Promise.resolve())
      const destroy = vi.fn(() => Promise.resolve())

      await pool.release({
        provider: "daytona",
        id: "sb-release-2",
        executeCommand: vi.fn(),
        uploadFile: vi.fn(),
        createSession: vi.fn(),
        executeSessionCommand: vi.fn(),
        deleteSession: vi.fn(),
        getServiceUrl: vi.fn(),
        refreshActivity: vi.fn(),
        start: vi.fn(),
        stop,
        destroy,
        setLabels: vi.fn(),
      })

      expect(stop).not.toHaveBeenCalled()
      expect(destroy).toHaveBeenCalled()
    })

    test("release handles missing sandbox gracefully", async () => {
      const destroy = vi.fn(() => Promise.reject(new Error("not found")))

      // Should not throw
      await pool.release({
        provider: "daytona",
        id: "nonexistent",
        executeCommand: vi.fn(),
        uploadFile: vi.fn(),
        createSession: vi.fn(),
        executeSessionCommand: vi.fn(),
        deleteSession: vi.fn(),
        getServiceUrl: vi.fn(),
        refreshActivity: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        destroy,
        setLabels: vi.fn(),
      })
    })
  })

  // ── initPool ────────────────────────────────────────────────────

  describe("initPool", () => {
    test("calls ensureSnapshot and replenishes pool with one warm sandbox", async () => {
      warmSandboxes = []

      await pool.initPool()

      expect(mockDaytona.create).toHaveBeenCalledTimes(1)
    })

    test("no-ops when Daytona auth is missing", async () => {
      auth = undefined

      await pool.initPool()

      expect(mockDaytona.create).not.toHaveBeenCalled()
    })

    test("no-ops when default provider is not Daytona", async () => {
      provider = "modal"

      await pool.initPool()

      expect(mockDaytona.create).not.toHaveBeenCalled()
    })

    test("prunes excess warm sandboxes down to one", async () => {
      warmSandboxes = [
        makeSandbox("sb-warm-1", "started", { app: "claxedo", pool: "warm", snapshot: "" }),
        makeSandbox("sb-warm-2", "started", { app: "claxedo", pool: "warm", snapshot: "" }),
        makeSandbox("sb-warm-3", "started", { app: "claxedo", pool: "warm", snapshot: "" }),
      ]

      await pool.initPool()

      expect(mockDaytona.delete).toHaveBeenCalledTimes(2)
      expect(deletedIds).toEqual(["sb-warm-2", "sb-warm-3"])
      expect(mockDaytona.create).not.toHaveBeenCalled()
    })
  })

  // ── startPoolMonitor / shutdown ─────────────────────────────────

  describe("startPoolMonitor / shutdown", () => {
    test("startPoolMonitor and shutdown are idempotent", () => {
      pool.startPoolMonitor()
      pool.startPoolMonitor() // second call should be no-op
      pool.shutdown()
      pool.shutdown() // second call should be no-op
    })
  })
})
