import { describe, expect, test, vi } from "vitest"
import type { ControlPlaneTokenVerifier } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../../authority/services"
import type { HostTunnelTokenSigner, RuntimeAccessTokenSigner } from "@claxedo/server-core/platform/auth/runtime-access-token"
import { HostedWorkspaceRoutes, type HostedWorkspaceRouteOptions } from "./workspace"
import { createFixedWindowConnectionRateLimiter } from "../../platform/auth/rate-limit"
import type { SandboxManager } from "@claxedo/sandbox-manager"

/**
 * Hosted workspace routes under machine-wide enrollment. These prove the
 * hosted control plane:
 *   - lets the OWNER assign/unassign a workspace to one of their enrolled
 *     hosts (no challenge, no machine signature — machine consent is the
 *     enrollment heartbeat's acked served set),
 *   - mints the Host Tunnel Token via the injected signer on assignment,
 *   - answers 404 on the retired per-workspace user-hosted quartet,
 *   - and NEVER starts a tunnel / reads local host identity / hits the disk.
 *
 * The signature-verification and routing policy behind assignment lives in
 * the authorities (`authority/adapters/d1/host-access-authority.test.ts`, the
 * the authority policy suite, `routes/hosted/host-enrollment.parity.test.ts`); here
 * we assert the request *behaviour* of the routes. The "no local-only"
 * guarantee at the import-graph level is enforced separately by
 * `worker.import-graph.test.ts`.
 */

const authConfig = {
  enabled: true,
  issuer: "https://issuer.example.test",
  jwksUrl: "https://issuer.example.test/.well-known/jwks.json",
} as const

const verifier: ControlPlaneTokenVerifier = async (token, config) => ({
  mode: "signed" as const,
  user: {
    subject: token,
    tokenIdentifier: `${config.issuer}|${token}`,
    issuer: config.issuer,
  },
})

function fakeAuthority(overrides: Record<string, unknown> = {}) {
  return {
    usersMe: vi.fn(async () => ({ subject: "user_1", user_id: "user_1", actor_id: "user_1", actor_kind: "human", actor_public_id: "user_pub_1", actor_name: "User One" })),
    openWorkspace: vi.fn(async () => ({
      allowed: true,
      role: "owner",
      workspace: { workspace_id: "ws_1", access: "user-hosted", backing: "local-worktree" },
    })),
    activeWorkspaceHost: vi.fn(async () => ({
      active: true,
      host_id: "host_1",
      workspace_id: "ws_1",
      expires_at: 9_999,
      last_seen_at: 1,
      // What this machine declared on its last heartbeat. A `claxedo up` host
      // against a hosted control plane injects a session authority into its
      // embedded runtime and is therefore managed-private — which is why no
      // assumption about "every user-hosted workspace runs an unbound local
      // policy" can stand in for the declaration.
      session_authority: "managed-private" as const,
    })),
    recordRuntimeAccessToken: vi.fn(async () => ({})),
    revokeRuntimeAccessToken: vi.fn(async () => ({})),
    runtimeAccessTokenActive: vi.fn(async () => ({ active: true })),
    listWorkspaces: vi.fn(async () => [
      { workspace_id: "ws_user", access: "user-hosted" },
      { workspace_id: "ws_cloud", access: "cloud" },
    ]),
    assignWorkspaceHost: vi.fn(async () => ({ assigned: true, workspace_id: "ws_1", host_id: "host_1" })),
    unassignWorkspaceHost: vi.fn(async () => ({ unassigned: true })),
    auditAllow: vi.fn(async () => ({})),
    auditDeny: vi.fn(async () => ({})),
    ...overrides,
  }
}

function fakeServices(authority: ReturnType<typeof fakeAuthority> | undefined) {
  const capture = vi.fn()
  return {
    services: {
      authority,
      sandbox: {},
      telemetry: { capture },
    } as unknown as ControlPlaneServices,
    capture,
  }
}

const ratSigner: RuntimeAccessTokenSigner = vi.fn(async () => ({
  runtimeAccessToken: "rat-token",
  tokenExpiresAt: 1_000_000,
  jti: "jti_rat",
}))

const httSigner: HostTunnelTokenSigner = vi.fn(async (input) => ({
  hostTunnelToken: `htt-for-${input.hostId}`,
  tokenExpiresAt: 2_000_000,
  jti: "jti_htt",
}))

function buildApp(opts: {
  authority?: ReturnType<typeof fakeAuthority>
  options?: Partial<HostedWorkspaceRouteOptions>
  sandboxManager?: SandboxManager
}) {
  const authority = "authority" in opts ? opts.authority : fakeAuthority()
  const { services, capture } = fakeServices(authority)
  services.sandbox.sandboxManager = opts.sandboxManager
  const app = HostedWorkspaceRoutes(services, {
    authConfig,
    verifier,
    relayUrl: "https://relay.test",
    runtimeAccessTokenSigner: ratSigner,
    hostTunnelTokenSigner: httSigner,
    ...opts.options,
  })
  return { app, authority, capture }
}

// HostedWorkspaceRoutes mounts routes at the root of its own Hono (the hosted
// app mounts it under /api/workspace); fetch the sub-app directly here.
function post(path: string, body: unknown, token = "user_1") {
  return new Request(`http://cp.test${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function get(path: string, token = "user_1") {
  return new Request(`http://cp.test${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
}

function del(path: string, token = "user_1") {
  return new Request(`http://cp.test${path}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  })
}

describe("host assignment (POST /:id/host-assignment)", () => {
  test("records the owner assignment and mints a host tunnel token, without starting a tunnel", async () => {
    const { app, authority, capture } = buildApp({
      options: {
        defaultHomeRegion: "eu-west",
        relayUrls: {
          "eu-west": "https://relay.eu.test",
        },
      },
    })
    const res = await app.fetch(
      post("/ws_1/host-assignment", {
        hostId: "host_1",
        displayName: "demo",
        repoName: "demo",
        gitBranch: "main",
      }),
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, any>
    // No challenge and no machine signature here: liveness is the enrollment
    // lease and machine consent is the heartbeat-acked served set. The route
    // only records the OWNER's intent.
    expect(authority!.assignWorkspaceHost).toHaveBeenCalledWith(
      expect.anything(),
      {
        workspaceId: "ws_1",
        hostId: "host_1",
        displayName: "demo",
        repoName: "demo",
        gitBranch: "main",
      },
    )
    expect(authority!.auditAllow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "host_workspace_assignment.assigned",
        workspaceId: "ws_1",
        metadata: { hostId: "host_1" },
      }),
    )
    expect(capture).toHaveBeenCalledWith("user_1", "host_workspace_assignment.assigned", {
      workspaceId: "ws_1",
      hostId: "host_1",
    })
    // Host Tunnel Token is minted immediately so the machine can open its
    // relay tunnel without waiting for a beat.
    expect(json.assignment).toMatchObject({ assigned: true, workspace_id: "ws_1", host_id: "host_1" })
    expect(json.hostTunnel).toMatchObject({
      hostTunnelToken: "htt-for-host_1",
      homeRegion: "eu-west",
      relayUrl: "https://relay.eu.test",
    })
  })

  test("rejects a body with no host id (schema fail-closed, stable 400)", async () => {
    const { app, authority } = buildApp({})
    const res = await app.fetch(post("/ws_1/host-assignment", { displayName: "demo" }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: "invalid_request_body" } })
    expect(authority!.assignWorkspaceHost).not.toHaveBeenCalled()
  })

  test("refuses the retired per-workspace registration shape rather than ignoring it", async () => {
    // `.strict()`. A caller still sending publicKey/challengeId/signature is
    // using the old per-workspace flow, and silently dropping those fields
    // would look like the old security property still held.
    const { app, authority } = buildApp({})
    const res = await app.fetch(
      post("/ws_1/host-assignment", {
        hostId: "host_1",
        publicKey: "pub-key-jwk",
        challengeId: "ch_1",
        signature: "client-signature",
      }),
    )
    expect(res.status).toBe(400)
    expect(authority!.assignWorkspaceHost).not.toHaveBeenCalled()
  })

  test("assigning a cloud-backed workspace returns a 409 conflict", async () => {
    const authority = fakeAuthority({
      assignWorkspaceHost: vi.fn(async () => {
        throw new Error("workspace_backing_conflict: cannot assign a host to a cloud workspace")
      }),
    })
    const { app } = buildApp({ authority: authority })
    const res = await app.fetch(post("/ws_1/host-assignment", { hostId: "host_1" }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: { code: "workspace_backing_conflict" } })
    expect(authority.auditAllow).not.toHaveBeenCalled()
  })

  test("fails closed (503) when no authority is configured", async () => {
    const { app } = buildApp({ authority: undefined })
    const res = await app.fetch(post("/ws_1/host-assignment", { hostId: "host_1" }))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: "workspace_authority_unavailable" } })
  })

  test("requires a signed bearer token", async () => {
    const { app, authority } = buildApp({})
    const res = await app.fetch(
      new Request("http://cp.test/ws_1/host-assignment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostId: "host_1" }),
      }),
    )
    expect(res.status).toBe(401)
    expect(authority!.assignWorkspaceHost).not.toHaveBeenCalled()
  })

  test("is rate limited per caller+workspace before any authority call", async () => {
    const { app, authority } = buildApp({
      options: {
        controlPlaneRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 2, windowMs: 60_000 }),
      },
    })

    // Rotating the client-supplied hostId cannot bypass the bucket.
    const assign = (hostId: string) => app.fetch(post("/ws_1/host-assignment", { hostId }))
    expect((await assign("host_a")).status).toBe(200)
    expect((await assign("host_b")).status).toBe(200)
    const limited = await assign("host_c")
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: { code: "control_plane_rate_limited" } })
    // The denied request was rejected BEFORE reaching authority resolution.
    expect(authority!.usersMe).toHaveBeenCalledTimes(2)
    expect(authority!.assignWorkspaceHost).toHaveBeenCalledTimes(2)
  })
})

describe("host unassignment (DELETE /:id/host-assignment)", () => {
  test("removes the assignment and audits it", async () => {
    const { app, authority } = buildApp({})
    const res = await app.fetch(del("/ws_1/host-assignment"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ unassigned: true })
    expect(authority!.unassignWorkspaceHost).toHaveBeenCalledWith(expect.anything(), { workspaceId: "ws_1" })
    expect(authority!.auditAllow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "host_workspace_assignment.unassigned", workspaceId: "ws_1" }),
    )
  })

  test("requires a signed bearer token", async () => {
    const { app, authority } = buildApp({})
    const res = await app.fetch(new Request("http://cp.test/ws_1/host-assignment", { method: "DELETE" }))
    expect(res.status).toBe(401)
    expect(authority!.unassignWorkspaceHost).not.toHaveBeenCalled()
  })
})

describe("the retired per-workspace user-hosted routes are gone", () => {
  test("challenge/register/heartbeat/pause answer 404, not a handler", async () => {
    // NO backward compatibility: a 400/401/409 here would mean a handler is
    // still mounted behind the path. Machine enrollment + owner assignment
    // replaced the whole quartet.
    const { app, authority } = buildApp({})
    for (const retired of ["challenge", "register", "heartbeat", "pause"]) {
      const res = await app.fetch(post(`/ws_1/user-hosted/${retired}`, { hostId: "host_1" }))
      expect(res.status, `POST /ws_1/user-hosted/${retired}`).toBe(404)
    }
    expect(authority!.assignWorkspaceHost).not.toHaveBeenCalled()
    expect(authority!.usersMe).not.toHaveBeenCalled()
  })
})

describe("hosted connection", () => {
  test("mints a Runtime Access Token for a user-hosted workspace", async () => {
    const { app, authority, capture } = buildApp({})
    const res = await app.fetch(get("/ws_1/connection"))
    expect(res.status).toBe(200)
    expect(authority!.recordRuntimeAccessToken).toHaveBeenCalled()
    expect(await res.json()).toMatchObject({
      access: "user-hosted",
      backing: "local-worktree",
      // Straight from what the HOST declared on its heartbeat, never derived
      // from the workspace's access or backing. Only the mint can tell the
      // client which stream scopes the runtime behind it serves, and a
      // managed-private one serves session-scoped streams only.
      sessionAuthority: "managed-private",
      relayUrl: "https://relay.test",
      runtimeAccessToken: "rat-token",
    })
    expect(capture).toHaveBeenCalledWith("user_1", "workspace.connection.requested", {
      workspaceId: "ws_1",
      access: "user-hosted",
      backing: "local-worktree",
      runtimeKind: "user-hosted",
      homeRegion: "us-east",
      relayRoom: "ws_1",
      hostId: "host_1",
    })
    expect(capture).toHaveBeenCalledWith(
      "user_1",
      "runtime_access_token.minted",
      expect.objectContaining({
        workspaceId: "ws_1",
        access: "user-hosted",
        relayRoom: "ws_1",
        relayUrl: "https://relay.test",
        jti: "jti_rat",
      }),
    )
    expect(JSON.stringify(capture.mock.calls)).not.toContain("rat-token")
  })

  test("uses the workspace home_region to choose the regional relay endpoint", async () => {
    const authority = fakeAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: {
          workspace_id: "ws_1",
          access: "user-hosted",
          backing: "local-worktree",
          home_region: "eu-west",
        },
      })),
    })
    const { app } = buildApp({
      authority: authority,
      options: {
        relayUrls: {
          "us-east": "https://relay.us.test",
          "eu-west": "https://relay.eu.test",
        },
      },
    })
    const res = await app.fetch(get("/ws_1/connection"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      access: "user-hosted",
      runtimeKind: "user-hosted",
      homeRegion: "eu-west",
      relayUrl: "https://relay.eu.test",
    })
  })

  test("supports the provider-neutral POST connection route", async () => {
    const { app, authority } = buildApp({})
    const res = await app.fetch(post("/ws_1/connection", {}))
    expect(res.status).toBe(200)
    expect(authority!.recordRuntimeAccessToken).toHaveBeenCalled()
    expect(await res.json()).toMatchObject({
      access: "user-hosted",
      backing: "local-worktree",
      workspaceId: "ws_1",
      relayUrl: "https://relay.test",
      runtimeAccessToken: "rat-token",
    })
  })

  test("returns provisioning metadata for a cloud workspace while ensure is still acquiring", async () => {
    const authority = fakeAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: "ws_1", access: "cloud", backing: "cloud-vm", home_region: "apac-south" },
      })),
    })
    const sandboxManager = {
      ensure: vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 3, homeRegion: "apac-south" })),
    } as unknown as SandboxManager
    const { app, capture } = buildApp({ authority: authority, sandboxManager })
    const res = await app.fetch(get("/ws_1/connection"))
    expect(res.status).toBe(200)
    expect(sandboxManager.ensure).toHaveBeenCalledWith("ws_1", { homeRegion: "apac-south" })
    expect(capture).toHaveBeenCalledWith("user_1", "workspace.connection.requested", {
      workspaceId: "ws_1",
      access: "cloud",
      backing: "cloud-vm",
      runtimeKind: "cloud",
      homeRegion: "apac-south",
      relayRoom: "ws_1",
    })
    expect(capture).toHaveBeenCalledWith("user_1", "sandbox.ensure", {
      workspaceId: "ws_1",
      status: "provisioning",
      homeRegion: "apac-south",
      relayRoom: "ws_1",
      leaseEpoch: 3,
      retryAfterMs: 2_000,
    })
    expect(await res.json()).toEqual({
      status: "provisioning",
      workspaceId: "ws_1",
      runtimeKind: "cloud",
      homeRegion: "apac-south",
      retryAfterMs: 2_000,
    })
  })

  test("mints a Runtime Access Token for a ready cloud workspace without driver internals", async () => {
    const authority = fakeAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "editor",
        workspace: { workspace_id: "ws_1", access: "cloud", backing: "cloud-vm", home_region: "eu-west" },
      })),
    })
    const sandboxManager = {
      ensure: vi.fn(async () => ({
        status: "ready",
        sandboxId: "sandbox_1",
        url: "https://runtime.test/ws_1",
        hostId: "host_cloud_1",
        driverResourceId: "driver-resource-secret-id",
        epoch: 8,
        homeRegion: "eu-west",
      })),
    } as unknown as SandboxManager
    const { app, capture } = buildApp({ authority: authority, sandboxManager })
    const res = await app.fetch(get("/ws_1/connection"))
    expect(res.status).toBe(200)
    expect(authority.recordRuntimeAccessToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspaceId: "ws_1", hostId: "host_cloud_1" }),
    )
    expect(authority.auditAllow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "runtime_access_token.minted",
        metadata: expect.objectContaining({
          jti: "jti_rat",
          hostId: "host_cloud_1",
          leaseEpoch: 8,
          driverResourceId: "driver-resource-secret-id",
          relayRoom: "ws_1",
          relayUrl: "https://relay.test",
        }),
      }),
    )
    expect(capture).toHaveBeenCalledWith("user_1", "sandbox.ensure", {
      workspaceId: "ws_1",
      status: "ready",
      homeRegion: "eu-west",
      relayRoom: "ws_1",
      hostId: "host_cloud_1",
      leaseEpoch: 8,
      driverResourceId: "driver-resource-secret-id",
    })
    expect(capture).toHaveBeenCalledWith(
      "user_1",
      "runtime_access_token.minted",
      expect.objectContaining({
        workspaceId: "ws_1",
        access: "cloud",
        backing: "cloud-vm",
        relayRoom: "ws_1",
        relayUrl: "https://relay.test",
        driverResourceId: "driver-resource-secret-id",
        jti: "jti_rat",
      }),
    )
    expect(JSON.stringify(capture.mock.calls)).not.toContain("rat-token")
    const body = await res.json()
    expect(body).toMatchObject({
      access: "cloud",
      backing: "cloud-vm",
      runtimeKind: "cloud",
      // A provisioned sandbox delegates to the control plane's session
      // authority, so it serves SESSION-SCOPED streams only.
      sessionAuthority: "managed-private",
      workspaceId: "ws_1",
      homeRegion: "eu-west",
      relayUrl: "https://relay.test",
      runtimeAccessToken: "rat-token",
      role: "editor",
      hostId: "host_cloud_1",
    })
    expect(body).not.toHaveProperty("sandboxId")
    expect(body).not.toHaveProperty("runtimeUrl")
    expect(body).not.toHaveProperty("driverResourceId")
  })

  test("emits structured telemetry when a cloud runtime is unavailable", async () => {
    const authority = fakeAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: "ws_1", access: "cloud", backing: "cloud-vm", home_region: "eu-west" },
      })),
    })
    const sandboxManager = {
      ensure: vi.fn(async () => ({
        status: "unavailable",
        retryAfterMs: 5_000,
        error: "retry cap reached",
        epoch: 9,
        homeRegion: "eu-west",
      })),
    } as unknown as SandboxManager
    const { app, capture } = buildApp({ authority: authority, sandboxManager })
    const res = await app.fetch(get("/ws_1/connection"))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      error: {
        code: "cloud_runtime_unavailable",
        retryAfterMs: 5_000,
      },
    })
    expect(capture).toHaveBeenCalledWith("user_1", "sandbox.ensure", {
      workspaceId: "ws_1",
      status: "unavailable",
      homeRegion: "eu-west",
      relayRoom: "ws_1",
      retryAfterMs: 5_000,
    })
    expect(capture).toHaveBeenCalledWith("user_1", "workspace.connection.unavailable", {
      workspaceId: "ws_1",
      runtimeKind: "cloud",
      homeRegion: "eu-west",
      relayRoom: "ws_1",
      retryAfterMs: 5_000,
    })
  })

  test("fails closed when a cloud workspace has no sandbox", async () => {
    const authority = fakeAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: "ws_1", access: "cloud", backing: "cloud-vm" },
      })),
    })
    const { app } = buildApp({ authority: authority })
    const res = await app.fetch(get("/ws_1/connection"))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: "sandbox_unavailable" } })
  })

  test("fails closed (503) when the Runtime Access Token signer is missing", async () => {
    const { app } = buildApp({ options: { runtimeAccessTokenSigner: undefined } })
    const res = await app.fetch(get("/ws_1/connection"))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: "runtime_access_token_signer_unavailable" } })
  })

  test("rejects a request with no bearer token", async () => {
    const { app } = buildApp({})
    const res = await app.fetch(new Request("http://cp.test/ws_1/connection"))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: "missing_bearer_token" } })
  })

  test("rejects a malformed refresh body with a stable 400 instead of a 500", async () => {
    const { app, authority } = buildApp({})
    const res = await app.fetch(post("/ws_1/connection/refresh", { previousJti: 42 }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: "invalid_request_body" } })
    expect(authority!.usersMe).not.toHaveBeenCalled()
  })
})

describe("hosted connection rate limiting (mint-only)", () => {
  function cloudWorkspaceAuthority() {
    return fakeAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: "ws_1", access: "cloud", backing: "cloud-vm", home_region: "us-east" },
      })),
    })
  }

  test("10 consecutive provisioning polls never hit the Runtime Access Token mint limit", async () => {
    const sandboxManager = {
      ensure: vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" })),
    } as unknown as SandboxManager
    const { app } = buildApp({ authority: cloudWorkspaceAuthority(), sandboxManager })

    // Default mint limit is 6/min; a 2s-poll cold start must survive far past it.
    for (let i = 0; i < 10; i++) {
      const res = await app.fetch(get("/ws_1/connection"))
      expect(res.status, `provisioning poll ${i + 1} must not be rate limited`).toBe(200)
      expect(await res.json()).toMatchObject({ status: "provisioning" })
    }
  })

  test("provisioning polls bypass the budget but actual mints still hit the cap", async () => {
    const ready = {
      status: "ready",
      sandboxId: "sandbox_1",
      url: "https://runtime.test/ws_1",
      hostId: "host_cloud_1",
      epoch: 2,
      homeRegion: "us-east",
    }
    const ensure = vi.fn(async () => ready as never)
    ensure
      .mockResolvedValueOnce({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" } as never)
      .mockResolvedValueOnce({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" } as never)
      .mockResolvedValueOnce({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" } as never)
    const sandboxManager = { ensure } as unknown as SandboxManager
    const { app, authority } = buildApp({
      authority: cloudWorkspaceAuthority(),
      sandboxManager,
      options: {
        connectionRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 2, windowMs: 60_000 }),
      },
    })

    // Three provisioning polls — all bypass/refund the mint budget.
    for (let i = 0; i < 3; i++) {
      expect((await app.fetch(get("/ws_1/connection"))).status).toBe(200)
    }
    // Two real mints consume the budget…
    expect((await app.fetch(get("/ws_1/connection"))).status).toBe(200)
    expect((await app.fetch(get("/ws_1/connection"))).status).toBe(200)
    expect(authority!.recordRuntimeAccessToken).toHaveBeenCalledTimes(2)
    // …and the third mint attempt is rejected at the cap.
    const limited = await app.fetch(get("/ws_1/connection"))
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: { code: "runtime_access_token_rate_limited" } })
  })

  test("provisioning polls beyond the control-plane request cap get 429 before any the authority read", async () => {
    const sandboxManager = {
      ensure: vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" })),
    } as unknown as SandboxManager
    const { app, authority } = buildApp({
      authority: cloudWorkspaceAuthority(),
      sandboxManager,
      options: {
        controlPlaneRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 3, windowMs: 60_000 }),
      },
    })

    // The mint budget is refunded for provisioning responses, so the
    // control-plane limiter is what caps a provisioning-poll flood.
    for (let i = 0; i < 3; i++) {
      const res = await app.fetch(get("/ws_1/connection"))
      expect(res.status, `poll ${i + 1} within the cap must pass`).toBe(200)
      expect(await res.json()).toMatchObject({ status: "provisioning" })
    }
    const authorityReadsAtCap = authority!.usersMe.mock.calls.length

    for (let i = 0; i < 4; i++) {
      const limited = await app.fetch(get("/ws_1/connection"))
      expect(limited.status, `poll ${i + 4} past the cap must be rejected`).toBe(429)
      expect(await limited.json()).toMatchObject({ error: { code: "control_plane_rate_limited" } })
    }
    // Rejected polls never reached the authority reads.
    expect(authority!.usersMe.mock.calls.length).toBe(authorityReadsAtCap)
    expect(sandboxManager.ensure).toHaveBeenCalledTimes(3)
  })

  test("repeated rate-limit rejections in one window audit to the authority exactly once", async () => {
    const sandboxManager = {
      ensure: vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" })),
    } as unknown as SandboxManager
    const { app, authority } = buildApp({
      authority: cloudWorkspaceAuthority(),
      sandboxManager,
      options: {
        controlPlaneRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 1, windowMs: 60_000 }),
      },
    })

    expect((await app.fetch(get("/ws_1/connection"))).status).toBe(200)
    for (let i = 0; i < 5; i++) {
      expect((await app.fetch(get("/ws_1/connection"))).status).toBe(429)
    }
    // A sustained flood produces ONE audit write per window, not one per request.
    expect(authority!.auditDeny).toHaveBeenCalledTimes(1)
    expect(authority!.auditDeny).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "workspace.connection.denied",
        reason: "control_plane_rate_limited",
        workspaceId: "ws_1",
      }),
    )
  })
})

describe("hosted workspace list (GET /api/workspace)", () => {
  test("signed access=user-hosted returns only the caller's user-hosted workspaces", async () => {
    const { app, authority } = buildApp({})
    const res = await app.fetch(get("/?access=user-hosted"))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { workspaces: Array<{ workspace_id: string }> }
    expect(json.workspaces).toEqual([{ workspace_id: "ws_user", access: "user-hosted" }])
    expect(authority!.usersMe).toHaveBeenCalledTimes(1)
    expect(authority!.listWorkspaces).toHaveBeenCalledTimes(1)
  })

  test("signed access=cloud returns the full list (no user-hosted filter)", async () => {
    const { app, authority } = buildApp({})
    const res = await app.fetch(get("/?access=cloud"))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { workspaces: Array<{ workspace_id: string }> }
    expect(json.workspaces).toEqual([
      { workspace_id: "ws_user", access: "user-hosted" },
      { workspace_id: "ws_cloud", access: "cloud" },
    ])
    expect(authority!.listWorkspaces).toHaveBeenCalledTimes(1)
  })

  test("unsigned (no access query) returns an empty list and never touches the authority", async () => {
    const { app, authority } = buildApp({})
    const res = await app.fetch(new Request("http://cp.test/"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ workspaces: [] })
    // Hosted has no local projects list — no authority read on the unsigned path.
    expect(authority!.usersMe).not.toHaveBeenCalled()
    expect(authority!.listWorkspaces).not.toHaveBeenCalled()
  })

  test("access=user-hosted with no bearer token fails closed (signed required)", async () => {
    const { app, authority } = buildApp({})
    const res = await app.fetch(new Request("http://cp.test/?access=user-hosted"))
    expect(res.status).toBe(401)
    expect(authority!.listWorkspaces).not.toHaveBeenCalled()
  })

  test("honors the control-plane rate limiter", async () => {
    const { app, authority } = buildApp({
      options: {
        controlPlaneRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 1, windowMs: 60_000 }),
      },
    })
    expect((await app.fetch(get("/?access=user-hosted"))).status).toBe(200)
    const limited = await app.fetch(get("/?access=user-hosted"))
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: { code: "control_plane_rate_limited" } })
    // The rate-limited request did not reach the workspace listing.
    expect(authority!.listWorkspaces).toHaveBeenCalledTimes(1)
  })
})

describe("hosted cloud workspace create (POST /create)", () => {
  test("on Workers the provisioning is held open past the response via waitUntil", async () => {
    // workerd cancels detached promises once the response returns, so the
    // route hands the whole chain — ensure AND the runtime provisioning that
    // follows a ready lease — to executionCtx.waitUntil.
    const authority = fakeAuthority({ createCloudWorkspace: vi.fn(async () => ({ workspace_id: "ignored" })) })
    const ensure = vi.fn(async () => ({ status: "ready", epoch: 1, homeRegion: "us-east", sandboxId: "sb_1", url: "https://sb.test" }))
    const provisionRuntime = vi.fn(async () => undefined)
    const { app } = buildApp({ authority, sandboxManager: { ensure } as unknown as SandboxManager, options: { provisionRuntime } })
    const waitUntil = vi.fn()
    const res = await app.fetch(
      post("/create", { workspaceName: "Held open", repoUrl: "https://github.com/a/b" }),
      undefined,
      { waitUntil, passThroughOnException() {}, props: {} } as never,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { workspaceId: string }
    expect(waitUntil).toHaveBeenCalledTimes(1)
    await (waitUntil.mock.calls[0] as unknown as [Promise<unknown>])[0]
    expect(ensure).toHaveBeenCalledWith(body.workspaceId, expect.objectContaining({ homeRegion: "us-east" }))
    expect(provisionRuntime).toHaveBeenCalledWith(body.workspaceId, undefined)
  })

  test("503 sandbox_driver_unavailable when no sandbox driver is composed", async () => {
    const authority = fakeAuthority()
    const { app } = buildApp({ authority: authority })
    const res = await app.fetch(post("/create", { projectId: "proj_1" }))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: "sandbox_driver_unavailable" } })
  })

  test("lets the authority derive the project when the caller names none", async () => {
    // A fresh id passed as the project would be one the caller cannot
    // administer; the D1 authority refuses that, so the route must leave the
    // project to the authority's repository-keyed derivation.
    const createCloudWorkspace = vi.fn(async () => ({ workspace_id: "ignored" }))
    const authority = fakeAuthority({ createCloudWorkspace })
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    const sandboxManager = { ensure } as unknown as SandboxManager
    const { app } = buildApp({ authority: authority, sandboxManager })
    const res = await app.fetch(post("/create", { workspaceName: "First cloud", repoUrl: "https://github.com/a/b" }))
    expect(res.status).toBe(200)
    const args = (createCloudWorkspace.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(args).not.toHaveProperty("projectId")
    expect(args).toMatchObject({ repoUrl: "https://github.com/a/b", displayName: "First cloud" })
  })

  test("creates the cloud workspace doc and kicks off provisioning", async () => {
    const createCloudWorkspace = vi.fn(async () => ({ workspace_id: "ignored" }))
    const authority = fakeAuthority({ createCloudWorkspace })
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    const sandboxManager = { ensure } as unknown as SandboxManager
    const { app } = buildApp({ authority: authority, sandboxManager })

    const res = await app.fetch(
      post("/create", { projectId: "proj_1", workspaceName: "Feature X", repoUrl: "https://github.com/a/b" }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { workspaceId: string; directory: string }
    expect(body.workspaceId).toMatch(/^ws_/)
    expect(body.directory).toBe("/workspace")

    expect(createCloudWorkspace).toHaveBeenCalledTimes(1)
    const args = (createCloudWorkspace.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(args).toMatchObject({
      workspaceId: body.workspaceId,
      projectId: "proj_1",
      displayName: "Feature X",
      repoUrl: "https://github.com/a/b",
      homeRegion: "us-east",
    })
    // provisioning kicked off for the same workspace id (fire-and-forget)
    await Promise.resolve()
    expect(ensure).toHaveBeenCalledTimes(1)
    const [ensuredWorkspaceId, ensured] = ensure.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ]
    expect(ensuredWorkspaceId).toBe(body.workspaceId)
    expect(ensured).toMatchObject({
      homeRegion: "us-east",
      labels: {
        projectId: "proj_1",
      },
      workspaceRoot: "/workspace",
      source: {
        kind: "git",
        repoUrl: "https://github.com/a/b",
      },
    })
    // Hosted creates are always egress-contained (security review §6.14). The
    // allowlist contents are pinned in `hosted-workspace-egress.test.ts`; what
    // matters here is that this call site cannot go back to allow-all.
    expect(ensured.net).toMatchObject({ mode: "restricted" })
  })

  test("rejects hosted cloud create without a clone source", async () => {
    const createCloudWorkspace = vi.fn(async () => ({ workspace_id: "ignored" }))
    const authority = fakeAuthority({ createCloudWorkspace })
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    const { app } = buildApp({
      authority: authority,
      sandboxManager: { ensure } as unknown as SandboxManager,
    })

    const res = await app.fetch(post("/create", { projectId: "proj_1", workspaceName: "Feature X" }))

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "cloud_workspace_source_required" },
    })
    expect(createCloudWorkspace).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
  })

  test("requires a signed bearer token", async () => {
    const authority = fakeAuthority({ createCloudWorkspace: vi.fn(async () => ({})) })
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    const { app } = buildApp({
      authority: authority,
      sandboxManager: { ensure } as unknown as SandboxManager,
    })
    const res = await app.fetch(
      new Request("http://cp.test/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect([401, 403]).toContain(res.status)
  })
})

describe("workspace shares (POST/DELETE /:id/shares)", () => {
  test("grants a share through the authority for a signed caller", async () => {
    const grantWorkspaceShare = vi.fn(async () => ({ granted: true, grant_id: "grant_1" }))
    const { app } = buildApp({ authority: fakeAuthority({ grantWorkspaceShare }) })
    const res = await app.request(post("/ws_user/shares", {
      role: "viewer",
      target: { kind: "user", userId: "user_2" },
    }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ granted: true, grant_id: "grant_1" })
    expect(grantWorkspaceShare).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "ws_user",
      role: "viewer",
      target: { kind: "user", userId: "user_2" },
    })
  })

  test("refuses an anonymous caller and a share with no target", async () => {
    const grantWorkspaceShare = vi.fn(async () => ({ granted: true }))
    const { app } = buildApp({ authority: fakeAuthority({ grantWorkspaceShare }) })
    const anonymous = await app.request(new Request("http://cp.test/ws_user/shares", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "viewer", target: { kind: "user", userId: "user_2" } }),
    }))
    expect(anonymous.status).toBe(401)
    const targetless = await app.request(post("/ws_user/shares", { role: "viewer" }))
    expect(targetless.status).toBe(400)
    expect(grantWorkspaceShare).not.toHaveBeenCalled()
  })
})
