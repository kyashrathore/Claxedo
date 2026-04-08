/**
 * Tests for sandbox-pool: acquire, release, initPool, startPoolMonitor, shutdown.
 *
 * Uses mock.module to replace external dependencies (@daytonaio/sdk, agent-config,
 * sandbox-image, provider) so the REAL pool logic is exercised.
 */

import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test"

// ── Mock state ────────────────────────────────────────────────────────────

function makeSandbox(id: string, state: string, labels: Record<string, string> = {}) {
  return {
    id,
    state,
    labels: { ...labels },
    setLabels: mock((newLabels: Record<string, string>) => {
      Object.assign(labels, newLabels)
      return Promise.resolve(labels)
    }),
    start: mock(() => Promise.resolve()),
    stop: mock(() => Promise.resolve()),
  }
}

let warmSandboxes: ReturnType<typeof makeSandbox>[] = []
let createdSandboxes: ReturnType<typeof makeSandbox>[] = []
let deletedIds: string[] = []
let createCount = 0

const mockDaytona = {
  create: mock((opts: any) => {
    const sb = makeSandbox(`sb-new-${createCount++}`, "started", opts.labels ?? {})
    createdSandboxes.push(sb)
    return Promise.resolve(sb)
  }),
  list: mock((_labels: Record<string, string>) => {
    return Promise.resolve({
      items: [...warmSandboxes],
    })
  }),
  get: mock((id: string) => {
    const sb = [...warmSandboxes, ...createdSandboxes].find((s) => s.id === id)
    if (!sb) throw new Error(`sandbox not found: ${id}`)
    return Promise.resolve(sb)
  }),
  delete: mock((sb: any) => {
    deletedIds.push(sb.id)
    return Promise.resolve()
  }),
}

// ── Module mocks (before import) ──────────────────────────────────────────

mock.module("@daytonaio/sdk", () => ({
  Daytona: class {
    constructor() {
      return mockDaytona
    }
  },
  SandboxState: { STARTED: "started", STOPPED: "stopped", ERROR: "error" },
}))

mock.module("../agent-config", () => ({
  loadUserConfig: mock(() =>
    Promise.resolve({
      sandbox: { auth: { daytona: { api_key: "test-key" } } },
    }),
  ),
}))

mock.module("./sandbox-image", () => ({
  ensureSnapshot: mock(() => Promise.resolve("test-snapshot")),
}))

mock.module("./provider", () => ({
  sandboxAuth: mock((_cfg: any, _provider: string) => ({ api_key: "test-key" })),
}))

mock.module("../log", () => ({
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

const pool = await import("./sandbox-pool")

// ── Tests ─────────────────────────────────────────────────────────────────

describe("sandbox-pool", () => {
  beforeEach(() => {
    warmSandboxes = []
    createdSandboxes = []
    deletedIds = []
    createCount = 0
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
  })

  // ── release ──────────────────────────────────────────────────────

  describe("release", () => {
    test("deletes sandbox on release", async () => {
      const sb = makeSandbox("sb-release-1", "started", {})
      warmSandboxes = [sb]
      ;(mockDaytona.get as any).mockImplementation(() => Promise.resolve(sb))

      await pool.release("sb-release-1")

      expect(deletedIds).toContain("sb-release-1")
    })

    test("release does NOT call sandbox.stop() — deletes entirely", async () => {
      const sb = makeSandbox("sb-release-2", "started", {})
      ;(mockDaytona.get as any).mockImplementation(() => Promise.resolve(sb))

      await pool.release("sb-release-2")

      expect(sb.stop).not.toHaveBeenCalled()
      expect(deletedIds).toContain("sb-release-2")
    })

    test("release handles missing sandbox gracefully", async () => {
      ;(mockDaytona.get as any).mockImplementation(() =>
        Promise.reject(new Error("not found")),
      )

      // Should not throw
      await pool.release("nonexistent")
    })
  })

  // ── initPool ────────────────────────────────────────────────────

  describe("initPool", () => {
    test("calls ensureSnapshot and replenishes pool", async () => {
      warmSandboxes = []

      await pool.initPool()

      // Should have created sandboxes to reach POOL_TARGET (3)
      expect(mockDaytona.create).toHaveBeenCalled()
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
