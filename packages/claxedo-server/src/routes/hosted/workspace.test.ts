import { PublicApiError } from "@claxedo/server-core/platform/errors/public-api-error"
import { describe, expect, test, vi } from "vitest"
import { ControlPlaneAuthError, type ControlPlaneTokenVerifier } from "@claxedo/server-core/platform/auth/auth"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import type { ControlPlaneServices } from "../../authority/services"
import type { HostTunnelTokenSigner, RuntimeAccessTokenSigner } from "@claxedo/server-core/platform/auth/runtime-access-token"
import { HostedWorkspaceRoutes, type HostedWorkspaceRouteOptions } from "./workspace"
import { D1WorkspaceAuthorityError } from "../../authority/adapters/d1/workspace-authority-error"
import { createFixedWindowConnectionRateLimiter } from "../../platform/auth/rate-limit"
import { sandboxRuntimeBootFailedError, type SandboxDriver, type SandboxManager } from "@claxedo/sandbox-manager"

/**
 * Hosted workspace routes under machine-wide enrollment. These prove the
 * hosted control plane:
 *   - lets the OWNER assign/unassign a workspace to one of their enrolled
 *     hosts (no challenge, no machine signature — machine consent is the
 *     enrollment heartbeat's acked served set),
 *   - mints the Host Tunnel Token via the injected signer on assignment,
 *   - answers 404 on the retired per-workspace machine-placement quartet,
 *   - and NEVER starts a tunnel / reads local host identity / hits the disk.
 *
 * The signature-verification and routing policy behind assignment lives in
 * the authority (`authority/adapters/d1/host-access-authority.test.ts`); here
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

type CloudCreateArgs = { workspaceId: string; projectId?: string; repoUrl?: string; gitBranch?: string; remoteDirectory?: string; homeRegion?: string }

/** The row an authority stores for a cloud create, which the route reads back to provision from. */
function cloudRow(args: CloudCreateArgs) {
  return {
    workspace_id: args.workspaceId,
    project_id: args.projectId ?? "proj_derived",
    backing: "cloud-vm",
    ...(args.homeRegion ? { home_region: args.homeRegion } : {}),
    ...(args.repoUrl ? { repo_url: args.repoUrl } : {}),
    ...(args.gitBranch ? { git_branch: args.gitBranch } : {}),
    ...(args.remoteDirectory ? { remote_directory: args.remoteDirectory } : {}),
  }
}

function fakeAuthority(overrides: Record<string, unknown> = {}) {
  const created = new Map<string, ReturnType<typeof cloudRow>>()
  const createCloudWorkspace = overrides.createCloudWorkspace as ((auth: unknown, args: CloudCreateArgs) => Promise<unknown>) | undefined
  return {
    usersMe: vi.fn(async () => ({ subject: "user_1", user_id: "user_1", actor_id: "user_1", actor_kind: "human", actor_public_id: "user_pub_1", actor_name: "User One" })),
    authorizeWorkspaceCreate: vi.fn(async () => {}),
    openWorkspace: vi.fn(async (_auth: unknown, args: { workspaceId: string }) => ({
      allowed: true,
      role: "owner",
      workspace: created.get(args.workspaceId) ?? { workspace_id: "ws_1", backing: "local-worktree" },
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
      // assumption about "every machine-placed workspace runs an unbound local
      // policy" can stand in for the declaration.
      session_authority: "managed-private" as const,
    })),
    recordRuntimeAccessToken: vi.fn(async () => ({})),
    revokeRuntimeAccessToken: vi.fn(async () => ({})),
    runtimeAccessTokenActive: vi.fn(async () => ({ active: true })),
    listWorkspaces: vi.fn(async () => [
      { workspace_id: "ws_user", backing: "local-worktree" },
      { workspace_id: "ws_cloud", backing: "cloud-vm" },
    ]),
    assignWorkspaceHost: vi.fn(async () => ({ assigned: true, workspace_id: "ws_1", host_id: "host_1" })),
    unassignWorkspaceHost: vi.fn(async () => ({ unassigned: true })),
    auditAllow: vi.fn(async () => ({})),
    auditDeny: vi.fn(async () => ({})),
    ...overrides,
    ...(createCloudWorkspace
      ? {
          createCloudWorkspace: async (auth: unknown, args: CloudCreateArgs) => {
            const result = await createCloudWorkspace(auth, args)
            created.set(args.workspaceId, cloudRow(args))
            return result
          },
        }
      : {}),
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
  workspaceDriver?: ControlPlaneServices["sandbox"]["workspaceDriver"]
  verifier?: ControlPlaneTokenVerifier
}) {
  const authority = "authority" in opts ? opts.authority : fakeAuthority()
  const { services, capture } = fakeServices(authority)
  services.sandbox.sandboxManager = opts.sandboxManager
  services.sandbox.workspaceDriver = opts.workspaceDriver
  const app = HostedWorkspaceRoutes(services, {
    authConfig,
    verifier: opts.verifier ?? verifier,
    relayUrl: "https://relay.test",
    runtimeAccessTokenSigner: ratSigner,
    hostTunnelTokenSigner: httSigner,
    // Tests never dial DNS: clone admission resolves through this stub (a
    // public answer) unless a case overrides it to answer private or nothing.
    resolveRepoAddresses: async () => ["93.184.216.34"],
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
  test("records the owner assignment without issuing a tunnel credential", async () => {
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
    expect(json.assignment).toMatchObject({ assigned: true, workspace_id: "ws_1", host_id: "host_1" })
    expect(json).not.toHaveProperty("hostTunnel")
  })

  test("an unknown enrollment or workspace is the authority's 404, not a server fault", async () => {
    for (const code of ["host_enrollment_not_found", "workspace_not_found"] as const) {
      const authority = fakeAuthority({
        assignWorkspaceHost: vi.fn(async () => {
          throw new ClaxedoError({ code, message: `${code} refused`, status: 404 })
        }),
      })
      const { app } = buildApp({ authority })
      const res = await app.fetch(post("/ws_1/host-assignment", { hostId: "host_1" }))
      expect(res.status, code).toBe(404)
      expect(await res.json()).toEqual({ error: { code, message: `${code} refused` } })
      expect(authority.auditAllow).not.toHaveBeenCalled()
    }
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
        throw new PublicApiError("workspace_backing_conflict")
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

  test("a repository another project already holds answers the caller a conflict, not a server fault", async () => {
    const createCloudWorkspace = vi.fn(async () => {
      throw new D1WorkspaceAuthorityError("resource_conflict", "Repository is already assigned to a different project")
    })
    const authority = fakeAuthority({ createCloudWorkspace })
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    const { app } = buildApp({ authority, sandboxManager: { ensure } as unknown as SandboxManager })

    const res = await app.fetch(post("/create", { workspaceName: "Conflicting", repoUrl: "https://github.com/a/b" }))

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({ error: { code: "resource_conflict" } })
    expect(ensure).not.toHaveBeenCalled()
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

describe("the retired per-workspace machine-placement routes are gone", () => {
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
  test("mints a Runtime Access Token for a machine-placed workspace", async () => {
    const { app, authority, capture } = buildApp({})
    const res = await app.fetch(get("/ws_1/connection"))
    expect(res.status).toBe(200)
    expect(authority!.recordRuntimeAccessToken).toHaveBeenCalled()
    expect(await res.json()).toMatchObject({
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
      backing: "local-worktree",
      homeRegion: "us-east",
      hostId: "host_1",
    })
    expect(capture).toHaveBeenCalledWith(
      "user_1",
      "runtime_access_token.minted",
      { workspaceId: "ws_1", backing: "local-worktree", role: "owner" },
    )
    expect(JSON.stringify(capture.mock.calls)).not.toMatch(/rat-token|jti_rat|relay\.test/)
  })

  test("uses the workspace home_region to choose the regional relay endpoint", async () => {
    const authority = fakeAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: {
          workspace_id: "ws_1",
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
      backing: "local-worktree",
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
      backing: "local-worktree",
      workspaceId: "ws_1",
      relayUrl: "https://relay.test",
      runtimeAccessToken: "rat-token",
    })
  })

  test("the explicit POST connect returns provisioning metadata while ensure is still acquiring", async () => {
    const authority = fakeAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: "ws_1", project_id: "proj_1", backing: "cloud-vm", home_region: "apac-south" },
      })),
    })
    const sandboxManager = {
      ensure: vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 3, homeRegion: "apac-south" })),
    target: vi.fn(async () => ({ status: "unavailable" as const, reason: "runtime_lease_not_ready", leaseStatus: "acquiring" as const })),
    } as unknown as SandboxManager
    const { app, capture } = buildApp({ authority: authority, sandboxManager })
    const res = await app.fetch(post("/ws_1/connection", {}))
    expect(res.status).toBe(200)
    expect(sandboxManager.ensure).toHaveBeenCalledWith("ws_1", {
      homeRegion: "apac-south",
      labels: { projectId: "proj_1" },
      workspaceRoot: "/workspace",
      source: { kind: "empty" },
      net: expect.objectContaining({ mode: "restricted", hosts: expect.arrayContaining(["api.anthropic.com"]) }),
    })
    expect(capture).toHaveBeenCalledWith("user_1", "workspace.connection.requested", {
      workspaceId: "ws_1",
      backing: "cloud-vm",
      homeRegion: "apac-south",
    })
    expect(capture).toHaveBeenCalledWith("user_1", "sandbox.ensure", {
      workspaceId: "ws_1",
      status: "provisioning",
      homeRegion: "apac-south",
      leaseEpoch: 3,
      retryAfterMs: 2_000,
    })
    expect(await res.json()).toEqual({
      status: "provisioning",
      workspaceId: "ws_1",
      homeRegion: "apac-south",
      retryAfterMs: 2_000,
    })
  })

  test("GET reports an in-flight start as provisioning without provisioning itself", async () => {
    const authority = fakeAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: "ws_1", project_id: "proj_1", backing: "cloud-vm", home_region: "apac-south" },
      })),
    })
    // No `ensure` on this fake: the read resolves the lease row through
    // `target` and a stray provisioning call throws instead of passing silently.
    const sandboxManager = {
      target: vi.fn(async () => ({
        status: "unavailable" as const,
        reason: "runtime_lease_not_ready",
        leaseStatus: "acquiring" as const,
        retryAfterMs: 2_000,
      })),
    } as unknown as SandboxManager
    const { app, capture } = buildApp({ authority: authority, sandboxManager })
    const res = await app.fetch(get("/ws_1/connection"))
    expect(res.status).toBe(200)
    expect(sandboxManager.target).toHaveBeenCalledWith("ws_1")
    expect(capture).toHaveBeenCalledWith("user_1", "sandbox.target", {
      workspaceId: "ws_1",
      status: "unavailable",
      homeRegion: "apac-south",
      reason: "runtime_lease_not_ready",
      leaseStatus: "acquiring",
    })
    expect(await res.json()).toEqual({
      status: "provisioning",
      workspaceId: "ws_1",
      homeRegion: "apac-south",
      retryAfterMs: 2_000,
    })
  })

  test("GET withholds tokens until settings are applied without provisioning from a read", async () => {
    const authority = fakeAuthority({ openWorkspace: async () => ({
      allowed: true, role: "owner", workspace: { workspace_id: "ws_1", org_id: "org_1", backing: "cloud-vm" },
    }) })
    const ensure = vi.fn()
    const runtimeProvisioned = vi.fn(async () => false)
    const { app } = buildApp({ authority, sandboxManager: {
      target: async () => ({ status: "ready", hostId: "host_1", epoch: 1 }), ensure,
    } as unknown as SandboxManager, options: { runtimeProvisioned } })
    expect(await (await app.fetch(get("/ws_1/connection"))).json()).toMatchObject({ status: "provisioning" })
    expect(authority.recordRuntimeAccessToken).not.toHaveBeenCalled()
    runtimeProvisioned.mockResolvedValue(true)
    expect(await (await app.fetch(get("/ws_1/connection"))).json()).toMatchObject({ runtimeAccessToken: "rat-token" })
    runtimeProvisioned.mockRejectedValue(new Error("Settings read failed"))
    expect((await app.fetch(get("/ws_1/connection"))).status).toBe(409)
    expect(ensure).not.toHaveBeenCalled()
  })

  test("GET refuses a running workspace booted from an older image with a typed answer, and mints nothing", async () => {
    const authority = fakeAuthority({ openWorkspace: async () => ({
      allowed: true, role: "owner", workspace: { workspace_id: "ws_1", org_id: "org_1", backing: "cloud-vm" },
    }) })
    const ensure = vi.fn()
    const { app } = buildApp({ authority, sandboxManager: {
      target: async () => ({ status: "ready", hostId: "host_1", epoch: 1, imageOutdated: true }), ensure,
    } as unknown as SandboxManager })
    const res = await app.fetch(get("/ws_1/connection"))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: { code: "cloud_runtime_image_outdated", message: "This cloud workspace runs an older version. Restart it to update." } })
    expect(authority.recordRuntimeAccessToken).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
  })

  test("GET reports a stopped cloud workspace without provisioning it", async () => {
    const authority = fakeAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: "ws_1", project_id: "proj_1", backing: "cloud-vm", home_region: "us-east" },
      })),
    })
    const ensure = vi.fn()
    const sandboxManager = {
      target: vi.fn(async () => ({
        status: "unavailable" as const,
        reason: "runtime_lease_not_ready",
        leaseStatus: "stopped" as const,
      })),
      ensure,
    } as unknown as SandboxManager
    const { app, authority: auth } = buildApp({ authority: authority, sandboxManager })
    const res = await app.fetch(get("/ws_1/connection"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: "stopped",
      workspaceId: "ws_1",
      homeRegion: "us-east",
    })
    // Reading a dormant workspace must not start billable compute (P-118):
    // no ensure, no mint.
    expect(ensure).not.toHaveBeenCalled()
    expect(auth!.recordRuntimeAccessToken).not.toHaveBeenCalled()
  })

  test("GET reports a cloud workspace with no lease as stopped", async () => {
    const authority = fakeAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: "ws_1", project_id: "proj_1", backing: "cloud-vm", home_region: "us-east" },
      })),
    })
    const ensure = vi.fn()
    const sandboxManager = {
      target: vi.fn(async () => ({ status: "unavailable" as const, reason: "runtime_lease_missing" })),
      ensure,
    } as unknown as SandboxManager
    const { app } = buildApp({ authority: authority, sandboxManager })
    const res = await app.fetch(get("/ws_1/connection"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: "stopped",
      workspaceId: "ws_1",
      homeRegion: "us-east",
    })
    expect(ensure).not.toHaveBeenCalled()
  })

  test("mints a Runtime Access Token for a ready cloud workspace without driver internals", async () => {
    const authority = fakeAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "editor",
        workspace: { workspace_id: "ws_1", project_id: "proj_1", backing: "cloud-vm", home_region: "eu-west" },
      })),
    })
    const sandboxManager = {
      target: vi.fn(async () => ({
        status: "ready",
        routingId: "routing_test",
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
    expect(ratSigner).toHaveBeenCalledWith(expect.objectContaining({ hostId: "host_cloud_1", routingId: "routing_test" }))
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
    expect(capture).toHaveBeenCalledWith("user_1", "sandbox.target", {
      workspaceId: "ws_1",
      status: "ready",
      homeRegion: "eu-west",
      hostId: "host_cloud_1",
      leaseEpoch: 8,
    })
    expect(capture).toHaveBeenCalledWith(
      "user_1",
      "runtime_access_token.minted",
      { workspaceId: "ws_1", backing: "cloud-vm", role: "editor", homeRegion: "eu-west", leaseEpoch: 8 },
    )
    expect(JSON.stringify(capture.mock.calls)).not.toMatch(/rat-token|jti_rat|relay\.test|driver-resource-secret-id/)
    const body = await res.json()
    expect(body).toMatchObject({
      backing: "cloud-vm",
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
        workspace: { workspace_id: "ws_1", project_id: "proj_1", backing: "cloud-vm", home_region: "eu-west" },
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
      target: vi.fn(async () => ({ status: "unavailable" as const, reason: "runtime_lease_not_ready", leaseStatus: "acquiring" as const })),
    } as unknown as SandboxManager
    const { app, capture } = buildApp({ authority: authority, sandboxManager })
    // The 409 is the explicit connect's answer; the GET read reports the same
    // lease as `stopped` instead.
    const res = await app.fetch(post("/ws_1/connection", {}))
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
      retryAfterMs: 5_000,
    })
    expect(capture).toHaveBeenCalledWith("user_1", "workspace.connection.unavailable", {
      workspaceId: "ws_1",
      backing: "cloud-vm",
      homeRegion: "eu-west",
      retryAfterMs: 5_000,
    })
  })

  test("a runtime whose boot failed answers the connect with the boot's reason instead of a wait", async () => {
    const authority = fakeAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: "ws_1", project_id: "proj_1", backing: "cloud-vm", home_region: "eu-west" },
      })),
    })
    const sandboxManager = {
      ensure: vi.fn(async () => ({
        status: "unavailable",
        retryAfterMs: 5_000,
        error: sandboxRuntimeBootFailedError("fatal: couldn't find remote ref refs/heads/missing"),
        epoch: 9,
        homeRegion: "eu-west",
      })),
      target: vi.fn(async () => ({ status: "unavailable" as const, reason: "runtime_lease_not_ready", leaseStatus: "acquiring" as const })),
    } as unknown as SandboxManager
    const { app } = buildApp({ authority: authority, sandboxManager })
    const res = await app.fetch(post("/ws_1/connection", {}))
    expect(res.status).toBe(409)
    const body = await res.json() as { error: Record<string, unknown> }
    expect(body.error).toMatchObject({
      code: "cloud_runtime_boot_failed",
      message: "The cloud workspace could not start: fatal: couldn't find remote ref refs/heads/missing",
    })
    expect(body.error).not.toHaveProperty("retryAfterMs")
  })

  test("fails closed when a cloud workspace has no sandbox", async () => {
    const authority = fakeAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: "ws_1", project_id: "proj_1", backing: "cloud-vm" },
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

describe("a session share holder's connection", () => {
  test("shared session catalog returns the authority's rows and refuses unsigned requests", async () => {
    const rows = [{ session_id: "ses_shared", workspace_id: "ws_1", project_id: "prj_1", title: "Review", owner_name: "Ada", level: "follow" }]
    const listSharedSessions = vi.fn(async () => rows)
    const { app } = buildApp({ authority: fakeAuthority({ listSharedSessions }) })
    const response = await app.fetch(get("/shared-sessions", "recipient"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sessions: rows })
    expect(listSharedSessions).toHaveBeenCalledTimes(1)
    expect((await app.fetch(new Request("http://cp.test/shared-sessions"))).status).toBe(401)
    expect(listSharedSessions).toHaveBeenCalledTimes(1)
  })
  function sessionApp(input: { authority: ReturnType<typeof fakeAuthority>; hostTunnelResolver?: (workspaceId: string) => Promise<unknown> }) {
    const { services } = fakeServices(input.authority)
    ;(services as { relay?: unknown }).relay = { hostTunnelResolver: input.hostTunnelResolver }
    return HostedWorkspaceRoutes(services, {
      authConfig,
      verifier,
      relayUrl: "https://relay.test",
      runtimeAccessTokenSigner: ratSigner,
      hostTunnelTokenSigner: httSigner,
    })
  }

  test("is scoped to the session it names, off the machine already serving it, without opening the workspace", async () => {
    const authorizeSessionRead = vi.fn(async () => {})
    const authority = fakeAuthority({
      authorizeSessionRead,
      resolveWorkspaceOwner: vi.fn(async () => ({ userId: "user_owner", actorId: "act_owner", orgId: "org_owner", projectId: "prj_1" })),
    })
    const app = sessionApp({ authority, hostTunnelResolver: async () => ({ active: true, hostId: "host_1", backing: "local-worktree" }) })

    const res = await app.fetch(get("/ws_1/connection?sessionId=ses_shared", "user_share"))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      backing: "local-worktree",
      sessionAuthority: "managed-private",
      workspaceId: "ws_1",
      sessionId: "ses_shared",
      relayUrl: "https://relay.test",
      runtimeAccessToken: "rat-token",
      tokenExpiresAt: 1_000_000,
      role: "viewer",
      hostId: "host_1",
    })
    expect(authorizeSessionRead).toHaveBeenCalledWith(expect.anything(), { workspaceId: "ws_1", sessionId: "ses_shared" })
    expect(vi.mocked(ratSigner).mock.calls.at(-1)?.[0]).toMatchObject({ orgId: "org_owner", role: "viewer", sessionId: "ses_shared", hostId: "host_1" })
    expect(authority.recordRuntimeAccessToken).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ role: "viewer", sessionId: "ses_shared" }))
    expect(authority.openWorkspace).not.toHaveBeenCalled()
    expect(authority.activeWorkspaceHost).not.toHaveBeenCalled()
  })

  test("is refused before anything is minted when the caller may not read the session", async () => {
    const resolveWorkspaceOwner = vi.fn(async () => ({ userId: "user_owner", actorId: "act_owner", orgId: "org_owner", projectId: "prj_1" }))
    const authority = fakeAuthority({
      authorizeSessionRead: vi.fn(async () => { throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Session authorization was denied") }),
      resolveWorkspaceOwner,
    })
    const app = sessionApp({ authority, hostTunnelResolver: async () => ({ active: true, hostId: "host_1", backing: "local-worktree" }) })

    const res = await app.fetch(get("/ws_1/connection?sessionId=ses_private", "user_stranger"))

    expect(res.status).toBe(403)
    expect(authority.recordRuntimeAccessToken).not.toHaveBeenCalled()
    expect(resolveWorkspaceOwner).not.toHaveBeenCalled()
  })

  test("answers offline, starting nothing, when no machine or running sandbox serves the workspace", async () => {
    const authority = fakeAuthority({
      authorizeSessionRead: vi.fn(async () => {}),
      resolveWorkspaceOwner: vi.fn(async () => ({ userId: "user_owner", actorId: "act_owner", orgId: "org_owner", projectId: "prj_1" })),
    })
    const app = sessionApp({ authority, hostTunnelResolver: async () => ({ active: false }) })

    const res = await app.fetch(get("/ws_1/connection?sessionId=ses_shared", "user_share"))

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({ error: { code: "workspace_host_offline" } })
    expect(authority.recordRuntimeAccessToken).not.toHaveBeenCalled()
  })
})

describe("hosted connection rate limiting (mint-only)", () => {
  function cloudWorkspaceAuthority() {
    return fakeAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: "ws_1", project_id: "proj_1", backing: "cloud-vm", home_region: "us-east" },
      })),
    })
  }

  test("10 consecutive provisioning polls never hit the Runtime Access Token mint limit", async () => {
    const sandboxManager = {
      target: vi.fn(async () => ({
        status: "unavailable" as const,
        reason: "runtime_lease_not_ready",
        leaseStatus: "acquiring" as const,
        retryAfterMs: 2_000,
      })),
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
      routingId: "routing_test",
      sandboxId: "sandbox_1",
      url: "https://runtime.test/ws_1",
      hostId: "host_cloud_1",
      epoch: 2,
      homeRegion: "us-east",
    }
    const acquiring = {
      status: "unavailable",
      reason: "runtime_lease_not_ready",
      leaseStatus: "acquiring",
      retryAfterMs: 2_000,
    }
    const target = vi.fn(async () => ready as never)
    target
      .mockResolvedValueOnce(acquiring as never)
      .mockResolvedValueOnce(acquiring as never)
      .mockResolvedValueOnce(acquiring as never)
    const sandboxManager = { target } as unknown as SandboxManager
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
    expect((await app.fetch(get("/ws_1/connection"))).status).toBe(200)
    expect((await app.fetch(get("/ws_1/connection"))).status).toBe(200)
    expect(authority!.recordRuntimeAccessToken).toHaveBeenCalledTimes(2)
    const limited = await app.fetch(get("/ws_1/connection"))
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: { code: "runtime_access_token_rate_limited" } })
  })

  test("provisioning polls beyond the control-plane request cap get 429 before any the authority read", async () => {
    const sandboxManager = {
      target: vi.fn(async () => ({
        status: "unavailable" as const,
        reason: "runtime_lease_not_ready",
        leaseStatus: "acquiring" as const,
        retryAfterMs: 2_000,
      })),
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
    expect(sandboxManager.target).toHaveBeenCalledTimes(3)
  })

  test("repeated rate-limit rejections in one window audit to the authority exactly once", async () => {
    const sandboxManager = {
      target: vi.fn(async () => ({
        status: "unavailable" as const,
        reason: "runtime_lease_not_ready",
        leaseStatus: "acquiring" as const,
        retryAfterMs: 2_000,
      })),
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
  test("signed host=machine returns only the caller's machine-placed workspaces", async () => {
    const { app, authority } = buildApp({})
    const res = await app.fetch(get("/?host=machine"))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { workspaces: Array<{ workspace_id: string }> }
    expect(json.workspaces).toEqual([{ workspace_id: "ws_user", backing: "local-worktree", reachable: false }])
    expect(authority!.usersMe).toHaveBeenCalledTimes(1)
    expect(authority!.listWorkspaces).toHaveBeenCalledTimes(1)
  })

  test("signed host=provisioner returns the full list (no machine-placement filter)", async () => {
    const { app, authority } = buildApp({})
    const res = await app.fetch(get("/?host=provisioner"))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { workspaces: Array<{ workspace_id: string }> }
    expect(json.workspaces).toEqual([
      { workspace_id: "ws_user", backing: "local-worktree", reachable: false },
      { workspace_id: "ws_cloud", backing: "cloud-vm", reachable: false, status: "failed", error: "This server runs no cloud workspaces" },
    ])
    expect(authority!.listWorkspaces).toHaveBeenCalledTimes(1)
  })

  test("each row says whether its runtime answers now: a machine row by host_online, a cloud row by a ready lease", async () => {
    const authority = fakeAuthority({
      listWorkspaces: vi.fn(async () => [
        { workspace_id: "ws_online", backing: "local-worktree", host_online: true },
        { workspace_id: "ws_offline", backing: "local-worktree", host_online: false },
        { workspace_id: "ws_ready", backing: "cloud-vm" },
        { workspace_id: "ws_stopped", backing: "cloud-vm" },
      ]),
    })
    const target = vi.fn(async (id: string) => ({ status: id === "ws_ready" ? "ready" : "stopped" }))
    const { app } = buildApp({ authority, sandboxManager: { target } as unknown as SandboxManager })
    const res = await app.fetch(get("/?host=provisioner"))
    const json = (await res.json()) as { workspaces: Array<{ workspace_id: string; reachable: boolean }> }
    expect(json.workspaces.map((row) => [row.workspace_id, row.reachable])).toEqual([
      ["ws_online", true],
      ["ws_offline", false],
      ["ws_ready", true],
      ["ws_stopped", false],
    ])
  })

  test("each cloud row carries the lifecycle status its lease names, read without starting compute", async () => {
    const leases: Record<string, unknown> = {
      ws_ready: { status: "ready", sandboxId: "box", url: "https://runtime.test", hostId: "host", epoch: 1, homeRegion: "eu-west" },
      ws_booting: { status: "unavailable", reason: "runtime_acquiring", leaseStatus: "acquiring" },
      ws_stopped: { status: "unavailable", reason: "runtime_stopped", leaseStatus: "stopped" },
      ws_never: { status: "unavailable", reason: "runtime_lease_missing" },
      ws_retrying: { status: "unavailable", reason: "runtime_lease_not_ready", leaseStatus: "unavailable", failure: { kind: "provider", message: "quota exceeded", retrying: true } },
      ws_broken: { status: "unavailable", reason: "runtime_lease_not_ready", leaseStatus: "unavailable", failure: { kind: "provider", message: "quota exceeded", retrying: false } },
    }
    const authority = fakeAuthority({ listWorkspaces: vi.fn(async () => Object.keys(leases).map((workspace_id) => ({ workspace_id, backing: "cloud-vm" }))) })
    const ensure = vi.fn()
    const target = vi.fn(async (id: string) => leases[id])
    const { app } = buildApp({ authority, sandboxManager: { target, ensure } as unknown as SandboxManager })
    const json = (await (await app.fetch(get("/?host=provisioner"))).json()) as { workspaces: unknown[] }
    expect(json.workspaces).toEqual([
      { workspace_id: "ws_ready", backing: "cloud-vm", status: "ready", reachable: true },
      { workspace_id: "ws_booting", backing: "cloud-vm", status: "provisioning", reachable: false },
      { workspace_id: "ws_stopped", backing: "cloud-vm", status: "stopped", reachable: false },
      { workspace_id: "ws_never", backing: "cloud-vm", status: "stopped", reachable: false },
      { workspace_id: "ws_retrying", backing: "cloud-vm", status: "provisioning", reachable: false },
      { workspace_id: "ws_broken", backing: "cloud-vm", status: "failed", error: "The cloud workspace could not start: quota exceeded", reachable: false },
    ])
    expect(ensure).not.toHaveBeenCalled()
  })

  test("unsigned (no host query) returns an empty list and never touches the authority", async () => {
    const { app, authority } = buildApp({})
    const res = await app.fetch(new Request("http://cp.test/"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ workspaces: [] })
    // Hosted has no local projects list — no authority read on the unsigned path.
    expect(authority!.usersMe).not.toHaveBeenCalled()
    expect(authority!.listWorkspaces).not.toHaveBeenCalled()
  })

  test("host=machine with no bearer token fails closed (signed required)", async () => {
    const { app, authority } = buildApp({})
    const res = await app.fetch(new Request("http://cp.test/?host=machine"))
    expect(res.status).toBe(401)
    expect(authority!.listWorkspaces).not.toHaveBeenCalled()
  })

  test("honors the control-plane rate limiter", async () => {
    const { app, authority } = buildApp({
      options: {
        controlPlaneRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 1, windowMs: 60_000 }),
      },
    })
    expect((await app.fetch(get("/?host=machine"))).status).toBe(200)
    const limited = await app.fetch(get("/?host=machine"))
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: { code: "control_plane_rate_limited" } })
    // The rate-limited request did not reach the workspace listing.
    expect(authority!.listWorkspaces).toHaveBeenCalledTimes(1)
  })
})

describe("hosted cloud workspace create (POST /create)", () => {
  test("creates the workspace and starts nothing: no ensure, and no work held past the response", async () => {
    const authority = fakeAuthority({ createCloudWorkspace: vi.fn(async () => ({ workspace_id: "ignored" })) })
    const ensure = vi.fn()
    const prepareRuntime = vi.fn()
    const { app, capture } = buildApp({ authority, sandboxManager: { ensure } as unknown as SandboxManager, options: { prepareRuntime } })
    const waitUntil = vi.fn()
    const res = await app.fetch(
      post("/create", { workspaceName: "Cold", repoUrl: "https://github.com/a/b" }),
      undefined,
      { waitUntil, passThroughOnException() {}, props: {} } as never,
    )
    expect(res.status).toBe(200)
    expect(waitUntil).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
    expect(prepareRuntime).not.toHaveBeenCalled()
    const { workspaceId } = await res.json() as { workspaceId: string }
    expect(capture).toHaveBeenCalledWith("user_1", "workspace_created", { workspaceId, kind: "cloud", private_repository: false })
  })

  test("503 sandbox_driver_unavailable when no sandbox driver is composed", async () => {
    const authority = fakeAuthority()
    const { app } = buildApp({ authority: authority })
    const res = await app.fetch(post("/create", { projectId: "proj_1", workspaceName: "Feature X" }))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: "sandbox_driver_unavailable" } })
  })

  test("refuses a create without a name before admission, creating and provisioning nothing", async () => {
    const createCloudWorkspace = vi.fn(async () => ({ workspace_id: "ignored" }))
    const authority = fakeAuthority({ createCloudWorkspace })
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    const { app } = buildApp({ authority, sandboxManager: { ensure } as unknown as SandboxManager })
    for (const body of [{ repoUrl: "https://github.com/a/b", repoName: "b" }, { workspaceName: "   ", repoUrl: "https://github.com/a/b" }]) {
      const res = await app.fetch(post("/create", body))
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: "workspace_name_required" } })
    }
    expect(authority.authorizeWorkspaceCreate).not.toHaveBeenCalled()
    expect(createCloudWorkspace).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
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

  test("creates the cloud workspace doc and leaves its start to the first explicit start", async () => {
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
    expect(ensure).not.toHaveBeenCalled()
  })

  test("a branch name git refuses is refused at create, before any workspace exists to fail every boot", async () => {
    const createCloudWorkspace = vi.fn(async () => ({ workspace_id: "ignored" }))
    const authority = fakeAuthority({ createCloudWorkspace })
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    const { app } = buildApp({ authority: authority, sandboxManager: { ensure } as unknown as SandboxManager })

    for (const gitBranch of ["-x", "feature..main"]) {
      const res = await app.fetch(post("/create", { workspaceName: "Feature X", repoUrl: "https://github.com/a/b", gitBranch }))
      expect(res.status, gitBranch).toBe(400)
      await expect(res.json()).resolves.toMatchObject({ error: { code: "git_branch_invalid" } })
    }
    expect(createCloudWorkspace).not.toHaveBeenCalled()

    const res = await app.fetch(post("/create", { workspaceName: "Feature X", repoUrl: "https://github.com/a/b", gitBranch: " feature/payments-v2 " }))
    expect(res.status).toBe(200)
    expect((createCloudWorkspace.mock.calls[0] as unknown[])[1]).toMatchObject({ gitBranch: "feature/payments-v2" })
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

  test("rejects a repoUrl this server will not clone", async () => {
    const createCloudWorkspace = vi.fn(async () => ({ workspace_id: "ignored" }))
    const authority = fakeAuthority({ createCloudWorkspace })
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    const { app } = buildApp({
      authority: authority,
      sandboxManager: { ensure } as unknown as SandboxManager,
    })

    for (const repoUrl of ["file:///etc/passwd", "ftp://example.com/repo.git", "not a url"]) {
      const res = await app.fetch(post("/create", { workspaceName: "Bad", repoUrl }))
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toMatchObject({ error: { code: "repo_url_invalid" } })
    }
    expect(createCloudWorkspace).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
  })

  test("rejects a repoUrl whose destination is not public", async () => {
    // Clone admission is the same policy the egress allowlist is derived
    // from: a signed caller must not turn a hosted create into reachability
    // into the deployment's own addresses (P-72).
    const createCloudWorkspace = vi.fn(async () => ({ workspace_id: "ignored" }))
    const authority = fakeAuthority({ createCloudWorkspace })
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    const { app } = buildApp({
      authority,
      sandboxManager: { ensure } as unknown as SandboxManager,
    })

    const refused = [
      "http://169.254.169.254/latest/meta-data",
      "https://10.0.0.5/acme/repo.git",
      "http://127.0.0.1:8080/acme/repo.git",
      "http://localhost:8080/acme/repo.git",
      "ssh://git@[::1]/acme/repo.git",
      "git@192.168.1.10:acme/repo.git",
    ]
    for (const [i, repoUrl] of refused.entries()) {
      // A fresh subject per request: the per-caller create budget (5/min) is
      // not the refusal under test.
      const res = await app.fetch(post("/create", { workspaceName: "Internal", repoUrl }, `user_${i}`))
      expect(res.status, repoUrl).toBe(400)
      await expect(res.json()).resolves.toMatchObject({ error: { code: "repo_url_invalid" } })
    }
    expect(createCloudWorkspace).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
  })

  test("rejects a clone hostname that resolves private, or does not resolve", async () => {
    const createCloudWorkspace = vi.fn(async () => ({ workspace_id: "ignored" }))
    const authority = fakeAuthority({ createCloudWorkspace })
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    const resolveRepoAddresses = vi.fn(async () => ["93.184.216.34", "10.0.0.5"])
    const { app } = buildApp({
      authority,
      sandboxManager: { ensure } as unknown as SandboxManager,
      options: { resolveRepoAddresses },
    })

    const mixed = await app.fetch(post("/create", { workspaceName: "Mixed", repoUrl: "https://git.acme.test/repo.git" }))
    expect(mixed.status).toBe(400)
    await expect(mixed.json()).resolves.toMatchObject({ error: { code: "repo_url_invalid" } })
    expect(resolveRepoAddresses).toHaveBeenCalledWith("git.acme.test")

    const { app: unresolvable } = buildApp({
      authority,
      sandboxManager: { ensure } as unknown as SandboxManager,
      options: { resolveRepoAddresses: async () => [] },
    })
    const nowhere = await unresolvable.fetch(post("/create", { workspaceName: "Nowhere", repoUrl: "https://git.acme.test/repo.git" }))
    expect(nowhere.status).toBe(400)
    expect(createCloudWorkspace).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
  })

  test("admits an operator-approved private Git host by exact name", async () => {
    const createCloudWorkspace = vi.fn(async () => ({ workspace_id: "ignored" }))
    const authority = fakeAuthority({ createCloudWorkspace })
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    const resolveRepoAddresses = vi.fn(async () => ["10.0.0.5"])
    const { app } = buildApp({
      authority,
      sandboxManager: { ensure } as unknown as SandboxManager,
      options: { privateRepoHosts: ["git.corp.internal"], resolveRepoAddresses },
    })

    const approved = await app.fetch(post("/create", { workspaceName: "Corp", repoUrl: "https://git.corp.internal/acme/repo.git" }))
    expect(approved.status).toBe(200)
    // Approval is an exact-name policy, not a lookup: the resolver never runs.
    expect(resolveRepoAddresses).not.toHaveBeenCalled()

    const sibling = await app.fetch(post("/create", { workspaceName: "Sibling", repoUrl: "https://other.corp.internal/acme/repo.git" }))
    expect(sibling.status).toBe(400)
  })

  test("asks the authority to admit a create that names no organization", async () => {
    const authority = fakeAuthority({ createCloudWorkspace: vi.fn(async () => ({ workspace_id: "ignored" })) })
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    const { app } = buildApp({ authority, sandboxManager: { ensure } as unknown as SandboxManager })

    const res = await app.fetch(post("/create", { workspaceName: "Implicit", repoUrl: "https://github.com/a/b" }))

    expect(res.status).toBe(200)
    expect(authority.authorizeWorkspaceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ subject: "user_1" }) }),
      {},
    )
  })

  test("hands the admission the same selectors the creation will resolve its organization from", async () => {
    const createCloudWorkspace = vi.fn(async () => ({ workspace_id: "ignored" }))
    const authority = fakeAuthority({ createCloudWorkspace })
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    const { app } = buildApp({ authority, sandboxManager: { ensure } as unknown as SandboxManager })

    const res = await app.fetch(post("/create", {
      orgId: " org_acme ",
      projectId: " proj_1 ",
      workspaceName: "Selected",
      repoUrl: "https://github.com/a/b",
    }))

    expect(res.status).toBe(200)
    expect(authority.authorizeWorkspaceCreate).toHaveBeenCalledWith(expect.anything(), {
      orgId: "org_acme",
      projectId: "proj_1",
    })
    // The project the authority admitted is the project it is then asked to
    // create in; a divergence here would authorize one tenant and write another.
    expect((createCloudWorkspace.mock.calls[0] as unknown[])[1]).toMatchObject({
      orgId: "org_acme",
      projectId: "proj_1",
    })
  })

  test("a connected private repository is bound to the connection the person picked; a public one is bound to none", async () => {
    for (const visibility of [{ private: true, bound: "conn_org" }, { private: false, bound: undefined }]) {
      const createCloudWorkspace = vi.fn(async () => ({ workspace_id: "ignored" }))
      const repository = { id: "1", name: "widgets", fullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git", private: visibility.private, permissions: { read: true, write: false } }
      const repositoryForAuth = vi.fn(async () => ({ ok: true as const, repository }))
      const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
      const { app } = buildApp({
        authority: fakeAuthority({ createCloudWorkspace }),
        sandboxManager: { ensure } as unknown as SandboxManager,
        options: { connections: { repositoryForAuth } },
      })
      const res = await app.fetch(post("/create", { workspaceName: "Widgets", connectionId: "conn_org", repo: { fullName: "acme/widgets" } }))
      expect(res.status).toBe(200)
      expect(repositoryForAuth).toHaveBeenCalledWith(expect.anything(), "conn_org", "acme/widgets")
      const created = (createCloudWorkspace.mock.calls[0] as unknown[])[1] as { repoUrl?: string; repoConnectionId?: string }
      expect([created.repoUrl, created.repoConnectionId]).toEqual([repository.cloneUrl, visibility.bound])
    }
  })

  test("a refused admission creates nothing and provisions nothing", async () => {
    const createCloudWorkspace = vi.fn(async () => ({ workspace_id: "ignored" }))
    const repositoryForAuth = vi.fn()
    const authority = fakeAuthority({
      createCloudWorkspace,
      authorizeWorkspaceCreate: vi.fn(async () => {
        throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Workspace authority denied workspace access")
      }),
    })
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    const requireCloudWorkspaceEntitlement = vi.fn(async () => undefined)
    const { app } = buildApp({
      authority,
      sandboxManager: { ensure } as unknown as SandboxManager,
      options: { requireCloudWorkspaceEntitlement, connections: { repositoryForAuth } },
    })

    const res = await app.fetch(post("/create", {
      orgId: "org_acme",
      workspaceName: "Widgets",
      connectionId: "conn_1",
      repo: { fullName: "acme/widgets" },
    }))

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ error: { code: "workspace_authorization_denied" } })
    expect(createCloudWorkspace).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
    // Refused before the clone token is minted and before the paid-capability
    // gate spends a billing read on a caller who may not create at all.
    expect(repositoryForAuth).not.toHaveBeenCalled()
    expect(requireCloudWorkspaceEntitlement).not.toHaveBeenCalled()
  })

  test("an authority that cannot admit a create refuses it", async () => {
    const createCloudWorkspace = vi.fn(async () => ({ workspace_id: "ignored" }))
    const authority = fakeAuthority({ createCloudWorkspace })
    delete (authority as { authorizeWorkspaceCreate?: unknown }).authorizeWorkspaceCreate
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    const { app } = buildApp({ authority, sandboxManager: { ensure } as unknown as SandboxManager })

    const res = await app.fetch(post("/create", { workspaceName: "Unadmitted", repoUrl: "https://github.com/a/b" }))

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({ error: { code: "workspace_authority_unavailable" } })
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

describe("the start that opens a cloud workspace's first lease", () => {
  const cloudAuthority = () => fakeAuthority({
    openWorkspace: vi.fn(async () => ({
      allowed: true,
      role: "owner",
      workspace: { workspace_id: "ws_1", project_id: "proj_1", backing: "cloud-vm", home_region: "us-east" },
    })),
  })
  const leaseMissing = { status: "unavailable" as const, reason: "runtime_lease_missing" }
  const leaseAcquiring = { status: "unavailable" as const, reason: "runtime_lease_not_ready", leaseStatus: "acquiring" as const }

  const acquiringEnsure = () => vi.fn(async (_id: string, input: { onLeaseOpened?: () => void }) => {
    input.onLeaseOpened?.()
    return { status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }
  })

  test("meters the lease under the driver, and whose key, it is placed on when its acquire opens it, stamps its tenant after, and meters a later start of it no more", async () => {
    const ensure = acquiringEnsure()
    const target = vi.fn().mockResolvedValueOnce(leaseMissing).mockResolvedValue(leaseAcquiring)
    const workspaceDriver = vi.fn(async () => ({ driver: { id: "boat" } as SandboxDriver, key: "org" as const }))
    const sandboxUsage = { leaseOpened: vi.fn(), recordLeaseTenant: vi.fn(async () => undefined) }
    const { app } = buildApp({ authority: cloudAuthority(), sandboxManager: { ensure, target } as unknown as SandboxManager, workspaceDriver, options: { sandboxUsage } })

    expect((await app.fetch(post("/ws_1/connection", {}))).status).toBe(200)
    expect(sandboxUsage.leaseOpened).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws_1", driver: "boat", keyOwner: "org" }))
    expect(sandboxUsage.recordLeaseTenant).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws_1" }))
    expect(sandboxUsage.recordLeaseTenant.mock.invocationCallOrder[0]).toBeGreaterThan(sandboxUsage.leaseOpened.mock.invocationCallOrder[0])

    expect((await app.fetch(post("/ws_1/connection", {}))).status).toBe(200)
    expect(ensure).toHaveBeenCalledTimes(2)
    expect(ensure.mock.calls[1]?.[1]).not.toHaveProperty("onLeaseOpened")
    expect(sandboxUsage.leaseOpened).toHaveBeenCalledTimes(1)
    expect(sandboxUsage.recordLeaseTenant).toHaveBeenCalledTimes(1)
  })

  test("of two first starts that both pass the cap, only the one whose acquire opened the lease meters it", async () => {
    let acquired = false
    const ensure = vi.fn(async (_id: string, input: { onLeaseOpened?: () => void }) => {
      if (!acquired) {
        acquired = true
        input.onLeaseOpened?.()
      }
      return { status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }
    })
    const sandboxUsage = { leaseOpened: vi.fn(), recordLeaseTenant: vi.fn(async () => undefined) }
    const { app } = buildApp({
      authority: cloudAuthority(),
      sandboxManager: { ensure, target: vi.fn(async () => leaseMissing) } as unknown as SandboxManager,
      options: { sandboxUsage },
    })

    const starts = await Promise.all([app.fetch(post("/ws_1/connection", {})), app.fetch(post("/ws_1/connection", {}))])

    expect(starts.map((res) => res.status)).toEqual([200, 200])
    expect(ensure).toHaveBeenCalledTimes(2)
    expect(sandboxUsage.leaseOpened).toHaveBeenCalledTimes(1)
    expect(sandboxUsage.recordLeaseTenant).toHaveBeenCalledTimes(1)
  })

  test("the concurrent-lease cap refuses a first start before ensure, and never a start of a workspace already leased", async () => {
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    const countActiveOrgSandboxLeases = vi.fn(async () => 2)
    const missing = buildApp({
      authority: cloudAuthority(),
      sandboxManager: { ensure, target: vi.fn(async () => leaseMissing) } as unknown as SandboxManager,
      options: { sandboxLeaseCap: 2, countActiveOrgSandboxLeases },
    })
    const refused = await missing.app.fetch(post("/ws_1/connection", {}))
    expect(refused.status).toBe(429)
    expect(await refused.json()).toMatchObject({ error: { code: "sandbox_lease_limit_reached" } })
    expect(ensure).not.toHaveBeenCalled()

    const leased = buildApp({
      authority: cloudAuthority(),
      sandboxManager: { ensure, target: vi.fn(async () => leaseAcquiring) } as unknown as SandboxManager,
      options: { sandboxLeaseCap: 2, countActiveOrgSandboxLeases },
    })
    expect((await leased.app.fetch(post("/ws_1/connection", {}))).status).toBe(200)
    expect(ensure).toHaveBeenCalledTimes(1)
  })
})

describe("bearer verification", () => {
  test("a bearer the verifier rejects reaches no authority call", async () => {
    // The shared fixture verifier accepts any token as its own subject, so
    // every other test here proves routing under a caller that is always
    // authentic. This is the one that proves the gate.
    const authority = fakeAuthority()
    const { app } = buildApp({
      authority,
      verifier: async (token, config) => {
        if (token !== "user_1") throw new ControlPlaneAuthError(401, "invalid_bearer_token", "invalid")
        return { mode: "signed" as const, user: { subject: token, tokenIdentifier: token, issuer: config.issuer } }
      },
    })

    const res = await app.fetch(post("/ws_1/host-assignment", { hostId: "host_1" }, "forged"))

    expect(res.status).toBe(401)
    expect(authority.openWorkspace).not.toHaveBeenCalled()
  })
})
