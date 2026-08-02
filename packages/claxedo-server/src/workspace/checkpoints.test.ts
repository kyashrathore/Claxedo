import { describe, expect, test, vi } from "vitest"
import type {
  SandboxCheckpointCaptureInput,
  SandboxCheckpointRestoreInput,
  SandboxManager,
} from "@claxedo/sandbox-manager"
import { createWorkspaceCheckpointService } from "./checkpoints"

function manager() {
  const checkpoint = vi.fn(async (_workspaceId: string, input: SandboxCheckpointCaptureInput) => {
    await input.runtime.freeze("drain")
    await input.runtime.flush()
    await input.runtime.scrub()
    await input.runtime.resume()
    return { status: "ready", lease: { status: "ready" } }
  })
  const restore = vi.fn(async (_workspaceId: string, input: SandboxCheckpointRestoreInput) => {
    await input.runtime.reconcile({ epoch: 2, checkpointId: input.checkpointId ?? "cp_1" })
    return { status: "ready" }
  })
  return {
    checkpoint,
    restore,
    stop: vi.fn(async () => ({ ok: true, status: "stopped" })),
    destroy: vi.fn(async () => ({ ok: true, status: "destroyed" })),
    release: vi.fn(async () => ({ released: true })),
    list: vi.fn(async () => [{
      workspaceId: "ws_1",
      driver: "cloudflare",
      homeRegion: "us-east",
      epoch: 1,
      status: "ready",
      retryCount: 0,
      createdAt: 1,
      updatedAt: 1,
      sandboxId: "sandbox-1",
      url: "https://runtime.test",
      hostId: "host-1",
      persistence: {
        resume: "replacement-restore",
        capture: "directories",
        clone: false,
        captureSource: "preserved",
        retention: "provider-managed",
        restoreMount: "copy-on-write",
      },
      checkpoint: {
        id: "cp_1",
        providerReference: "backup-1",
        sourceEpoch: 1,
        capturedAt: 1,
        metadata: {
          scope: "directories",
          sourceBehavior: "preserved",
          restoreMount: "copy-on-write",
        },
      },
    }]),
  } as unknown as SandboxManager & {
    checkpoint: typeof checkpoint
    restore: typeof restore
    stop: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    release: ReturnType<typeof vi.fn>
  }
}

describe("workspace checkpoint service", () => {
  test("UI and MCP application operations share the same runtime protocol and manager", async () => {
    const sandboxManager = manager()
    const calls: Array<{ path: string; method?: string }> = []
    const service = createWorkspaceCheckpointService({
      sandboxManager,
      runtimeRequest: vi.fn(async (_workspaceId, path, init) => {
        calls.push({ path, method: init?.method })
        if (path === "/api/wr/worktrees") {
          return Response.json({ worktrees: [{ sessionId: "session-1", branch: "claxedo/session/session-1", state: "active" }] })
        }
        return Response.json({ ok: true })
      }),
    })

    await expect(service.inspect("ws_1")).resolves.toMatchObject({
      lease: { epoch: 1, sandboxId: "sandbox-1" },
      checkpoint: { id: "cp_1" },
      worktrees: [{ sessionId: "session-1" }],
    })
    await service.capture("ws_1")
    await service.restore("ws_1", { checkpointId: "cp_1" })

    expect(calls.map((call) => call.path)).toEqual([
      "/api/wr/worktrees",
      "/api/wr/checkpoint/freeze",
      "/api/wr/checkpoint/flush",
      "/api/wr/checkpoint/scrub",
      "/api/wr/checkpoint/resume",
      "/api/wr/checkpoint/restore-reconcile",
    ])
  })

  test("forced cleanup destroys the provider resource before releasing its lease", async () => {
    const sandboxManager = manager()
    const service = createWorkspaceCheckpointService({
      sandboxManager,
      runtimeRequest: vi.fn(),
    })

    await expect(service.cleanup("ws_1")).resolves.toEqual({
      ok: true,
      status: "destroyed",
      released: true,
    })
    expect(sandboxManager.destroy.mock.invocationCallOrder[0]).toBeLessThan(
      sandboxManager.release.mock.invocationCallOrder[0]!,
    )
  })

  test("inspection uses the non-resuming runtime path", async () => {
    const runtimeRequest = vi.fn(async () => Response.json({ worktrees: [{ sessionId: "woken" }] }))
    const inspectRuntimeRequest = vi.fn(async () => Response.json({ worktrees: [{ sessionId: "already-live" }] }))
    const service = createWorkspaceCheckpointService({
      sandboxManager: manager(),
      runtimeRequest,
      inspectRuntimeRequest,
    })

    await expect(service.inspect("ws_1")).resolves.toMatchObject({
      worktrees: [{ sessionId: "already-live" }],
    })
    expect(inspectRuntimeRequest).toHaveBeenCalledOnce()
    expect(runtimeRequest).not.toHaveBeenCalled()
  })

  test("stop captures durable state before stopping a capture-capable provider", async () => {
    const sandboxManager = manager()
    const calls: string[] = []
    sandboxManager.checkpoint.mockImplementation(async (_workspaceId, request) => {
      calls.push("checkpoint")
      await request.runtime.freeze("drain")
      await request.runtime.flush()
      await request.runtime.scrub()
      await request.runtime.resume()
      return { status: "ready", lease: { status: "ready" } }
    })
    sandboxManager.stop.mockImplementation(async () => {
      calls.push("stop")
      return { ok: true, status: "stopped" }
    })
    const service = createWorkspaceCheckpointService({
      sandboxManager,
      runtimeRequest: vi.fn(async () => Response.json({ ok: true })),
    })

    await expect(service.stop("ws_1")).resolves.toEqual({ ok: true, status: "stopped" })
    expect(calls).toEqual(["checkpoint", "stop"])
  })
})
