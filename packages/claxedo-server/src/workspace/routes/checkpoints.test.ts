import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import type { SandboxManager } from "@claxedo/sandbox-manager"
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

  test("mints checkpoint runtime authority from the workspace org and live role", async () => {
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
