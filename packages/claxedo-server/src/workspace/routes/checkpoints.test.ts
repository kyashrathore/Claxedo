import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { createSandboxManager, SandboxCheckpointUnusableError, type SandboxDriver, type SandboxManager } from "@claxedo/sandbox-manager"
import { sandboxDriverCatalog } from "@claxedo/sandbox-manager/driver-catalog"
import { createMemoryLeaseStore } from "@claxedo/sandbox-manager/stores/memory"
import type { ControlPlaneServices } from "../../authority/services"
import {
  filterCheckpointSessions,
  workspaceCheckpointRoleAllowsWrite,
  WorkspaceCheckpointRoutes,
} from "./checkpoints"

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
  test("maps typed unavailability independently of display text", async () => {
    const fixture = app()
    vi.mocked(fixture.sandboxManager.restore).mockRejectedValue(Object.assign(new Error("Busy"), { code: "sandbox_unavailable", status: 503, retryable: true }))
    const response = await fixture.app.request("http://test/api/workspace/ws_1/checkpoints/cp_1/restore", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: true }),
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "workspace_checkpoint_unavailable", retryable: true } })
  })
  test("uses the composed auth verifier for signed checkpoint requests", async () => {
    const verifier = vi.fn(async () => ({
      mode: "signed" as const,
      user: {
        subject: "alice",
        tokenIdentifier: "issuer|alice",
        issuer: "https://identity.example.test",
      },
    }))
    const openWorkspace = vi.fn(async () => ({
      allowed: true,
      role: "editor",
      workspace: { workspace_id: "ws_1", org_id: "org_team" },
    }))
    const services = {
      auth: {
        config: {
          enabled: true,
          issuer: "https://identity.example.test",
          jwksUrl: "https://identity.example.test/.well-known/jwks.json",
          audience: "claxedo-server",
        },
        verifier,
      },
      authority: { openWorkspace, listSessions: vi.fn(async () => []) },
      sandbox: { sandboxManager: { list: vi.fn(async () => []) } },
      relay: {},
      telemetry: { capture: vi.fn() },
    } as unknown as ControlPlaneServices
    const response = await new Hono()
      .route("/api/workspace", WorkspaceCheckpointRoutes(services))
      .request("http://localhost/api/workspace/ws_1/checkpoints", {
        headers: { authorization: "Bearer signed-token" },
      })

    expect(response.status).toBe(200)
    expect(verifier).toHaveBeenCalledWith("signed-token", services.auth.config)
    expect(openWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      mode: "signed",
      user: expect.objectContaining({ subject: "alice" }),
    }), { workspaceId: "ws_1" })
  })

  test("mints checkpoint runtime authority for the signed caller, from the workspace org and live role", async () => {
    const originalFetch = globalThis.fetch
    const mintRuntimeAccessToken = vi.fn(async () => ({ token: "rat_1", jti: "jti_1", expiresAt: Date.now() + 60_000 }))
    globalThis.fetch = vi.fn(async () => Response.json({ worktrees: [] })) as unknown as typeof globalThis.fetch
    try {
      const services = {
        auth: {
          config: {
            enabled: true,
            issuer: "https://identity.example.test",
            jwksUrl: "https://identity.example.test/.well-known/jwks.json",
            audience: "claxedo-server",
          },
          verifier: vi.fn(async () => ({
            mode: "signed" as const,
            user: {
              subject: "alice",
              tokenIdentifier: "issuer|alice",
              issuer: "https://identity.example.test",
              orgId: "org_personal",
            },
          })),
        },
        authority: {
          openWorkspace: vi.fn(async () => ({
            allowed: true,
            role: "viewer",
            workspace: { workspace_id: "ws_team", org_id: "org_team" },
          })),
          usersMe: vi.fn(async () => ({
            actor_id: "issuer|alice",
            actor_kind: "human",
            actor_public_id: "usr_alice",
            actor_name: "Alice",
          })),
          listSessions: vi.fn(async () => []),
        },
        sandbox: {
          sandboxManager: {
            list: vi.fn(async () => [{ workspaceId: "ws_team", status: "ready" }]),
            target: vi.fn(async () => ({
              workspaceId: "ws_team",
              hostId: "host_team",
              homeRegion: "us-east",
              status: "ready",
            })),
          },
        },
        relay: {
          provider: {
            mintRuntimeAccessToken,
            getRelayEndpoint: vi.fn(async () => "http://relay.test"),
          },
        },
        telemetry: { capture: vi.fn() },
      } as unknown as ControlPlaneServices

      const response = await new Hono()
        .route("/api/workspace", WorkspaceCheckpointRoutes(services))
        .request("http://localhost/api/workspace/ws_team/checkpoints", {
          headers: { authorization: "Bearer signed-token" },
        })

      expect(response.status).toBe(200)
      expect(mintRuntimeAccessToken).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: "ws_team",
        hostId: "host_team",
        orgId: "org_team",
        role: "viewer",
        principalKind: "user",
        actorId: "issuer|alice",
        actorKind: "human",
        auth: expect.objectContaining({ mode: "signed", user: expect.objectContaining({ subject: "alice" }) }),
      }))
      expect(mintRuntimeAccessToken).toHaveBeenCalledWith(expect.not.objectContaining({ orgId: "org_personal" }))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("requires editor authority for checkpoint and lifecycle mutations", () => {
    expect(workspaceCheckpointRoleAllowsWrite("viewer")).toBe(false)
    expect(workspaceCheckpointRoleAllowsWrite("editor")).toBe(true)
    expect(workspaceCheckpointRoleAllowsWrite("admin")).toBe(true)
    expect(workspaceCheckpointRoleAllowsWrite("owner")).toBe(true)
  })

  test("filters worktree session metadata through private-session visibility", () => {
    expect(filterCheckpointSessions({
      worktrees: [
        { sessionId: "ses_a", directory: "/workspace/a" },
        { sessionId: "ses_b", directory: "/workspace/b" },
        { directory: "/workspace/shared" },
      ],
    }, [{ session_id: "ses_b" }])).toEqual({
      worktrees: [
        { sessionId: "ses_b", directory: "/workspace/b" },
        { directory: "/workspace/shared" },
      ],
    })
  })

  test("inspection is available through the shared lifecycle surface", async () => {
    const fixture = app()
    const response = await fixture.app.request("/api/workspace/ws_1/checkpoints")

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ worktrees: [], runtime: {} })
  })

  test("an oversized body is refused on the write verbs before the runtime is asked", async () => {
    const fixture = app()
    const oversized = "x".repeat(17 * 1024)
    const requests = [
      "/api/workspace/ws_1/checkpoints",
      "/api/workspace/ws_1/checkpoints/cp_1/restore",
      "/api/workspace/ws_1/lifecycle/destroy",
    ]

    for (const path of requests) {
      const response = await fixture.app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oversized,
      })
      expect(response.status).toBe(413)
      expect(await response.json()).toMatchObject({
        error: { code: "request_body_too_large" },
      })
    }
    expect(fixture.sandboxManager.restore).not.toHaveBeenCalled()
    expect(fixture.sandboxManager.destroy).not.toHaveBeenCalled()
  })

  test("a chunked body over the cap is refused without a declared length", async () => {
    const fixture = app()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 4; i += 1) controller.enqueue(new TextEncoder().encode("x".repeat(8192)))
        controller.close()
      },
    })

    const response = await fixture.app.request("/api/workspace/ws_1/checkpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit)

    expect(response.status).toBe(413)
  })

  test("Start fresh drops an unusable checkpoint so the next start boots the image, is refused while the workspace runs, and needs explicit approval", async () => {
    const leaseStore = createMemoryLeaseStore()
    const driver: SandboxDriver = {
      id: "cloudflare",
      metadata: sandboxDriverCatalog.cloudflare.metadata,
      ensureHost: vi.fn(async (input) => {
        if (input.bootSource?.kind === "driver-snapshot") throw new SandboxCheckpointUnusableError("expired", "This workspace's saved files expired after 30 days unused; choose Start fresh.")
        return { sandboxId: "claxedo-ws_1", url: "https://runtime.test", hostId: "claxedo-ws_1", labels: input.labels }
      }),
      stop: vi.fn(async () => {}),
    }
    const sandboxManager = createSandboxManager({ leaseStore, driver })
    const services = { auth: { config: { enabled: false } }, sandbox: { sandboxManager }, relay: {} } as unknown as ControlPlaneServices
    const routes = new Hono().route("/api/workspace", WorkspaceCheckpointRoutes(services, { allowUnsignedLocal: true }))
    const startFresh = (body: unknown) => routes.request("/api/workspace/ws_1/lifecycle/start-fresh", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })
    await sandboxManager.ensure("ws_1", { homeRegion: "us-east" })

    const running = await startFresh({ approved: true })
    expect(running.status).toBe(409)
    expect(await running.json()).toMatchObject({ error: { code: "workspace_running", message: "Stop this workspace before starting it fresh." } })

    await leaseStore.update("ws_1", 1, {
      status: "stopped",
      checkpoint: { id: "chk_1", providerReference: "snap_gone", sourceEpoch: 1, capturedAt: 1, metadata: { scope: "filesystem", sourceBehavior: "preserved", restoreMount: "new-resource" } },
    })
    await expect(sandboxManager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({ status: "unavailable", error: expect.stringContaining("checkpoint_unusable:expired") })

    const unapproved = await startFresh({})
    expect(unapproved.status).toBe(409)
    expect(await unapproved.json()).toMatchObject({ error: { code: "workspace_lifecycle_approval_required" } })
    expect((await leaseStore.get("ws_1"))?.checkpoint).toBeDefined()

    const fresh = await startFresh({ approved: true })
    expect(fresh.status).toBe(200)
    expect(await fresh.json()).toEqual({ ok: true, status: "stopped" })
    expect((await leaseStore.get("ws_1"))?.checkpoint).toBeUndefined()
    await expect(sandboxManager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({ status: "ready" })
    expect(driver.ensureHost).toHaveBeenLastCalledWith(expect.objectContaining({ bootSource: { kind: "default" } }))
  })

  test("Start fresh needs write authority on the workspace, as Stop does", async () => {
    const startFresh = vi.fn()
    const services = {
      auth: {
        config: { enabled: true, issuer: "https://identity.example.test", jwksUrl: "https://identity.example.test/.well-known/jwks.json", audience: "claxedo-server" },
        verifier: vi.fn(async () => ({ mode: "signed" as const, user: { subject: "bob", tokenIdentifier: "issuer|bob", issuer: "https://identity.example.test" } })),
      },
      authority: { openWorkspace: vi.fn(async () => ({ allowed: true, role: "viewer", workspace: { workspace_id: "ws_1", org_id: "org_team" } })) },
      sandbox: { sandboxManager: { startFresh } },
      relay: {},
      telemetry: { capture: vi.fn() },
    } as unknown as ControlPlaneServices
    const response = await new Hono().route("/api/workspace", WorkspaceCheckpointRoutes(services)).request("http://localhost/api/workspace/ws_1/lifecycle/start-fresh", {
      method: "POST", headers: { authorization: "Bearer signed-token", "content-type": "application/json" }, body: JSON.stringify({ approved: true }),
    })
    expect(response.status).toBe(403)
    expect(startFresh).not.toHaveBeenCalled()
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
