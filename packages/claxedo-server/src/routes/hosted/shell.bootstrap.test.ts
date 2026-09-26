/**
 * `GET /api/claxedo/bootstrap` on the hosted shell surface.
 *
 * The app reads this before its first render, while nobody is signed in, to
 * learn whether a signed session is required at all. It therefore passes no
 * auth gate — and it must carry none of the node bootstrap's machine-local
 * fields, because a hosted central has no machine behind it.
 */
import { describe, expect, test } from "vitest"
import { HostedShellRoutes } from "./shell"
import type { ControlPlaneAuthConfig } from "@claxedo/server-core/platform/auth/auth"

const signedConfig: ControlPlaneAuthConfig = {
  enabled: true,
  issuer: "https://example.issuer.dev",
  jwksUrl: "https://example.issuer.dev/.well-known/jwks.json",
  audience: "claxedo-server",
}

const verifier = async (token: string) => {
  if (token !== "token-owner") throw Object.assign(new Error("unknown token"), { status: 401 })
  return {
    mode: "signed" as const,
    user: { subject: "user_owner", tokenIdentifier: "https://example.issuer.dev|user_owner", issuer: "https://example.issuer.dev" },
  }
}

const OWNER_WORKSPACES = [
  { workspace_id: "ws_cloud", project_id: "proj_one", backing: "cloud-vm", workspace_name: "main", remote_directory: "/workspace", created_at: 1_800_000_000_000 },
]

function bootstrap(options: { authConfig: ControlPlaneAuthConfig; version?: string; token?: string }) {
  const { token, ...route } = options
  return HostedShellRoutes({ ...route, verifier, listWorkspaces: async () => OWNER_WORKSPACES }).request("http://cp.test/api/claxedo/bootstrap", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

describe("GET /api/claxedo/bootstrap on a hosted central", () => {
  test("answers an anonymous caller with the posture it must satisfy", async () => {
    const response = await bootstrap({ authConfig: signedConfig, version: "9.9.9-test" })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      healthy: true,
      version: "9.9.9-test",
      events: { hostAggregate: false },
      deployment: { issuesSessions: true, documents: false },
    })
  })

  // A hosted central serves no runtime of its own, so every workspace stream it
  // can name belongs to a machine reached through the relay.
  test("declares no host aggregate, and nothing about a machine", async () => {
    const body = await (await bootstrap({ authConfig: signedConfig })).json() as Record<string, unknown>

    expect(body.events).toEqual({ hostAggregate: false })
    expect(body.host).toBeUndefined()
    expect(body.path).toBeUndefined()
    expect(body.project).toBeUndefined()
    expect(body.provider_auth).toBeUndefined()
  })

  test("never caches, so a redeployed central is not read from a stale copy", async () => {
    const response = await bootstrap({ authConfig: signedConfig })

    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  // The declaration is the shared `issuesSessions` rule applied to the config
  // this route was composed with, not a constant: only an explicitly local-only
  // composition says false. What the DEPLOYED central declares is asserted
  // through the composed app in `hosted-core-app.test.ts`, which is the only
  // composer of this route and always configures auth.
  test("reads the posture off the composed auth config rather than hardcoding the hosted answer", async () => {
    const localOnly = await bootstrap({
      authConfig: { enabled: false, mode: "local-only", reason: "signed auth disabled" },
    })

    await expect(localOnly.json()).resolves.toMatchObject({ deployment: { issuesSessions: false } })
  })

  test("hands a signed caller its project catalog beside the posture", async () => {
    const body = await (await bootstrap({ authConfig: signedConfig, token: "token-owner" })).json() as Record<string, unknown>

    expect(body).toMatchObject({ healthy: true, events: { hostAggregate: false }, deployment: { issuesSessions: true } })
    expect(body.project).toMatchObject([{ id: "proj_one", workspaces: { ws_cloud: { id: "ws_cloud", backing: "cloud-vm", directory: "workspace:ws_cloud" } } }])
  })

  test("refuses a credential it cannot verify instead of answering it as anonymous", async () => {
    const response = await bootstrap({ authConfig: signedConfig, token: "token-stranger" })

    expect(response.status).toBe(401)
  })

  test("states each cloud workspace reachable only while the sandbox manager reports its lease ready", async () => {
    const workspaces = [
      { workspace_id: "ws_running", project_id: "proj_one", backing: "cloud-vm" },
      { workspace_id: "ws_stopped", project_id: "proj_one", backing: "cloud-vm" },
    ]
    const sandboxManager = {
      target: async (id: string) => id === "ws_running"
        ? { status: "ready" as const, routingId: "routing_test", sandboxId: id, url: "http://sandbox.test", hostId: id, epoch: 1, homeRegion: "us-east" }
        : { status: "unavailable" as const, reason: "runtime_lease_not_ready", leaseStatus: "stopped" as const },
    }
    const response = await HostedShellRoutes({ authConfig: signedConfig, verifier, listWorkspaces: async () => workspaces, sandboxManager })
      .request("http://cp.test/api/claxedo/bootstrap", { headers: { authorization: "Bearer token-owner" } })

    const body = await response.json() as { project: Array<{ workspaces: Record<string, { reachable: boolean }> }> }
    expect(body.project[0]?.workspaces).toMatchObject({ ws_running: { reachable: true }, ws_stopped: { reachable: false } })
  })
})
