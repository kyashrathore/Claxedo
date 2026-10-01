import { afterEach, describe, expect, test, vi } from "vitest"
import type { Hono } from "hono"
import {
  AuthenticationError,
  type AuthIdentity,
  type ControlPlanePrincipal,
  type RequestAuthenticationAdapter,
} from "@claxedo/server-core/platform/auth/authentication"
import { createHostedCoreApp } from "../../deployments/hosted-shared/hosted-core-app"
import { STATIC_PRODUCT_DESCRIPTORS } from "../../deployments/hosted-shared/deployment-profile"
import { sandboxRelayTargetLookup, type HostedControlPlane } from "../../authority/hosted-services"
import type { ControlPlaneServices } from "../../authority/services"
import { composeBetterAuthD1Authority } from "../../authority/adapters/worker/better-auth-d1-compose"
import { readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import { betterAuthVerifiedEmail } from "../../platform/auth/better-auth-d1-authentication-evidence"
import { orgInvitationEmailDelivery } from "../../platform/auth/auth-email-delivery"
import { testRequestAuthenticationAdapter } from "../../test-support/request-authentication"
import {
  controlPlaneMigrations,
  miniflareControlPlaneDatabase,
} from "../../test-support/control-plane-migrations"

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()))
})

const AUTH_MIGRATIONS = fileURLToPath(new URL("../../../migrations/auth/", import.meta.url))

/** Better Auth's own database, where the only copy of an account's email lives. */
async function authDatabase() {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["AUTH_DB"],
  })
  disposers.push(() => instance.dispose())
  const database = await instance.getD1Database("AUTH_DB")
  for (const name of readdirSync(AUTH_MIGRATIONS).filter((file) => file.endsWith(".sql")).sort()) {
    const migration = (await readFile(`${AUTH_MIGRATIONS}${name}`, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      await database.prepare(statement).run()
    }
  }
  return database
}

/**
 * The hosted core app over a real D1 control plane. The bearer token names a
 * person whose identity the D1 authority minted, so every role a route decides
 * on is the one the database holds.
 */
async function hosted() {
  const controlPlane = await miniflareControlPlaneDatabase(controlPlaneMigrations())
  disposers.push(() => controlPlane.dispose())
  const accounts = await authDatabase()
  const sent: Array<{ recipient: string; token: string }> = []
  const authority = composeBetterAuthD1Authority({
    env: {
      CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
      CLAXEDO_PRODUCT_POSTURE: "claxedo-hosted",
      CLAXEDO_DEPLOYMENT_ID: "deployment-a",
      CONTROL_PLANE_DB: controlPlane.database,
    },
    product: { kind: "claxedo-hosted" },
    invitations: orgInvitationEmailDelivery({ verifiedEmail: (auth) => betterAuthVerifiedEmail({ database: accounts, issuer: "https://auth.test" }, auth.principal?.identity), appOrigin: "https://app.test", sender: { send: async (message) => { sent.push(message) } } }),
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
    await accounts.prepare(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (?, ?, ?, 1, 1, 1) on conflict (id) do nothing`)
      .bind(subject, subject, `${subject}@example.test`).run()
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
  const account = async (subject: string, email: string, verified: boolean) => {
    await accounts
      .prepare(`insert into "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt") values (?, ?, ?, ?, null, 1, 1)`)
      .bind(subject, subject, email, verified ? 1 : 0)
      .run()
    return await person(subject)
  }
  const join = async (adminToken: string, orgId: string, member: { token: string }) => {
    expect(await call(adminToken, "POST", `/api/control/orgs/${orgId}/invitations`, { email: `${member.token}@example.test`, role: "member" })).toEqual({ status: 202, body: { message: "invitation sent" } })
    return call(member.token, "POST", "/api/control/invitations/accept", { token: sent.at(-1)!.token })
  }
  return { authority, person, account, call, join, sent }
}

describe("hosted organization, team and project access routes on D1", () => {
  test("a team grant and a member grant show on the project's access listing and never open the owner's workspace", async () => {
    const { authority, person, call, join } = await hosted()
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
    })
    const opens = async () => (await call(bob.token, "GET", "/api/claxedo/agent-config/harness?workspaceId=ws_acme")).status
    const listed = async () =>
      ((await call(bob.token, "GET", "/api/workspace?host=machine")).body as { workspaces: Array<{ workspace_id: string }> })
        .workspaces.map((row) => row.workspace_id)
    const access = async () =>
      ((await call(alice.token, "GET", `/api/control/projects/${projectId}/access`)).body as { entries: unknown[] }).entries

    expect((await join(alice.token, orgId, bob)).body)
      .toMatchObject({ user_id: bob.userId, role: "member" })
    expect((await call(alice.token, "GET", `/api/control/orgs/${orgId}/members`)).body)
      .toEqual([
        expect.objectContaining({ user_id: alice.userId, role: "owner", joined_at: expect.any(Number) }),
        expect.objectContaining({ user_id: bob.userId, role: "member", joined_at: expect.any(Number) }),
      ])
    const team = (await call(alice.token, "POST", `/api/control/orgs/${orgId}/teams`, { name: "Eng" })).body as { team_id: string }
    expect((await call(alice.token, "POST", `/api/control/teams/${team.team_id}/members`, { userPublicId: bob.userId })).status).toBe(200)

    expect((await call(alice.token, "POST", `/api/control/teams/${team.team_id}/projects`, { projectId, role: "editor" })).status).toBe(200)
    expect((await call(bob.token, "GET", `/api/control/teams/${team.team_id}/projects`)).body)
      .toEqual([expect.objectContaining({ project_id: projectId, role: "editor" })])
    expect(await access()).toEqual(expect.arrayContaining([
      { kind: "team", team_id: team.team_id, name: "Eng", role: "editor", source: `team:${team.team_id}` },
    ]))
    expect(await opens()).toBe(404)
    expect(await listed()).toEqual([])

    expect((await call(alice.token, "DELETE", `/api/control/teams/${team.team_id}/projects`, { projectId })).body).toEqual({ revoked: true })
    expect((await call(bob.token, "POST", `/api/control/projects/${projectId}/members`, { userPublicId: bob.userId, role: "admin" })))
      .toMatchObject({ status: 403, body: { error: { code: "project_admin_required" } } })
    expect((await call(alice.token, "POST", `/api/control/projects/${projectId}/members`, { userPublicId: bob.userId, role: "editor" })).body)
      .toEqual({ project_id: projectId, user_id: bob.userId, role: "editor" })
    expect(await access()).toEqual(expect.arrayContaining([
      { kind: "user", user_id: alice.userId, role: "owner", source: "owner" },
      { kind: "user", user_id: bob.userId, role: "editor", source: "member" },
      { kind: "user", user_id: bob.userId, role: "viewer", source: "org-role" },
    ]))
    expect(await opens()).toBe(404)
    expect(await listed()).toEqual([])
    expect((await call(bob.token, "GET", `/api/control/projects/${projectId}/access`)))
      .toMatchObject({ status: 403, body: { error: { code: "project_admin_required" } } })

    expect((await call(alice.token, "DELETE", `/api/control/projects/${projectId}/members/${bob.userId}`)).body).toEqual({ revoked: true })
    expect((await access()).filter((entry) => (entry as { source: string }).source === "member")).toEqual([])
  })

  test("membership routes change roles, protect the founding owner, and a removed member is refused on the next request", async () => {
    const { authority, person, call, join } = await hosted()
    const alice = await person("alice")
    const bob = await person("bob")
    const orgId = ((await call(alice.token, "POST", "/api/control/orgs", { name: "Acme" })).body as { org_id: string }).org_id
    const { project_id: projectId } = await authority.createWorkspace(alice.auth, {
      workspaceId: "ws_acme",
      orgId,
      displayName: "acme",
      backing: "local-worktree",
    })
    await join(alice.token, orgId, bob)

    expect((await call(alice.token, "PATCH", `/api/control/orgs/${orgId}/members/${bob.userId}`, { role: "admin" })).body)
      .toMatchObject({ user_id: bob.userId, role: "admin" })
    expect(await call(bob.token, "PATCH", `/api/control/orgs/${orgId}/members/${alice.userId}`, { role: "member" }))
      .toMatchObject({ status: 409, body: { error: { code: "org_owner_protected" } } })
    expect(await call(bob.token, "DELETE", `/api/control/orgs/${orgId}/members/${alice.userId}`))
      .toMatchObject({ status: 409, body: { error: { code: "org_owner_protected" } } })
    expect(await call(alice.token, "POST", `/api/control/orgs/${orgId}/invitations`, { email: "bob@example.test", role: "boss" }))
      .toMatchObject({ status: 400, body: { error: { code: "invalid_input" } } })
    expect(await call(bob.token, "GET", `/api/control/projects/${projectId}/access`)).toMatchObject({ status: 200 })

    expect((await call(alice.token, "DELETE", `/api/control/orgs/${orgId}/members/${bob.userId}`)).body)
      .toMatchObject({ removed: true, team_memberships_revoked: 0, project_memberships_revoked: 0 })
    expect(await call(bob.token, "GET", `/api/control/projects/${projectId}/access`))
      .toMatchObject({ status: 404, body: { error: { code: "project_not_found" } } })
    expect(await call(bob.token, "GET", `/api/control/orgs/${orgId}/members`)).toMatchObject({ status: 200, body: [] })
  })

  test("a team member role that does not exist is refused and adds nobody", async () => {
    const { person, call, join } = await hosted()
    const alice = await person("alice")
    const bob = await person("bob")
    const orgId = ((await call(alice.token, "POST", "/api/control/orgs", { name: "Acme" })).body as { org_id: string }).org_id
    await join(alice.token, orgId, bob)
    const team = (await call(alice.token, "POST", `/api/control/orgs/${orgId}/teams`, { name: "Eng" })).body as { team_id: string }

    expect(await call(alice.token, "POST", `/api/control/teams/${team.team_id}/members`, { userPublicId: bob.userId, role: "boss" }))
      .toMatchObject({ status: 400, body: { error: { code: "team_member_role_invalid" } } })
    expect(((await call(alice.token, "GET", `/api/control/teams/${team.team_id}/members`)).body as Array<{ user_id: string }>)
      .map((row) => row.user_id)).not.toContain(bob.userId)
    expect((await call(alice.token, "POST", `/api/control/teams/${team.team_id}/members`, { userPublicId: bob.userId, role: "admin" })).body)
      .toMatchObject({ user_id: bob.userId, role: "admin" })
  })

  test("known, unverified and unknown addresses receive the same invitation receipt", async () => {
    const { person, account, call, sent } = await hosted()
    const alice = await person("alice")
    const carol = await account("carol", "carol@example.com", true)
    await account("dave", "dave@example.com", false)
    const orgId = ((await call(alice.token, "POST", "/api/control/orgs", { name: "Acme" })).body as { org_id: string }).org_id
    for (const email of [" Carol@Example.COM ", "dave@example.com", "nobody@example.com"]) {
      expect(await call(alice.token, "POST", `/api/control/orgs/${orgId}/invitations`, { email, role: "member" }))
        .toEqual({ status: 202, body: { message: "invitation sent" } })
    }
    expect((await call(carol.token, "POST", "/api/control/invitations/accept", { token: sent[0]!.token })).body)
      .toMatchObject({ user_id: carol.userId, role: "member" })
    expect(await call("dave", "POST", "/api/control/invitations/accept", { token: sent[1]!.token }))
      .toMatchObject({ status: 403, body: { error: { code: "org_invitation_email_mismatch" } } })
  })

  test("a caller who does not administer the org learns nothing about whether an email has an account", async () => {
    const { person, account, call, join, sent } = await hosted()
    const alice = await person("alice")
    const bob = await person("bob")
    await account("carol", "carol@example.com", true)
    const orgId = ((await call(alice.token, "POST", "/api/control/orgs", { name: "Acme" })).body as { org_id: string }).org_id
    await join(alice.token, orgId, bob)

    const known = await call(bob.token, "POST", `/api/control/orgs/${orgId}/invitations`, { email: "carol@example.com", role: "member" })
    const unknown = await call(bob.token, "POST", `/api/control/orgs/${orgId}/invitations`, { email: "nobody@example.com", role: "member" })
    expect(known).toMatchObject({ status: 403, body: { error: { code: "org_admin_required" } } })
    expect(unknown).toEqual(known)
  })
})
