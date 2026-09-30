import { afterEach, describe, expect, test, vi } from "vitest"
import type { Hono } from "hono"
import {
  AuthenticationError,
  type AuthIdentity,
  type ControlPlanePrincipal,
  type RequestAuthenticationAdapter,
} from "@claxedo/server-core/platform/auth/authentication"
import { createInMemoryCliSessionTokenRegistry } from "@claxedo/server-core/platform/auth/cli-session-registry"
import { createHostedCoreApp } from "../../deployments/hosted-shared/hosted-core-app"
import { STATIC_PRODUCT_DESCRIPTORS } from "../../deployments/hosted-shared/deployment-profile"
import { sandboxRelayTargetLookup, type HostedControlPlane } from "../../authority/hosted-services"
import type { ControlPlaneServices } from "../../authority/services"
import { composeBetterAuthD1Authority } from "../../authority/adapters/worker/better-auth-d1-compose"
import { testRequestAuthenticationAdapter } from "../../test-support/request-authentication"
import {
  controlPlaneMigrations,
  miniflareControlPlaneDatabase,
  type ControlPlaneDatabase,
} from "../../test-support/control-plane-migrations"

const active: ControlPlaneDatabase[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((database) => database.dispose()))
})

/**
 * The hosted core app over a real D1 control plane. The bearer token names a
 * person whose identity the D1 authority minted, so every role a route decides
 * on is the one the database holds.
 */
async function hosted() {
  const controlPlane = await miniflareControlPlaneDatabase(controlPlaneMigrations())
  active.push(controlPlane)
  const authority = composeBetterAuthD1Authority({
    env: {
      CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
      CLAXEDO_PRODUCT_POSTURE: "claxedo-hosted",
      CLAXEDO_DEPLOYMENT_ID: "deployment-a",
      CONTROL_PLANE_DB: controlPlane.database,
    },
    product: { kind: "claxedo-hosted" },
  })
  const principals = new Map<string, ControlPlanePrincipal>()
  const authentication: RequestAuthenticationAdapter = {
    descriptor: testRequestAuthenticationAdapter().descriptor,
    async authenticate(request) {
      const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
      const principal = token ? principals.get(token) : undefined
      if (!principal) throw new AuthenticationError(401, "invalid_credentials", "Authentication credential is invalid")
      return principal
    },
  }
  const services = {
    auth: { config: { enabled: true, issuer: "https://auth.test", jwksUrl: "https://auth.test/jwks" } },
    relay: {},
    sandbox: {},
    authority,
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: false },
  } as unknown as ControlPlaneServices
  const plane = {
    services,
    relayUrl: "https://relay.test",
    resolverToken: "resolver-token",
    safetyLimits: {
      connectionRateLimit: 60,
      connectionRateLimitWindowMs: 60_000,
      controlPlaneRateLimit: 1_000,
      controlPlaneRateLimitWindowMs: 60_000,
      defaultRequestRateLimit: 10_000,
      defaultRequestRateLimitWindowMs: 60_000,
      sandboxMaxRetryCount: 5,
    },
    relayTargetLookup: sandboxRelayTargetLookup({ telemetry: services.telemetry }),
    cliSessionTokenRegistry: createInMemoryCliSessionTokenRegistry(),
    privateSessionAuthority: authority,
    runtimeSessionAuthority: authority,
    env: { CLAXEDO_DEPLOYMENT_MODE: "hosted" },
  } as unknown as HostedControlPlane
  const app = createHostedCoreApp(plane, {
    authentication,
    liveSyncRoom: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response(null, { status: 503 }) }),
    },
    sharedRateLimitStore: { periodSeconds: 60, check: async () => ({ allowed: true }) },
    cloudWorkspaceAdmission: async () => undefined,
    product: STATIC_PRODUCT_DESCRIPTORS["claxedo-hosted"],
    requestGuardExemptions: [],
  } as unknown as Parameters<typeof createHostedCoreApp>[1]) as unknown as Hono

  const person = async (subject: string) => {
    const identity: AuthIdentity = { adapter: "better-auth", issuer: "https://auth.test", subject }
    const mapped = await authority.ensureApplicationIdentity(identity)
    if (mapped.state !== "active") throw new Error(`identity did not become active: ${mapped.state}`)
    principals.set(subject, {
      userId: mapped.userId,
      actorId: mapped.actorId,
      actorKind: "human",
      deploymentId: "deployment-a",
      sessionId: `session:${subject}`,
      authenticatedAt: 1_800_000_000_000,
      methods: ["oauth:google"],
      assurance: "single-factor",
      client: {
        id: "claxedo-cli",
        kind: "cli",
        tokenKind: "access-token",
        resource: "https://core.test/control-plane",
        scopes: ["workspace:read"],
        deploymentId: "deployment-a",
        adapter: "better-auth",
        issuer: "https://auth.test",
        tokenEndpointOrigin: "https://auth.test",
        controlPlaneOrigin: "https://core.test",
      },
      identity,
    })
    return { token: subject, userId: mapped.userId, auth: await signedAuth(subject) }
  }
  const signedAuth = async (subject: string) => {
    const principal = principals.get(subject)!
    return {
      mode: "signed" as const,
      principal,
      user: { subject: principal.userId, tokenIdentifier: `https://auth.test|${subject}`, issuer: "https://auth.test" },
    }
  }
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const response = await app.request(`https://core.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: (await response.json()) as never }
  }
  return { authority, person, call }
}

describe("hosted organization, team and project access routes on D1", () => {
  test("a member reaches the project through a team grant, loses it on revoke, and a member grant alone restores it", async () => {
    const { authority, person, call } = await hosted()
    const alice = await person("alice")
    const bob = await person("bob")

    const org = await call(alice.token, "POST", "/api/control/orgs", { name: "Acme" })
    expect(org.status).toBe(200)
    const orgId = (org.body as { org_id: string }).org_id
    const { project_id: projectId } = await authority.createWorkspace(alice.auth, {
      workspaceId: "ws_acme",
      orgId,
      displayName: "acme",
      backing: "local-worktree",
      orgMemberVisible: false,
    })
    const opens = async () => (await call(bob.token, "GET", "/api/claxedo/agent-config/harness?workspaceId=ws_acme")).status
    const listed = async () =>
      ((await call(bob.token, "GET", "/api/workspace?host=machine")).body as { workspaces: Array<{ workspace_id: string; role: string }> })
        .workspaces.filter((row) => row.workspace_id === "ws_acme").map((row) => row.role)

    expect((await call(alice.token, "POST", `/api/control/orgs/${orgId}/members`, { userPublicId: bob.userId, role: "member" })).body)
      .toMatchObject({ user_id: bob.userId, role: "member" })
    expect((await call(alice.token, "GET", `/api/control/orgs/${orgId}/members`)).body)
      .toEqual([
        expect.objectContaining({ user_id: alice.userId, role: "owner", joined_at: expect.any(Number) }),
        expect.objectContaining({ user_id: bob.userId, role: "member", joined_at: expect.any(Number) }),
      ])
    const team = (await call(alice.token, "POST", `/api/control/orgs/${orgId}/teams`, { name: "Eng" })).body as { team_id: string }
    expect((await call(alice.token, "POST", `/api/control/teams/${team.team_id}/members`, { userPublicId: bob.userId })).status).toBe(200)
    expect(await opens()).toBe(404)

    expect((await call(alice.token, "POST", `/api/control/teams/${team.team_id}/projects`, { projectId, role: "editor" })).status).toBe(200)
    expect((await call(bob.token, "GET", `/api/control/teams/${team.team_id}/projects`)).body)
      .toEqual([expect.objectContaining({ project_id: projectId, role: "editor" })])
    expect(await opens()).toBe(200)
    expect(await listed()).toEqual(["editor"])

    expect((await call(alice.token, "DELETE", `/api/control/teams/${team.team_id}/projects`, { projectId })).body).toEqual({ revoked: true })
    expect(await opens()).toBe(404)
    expect(await listed()).toEqual([])

    expect((await call(bob.token, "POST", `/api/control/projects/${projectId}/members`, { userPublicId: bob.userId, role: "admin" })))
      .toMatchObject({ status: 403, body: { error: { code: "project_admin_required" } } })
    expect((await call(alice.token, "POST", `/api/control/projects/${projectId}/members`, { userPublicId: bob.userId, role: "viewer" })).body)
      .toEqual({ project_id: projectId, user_id: bob.userId, role: "viewer" })
    expect(await opens()).toBe(200)
    expect(await listed()).toEqual(["viewer"])

    await call(alice.token, "POST", `/api/control/teams/${team.team_id}/projects`, { projectId, role: "editor" })
    const access = await call(alice.token, "GET", `/api/control/projects/${projectId}/access`)
    expect(access.status).toBe(200)
    expect((access.body as { entries: unknown[] }).entries).toEqual(expect.arrayContaining([
      { kind: "user", user_id: alice.userId, role: "owner", source: "owner" },
      { kind: "user", user_id: bob.userId, role: "viewer", source: "member" },
      { kind: "team", team_id: team.team_id, name: "Eng", role: "editor", source: `team:${team.team_id}` },
      { kind: "user", user_id: bob.userId, role: "viewer", source: "org-role" },
    ]))
    expect((await call(bob.token, "GET", `/api/control/projects/${projectId}/access`)))
      .toMatchObject({ status: 403, body: { error: { code: "project_admin_required" } } })

    expect((await call(alice.token, "DELETE", `/api/control/projects/${projectId}/members/${bob.userId}`)).body).toEqual({ revoked: true })
    expect(await listed()).toEqual(["editor"])
  })

  test("membership routes change roles, protect the founding owner, and a removed member is refused on the next request", async () => {
    const { authority, person, call } = await hosted()
    const alice = await person("alice")
    const bob = await person("bob")
    const orgId = ((await call(alice.token, "POST", "/api/control/orgs", { name: "Acme" })).body as { org_id: string }).org_id
    const { project_id: projectId } = await authority.createWorkspace(alice.auth, {
      workspaceId: "ws_acme",
      orgId,
      displayName: "acme",
      backing: "local-worktree",
      orgMemberVisible: false,
    })
    await call(alice.token, "POST", `/api/control/orgs/${orgId}/members`, { userPublicId: bob.userId, role: "member" })

    expect((await call(alice.token, "PATCH", `/api/control/orgs/${orgId}/members/${bob.userId}`, { role: "admin" })).body)
      .toMatchObject({ user_id: bob.userId, role: "admin" })
    expect(await call(bob.token, "PATCH", `/api/control/orgs/${orgId}/members/${alice.userId}`, { role: "member" }))
      .toMatchObject({ status: 409, body: { error: { code: "org_owner_protected" } } })
    expect(await call(bob.token, "DELETE", `/api/control/orgs/${orgId}/members/${alice.userId}`))
      .toMatchObject({ status: 409, body: { error: { code: "org_owner_protected" } } })
    expect(await call(alice.token, "POST", `/api/control/orgs/${orgId}/members`, { userPublicId: bob.userId, role: "boss" }))
      .toMatchObject({ status: 400, body: { error: { code: "org_member_role_required" } } })
    expect(await call(bob.token, "GET", "/api/claxedo/agent-config/harness?workspaceId=ws_acme")).toMatchObject({ status: 200 })

    expect((await call(alice.token, "DELETE", `/api/control/orgs/${orgId}/members/${bob.userId}`)).body)
      .toEqual({ removed: true, team_memberships_revoked: 0, project_memberships_revoked: 0 })
    expect(await call(bob.token, "GET", "/api/claxedo/agent-config/harness?workspaceId=ws_acme")).toMatchObject({ status: 404 })
    expect(await call(bob.token, "GET", `/api/control/projects/${projectId}/access`))
      .toMatchObject({ status: 404, body: { error: { code: "project_not_found" } } })
    expect(await call(bob.token, "GET", `/api/control/orgs/${orgId}/members`)).toMatchObject({ status: 200, body: [] })
  })
})
