import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"

import { D1WorkspaceAuthority } from "./workspace-authority"
import { D1OrgMemberAuthority } from "./org-member-authority"
import { D1ChannelRuntimeAuthority } from "./channel-runtime-authority"
import { applyControlPlaneMigration, controlPlaneMigrations } from "../../../test-support/control-plane-migrations"

const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function setup() {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const database = await instance.getD1Database("CONTROL_PLANE_DB")
  await applyControlPlaneMigration(database, controlPlaneMigrations()[0])
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

async function deployment() {
  const context = await setup()
  const handleHolder = await signed(context.workspace, "handle-holder")
  const accountHolder = await signed(context.workspace, "account-holder")
  await context.workspace.createHostedOrganization(handleHolder, { name: "Acme", orgId: "org_acme" })
  await new D1OrgMemberAuthority(context.workspace.accessContext()).addOrgMember(handleHolder, {
    orgId: "org_acme",
    userPublicId: accountHolder.principal!.userId,
    role: "admin",
  })
  const workspace = await context.workspace.createWorkspace(handleHolder, {
    workspaceId: "ws_main",
    orgId: "org_acme",
    displayName: "main",
    repoUrl: "https://github.com/acme/main.git",
    backing: "cloud-vm",
  })
  await context.workspace.createWorkspace(accountHolder, {
    workspaceId: "ws_account",
    orgId: "org_acme",
    displayName: "account",
    repoUrl: "https://github.com/acme/main.git",
    backing: "cloud-vm",
  })
  return { ...context, handleHolder, accountHolder, workspace }
}

const TELEGRAM_KEY = { channel: "telegram", externalUserId: "12345", threadKey: "telegram:dm:12345" }

function admission(channels: D1ChannelRuntimeAuthority, workspaceId: "ws_main" | "ws_account") {
  return channels.authorizeChannelWorkspace({ ...TELEGRAM_KEY, workspaceId, action: "write" })
}

async function versions(database: D1Database) {
  const rows = await database
    .prepare("select user_id, identity_version, revoked_at from channel_identity_bindings order by rowid")
    .all<{ user_id: string; identity_version: number; revoked_at: number | null }>()
  return rows.results
}

describe("channel identity baseline", () => {
  test("bindings require the current identity version", async () => {
    const context = await deployment()
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

  test("the canonical producer writes current bindings and admits them", async () => {
    const context = await deployment()
    await context.channels.bindChannelIdentity(context.accountHolder, TELEGRAM_KEY)
    expect(await versions(context.database)).toEqual([
      { user_id: context.accountHolder.principal!.userId, identity_version: 1, revoked_at: null },
    ])
    expect(await admission(context.channels, "ws_account")).toEqual({
      actorId: context.accountHolder.principal!.actorId,
      actorKind: "human",
    })
  })
})
