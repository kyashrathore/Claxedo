import { describe, expect, test, beforeEach, vi } from "vitest"
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

function createMockSandbox(overrides?: Partial<Sandbox>): Sandbox {
  return {
    id: "sb-test-123",
    state: "started" as any,
    process: {
      executeCommand: vi.fn(() => Promise.resolve(makeExecuteResult("missing"))),
      createSession: vi.fn(() => Promise.resolve()),
      executeSessionCommand: vi.fn(() => Promise.resolve()),
      deleteSession: vi.fn(() => Promise.resolve()),
    },
    fs: {
      uploadFile: vi.fn(() => Promise.resolve()),
    },
    getSignedPreviewUrl: vi.fn(() =>
      Promise.resolve({ url: "https://sandbox.example.com" }),
    ),
    getPreviewLink: vi.fn(() =>
      Promise.resolve({ url: "https://sandbox.example.com" }),
    ),
    refreshActivity: vi.fn(() => Promise.resolve()),
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    setLabels: vi.fn(() => Promise.resolve({})),
    ...overrides,
  } as unknown as Sandbox
}

// ── Mock fs module ───────────────────────────────────────────────────────

// We mock the runtime.mjs file read so deployAndStart doesn't hit real filesystem
const FAKE_BUNDLE = Buffer.from("// runtime.mjs mock content")

// We need to mock fs before importing the module
const originalReadFileSync = (await import("fs")).readFileSync
const originalExistsSync = (await import("fs")).existsSync

// ── Import module under test ────────────────────────────────────────────

import * as sandboxRuntime from "./sandbox-runtime"

// ── Mock fetch for health checks ────────────────────────────────────────

const originalFetch = globalThis.fetch

// ── Tests ────────────────────────────────────────────────────────────────

describe("sandbox-runtime", () => {
  describe("deployAndStart", () => {
    let sandbox: Sandbox
    let tracker: ReturnType<typeof captureProvisionEvents>

    beforeEach(() => {
      sandbox = createMockSandbox()
      tracker = captureProvisionEvents()

      // Mock fs.readFileSync and fs.existsSync for the runtime bundle
      const fsModule = require("fs")
      fsModule.readFileSync = vi.fn((_path: string) => FAKE_BUNDLE)
      fsModule.existsSync = vi.fn((_path: string) => true)

      // Mock fetch for health checks — succeed immediately
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
      ) as any
    })

    // ── Fresh deployment ─────────────────────────────────────────────

    test("full fresh deployment: clones repo, uploads runtime, starts process", async () => {
      // Both checks return "missing"
      ;(sandbox.process.executeCommand as any)
        .mockResolvedValueOnce(makeExecuteResult("missing")) // git check
        .mockResolvedValueOnce(makeExecuteResult("missing")) // runtime check

      const result = await sandboxRuntime.deployAndStart(sandbox, "ws-1", {
        repoUrl: "https://github.com/test/repo.git",
        directory: "/workspace",
      })

      expect(result.url).toBe("https://sandbox.example.com")

      // Verify clone was called
      const cmds = (sandbox.process.executeCommand as any).mock.calls
      expect(cmds.length).toBe(3) // git check + runtime check + clone
      const cloneCall = cmds.find((c: any[]) =>
        c[0]?.includes("git clone"),
      )
      expect(cloneCall).toBeTruthy()
      expect(cloneCall[0]).toContain("https://github.com/test/repo.git")

      // Verify runtime upload was called
      expect(sandbox.fs.uploadFile).toHaveBeenCalled()

      // Verify session created and command executed
      expect(sandbox.process.createSession).toHaveBeenCalledWith("wr-ws-1")
      expect(sandbox.process.executeSessionCommand).toHaveBeenCalled()

      tracker.cleanup()
    })

    // ── Skip clone when repo exists ─────────────────────────────────

    test("skips clone when .git directory already exists", async () => {
      ;(sandbox.process.executeCommand as any)
        .mockResolvedValueOnce(makeExecuteResult("exists")) // git check → exists
        .mockResolvedValueOnce(makeExecuteResult("missing")) // runtime check

      await sandboxRuntime.deployAndStart(sandbox, "ws-2", {
        repoUrl: "https://github.com/test/repo.git",
        directory: "/workspace",
      })

      const cmds = (sandbox.process.executeCommand as any).mock.calls
      const cloneCall = cmds.find((c: any[]) =>
        c[0]?.includes("git clone"),
      )
      expect(cloneCall).toBeUndefined()

      tracker.cleanup()
    })

    // ── Skip upload when runtime exists ──────────────────────────────

    test("skips runtime upload when runtime.mjs already exists", async () => {
      ;(sandbox.process.executeCommand as any)
        .mockResolvedValueOnce(makeExecuteResult("exists")) // git check
        .mockResolvedValueOnce(makeExecuteResult("exists")) // runtime check → exists

      await sandboxRuntime.deployAndStart(sandbox, "ws-3", {
        repoUrl: "https://github.com/test/repo.git",
        directory: "/workspace",
      })

      expect(sandbox.fs.uploadFile).not.toHaveBeenCalled()

      tracker.cleanup()
    })

    // ── Both exist: only restart process ─────────────────────────────

    test("when repo and runtime both exist, only restarts process and waits for health", async () => {
      ;(sandbox.process.executeCommand as any)
        .mockResolvedValueOnce(makeExecuteResult("exists")) // git check
        .mockResolvedValueOnce(makeExecuteResult("exists")) // runtime check

      const result = await sandboxRuntime.deployAndStart(sandbox, "ws-4", {
        repoUrl: "https://github.com/test/repo.git",
        directory: "/workspace",
      })

      // No clone, no upload
      const cmds = (sandbox.process.executeCommand as any).mock.calls
      expect(cmds.find((c: any[]) => c[0]?.includes("git clone"))).toBeUndefined()
      expect(sandbox.fs.uploadFile).not.toHaveBeenCalled()

      // But session + process start + health check still happened
      expect(sandbox.process.createSession).toHaveBeenCalledWith("wr-ws-4")
      expect(sandbox.process.executeSessionCommand).toHaveBeenCalled()
      expect(result.url).toBeTruthy()

      tracker.cleanup()
    })

    // ── No repo URL means no clone attempt ───────────────────────────

    test("no clone attempted when repoUrl is not provided", async () => {
      ;(sandbox.process.executeCommand as any)
        .mockResolvedValueOnce(makeExecuteResult("missing")) // runtime check

      await sandboxRuntime.deployAndStart(sandbox, "ws-5", {
        directory: "/workspace",
      })

      const cmds = (sandbox.process.executeCommand as any).mock.calls
      // Only runtime check, no git check
      expect(cmds.find((c: any[]) => c[0]?.includes("git clone"))).toBeUndefined()
      expect(cmds.find((c: any[]) => c[0]?.includes(".git"))).toBeUndefined()

      tracker.cleanup()
    })

    // ── Session creation is idempotent ───────────────────────────────

    test("session creation is idempotent — does not throw if session exists", async () => {
      ;(sandbox.process.executeCommand as any)
        .mockResolvedValueOnce(makeExecuteResult("exists"))
        .mockResolvedValueOnce(makeExecuteResult("exists"))
      ;(sandbox.process.createSession as any).mockRejectedValueOnce(
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
      ;(sandbox.process.executeCommand as any)
        .mockResolvedValueOnce(makeExecuteResult("exists"))
        .mockResolvedValueOnce(makeExecuteResult("exists"))

      await sandboxRuntime.deployAndStart(sandbox, "ws-7", {
        directory: "/custom/dir",
        envVars: { CUSTOM_VAR: "value" },
      })

      const sessionCmd = (sandbox.process.executeSessionCommand as any).mock.calls[0]
      const command = sessionCmd[1].command as string
      expect(command).toContain("CLAXEDO_WR_PORT=")
      expect(command).toContain("CLAXEDO_WR_WORKSPACE_ID=ws-7")
      expect(command).toContain("CLAXEDO_WR_DIRECTORY=/custom/dir")
      expect(command).toContain("CUSTOM_VAR=value")
      expect(command).toContain("node runtime.mjs")

      tracker.cleanup()
    })

    // ── Provision events emitted in correct order ────────────────────

    test("emits provision events in correct order for full deployment", async () => {
      ;(sandbox.process.executeCommand as any)
        .mockResolvedValueOnce(makeExecuteResult("missing")) // git check
        .mockResolvedValueOnce(makeExecuteResult("missing")) // runtime check

      await sandboxRuntime.deployAndStart(sandbox, "ws-8", {
        repoUrl: "https://github.com/test/repo.git",
        directory: "/workspace",
      })

      const steps = tracker.events
        .filter((e): e is Extract<ClaxedoEvent, { type: "provision" }> => e.type === "provision")
        .map((e) => e.step)

      expect(steps).toEqual([
        "cloning",
        "uploading_runtime",
        "starting_runtime",
        "waiting_health",
        "ready",
      ])

      tracker.cleanup()
    })

    test("emits provision events in correct order for warm wake (both exist)", async () => {
      ;(sandbox.process.executeCommand as any)
        .mockResolvedValueOnce(makeExecuteResult("exists"))
        .mockResolvedValueOnce(makeExecuteResult("exists"))

      await sandboxRuntime.deployAndStart(sandbox, "ws-9", {
        repoUrl: "https://github.com/test/repo.git",
        directory: "/workspace",
      })

      const steps = tracker.events
        .filter((e): e is Extract<ClaxedoEvent, { type: "provision" }> => e.type === "provision")
        .map((e) => e.step)

      // clone and upload skipped — no events for those
      expect(steps).toEqual([
        "starting_runtime",
        "waiting_health",
        "ready",
      ])

      tracker.cleanup()
    })

    test("ready event includes totalMs", async () => {
      ;(sandbox.process.executeCommand as any)
        .mockResolvedValueOnce(makeExecuteResult("exists"))
        .mockResolvedValueOnce(makeExecuteResult("exists"))

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
      ;(sandbox.process.executeCommand as any)
        .mockResolvedValueOnce(makeExecuteResult("exists"))
        .mockResolvedValueOnce(makeExecuteResult("exists"))

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
      ;(sandbox.process.executeCommand as any)
        .mockResolvedValueOnce(makeExecuteResult("exists"))
        .mockResolvedValueOnce(makeExecuteResult("exists"))

      // Mock getSignedPreviewUrl to return URL
      ;(sandbox.getSignedPreviewUrl as any).mockResolvedValueOnce({
        url: "https://sandbox.example.com",
      })

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
    }, 60_000)

    // ── URL resolution ───────────────────────────────────────────────

    test("uses signed preview URL when available", async () => {
      ;(sandbox.process.executeCommand as any)
        .mockResolvedValueOnce(makeExecuteResult("exists"))
        .mockResolvedValueOnce(makeExecuteResult("exists"))

      ;(sandbox.getSignedPreviewUrl as any).mockResolvedValueOnce({
        url: "https://signed.example.com",
      })

      const result = await sandboxRuntime.deployAndStart(sandbox, "ws-13", {
        directory: "/workspace",
      })

      expect(result.url).toBe("https://signed.example.com")

      tracker.cleanup()
    })

    test("falls back to preview link when signed URL fails", async () => {
      ;(sandbox.process.executeCommand as any)
        .mockResolvedValueOnce(makeExecuteResult("exists"))
        .mockResolvedValueOnce(makeExecuteResult("exists"))

      ;(sandbox.getSignedPreviewUrl as any).mockRejectedValueOnce(
        new Error("not available"),
      )
      ;(sandbox.getPreviewLink as any).mockResolvedValueOnce({
        url: "https://preview.example.com",
      })

      const result = await sandboxRuntime.deployAndStart(sandbox, "ws-14", {
        directory: "/workspace",
      })

      expect(result.url).toBe("https://preview.example.com")

      tracker.cleanup()
    })

    // ── Default directory ────────────────────────────────────────────

    test("uses WORKSPACE_DIR as default directory", async () => {
      ;(sandbox.process.executeCommand as any)
        .mockResolvedValueOnce(makeExecuteResult("exists"))
        .mockResolvedValueOnce(makeExecuteResult("exists"))

      await sandboxRuntime.deployAndStart(sandbox, "ws-15", {})

      const sessionCmd = (sandbox.process.executeSessionCommand as any).mock.calls[0]
      const command = sessionCmd[1].command as string
      expect(command).toContain("CLAXEDO_WR_DIRECTORY=/workspace")

      tracker.cleanup()
    })

    // ── Clone timeout ────────────────────────────────────────────────

    test("clone command has 120 second timeout", async () => {
      ;(sandbox.process.executeCommand as any)
        .mockResolvedValueOnce(makeExecuteResult("missing")) // git check
        .mockResolvedValueOnce(makeExecuteResult("missing")) // runtime check

      await sandboxRuntime.deployAndStart(sandbox, "ws-16", {
        repoUrl: "https://github.com/test/repo.git",
        directory: "/workspace",
      })

      const cmds = (sandbox.process.executeCommand as any).mock.calls
      const cloneCall = cmds.find((c: any[]) => c[0]?.includes("git clone"))
      // 4th argument is timeout = 120
      expect(cloneCall?.[3]).toBe(120)

      tracker.cleanup()
    })

    // ── Async runtime start ──────────────────────────────────────────

    test("runtime process is started with runAsync: true", async () => {
      ;(sandbox.process.executeCommand as any)
        .mockResolvedValueOnce(makeExecuteResult("exists"))
        .mockResolvedValueOnce(makeExecuteResult("exists"))

      await sandboxRuntime.deployAndStart(sandbox, "ws-17", {
        directory: "/workspace",
      })

      const sessionCmd = (sandbox.process.executeSessionCommand as any).mock.calls[0]
      expect(sessionCmd[1].runAsync).toBe(true)

      tracker.cleanup()
    })
  })

  // ── stopRemoteRuntime ──────────────────────────────────────────────────

  describe("stopRemoteRuntime", () => {
    test("deletes the workspace session", async () => {
      const sandbox = createMockSandbox()

      await sandboxRuntime.stopRemoteRuntime(sandbox, "ws-stop-1")

      expect(sandbox.process.deleteSession).toHaveBeenCalledWith("wr-ws-stop-1")
    })

    test("does not throw if session deletion fails", async () => {
      const sandbox = createMockSandbox()
      ;(sandbox.process.deleteSession as any).mockRejectedValueOnce(
        new Error("session not found"),
      )

      // Should not throw
      await sandboxRuntime.stopRemoteRuntime(sandbox, "ws-stop-2")
    })

    test("does NOT stop the sandbox itself — only the runtime session", async () => {
      const sandbox = createMockSandbox()

      await sandboxRuntime.stopRemoteRuntime(sandbox, "ws-stop-3")

      // sandbox.stop() should NOT be called — this is the current behavior
      // (and a known gap — sandbox stays alive in Daytona)
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
