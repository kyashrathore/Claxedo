import { afterEach, describe, expect, test } from "vitest"
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import { D1WorkspaceAuthority } from "./workspace-authority"
import { D1ChannelRuntimeAuthority } from "./channel-runtime-authority"
import { D1AuditAuthority } from "./audit-authority"
import {
  controlPlaneMigrations,
  miniflareControlPlaneDatabase,
  type ControlPlaneDatabase,
} from "../../../test-support/control-plane-migrations"

const active: ControlPlaneDatabase[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((database) => database.dispose()))
})

const identity = (subject: string): AuthIdentity => ({ adapter: "better-auth", issuer: "https://auth.example.test", subject })

async function signed(authority: D1WorkspaceAuthority, subject: string): Promise<SignedControlPlaneAuth> {
  const mapped = await authority.ensureApplicationIdentity(identity(subject))
  if (mapped.state !== "active") throw new Error(`identity did not become active: ${mapped.state}`)
  const principal: ControlPlanePrincipal = {
    userId: mapped.userId,
    actorId: mapped.actorId,
    actorKind: "human",
    deploymentId: "deployment-a",
    sessionId: `session:${subject}`,
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
    identity: identity(subject),
  }
  return { mode: "signed", principal, user: { subject, tokenIdentifier: `https://auth.example.test|${subject}`, issuer: "https://auth.example.test" } }
}

/**
 * The database a write sees when `step` lands between the write's own
 * authorization read and the write: `step` runs once, just before the first
 * statement matching `write` executes, alone or in a batch.
 */
function beforeWrite(database: D1Database, write: RegExp, step: (database: D1Database) => Promise<unknown>) {
  let pending = true
  const sqlOf = new WeakMap<object, string>()
  const fire = async (sql: string | undefined) => {
    if (!pending || !sql || !write.test(sql)) return
    pending = false
    await step(database)
  }
  const statement = (target: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(target, {
      get(inner, key) {
        if (key === "bind") return (...values: unknown[]) => statement(inner.bind(...values), sql)
        if (key === "run" || key === "first" || key === "all" || key === "raw") {
          return async (...args: unknown[]) => {
            await fire(sql)
            return await (inner[key] as (...a: unknown[]) => unknown).apply(inner, args)
          }
        }
        const value: unknown = Reflect.get(inner, key, inner)
        return typeof value === "function" ? value.bind(inner) : value
      },
    })
    sqlOf.set(wrapped, sql)
    unwrap.set(wrapped, target)
    return wrapped
  }
  const unwrap = new WeakMap<object, D1PreparedStatement>()
  return new Proxy(database, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => statement(target.prepare(sql), sql)
      if (key === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          for (const each of statements) await fire(sqlOf.get(each))
          return await target.batch(statements.map((each) => unwrap.get(each) ?? each))
        }
      }
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

async function setup() {
  const controlPlane = await miniflareControlPlaneDatabase(controlPlaneMigrations())
  active.push(controlPlane)
  const { database } = controlPlane
  const options = { deploymentId: "deployment-a", product: { kind: "claxedo-hosted" as const } }
  const authority = new D1WorkspaceAuthority(database, options)
  const alice = await signed(authority, "alice")
  await authority.createHostedOrganization(alice, { name: "Acme", orgId: "org_acme" })
  await authority.createWorkspace(alice, {
    workspaceId: "ws_alice", orgId: "org_acme", displayName: "alice", backing: "local-worktree", repoUrl: "https://github.com/acme/app",
  })
  const suspendActor = (target: D1Database) =>
    target.prepare("update actors set state = 'suspended' where actor_id = ?").bind(alice.principal!.actorId).run()
  return { database, options, alice, suspendActor }
}

describe("a write re-asks its caller's standing inside the write", () => {
  test("an actor suspended before the write links no identity and creates no organization", async () => {
    const { database, options, alice, suspendActor } = await setup()
    const linking = new D1WorkspaceAuthority(beforeWrite(database, /insert into auth_identities/, suspendActor), options)
    await expect(linking.linkApplicationIdentity(alice, { identity: identity("alice-second") })).rejects.toMatchObject({ status: 403 })
    expect(await database.prepare("select 1 from auth_identities where subject = 'alice-second'").first()).toBeNull()

    await database.prepare("update actors set state = 'active' where actor_id = ?").bind(alice.principal!.actorId).run()
    const creating = new D1WorkspaceAuthority(beforeWrite(database, /insert into orgs/, suspendActor), options)
    await expect(creating.createHostedOrganization(alice, { name: "Late", orgId: "org_late" })).rejects.toMatchObject({ status: 403 })
    expect(await database.prepare("select 1 from orgs where org_id = 'org_late'").first()).toBeNull()
  })

  test("an actor suspended before the write revokes no channel binding and no runtime token", async () => {
    const { database, alice, suspendActor } = await setup()
    const runtime = { deploymentId: "deployment-a" }
    await new D1ChannelRuntimeAuthority(database, runtime).bindChannelIdentity(alice, { channel: "telegram", externalUserId: "tg_alice" })
    const unbinding = new D1ChannelRuntimeAuthority(beforeWrite(database, /update channel_identity_bindings/, suspendActor), runtime)
    await expect(unbinding.revokeChannelIdentity(alice, { channel: "telegram", externalUserId: "tg_alice" })).rejects.toMatchObject({ status: 403 })
    expect(await database.prepare("select revoked_at from channel_identity_bindings where external_user_id = 'tg_alice'").first())
      .toEqual({ revoked_at: null })

    await database.prepare("update actors set state = 'active' where actor_id = ?").bind(alice.principal!.actorId).run()
    const tokens = new D1ChannelRuntimeAuthority(database, runtime)
    for (const jti of ["jti_one", "jti_all"]) {
      await tokens.recordRuntimeAccessToken(alice, {
        jti, workspaceId: "ws_alice", hostId: "host_alice", actorId: alice.principal!.actorId, actorKind: "human", role: "owner",
        expiresAt: Date.now() + 60_000,
      })
    }
    const revokingOne = new D1ChannelRuntimeAuthority(beforeWrite(database, /update runtime_access_tokens/, suspendActor), runtime)
    await expect(revokingOne.revokeRuntimeAccessToken(alice, { jti: "jti_one", workspaceId: "ws_alice" })).rejects.toMatchObject({ status: 403 })
    await database.prepare("update actors set state = 'active' where actor_id = ?").bind(alice.principal!.actorId).run()
    const revokingAll = new D1ChannelRuntimeAuthority(beforeWrite(database, /update runtime_access_tokens/, suspendActor), runtime)
    await expect(revokingAll.revokeRuntimeAccessTokensForWorkspaceUser(alice, { workspaceId: "ws_alice" })).rejects.toMatchObject({ status: 403 })
    expect((await database.prepare("select jti from runtime_access_tokens where revoked_at is null order by jti").all()).results)
      .toEqual([{ jti: "jti_all" }, { jti: "jti_one" }])
  })

  test("an audit row is filed under a workspace only if the caller may still open it as the row is written", async () => {
    const { database, alice } = await setup()
    const removeWorkspace = (target: D1Database) =>
      target.prepare("update workspaces set deleted_at = 1 where workspace_id = 'ws_alice'").run()
    const audit = new D1AuditAuthority(beforeWrite(database, /insert into authority_audit_events/, removeWorkspace), {
      deploymentId: "deployment-a",
    })
    await audit.auditAllow(alice, { action: "workspace.touched", workspaceId: "ws_alice" })
    expect(await database.prepare(`
      select workspace_id, org_id, unverified_attempted_workspace_id from authority_audit_events where action = 'workspace.touched'
    `).first()).toEqual({ workspace_id: null, org_id: null, unverified_attempted_workspace_id: "ws_alice" })
  })
})
