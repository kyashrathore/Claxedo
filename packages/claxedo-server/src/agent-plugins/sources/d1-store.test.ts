import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import {
  agentPluginSourceRecord,
  type AgentPluginSourceRegistration,
} from "@claxedo/server-core/agent-plugins/sources/registry"
import { AgentPluginSourceRegistryError } from "@claxedo/server-core/agent-plugins/sources/routes"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import { D1WorkspaceAuthority } from "../../authority/adapters/d1/workspace-authority"
import { D1AgentPluginSourceStore } from "./d1-store"

// The store resolves the caller through the real authority, so the harness runs
// the same control-plane migrations a hosted deployment runs and builds real
// identities and organization memberships rather than stubbing roles.
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

async function setup() {
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
  return { database, authority, store: new D1AgentPluginSourceStore({ database, authority }) }
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
 * A second member of someone else's organization. There is no authority method
 * for org invites, so the membership row is seeded directly and the member's own
 * personal organization is retired to keep `usersMe` unambiguous.
 */
async function member(input: {
  database: D1Database
  authority: D1WorkspaceAuthority
  subject: string
  orgId: string
  role: "member" | "admin"
}) {
  const auth = await signed(input.authority, identity(input.subject))
  const me = await input.authority.usersMe(auth)
  await input.database
    .prepare(`update orgs set deleted_at = 1 where owner_user_id = ? and kind = 'personal'`)
    .bind(me.user_id)
    .run()
  await input.database
    .prepare(`
      insert into org_memberships (org_id, user_id, role, created_at, updated_at, revoked_at)
      values (?, ?, ?, 1, 1, null)
    `)
    .bind(input.orgId, me.user_id, input.role)
    .run()
  return { auth, userId: me.user_id }
}

function registration(
  owner: string,
  repository: string,
  authority: AgentPluginSourceRegistration["authority"] = "user",
): AgentPluginSourceRegistration {
  return { owner, repository, ref: "main", authority }
}

async function failure(promise: Promise<unknown>) {
  const caught = await promise.then(() => undefined, (cause: unknown) => cause)
  if (!(caught instanceof AgentPluginSourceRegistryError)) throw caught ?? new Error("expected a registry failure")
  return caught
}

describe("D1 Agent Plugin source store", () => {
  test("a personal source is visible only to the user who added it", async () => {
    const { database, authority, store } = await setup()
    const owner = await signed(authority, identity("alice"))
    const orgId = await authority.resolveOrgId(owner)
    const other = await member({ database, authority, subject: "bob", orgId, role: "member" })

    await store.add(owner, agentPluginSourceRecord(registration("acme", "plugins"), 10))

    expect((await store.list(owner)).map((source) => source.id)).toEqual(["github:acme/plugins@main"])
    expect(await store.list(other.auth)).toEqual([])
  })

  test("an organization source is visible to every member and only an admin may add it", async () => {
    const { database, authority, store } = await setup()
    const owner = await signed(authority, identity("alice"))
    const orgId = await authority.resolveOrgId(owner)
    const plain = await member({ database, authority, subject: "bob", orgId, role: "member" })
    const admin = await member({ database, authority, subject: "carol", orgId, role: "admin" })

    expect((await failure(store.add(plain.auth, agentPluginSourceRecord(registration("acme", "team", "organization"), 5)))).code)
      .toBe("source-forbidden")
    await store.add(admin.auth, agentPluginSourceRecord(registration("acme", "team", "organization"), 5))

    for (const auth of [owner, plain.auth, admin.auth]) {
      expect((await store.list(auth)).map((source) => ({ id: source.id, kind: source.kind }))).toEqual([
        { id: "github:acme/team@main", kind: "organization" },
      ])
    }
    expect(await store.canRemove(plain.auth, (await store.list(plain.auth))[0]!)).toBe(false)
    expect(await store.canRemove(admin.auth, (await store.list(admin.auth))[0]!)).toBe(true)
  })

  test("organization rows sort ahead of a member's identical personal row", async () => {
    const { database, authority, store } = await setup()
    const owner = await signed(authority, identity("alice"))
    const orgId = await authority.resolveOrgId(owner)
    const plain = await member({ database, authority, subject: "bob", orgId, role: "member" })

    await store.add(plain.auth, agentPluginSourceRecord(registration("acme", "plugins"), 1))
    await store.add(owner, agentPluginSourceRecord(registration("acme", "plugins", "organization"), 2))

    expect((await store.list(plain.auth)).map((source) => source.authority)).toEqual(["organization", "user"])
  })

  test("refuses a duplicate the caller can already see", async () => {
    const { authority, store } = await setup()
    const owner = await signed(authority, identity("alice"))
    await store.add(owner, agentPluginSourceRecord(registration("acme", "plugins"), 1))

    expect((await failure(store.add(owner, agentPluginSourceRecord(registration("acme", "plugins"), 2)))).code)
      .toBe("source-exists")
    expect((await store.list(owner)).map((source) => source.addedAt)).toEqual([1])
  })

  test("removes a personal source, refuses an unknown one, and gates the organization one on the role", async () => {
    const { database, authority, store } = await setup()
    const owner = await signed(authority, identity("alice"))
    const orgId = await authority.resolveOrgId(owner)
    const plain = await member({ database, authority, subject: "bob", orgId, role: "member" })
    await store.add(plain.auth, agentPluginSourceRecord(registration("acme", "personal"), 1))
    await store.add(owner, agentPluginSourceRecord(registration("acme", "team", "organization"), 2))

    await store.remove(plain.auth, "github:acme/personal@main")
    expect((await store.list(plain.auth)).map((source) => source.id)).toEqual(["github:acme/team@main"])

    expect((await failure(store.remove(plain.auth, "github:acme/nothing@main"))).code).toBe("source-unknown")
    expect((await failure(store.remove(plain.auth, "github:acme/team@main"))).code).toBe("source-forbidden")

    await store.remove(owner, "github:acme/team@main")
    expect(await store.list(owner)).toEqual([])
  })

  test("stores the registration fields a catalog read needs", async () => {
    const { authority, store } = await setup()
    const owner = await signed(authority, identity("alice"))
    await store.add(owner, agentPluginSourceRecord({ owner: "acme", repository: "plugins", ref: "release", authority: "user" }, 42))

    expect(await store.list(owner)).toEqual([{
      id: "github:acme/plugins@release",
      kind: "personal",
      label: "acme/plugins",
      owner: "acme",
      repository: "plugins",
      ref: "release",
      authority: "user",
      addedAt: 42,
    }])
  })
})
