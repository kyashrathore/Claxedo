import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import type { ControlPlaneServices } from "../../authority/services"
import { WorkspaceCheckpointRoutes } from "./checkpoints"

function app() {
  const sandboxManager = {
    list: vi.fn(async () => []),
    restore: vi.fn(),
    destroy: vi.fn(),
  } as unknown as SandboxManager
  const services = {
    auth: { config: { enabled: false } },
    sandbox: { sandboxManager },
    relay: {},
  } as unknown as ControlPlaneServices
  return {
    sandboxManager,
    app: new Hono().route("/api/workspace", WorkspaceCheckpointRoutes(services, { allowUnsignedLocal: true })),
  }
}

describe("workspace checkpoint routes", () => {
  test("inspection is available through the shared lifecycle surface", async () => {
    const fixture = app()
    const response = await fixture.app.request("/api/workspace/ws_1/checkpoints")

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ worktrees: [], runtime: {} })
  })

  test("restore, replacement, cleanup, and destruction require explicit approval", async () => {
    const fixture = app()
    const requests = [
      "/api/workspace/ws_1/checkpoints/cp_1/restore",
      "/api/workspace/ws_1/lifecycle/replace",
      "/api/workspace/ws_1/lifecycle/cleanup",
      "/api/workspace/ws_1/lifecycle/destroy",
    ]

    for (const path of requests) {
      const response = await fixture.app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        error: { code: "workspace_lifecycle_approval_required" },
      })
    }
    expect(fixture.sandboxManager.restore).not.toHaveBeenCalled()
    expect(fixture.sandboxManager.destroy).not.toHaveBeenCalled()
  })
})
