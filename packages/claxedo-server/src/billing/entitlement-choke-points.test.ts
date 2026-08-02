import { describe, expect, test, vi } from "vitest"
import { HostedWorkspaceRoutes } from "../routes/hosted/workspace"
import type { ClerkVerifier } from "../control-plane/auth"
import type { ControlPlaneServices } from "../control-plane/services"
import type { SandboxManager } from "@claxedo/sandbox-manager"

/**
 * D6/B4 choke point #1: hosted cloud-workspace creation (ADR 014 §5 — the
 * paid capability list). The route consults the composed entitlement hook
 * BEFORE any workspace doc or sandbox exists; a denial creates nothing.
 * (Choke point #2, the connections-host gate, is covered in
 * connections-host/connections-host.test.ts alongside the D7 partition tests.)
 */

const authConfig = {
  enabled: true,
  issuer: "https://clerk.example.test",
  jwksUrl: "https://clerk.example.test/.well-known/jwks.json",
} as const

const verifier: ClerkVerifier = async (token, config) => ({
  mode: "signed" as const,
  user: { subject: token, tokenIdentifier: `${config.issuer}|${token}`, issuer: config.issuer },
})

function build(entitled: boolean) {
  const createCloudWorkspace = vi.fn(async () => ({ workspace_id: "ignored" }))
  const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
  const requireCloudWorkspaceEntitlement = vi.fn(async () =>
    entitled
      ? undefined
      : {
          status: 402 as const,
          body: { error: { code: "billing_entitlement_required", message: "subscription required" } },
        })
  const services = {
    authority: {
      usersMe: vi.fn(async () => ({ subject: "user_1" })),
      createCloudWorkspace,
      auditAllow: vi.fn(async () => ({})),
    },
    sandbox: { sandboxManager: { ensure } as unknown as SandboxManager },
    telemetry: { capture: vi.fn() },
  } as unknown as ControlPlaneServices
  const app = HostedWorkspaceRoutes(services, {
    authConfig,
    verifier,
    requireCloudWorkspaceEntitlement,
  })
  return { app, createCloudWorkspace, ensure, requireCloudWorkspaceEntitlement }
}

const post = () =>
  new Request("http://cp.test/create", {
    method: "POST",
    body: JSON.stringify({ projectId: "proj_1", repoUrl: "https://github.com/a/b" }),
    headers: { authorization: "Bearer user_1", "content-type": "application/json" },
  })

describe("hosted cloud create × entitlement (choke point #1)", () => {
  test("free org → 402 typed denial; no workspace doc, no provisioning", async () => {
    const { app, createCloudWorkspace, ensure, requireCloudWorkspaceEntitlement } = build(false)
    const res = await app.fetch(post())
    expect(res.status).toBe(402)
    expect(await res.json()).toMatchObject({ error: { code: "billing_entitlement_required" } })
    expect(requireCloudWorkspaceEntitlement).toHaveBeenCalledTimes(1)
    expect(createCloudWorkspace).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
  })

  test("entitled org → creation proceeds", async () => {
    const { app, createCloudWorkspace } = build(true)
    const res = await app.fetch(post())
    expect(res.status).toBe(200)
    expect(createCloudWorkspace).toHaveBeenCalledTimes(1)
  })

  test("anonymous request never reaches the entitlement hook (401 first)", async () => {
    const { app, requireCloudWorkspaceEntitlement } = build(false)
    const res = await app.fetch(
      new Request("http://cp.test/create", {
        method: "POST",
        body: JSON.stringify({ repoUrl: "https://github.com/a/b" }),
      }),
    )
    expect(res.status).toBe(401)
    expect(requireCloudWorkspaceEntitlement).not.toHaveBeenCalled()
  })
})
