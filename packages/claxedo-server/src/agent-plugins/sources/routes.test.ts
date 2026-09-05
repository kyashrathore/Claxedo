import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test, vi } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import {
  agentPluginManifestFixture,
  gitHubArchiveFetch,
} from "@claxedo/server-core/agent-plugins/sources/github-archive-fixture"
import {
  agentPluginCatalogSources,
  createAgentPluginSourceProviderCache,
} from "@claxedo/server-core/agent-plugins/sources/registry"
import { resolveCollections } from "@claxedo/server-core/agent-plugins/catalog/resolve-collections"
import type { CatalogSourceProvider } from "@claxedo/server-core/agent-plugins/ports"
import type { AgentPluginSourceFetch } from "@claxedo/server-core/agent-plugins/sources/github-public"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import type { ControlPlaneServices } from "../../authority/services"
import { D1WorkspaceAuthority } from "../../authority/adapters/d1/workspace-authority"
import { D1AgentPluginSourceStore } from "./d1-store"
import { HostedAgentPluginSourceRoutes } from "./routes"

const MIGRATIONS = [
  "0001_service_installations.sql",
  "0002_workspace_authority.sql",
  "0003_private_sessions.sql",
  "0008_user_deployed_owner_bootstrap.sql",
  "0013_org_team_session_sharing.sql",
  "0017_adapter_custom.sql",
  "0018_drop_agent_extensions.sql",
  "0023_agent_plugin_sources.sql",
]

const EMPTY_BASE: CatalogSourceProvider = { listAuthorizedSources: async () => [] }

const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

function identity(subject: string): AuthIdentity {
  return { adapter: "better-auth", issuer: "https://better-auth.example.test", subject }
}

async function migrate(database: D1Database) {
  for (const name of MIGRATIONS) {
    const path = fileURLToPath(new URL(`../../../migrations/control-plane/${name}`, import.meta.url))
    const migration = (await readFile(path, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      await database.prepare(statement).run()
    }
  }
}

async function signed(
  authority: D1WorkspaceAuthority,
  applicationIdentity: AuthIdentity,
): Promise<SignedControlPlaneAuth> {
  const result = await authority.ensureApplicationIdentity(applicationIdentity)
  if (result.state !== "active") throw new Error(`identity did not become active: ${result.state}`)
  const principal: ControlPlanePrincipal = {
    userId: result.userId,
    actorId: result.actorId,
    actorKind: "human",
    deploymentId: "deployment-a",
    sessionId: `session:${applicationIdentity.subject}`,
    authenticatedAt: 1_800_000_000_000,
    methods: ["oauth:github"],
    assurance: "single-factor",
    client: {
      kind: "browser",
      tokenKind: "browser-session",
      id: "browser",
      resource: "https://api.example.test",
      scopes: ["openid"],
      origin: "https://app.example.test",
    },
    identity: applicationIdentity,
  }
  return {
    mode: "signed",
    principal,
    user: {
      subject: applicationIdentity.subject,
      tokenIdentifier: `${applicationIdentity.issuer}|${applicationIdentity.subject}`,
      issuer: applicationIdentity.issuer,
    },
  }
}

/**
 * The signed rail over real control-plane rows: the bearer token names a real
 * identity the authority minted, so the organization role the routes gate on is
 * the one the database holds rather than a stubbed answer.
 */
async function rail(fetch: AgentPluginSourceFetch) {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const database = await instance.getD1Database("CONTROL_PLANE_DB")
  await migrate(database)
  let sequence = 0
  const authority = new D1WorkspaceAuthority(database, {
    deploymentId: "deployment-a",
    product: { kind: "claxedo-hosted" },
    now: () => 1_800_000_000_000 + sequence,
    randomId: (prefix) => `${prefix}_${String(++sequence).padStart(4, "0")}`,
  })
  const tokens = new Map<string, SignedControlPlaneAuth>()
  const services = {
    auth: {
      config: { enabled: true, issuer: "https://better-auth.example.test", jwksUrl: "https://auth.test/jwks" },
      verifier: vi.fn(async (token: string) => {
        const auth = tokens.get(token)
        if (!auth) throw new Error(`unknown token ${token}`)
        return auth
      }),
    },
    authority,
    telemetry: { capture: vi.fn() },
  } as unknown as ControlPlaneServices
  const registry = new D1AgentPluginSourceStore({ database, authority })
  const cache = createAgentPluginSourceProviderCache(fetch)
  const app = HostedAgentPluginSourceRoutes({
    services,
    registry,
    cache,
    fetch,
    now: () => 1_700_000_000_000,
  })
  const enrol = async (subject: string, role?: "member" | "admin", orgId?: string) => {
    const auth = await signed(authority, identity(subject))
    if (role && orgId) {
      const me = await authority.usersMe(auth)
      await database
        .prepare(`update orgs set deleted_at = 1 where owner_user_id = ? and kind = 'personal'`)
        .bind(me.user_id)
        .run()
      await database
        .prepare(`
          insert into org_memberships (org_id, user_id, role, created_at, updated_at, revoked_at)
          values (?, ?, ?, 1, 1, null)
        `)
        .bind(orgId, me.user_id, role)
        .run()
    }
    tokens.set(subject, auth)
    return auth
  }
  const catalog = (auth: SignedControlPlaneAuth) => agentPluginCatalogSources({
    base: EMPTY_BASE,
    cache,
    list: () => registry.list(auth),
  })
  return { app, authority, registry, enrol, catalog }
}

function request(
  app: Awaited<ReturnType<typeof rail>>["app"],
  init: { method?: string; token?: string; body?: unknown; path?: string } = {},
) {
  return app.request(`http://control.test${init.path ?? "/"}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  })
}

function github(files: Record<string, string>) {
  return gitHubArchiveFetch({ files }).fetch
}

const PLUGIN_REPOSITORY = { "review/plugin.json": agentPluginManifestFixture("review") }

describe("signed Agent Plugin source routes", () => {
  test("refuses an unauthenticated caller", async () => {
    const { app } = await rail(github(PLUGIN_REPOSITORY))
    const response = await request(app)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: expect.objectContaining({ code: expect.any(String) }) })
  })

  test("lists the built-in collection and saves a personal source only its owner sees", async () => {
    const { app, authority, enrol, catalog } = await rail(github(PLUGIN_REPOSITORY))
    const alice = await enrol("alice")
    const orgId = await authority.resolveOrgId(alice)
    await enrol("bob", "member", orgId)

    expect(await (await request(app, { token: "alice" })).json()).toEqual({
      sources: [expect.objectContaining({ id: "claxedo", canRemove: false })],
    })

    const created = await request(app, { method: "POST", token: "alice", body: { owner: "acme", repository: "plugins" } })
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual({
      source: {
        id: "github:acme/plugins@main",
        kind: "personal",
        label: "acme/plugins",
        repository: "acme/plugins",
        ref: "main",
        authority: "user",
        addedAt: 1_700_000_000_000,
        canRemove: true,
      },
      plugins: 1,
    })

    const mine = await (await request(app, { token: "alice" })).json() as { sources: Array<{ id: string }> }
    expect(mine.sources.map((source) => source.id)).toEqual(["claxedo", "github:acme/plugins@main"])
    const theirs = await (await request(app, { token: "bob" })).json() as { sources: Array<{ id: string }> }
    expect(theirs.sources.map((source) => source.id)).toEqual(["claxedo"])

    // The catalog the routes hand `resolveCollections` is per caller too.
    expect((await resolveCollections(catalog(alice))).candidates.map((candidate) => candidate.sourceId))
      .toEqual(["github:acme/plugins@main"])
    expect((await resolveCollections(catalog((await enrol("bob"))))).candidates).toEqual([])
  })

  test("gates an organization source on the admin role for both add and remove", async () => {
    const { app, authority, enrol } = await rail(github(PLUGIN_REPOSITORY))
    const owner = await enrol("alice")
    const orgId = await authority.resolveOrgId(owner)
    await enrol("bob", "member", orgId)
    await enrol("carol", "admin", orgId)

    const refused = await request(app, {
      method: "POST",
      token: "bob",
      body: { owner: "acme", repository: "team", authority: "organization" },
    })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({
      error: { code: "agent_plugins_source_forbidden", message: expect.any(String) },
    })

    const created = await request(app, {
      method: "POST",
      token: "carol",
      body: { owner: "acme", repository: "team", authority: "organization" },
    })
    expect(created.status).toBe(201)

    const seen = await (await request(app, { token: "bob" })).json() as {
      sources: Array<{ id: string; kind: string; authority?: string; canRemove: boolean }>
    }
    expect(seen.sources[1]).toEqual(expect.objectContaining({
      id: "github:acme/team@main",
      kind: "organization",
      authority: "organization",
      canRemove: false,
    }))

    const denied = await request(app, {
      method: "DELETE",
      token: "bob",
      path: "/github:acme/team@main",
    })
    expect(denied.status).toBe(403)

    const removed = await request(app, {
      method: "DELETE",
      token: "carol",
      path: "/github:acme/team@main",
    })
    expect(removed.status).toBe(204)
    expect((await (await request(app, { token: "bob" })).json() as { sources: unknown[] }).sources).toHaveLength(1)
  })

  test("refuses a duplicate, an unknown removal, and the built-in collection", async () => {
    const { app, enrol } = await rail(github(PLUGIN_REPOSITORY))
    await enrol("alice")
    await request(app, { method: "POST", token: "alice", body: { owner: "acme", repository: "plugins" } })

    const duplicate = await request(app, {
      method: "POST",
      token: "alice",
      body: { owner: "acme", repository: "plugins" },
    })
    expect(duplicate.status).toBe(409)
    expect((await duplicate.json() as { error: { code: string } }).error.code).toBe("agent_plugins_source_exists")

    expect((await request(app, { method: "DELETE", token: "alice", path: "/github:acme/nothing@main" })).status).toBe(404)
    expect((await request(app, { method: "DELETE", token: "alice", path: "/claxedo" })).status).toBe(403)
    expect((await request(app, { method: "DELETE", token: "alice", path: "/github:acme/plugins@main" })).status).toBe(204)
  })

  test("refuses a repository that serves no valid plugin and saves nothing", async () => {
    const { app, enrol, registry } = await rail(github({ "README.md": "nothing here" }))
    const alice = await enrol("alice")

    const response = await request(app, { method: "POST", token: "alice", body: { owner: "acme", repository: "empty" } })
    expect(response.status).toBe(422)
    expect((await response.json() as { error: { code: string; diagnostics: unknown[] } }).error).toEqual({
      code: "agent_plugins_source_empty",
      message: expect.any(String),
      diagnostics: [],
    })
    expect(await registry.list(alice)).toEqual([])
  })

  test("refuses a body without a usable GitHub address", async () => {
    const { app, enrol } = await rail(github(PLUGIN_REPOSITORY))
    await enrol("alice")

    const response = await request(app, { method: "POST", token: "alice", body: { owner: "acme" } })
    expect(response.status).toBe(400)
    expect((await response.json() as { error: { code: string } }).error.code).toBe("agent_plugins_source_invalid_body")
  })
})
