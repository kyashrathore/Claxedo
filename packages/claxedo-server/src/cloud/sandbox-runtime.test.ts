import { describe, expect, test, beforeEach, vi } from "vitest"
import type { SandboxHandle } from "./sandbox-handle"
import { claxedoBus, type ClaxedoEvent } from "../bus"

// ── Helpers ──────────────────────────────────────────────────────────────

function captureProvisionEvents() {
  const events: ClaxedoEvent[] = []
  const unsub = claxedoBus.subscribe((e) => {
    if (e.type === "provision") events.push(e)
  })
  return { events, cleanup: unsub }
}

function createMockSandbox(overrides?: Partial<SandboxHandle>): SandboxHandle {
  return {
    id: "sb-test-123",
    executeCommand: vi.fn(() => Promise.resolve({ result: "missing" })),
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
    ...overrides,
  }
}

// ── Import module under test ────────────────────────────────────────────

import * as sandboxRuntime from "./sandbox-runtime"

// ── Tests ────────────────────────────────────────────────────────────────

describe("sandbox-runtime", () => {
  describe("deployAndStart", () => {
    let sandbox: SandboxHandle
    let tracker: ReturnType<typeof captureProvisionEvents>

    beforeEach(() => {
      sandbox = createMockSandbox()
      tracker = captureProvisionEvents()

      // Mock fetch for health checks — succeed immediately
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
      ) as any
    })

    // ── Fresh deployment ─────────────────────────────────────────────

    test("full fresh deployment: clones repo, installs runtime, starts process", async () => {
      ;(sandbox.executeCommand as any)
        .mockResolvedValueOnce({ result: "" }) // mkdir
        .mockResolvedValueOnce({ result: "missing" }) // git check
        .mockResolvedValueOnce({ result: "missing" }) // runtime check

      const result = await sandboxRuntime.deployAndStart(sandbox, "ws-1", {
        repoUrl: "https://github.com/test/repo.git",
        directory: "/workspace",
      })

      expect(result.url).toBe("https://sandbox.example.com")

      // Verify clone was called
      const cmds = (sandbox.executeCommand as any).mock.calls
      const cloneCall = cmds.find((c: any[]) =>
        c[0]?.includes("git clone"),
      )
      expect(cloneCall).toBeTruthy()
      expect(cloneCall[0]).toContain("https://github.com/test/repo.git")

      // Verify npm install was called (not uploadFile)
      const installCall = cmds.find((c: any[]) =>
        c[0]?.includes("npm install"),
      )
      expect(installCall).toBeTruthy()
      expect(sandbox.uploadFile).not.toHaveBeenCalled()

      // Verify session created and command executed
      expect(sandbox.createSession).toHaveBeenCalledWith("wr-ws-1")
      expect(sandbox.executeSessionCommand).toHaveBeenCalled()

      tracker.cleanup()
    })

    // ── Skip clone when repo exists ─────────────────────────────────

    test("skips clone when .git directory already exists", async () => {
      ;(sandbox.executeCommand as any)
        .mockResolvedValueOnce({ result: "" }) // mkdir
        .mockResolvedValueOnce({ result: "exists" }) // git check → exists
        .mockResolvedValueOnce({ result: "missing" }) // runtime check

      await sandboxRuntime.deployAndStart(sandbox, "ws-2", {
        repoUrl: "https://github.com/test/repo.git",
        directory: "/workspace",
      })

      const cmds = (sandbox.executeCommand as any).mock.calls
      const cloneCall = cmds.find((c: any[]) =>
        c[0]?.includes("git clone"),
      )
      expect(cloneCall).toBeUndefined()

      tracker.cleanup()
    })

    // ── Skip install when runtime exists ─────────────────────────────

    test("skips npm install when runtime already exists", async () => {
      ;(sandbox.executeCommand as any)
        .mockResolvedValueOnce({ result: "" }) // mkdir
        .mockResolvedValueOnce({ result: "exists" }) // git check
        .mockResolvedValueOnce({ result: "exists" }) // runtime check → exists

      await sandboxRuntime.deployAndStart(sandbox, "ws-3", {
        repoUrl: "https://github.com/test/repo.git",
        directory: "/workspace",
      })

      const cmds = (sandbox.executeCommand as any).mock.calls
      const installCall = cmds.find((c: any[]) =>
        c[0]?.includes("npm install"),
      )
      expect(installCall).toBeUndefined()

      tracker.cleanup()
    })

    // ── Both exist: only restart process ─────────────────────────────

    test("when repo and runtime both exist, only restarts process and waits for health", async () => {
      ;(sandbox.executeCommand as any)
        .mockResolvedValueOnce({ result: "" }) // mkdir
        .mockResolvedValueOnce({ result: "exists" }) // git check
        .mockResolvedValueOnce({ result: "exists" }) // runtime check

      const result = await sandboxRuntime.deployAndStart(sandbox, "ws-4", {
        repoUrl: "https://github.com/test/repo.git",
        directory: "/workspace",
      })

      // No clone, no install
      const cmds = (sandbox.executeCommand as any).mock.calls
      expect(cmds.find((c: any[]) => c[0]?.includes("git clone"))).toBeUndefined()
      expect(cmds.find((c: any[]) => c[0]?.includes("npm install"))).toBeUndefined()

      // But session + process start + health check still happened
      expect(sandbox.createSession).toHaveBeenCalledWith("wr-ws-4")
      expect(sandbox.executeSessionCommand).toHaveBeenCalled()
      expect(result.url).toBeTruthy()

      tracker.cleanup()
    })

    // ── No repo URL means no clone attempt ───────────────────────────

    test("no clone attempted when repoUrl is not provided", async () => {
      ;(sandbox.executeCommand as any)
        .mockResolvedValueOnce({ result: "missing" }) // runtime check

      await sandboxRuntime.deployAndStart(sandbox, "ws-5", {
        directory: "/workspace",
      })

      const cmds = (sandbox.executeCommand as any).mock.calls
      // Only runtime check, no git check
      expect(cmds.find((c: any[]) => c[0]?.includes("git clone"))).toBeUndefined()
      expect(cmds.find((c: any[]) => c[0]?.includes(".git"))).toBeUndefined()

      tracker.cleanup()
    })

    // ── Session creation is idempotent ───────────────────────────────

    test("session creation is idempotent — does not throw if session exists", async () => {
      ;(sandbox.executeCommand as any)
        .mockResolvedValueOnce({ result: "exists" })
        .mockResolvedValueOnce({ result: "exists" })
      ;(sandbox.createSession as any).mockRejectedValueOnce(
        new Error("session already exists"),
      )

      // Should not throw
      const result = await sandboxRuntime.deployAndStart(sandbox, "ws-6", {
        directory: "/workspace",
      })
      expect(result.url).toBeTruthy()

      tracker.cleanup()
    })

    // ── Environment variables ────────────────────────────────────────

    test("passes correct environment variables to runtime process", async () => {
      ;(sandbox.executeCommand as any)
        .mockResolvedValueOnce({ result: "exists" })
        .mockResolvedValueOnce({ result: "exists" })

      await sandboxRuntime.deployAndStart(sandbox, "ws-7", {
        directory: "/custom/dir",
        envVars: { CUSTOM_VAR: "value" },
      })

      const sessionCmd = (sandbox.executeSessionCommand as any).mock.calls[0]
      const command = sessionCmd[1].command as string
      expect(command).toContain("CLAXEDO_WR_PORT=")
      expect(command).toContain("CLAXEDO_WR_WORKSPACE_ID=ws-7")
      expect(command).toContain("CLAXEDO_WR_DIRECTORY=/custom/dir")
      expect(command).toContain("CUSTOM_VAR=value")
      expect(command).toContain("node ")

      tracker.cleanup()
    })

    // ── Provision events emitted in correct order ────────────────────

    test("emits provision events in correct order for full deployment", async () => {
      ;(sandbox.executeCommand as any)
        .mockResolvedValueOnce({ result: "" }) // mkdir
        .mockResolvedValueOnce({ result: "missing" }) // git check
        .mockResolvedValueOnce({ result: "missing" }) // runtime check

      await sandboxRuntime.deployAndStart(sandbox, "ws-8", {
        repoUrl: "https://github.com/test/repo.git",
        directory: "/workspace",
      })

      const steps = tracker.events
        .filter((e): e is Extract<ClaxedoEvent, { type: "provision" }> => e.type === "provision")
        .map((e) => e.step)

      expect(steps).toEqual([
        "cloning",
        "installing_runtime",
        "starting_runtime",
        "waiting_health",
        "ready",
      ])

      tracker.cleanup()
    })

    test("emits provision events in correct order for warm wake (both exist)", async () => {
      ;(sandbox.executeCommand as any)
        .mockResolvedValueOnce({ result: "" }) // mkdir
        .mockResolvedValueOnce({ result: "exists" })
        .mockResolvedValueOnce({ result: "exists" })

      await sandboxRuntime.deployAndStart(sandbox, "ws-9", {
        repoUrl: "https://github.com/test/repo.git",
        directory: "/workspace",
      })

      const steps = tracker.events
        .filter((e): e is Extract<ClaxedoEvent, { type: "provision" }> => e.type === "provision")
        .map((e) => e.step)

      // clone and install skipped — no events for those
      expect(steps).toEqual([
        "starting_runtime",
        "waiting_health",
        "ready",
      ])

      tracker.cleanup()
    })

    test("ready event includes totalMs", async () => {
      ;(sandbox.executeCommand as any)
        .mockResolvedValueOnce({ result: "exists" })
        .mockResolvedValueOnce({ result: "exists" })

      await sandboxRuntime.deployAndStart(sandbox, "ws-10", {
        directory: "/workspace",
      })

      const readyEvent = tracker.events.find(
        (e): e is Extract<ClaxedoEvent, { type: "provision" }> =>
          e.type === "provision" && (e as any).step === "ready",
      )
      expect(readyEvent).toBeTruthy()
      expect((readyEvent as any).totalMs).toBeGreaterThanOrEqual(0)

      tracker.cleanup()
    })

    test("provision events include workspaceId", async () => {
      ;(sandbox.executeCommand as any)
        .mockResolvedValueOnce({ result: "exists" })
        .mockResolvedValueOnce({ result: "exists" })

      await sandboxRuntime.deployAndStart(sandbox, "ws-11", {
        directory: "/workspace",
      })

      for (const event of tracker.events) {
        if (event.type === "provision") {
          expect(event.workspaceId).toBe("ws-11")
        }
      }

      tracker.cleanup()
    })

    // ── Health check failure ─────────────────────────────────────────

    test("throws when health check fails after max retries", async () => {
      ;(sandbox.executeCommand as any)
        .mockResolvedValueOnce({ result: "exists" })
        .mockResolvedValueOnce({ result: "exists" })

      // Make all fetch calls fail (health check)
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response("error", { status: 500 })),
      ) as any

      await expect(
        sandboxRuntime.deployAndStart(sandbox, "ws-12", {
          directory: "/workspace",
        }),
      ).rejects.toThrow(/health check failed/)

      tracker.cleanup()
    }, 90_000)

    // ── URL resolution ───────────────────────────────────────────────

    test("uses service URL from sandbox handle", async () => {
      ;(sandbox.executeCommand as any)
        .mockResolvedValueOnce({ result: "exists" })
        .mockResolvedValueOnce({ result: "exists" })

      ;(sandbox.getServiceUrl as any).mockResolvedValueOnce("https://signed.example.com")

      const result = await sandboxRuntime.deployAndStart(sandbox, "ws-13", {
        directory: "/workspace",
      })

      expect(result.url).toBe("https://signed.example.com")

      tracker.cleanup()
    })

    // ── Default directory ────────────────────────────────────────────

    test("uses WORKSPACE_DIR as default directory", async () => {
      ;(sandbox.executeCommand as any)
        .mockResolvedValueOnce({ result: "exists" })
        .mockResolvedValueOnce({ result: "exists" })

      await sandboxRuntime.deployAndStart(sandbox, "ws-15", {})

      const sessionCmd = (sandbox.executeSessionCommand as any).mock.calls[0]
      const command = sessionCmd[1].command as string
      expect(command).toContain("CLAXEDO_WR_DIRECTORY=/workspace")

      tracker.cleanup()
    })

    // ── Clone timeout ────────────────────────────────────────────────

    test("clone command has 120 second timeout", async () => {
      ;(sandbox.executeCommand as any)
        .mockResolvedValueOnce({ result: "" }) // mkdir
        .mockResolvedValueOnce({ result: "missing" }) // git check
        .mockResolvedValueOnce({ result: "missing" }) // runtime check

      await sandboxRuntime.deployAndStart(sandbox, "ws-16", {
        repoUrl: "https://github.com/test/repo.git",
        directory: "/workspace",
      })

      const cmds = (sandbox.executeCommand as any).mock.calls
      const cloneCall = cmds.find((c: any[]) => c[0]?.includes("git clone"))
      // 2nd argument is timeout = 120
      expect(cloneCall?.[1]).toBe(120)

      tracker.cleanup()
    })

    // ── Async runtime start ──────────────────────────────────────────

    test("runtime process is started with runAsync: true", async () => {
      ;(sandbox.executeCommand as any)
        .mockResolvedValueOnce({ result: "exists" })
        .mockResolvedValueOnce({ result: "exists" })

      await sandboxRuntime.deployAndStart(sandbox, "ws-17", {
        directory: "/workspace",
      })

      const sessionCmd = (sandbox.executeSessionCommand as any).mock.calls[0]
      expect(sessionCmd[1].runAsync).toBe(true)

      tracker.cleanup()
    })

    // ── npm install timeout ──────────────────────────────────────────

    test("npm install has 300 second timeout", async () => {
      ;(sandbox.executeCommand as any)
        .mockResolvedValueOnce({ result: "" }) // mkdir
        .mockResolvedValueOnce({ result: "missing" }) // runtime check

      await sandboxRuntime.deployAndStart(sandbox, "ws-18", {
        directory: "/workspace",
      })

      const cmds = (sandbox.executeCommand as any).mock.calls
      const installCall = cmds.find((c: any[]) => c[0]?.includes("npm install"))
      expect(installCall?.[1]).toBe(300)

      tracker.cleanup()
    })
  })

  // ── stopRemoteRuntime ──────────────────────────────────────────────────

  describe("stopRemoteRuntime", () => {
    test("deletes the workspace session", async () => {
      const sandbox = createMockSandbox()

      await sandboxRuntime.stopRemoteRuntime(sandbox, "ws-stop-1")

      expect(sandbox.deleteSession).toHaveBeenCalledWith("wr-ws-stop-1")
    })

    test("does not throw if session deletion fails", async () => {
      const sandbox = createMockSandbox()
      ;(sandbox.deleteSession as any).mockRejectedValueOnce(
        new Error("session not found"),
      )

      // Should not throw
      await sandboxRuntime.stopRemoteRuntime(sandbox, "ws-stop-2")
    })

    test("does NOT stop the sandbox itself — only the runtime session", async () => {
      const sandbox = createMockSandbox()

      await sandboxRuntime.stopRemoteRuntime(sandbox, "ws-stop-3")

      expect(sandbox.stop).not.toHaveBeenCalled()
    })
  })

  // ── emitProvision ──────────────────────────────────────────────────────

  describe("emitProvision", () => {
    test("publishes provision event with correct fields", () => {
      const tracker = captureProvisionEvents()

      sandboxRuntime.emitProvision("ws-emit-1", "cloning", { message: "https://github.com/test/repo" })

      expect(tracker.events).toHaveLength(1)
      const event = tracker.events[0] as Extract<ClaxedoEvent, { type: "provision" }>
      expect(event.type).toBe("provision")
      expect(event.workspaceId).toBe("ws-emit-1")
      expect(event.step).toBe("cloning")
      expect(event.message).toBe("https://github.com/test/repo")
      expect(event.ts).toBeGreaterThan(0)

      tracker.cleanup()
    })

    test("publishes without extra fields", () => {
      const tracker = captureProvisionEvents()

      sandboxRuntime.emitProvision("ws-emit-2", "ready")

      const event = tracker.events[0] as any
      expect(event.workspaceId).toBe("ws-emit-2")
      expect(event.step).toBe("ready")

      tracker.cleanup()
    })
  })
})
