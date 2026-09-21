/**
 * The persisted boundary between channel identity bindings written before the
 * key was proven to be a platform's stable account id and the ones written
 * after.
 *
 * The legacy side is seeded on the schema that shipped before the boundary
 * migration, with the statement the producer shipped, because a row written
 * against the post-migration table proves nothing about what a live deployment
 * is already holding.
 */
import { readFile } from "node:fs/promises"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"

import { D1WorkspaceAuthority } from "./workspace-authority"
import { D1ChannelRuntimeAuthority } from "./channel-runtime-authority"
import { controlPlaneMigrationPath, controlPlaneMigrations } from "../../../test-support/control-plane-migrations"

const BOUNDARY_MIGRATION = "0038_channel_identity_version.sql"
const ALL_MIGRATIONS = controlPlaneMigrations()
const BEFORE_BOUNDARY = ALL_MIGRATIONS.slice(0, ALL_MIGRATIONS.indexOf(BOUNDARY_MIGRATION))

const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function statements(name: string) {
  const migration = (await readFile(controlPlaneMigrationPath(name), "utf8")).replace(/^\s*--.*$/gm, "")
  return migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)
}

const boundaryStatements = () => statements(BOUNDARY_MIGRATION)

async function apply(database: D1Database, names: readonly string[]) {
  for (const name of names) {
    for (const statement of await statements(name)) await database.prepare(statement).run()
  }
}

async function setup(migrations: readonly string[]) {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const database = await instance.getD1Database("CONTROL_PLANE_DB")
  await apply(database, migrations)
  let sequence = 0
  let currentTime = 1_800_000_000_000
  const now = () => ++currentTime
  const workspace = new D1WorkspaceAuthority(database, {
    deploymentId: "deployment-a",
    product: { kind: "claxedo-hosted" },
    now,
    randomId: (prefix) => `${prefix}_${String(++sequence).padStart(4, "0")}`,
  })
  const channels = new D1ChannelRuntimeAuthority(database, {
    deploymentId: "deployment-a",
    now,
    randomId: () => `chn_${String(++sequence).padStart(4, "0")}`,
  })
  return { database, workspace, channels }
}

async function signed(authority: D1WorkspaceAuthority, subject: string): Promise<SignedControlPlaneAuth> {
  const applicationIdentity: AuthIdentity = {
    adapter: "better-auth",
    issuer: "https://auth.example.test",
    subject,
  }
  const result = await authority.ensureApplicationIdentity(applicationIdentity)
  if (result.state !== "active") throw new Error(`identity did not become active: ${result.state}`)
  const principal: ControlPlanePrincipal = {
    userId: result.userId,
    actorId: result.actorId,
    actorKind: "human",
    deploymentId: "deployment-a",
    sessionId: `auth:${subject}`,
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
      subject,
      tokenIdentifier: `${applicationIdentity.issuer}|${subject}`,
      issuer: applicationIdentity.issuer,
    },
  }
}

/**
 * Two accounts in one organization, both able to reach the workspace: the
 * collision only means anything when the legacy holder and the stable-id holder
 * would each have been authorized on their own.
 */
async function deployment(migrations: readonly string[]) {
  const context = await setup(migrations)
  const handleHolder = await signed(context.workspace, "handle-holder")
  const accountHolder = await signed(context.workspace, "account-holder")
  await context.workspace.createHostedOrganization(handleHolder, { name: "Acme", orgId: "org_acme" })
  await context.workspace.addOrganizationMember(handleHolder, {
    orgId: "org_acme",
    userId: accountHolder.principal!.userId,
    role: "member",
  })
  const workspace = await context.workspace.createWorkspace(handleHolder, {
    workspaceId: "ws_main",
    orgId: "org_acme",
    displayName: "main",
    repoUrl: "https://github.com/acme/main.git",
    backing: "cloud-vm",
  })
  await context.database.prepare(
    `insert into project_memberships (project_id, user_id, role, created_at, updated_at, revoked_at)
     values (?, ?, 'editor', 1, 1, null)`,
  ).bind(workspace.project_id, accountHolder.principal!.userId).run()
  return { ...context, handleHolder, accountHolder, workspace }
}

const TELEGRAM_KEY = { channel: "telegram", externalUserId: "12345", threadKey: "telegram:dm:12345" }

/**
 * The insert `bindChannelIdentity` shipped against the 0006 table, column list
 * and all. The current producer cannot write this row — it names a column the
 * pre-boundary table does not have — and that is the point: the row under test
 * is one a live deployment is already holding, not one this build can make.
 */
async function bindPreBoundary(context: Awaited<ReturnType<typeof deployment>>, auth: SignedControlPlaneAuth) {
  await context.database.prepare(
    `insert into channel_identity_bindings (
       binding_id, deployment_id, channel, external_user_id, user_id,
       actor_id, bound_by_actor_id, created_at, revoked_at
     ) values ('chn_legacy', 'deployment-a', ?, ?, ?, ?, ?, 1, null)`,
  ).bind(
    TELEGRAM_KEY.channel,
    TELEGRAM_KEY.externalUserId,
    auth.principal!.userId,
    auth.principal!.actorId,
    auth.principal!.actorId,
  ).run()
}

/**
 * The admission read `binding()` shipped alongside that insert. Running it on
 * the pre-boundary database is how the test states what the deployment does
 * today, before the migration changes the answer.
 */
async function preBoundaryAdmits(database: D1Database) {
  return !!await database.prepare(
    `select binding.binding_id
     from channel_identity_bindings binding
     join users user on user.user_id = binding.user_id
     join actors actor on actor.actor_id = binding.actor_id and actor.user_id = binding.user_id
     where binding.deployment_id = 'deployment-a' and binding.channel = ? and binding.external_user_id = ?
       and binding.revoked_at is null
       and user.state = 'active' and actor.state = 'active' and actor.kind = 'human'`,
  ).bind(TELEGRAM_KEY.channel, TELEGRAM_KEY.externalUserId).first()
}

function admission(channels: D1ChannelRuntimeAuthority) {
  return channels.authorizeChannelWorkspace({ ...TELEGRAM_KEY, workspaceId: "ws_main", action: "write" })
}

async function versions(database: D1Database) {
  const rows = await database
    .prepare("select user_id, identity_version, revoked_at from channel_identity_bindings order by rowid")
    .all<{ user_id: string; identity_version: number; revoked_at: number | null }>()
  return rows.results
}

describe("channel identity binding version boundary", () => {
  test("a binding written before the boundary survives as history that authorizes nothing", async () => {
    const before = await deployment(BEFORE_BOUNDARY)
    // The pre-boundary producer accepted whatever string the transport called a
    // sender id, so "12345" here is the handle @12345, not an account id.
    await bindPreBoundary(before, before.handleHolder)
    expect(await preBoundaryAdmits(before.database)).toBe(true)

    await apply(before.database, [BOUNDARY_MIGRATION])

    expect(await versions(before.database)).toEqual([
      { user_id: before.handleHolder.principal!.userId, identity_version: 0, revoked_at: null },
    ])
    await expect(admission(before.channels)).rejects.toMatchObject({ status: 403 })
  })

  test("the account that actually owns the colliding id binds and is admitted", async () => {
    const context = await deployment(BEFORE_BOUNDARY)
    await bindPreBoundary(context, context.handleHolder)
    await apply(context.database, [BOUNDARY_MIGRATION])

    // The legacy row is still active-and-unrevoked, so the pre-boundary unique
    // index would have refused this insert outright.
    expect(await context.channels.bindChannelIdentity(context.accountHolder, TELEGRAM_KEY))
      .toMatchObject({ created: true, userId: context.accountHolder.principal!.userId })
    expect(await admission(context.channels)).toEqual({
      actorId: context.accountHolder.principal!.actorId,
      actorKind: "human",
    })
    expect(await versions(context.database)).toEqual([
      { user_id: context.handleHolder.principal!.userId, identity_version: 0, revoked_at: null },
      { user_id: context.accountHolder.principal!.userId, identity_version: 1, revoked_at: null },
    ])
  })

  test("the legacy actor cannot rebind the id it used to hold once someone else has it", async () => {
    const context = await deployment(BEFORE_BOUNDARY)
    await bindPreBoundary(context, context.handleHolder)
    await apply(context.database, [BOUNDARY_MIGRATION])
    await context.channels.bindChannelIdentity(context.accountHolder, TELEGRAM_KEY)

    await expect(context.channels.bindChannelIdentity(context.handleHolder, TELEGRAM_KEY))
      .rejects.toMatchObject({ status: 403 })
    expect(await admission(context.channels)).toEqual({
      actorId: context.accountHolder.principal!.actorId,
      actorKind: "human",
    })
  })

  test("a legacy row is not something its holder can revoke, and revoking a current binding still works", async () => {
    const context = await deployment(BEFORE_BOUNDARY)
    await bindPreBoundary(context, context.handleHolder)
    await apply(context.database, [BOUNDARY_MIGRATION])

    expect(await context.channels.revokeChannelIdentity(context.handleHolder, TELEGRAM_KEY))
      .toEqual({ revoked: false })

    await context.channels.bindChannelIdentity(context.accountHolder, TELEGRAM_KEY)
    expect(await context.channels.revokeChannelIdentity(context.accountHolder, TELEGRAM_KEY))
      .toEqual({ revoked: true })
    // Retrying the route after its local projection delete failed reports the
    // state it already reached rather than re-authorizing anyone.
    expect(await context.channels.revokeChannelIdentity(context.accountHolder, TELEGRAM_KEY))
      .toEqual({ revoked: true })
    await expect(admission(context.channels)).rejects.toMatchObject({ status: 403 })
  })

  test("a runtime credential minted for a legacy binding stops renewing and stops admitting", async () => {
    const context = await deployment(BEFORE_BOUNDARY)
    await bindPreBoundary(context, context.handleHolder)
    // The credential the legacy binding already bought, recorded as the
    // pre-boundary mint recorded it.
    await context.database.prepare(
      `insert into runtime_access_tokens (
         jti, deployment_id, workspace_id, org_id, project_id, host_id,
         principal_kind, actor_id, actor_kind, role, minted_for_user_id,
         expires_at, revoked_at, created_at
       )
       select 'jti-legacy', 'deployment-a', workspace_id, org_id, project_id, 'host-a',
         'user', ?, 'human', 'editor', ?, 1900000000000, null, 1
       from workspaces where workspace_id = 'ws_main'`,
    ).bind(context.handleHolder.principal!.actorId, context.handleHolder.principal!.userId).run()

    await apply(context.database, [BOUNDARY_MIGRATION])

    // The recorded credential outlives the boundary — nothing sweeps the
    // table — so the version check has to hold on every path that reads a
    // binding, not only on the first admission.
    expect(await context.channels.runtimeAccessTokenActive({
      jti: "jti-legacy",
      workspaceId: "ws_main",
      hostId: "host-a",
    })).toEqual({ active: true })
    await expect(context.channels.resolveChannelMachineAccess(TELEGRAM_KEY, "ws_main"))
      .rejects.toMatchObject({ status: 403 })
    await expect(context.channels.recordChannelRuntimeAccessToken(TELEGRAM_KEY, {
      jti: "jti-renewed",
      workspaceId: "ws_main",
      hostId: "host-a",
      actorId: context.handleHolder.principal!.actorId,
      actorKind: "human",
      role: "editor",
      expiresAt: 1_900_000_000_000,
    })).rejects.toMatchObject({ status: 403 })
  })

  test("running the boundary migration again promotes nothing and drops no guard", async () => {
    const context = await deployment(BEFORE_BOUNDARY)
    await bindPreBoundary(context, context.handleHolder)
    await apply(context.database, [BOUNDARY_MIGRATION])
    await context.channels.bindChannelIdentity(context.accountHolder, TELEGRAM_KEY)

    const schema = async () => (await context.database.prepare(
      `select type, name, sql from sqlite_master
       where tbl_name = 'channel_identity_bindings' and name not like 'sqlite_%'
       order by type, name`,
    ).all()).results
    const before = { rows: await versions(context.database), schema: await schema() }

    // The column add is the one statement SQLite cannot express as a no-op, so
    // a repeat stops there; everything after it is guarded and re-runs clean,
    // which is what a resumed partial apply needs.
    await expect(apply(context.database, [BOUNDARY_MIGRATION])).rejects.toThrow(/duplicate column name/i)
    for (const statement of (await boundaryStatements()).slice(1)) {
      await context.database.prepare(statement).run()
    }

    expect(await versions(context.database)).toEqual(before.rows)
    expect(await schema()).toEqual(before.schema)
    expect(await admission(context.channels)).toEqual({
      actorId: context.accountHolder.principal!.actorId,
      actorKind: "human",
    })
  })

  test("nothing may write a new pre-boundary row", async () => {
    const context = await deployment(ALL_MIGRATIONS)
    await expect(context.database.prepare(
      `insert into channel_identity_bindings (
         binding_id, deployment_id, channel, external_user_id, user_id,
         actor_id, bound_by_actor_id, created_at, revoked_at, identity_version
       ) values ('chn_forged', 'deployment-a', 'telegram', '12345', ?, ?, ?, 1, null, 0)`,
    ).bind(
      context.handleHolder.principal!.userId,
      context.handleHolder.principal!.actorId,
      context.handleHolder.principal!.actorId,
    ).run()).rejects.toThrow(/current identity version/)

    await context.channels.bindChannelIdentity(context.accountHolder, TELEGRAM_KEY)
    await expect(context.database.prepare(
      "update channel_identity_bindings set identity_version = 0 where external_user_id = '12345'",
    ).run()).rejects.toThrow(/intent is immutable/)
  })

  test("a deployment created after the boundary writes current bindings and admits them", async () => {
    const context = await deployment(ALL_MIGRATIONS)
    await context.channels.bindChannelIdentity(context.accountHolder, TELEGRAM_KEY)
    expect(await versions(context.database)).toEqual([
      { user_id: context.accountHolder.principal!.userId, identity_version: 1, revoked_at: null },
    ])
    expect(await admission(context.channels)).toEqual({
      actorId: context.accountHolder.principal!.actorId,
      actorKind: "human",
    })
  })
})
