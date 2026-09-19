import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"

import { D1_AUTHORITY_MISSING_CAPABILITIES, type D1CoreAuthorityBoundary } from "./core-authority"
import { composeBetterAuthD1Authority } from "../worker/better-auth-d1-compose"

const MIGRATIONS = [
  "0001_service_installations.sql",
  "0002_workspace_authority.sql",
  "0003_private_sessions.sql",
  "0004_host_access_and_sharing.sql",
  "0005_agent_extensions_and_audit.sql",
  "0006_channel_identity_and_canonical_runtime.sql",
  "0007_paired_recovery_epoch.sql",
  "0008_user_deployed_owner_bootstrap.sql",
  "0009_optional_service_deployment.sql",
  "0010_session_turn_leases.sql",
  "0011_session_turn_producers.sql",
  "0012_cold_local_host_challenges.sql",
  "0013_org_team_session_sharing.sql",
  "0014_host_workspace_assignments.sql",
  "0015_drop_local_host_links.sql",
  "0016_host_session_authority.sql",
  "0017_adapter_custom.sql",
  "0024_session_last_human_turn.sql",
  "0028_workspace_org_member_visible.sql",
  "0029_host_connect.sql",
  "0030_workspace_host_assignment_revision.sql",
  "0034_drop_workspace_access.sql",
  "0035_session_share_level.sql",
  "0036_drop_workspace_share_role.sql",
].map((name) => fileURLToPath(new URL(`../../../../migrations/control-plane/${name}`, import.meta.url)))

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
  for (const path of MIGRATIONS) {
    const migration = (await readFile(path, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration
      .split(/;\s*\n\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean)) {
      await database.prepare(statement).run()
    }
  }
  const authority = composeBetterAuthD1Authority({
    env: {
      CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
      CLAXEDO_PRODUCT_POSTURE: "claxedo-hosted",
      CLAXEDO_DEPLOYMENT_ID: "deployment-a",
      CONTROL_PLANE_DB: database,
    },
    product: { kind: "claxedo-hosted" },
  })
  return { authority, database }
}

async function signed(authority: D1CoreAuthorityBoundary, subject: string): Promise<SignedControlPlaneAuth> {
  const identity: AuthIdentity = {
    adapter: "better-auth",
    issuer: "https://auth.example.test",
    subject,
  }
  const mapped = await authority.ensureApplicationIdentity(identity)
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
    identity,
  }
  return {
    mode: "signed",
    principal,
    user: {
      subject: mapped.userId,
      tokenIdentifier: `${identity.issuer}|${identity.subject}`,
      issuer: identity.issuer,
    },
  }
}

describe("composed Better Auth + D1 authority", () => {
  test("uses one canonical principal and tenant scope across workspace, session, and runtime-token modules", async () => {
    const { authority } = await setup()
    const alice = await signed(authority, "alice")
    const bob = await signed(authority, "bob")

    await authority.createHostedOrganization(alice, { name: "Acme", orgId: "org_acme" })
    await authority.addOrganizationMember(alice, {
      orgId: "org_acme",
      userId: bob.principal!.userId,
      role: "member",
    })
    await authority.createWorkspace(alice, {
      workspaceId: "ws_acme",
      orgId: "org_acme",
      displayName: "Acme workspace",
      backing: "cloud-vm",
    })

    await authority.addOrganizationMember(alice, {
      orgId: "org_acme",
      userId: bob.principal!.userId,
      role: "admin",
    })
    expect(await authority.openWorkspace(bob, { workspaceId: "ws_acme" })).toMatchObject({ role: "admin" })

    await authority.reserveSession(bob, {
      operationId: "op_bob",
      sessionId: "ses_bob",
      workspaceId: "ws_acme",
      kind: "create",
      title: "Bob's session",
    })
    await authority.registerRuntimeSession({
      principalKind: "user",
      actorId: bob.principal!.actorId,
      actorKind: "human",
      operationId: "op_bob",
      sessionId: "ses_bob",
      workspaceId: "ws_acme",
      title: "Bob's session",
    })
    const turn = await authority.acquireSessionTurn({
      principalKind: "user",
      actorId: bob.principal!.actorId,
      actorKind: "human",
      sessionId: "ses_bob",
      workspaceId: "ws_acme",
      turnId: "msg_1",
    })
    await authority.syncSessionMessages(bob, {
      sessionId: "ses_bob",
      workspaceId: "ws_acme",
      messages: [
        {
          id: "msg_1",
          role: "user",
          info: { claxedo: { author: { id: bob.principal!.actorId, kind: "human" } } },
        },
      ],
      maxEventOrdinal: 1,
      fencingToken: turn.fencingToken,
    })
    await authority.releaseSessionTurn({
      principalKind: "user",
      actorId: bob.principal!.actorId,
      actorKind: "human",
      sessionId: "ses_bob",
      workspaceId: "ws_acme",
      turnId: "msg_1",
      leaseId: turn.leaseId,
      fencingToken: turn.fencingToken,
    })
    const transcript = (await authority.readSessionMessages(bob, {
      sessionId: "ses_bob",
      workspaceId: "ws_acme",
    })) as { messages: Array<{ info: { claxedo: { author: { id: string } } } }> }
    expect(transcript.messages[0]?.info.claxedo.author.id).toBe(bob.principal!.actorId)

    await authority.recordRuntimeAccessToken(bob, {
      jti: "jti_bob",
      workspaceId: "ws_acme",
      hostId: "host_bob",
      actorId: bob.principal!.actorId,
      actorKind: "human",
      role: "editor",
      expiresAt: Date.now() + 60_000,
    })
    expect(
      await authority.runtimeAccessTokenActive({
        jti: "jti_bob",
        workspaceId: "ws_acme",
        hostId: "host_bob",
      }),
    ).toEqual({ active: true })
  })

  test("persists team session sharing and revokes the shared user's live authority", async () => {
    const { authority } = await setup()
    const alice = await signed(authority, "team-alice")
    const bob = await signed(authority, "team-bob")
    const outsider = await signed(authority, "team-outsider")

    await authority.createHostedOrganization(alice, { name: "Team sharing", orgId: "org_team_sharing" })
    await authority.addOrganizationMember(alice, {
      orgId: "org_team_sharing",
      userId: bob.principal!.userId,
      role: "member",
    })
    await authority.createHostedOrganization(outsider, { name: "Other org", orgId: "org_other" })
    await authority.createWorkspace(alice, {
      workspaceId: "ws_team_sharing",
      orgId: "org_team_sharing",
      displayName: "Team sharing workspace",
      backing: "cloud-vm",
    })

    const defaultTeam = await authority.ensureDefaultTeam!(alice, { orgId: "org_team_sharing" }) as {
      team_id: string
    }
    await authority.addTeamMember!(alice, {
      teamId: defaultTeam.team_id,
      userPublicId: bob.principal!.userId,
      role: "member",
    })
    await expect(authority.openWorkspace(bob, { workspaceId: "ws_team_sharing" })).resolves.toMatchObject({
      role: "editor",
    })
    const otherTeam = await authority.ensureDefaultTeam!(outsider, { orgId: "org_other" }) as {
      team_id: string
    }

    await authority.reserveSession(alice, {
      operationId: "op_team_sharing",
      sessionId: "ses_team_sharing",
      workspaceId: "ws_team_sharing",
      kind: "create",
      title: "Private team session",
    })
    await authority.registerRuntimeSession({
      principalKind: "user",
      actorId: alice.principal!.actorId,
      actorKind: "human",
      operationId: "op_team_sharing",
      sessionId: "ses_team_sharing",
      workspaceId: "ws_team_sharing",
      title: "Private team session",
    })

    expect(await authority.listSessions(bob, { workspaceId: "ws_team_sharing" })).toEqual([])
    await expect(
      authority.grantSessionShare!(alice, {
        sessionId: "ses_team_sharing",
        workspaceId: "ws_team_sharing",
        grantedToTeamId: otherTeam.team_id,
      }),
    ).rejects.toThrow("session_share_team_org_mismatch")

    const firstGrant = await authority.grantSessionShare!(alice, {
      sessionId: "ses_team_sharing",
      workspaceId: "ws_team_sharing",
      grantedToTeamId: defaultTeam.team_id,
    }) as { grant_id: string }
    expect(await authority.grantSessionShare!(alice, {
      sessionId: "ses_team_sharing",
      workspaceId: "ws_team_sharing",
      grantedToTeamPublicId: defaultTeam.team_id,
    })).toEqual(firstGrant)
    expect(await authority.listSessions(bob, { workspaceId: "ws_team_sharing" })).toMatchObject([
      { session_id: "ses_team_sharing", title: "Private team session" },
    ])
    await expect(authority.readSessionMessages(bob, {
      sessionId: "ses_team_sharing",
      workspaceId: "ws_team_sharing",
    })).resolves.toMatchObject({ allowed: true, messages: [] })
    await expect(authority.listSessionShares!(alice, {
      sessionId: "ses_team_sharing",
      workspaceId: "ws_team_sharing",
    })).resolves.toMatchObject({
      can_manage_shares: true,
      grants: [{ grant_id: firstGrant.grant_id, granted_to_team_id: defaultTeam.team_id }],
      teams: [{ team_id: defaultTeam.team_id, is_shared: true }],
    })

    // A session the control plane does not hold (created on a machine, never
    // registered) has no shares here: a workspace member gets a definite empty
    // answer, and only a caller without workspace access is denied.
    await expect(authority.listSessionShares!(alice, {
      sessionId: "ses_created_on_the_machine",
      workspaceId: "ws_team_sharing",
    })).resolves.toEqual({ can_manage_shares: false, grants: [], participants: [], teams: [] })
    await expect(authority.listSessionShares!(outsider, {
      sessionId: "ses_created_on_the_machine",
      workspaceId: "ws_team_sharing",
    })).rejects.toMatchObject({ code: "workspace_authorization_denied" })

    await authority.recordRuntimeAccessToken(bob, {
      jti: "jti_team_bob",
      workspaceId: "ws_team_sharing",
      hostId: "host_team",
      actorId: bob.principal!.actorId,
      actorKind: "human",
      role: "viewer",
      expiresAt: Date.now() + 60_000,
    })
    await expect(authority.revokeSessionShare!(alice, {
      sessionId: "ses_team_sharing",
      workspaceId: "ws_team_sharing",
      grantId: firstGrant.grant_id,
    })).resolves.toMatchObject({ revoked: true, runtime_tokens_revoked: 1 })
    expect(await authority.listSessions(bob, { workspaceId: "ws_team_sharing" })).toEqual([])
    expect(await authority.runtimeAccessTokenActive({
      jti: "jti_team_bob",
      workspaceId: "ws_team_sharing",
      hostId: "host_team",
    })).toMatchObject({ active: false, code: "runtime_access_token_revoked" })
  })

  test("has no unimplemented full-authority capabilities", () => {
    expect(D1_AUTHORITY_MISSING_CAPABILITIES).toEqual([])
  })

  test("binds a signed canonical actor before channel authorization and revokes it without cross-actor takeover", async () => {
    const { authority, database } = await setup()
    const alice = await signed(authority, "channel-alice")
    const bob = await signed(authority, "channel-bob")
    await authority.createHostedOrganization(alice, { name: "Channels", orgId: "org_channels" })
    await authority.addOrganizationMember(alice, {
      orgId: "org_channels",
      userId: bob.principal!.userId,
      role: "member",
    })
    await authority.createWorkspace(alice, {
      workspaceId: "ws_channels",
      orgId: "org_channels",
      displayName: "Channels workspace",
      backing: "cloud-vm",
    })
    const project = await database
      .prepare(`select project_id from workspaces where workspace_id = ?`)
      .bind("ws_channels")
      .first<{ project_id: string }>()
    const binding = await authority.bindChannelIdentity(bob, {
      channel: "telegram",
      externalUserId: "telegram-user-7",
    })
    expect(binding).toMatchObject({
      created: true,
      userId: bob.principal!.userId,
      actorId: bob.principal!.actorId,
      actorKind: "human",
    })
    await expect(
      authority.bindChannelIdentity(alice, {
        channel: "telegram",
        externalUserId: "telegram-user-7",
      }),
    ).rejects.toMatchObject({ status: 403 })
    expect(
      await authority.authorizeChannelProject({
        channel: "telegram",
        externalUserId: "telegram-user-7",
        threadKey: "telegram:thread-1",
        projectId: project!.project_id,
        action: "read",
      }),
    ).toMatchObject({ ok: true, actorId: bob.principal!.actorId, actorKind: "human" })
    expect(
      await authority.authorizeChannelWorkspace({
        channel: "telegram",
        externalUserId: "telegram-user-7",
        threadKey: "telegram:thread-1",
        workspaceId: "ws_channels",
        action: "read",
      }),
    ).toEqual({ actorId: bob.principal!.actorId, actorKind: "human" })
    const channelIdentity = { channel: "telegram", externalUserId: "telegram-user-7", threadKey: "telegram:thread-1" }
    await expect(authority.resolveChannelMachineAccess(channelIdentity, "ws_channels")).rejects.toMatchObject({ status: 403 })
    await authority.addOrganizationMember(alice, { orgId: "org_channels", userId: bob.principal!.userId, role: "admin" })
    const access = await authority.resolveChannelMachineAccess(channelIdentity, "ws_channels")
    expect(access).toMatchObject({ actorId: bob.principal!.actorId, orgId: "org_channels" })
    const tokenScope = { jti: "channel-token", workspaceId: "ws_channels", hostId: "channel-host", actorId: access.actorId, actorKind: access.actorKind, role: access.role, expiresAt: Date.now() + 600_000 }
    await expect(authority.recordChannelRuntimeAccessToken(channelIdentity, { ...tokenScope, actorId: alice.principal!.actorId })).rejects.toMatchObject({ status: 403 })
    await authority.recordChannelRuntimeAccessToken(channelIdentity, tokenScope)
    await expect(authority.reserveRuntimeSession({ actorId: access.actorId, actorKind: "human", principalKind: "user" }, { operationId: "channel-register", sessionId: "channel-session", workspaceId: "ws_channels", kind: "create" })).resolves.toMatchObject({ state: "reserved", sessionId: "channel-session" })
    expect(
      await authority.revokeChannelIdentity(bob, {
        channel: "telegram",
        externalUserId: "telegram-user-7",
      }),
    ).toEqual({ revoked: true })
    await expect(authority.resolveChannelMachineAccess(channelIdentity, "ws_channels")).rejects.toMatchObject({ status: 403 })
    await expect(authority.recordChannelRuntimeAccessToken(channelIdentity, { ...tokenScope, jti: "after-revoke" })).rejects.toMatchObject({ status: 403 })

    expect(
      await authority.revokeChannelIdentity(bob, {
        channel: "telegram",
        externalUserId: "telegram-user-7",
      }),
    ).toEqual({ revoked: true })
    await expect(
      authority.authorizeChannelWorkspace({
        channel: "telegram",
        externalUserId: "telegram-user-7",
        threadKey: "telegram:thread-1",
        workspaceId: "ws_channels",
        action: "read",
      }),
    ).rejects.toMatchObject({ status: 403 })
    expect(
      await authority.bindChannelIdentity(alice, {
        channel: "telegram",
        externalUserId: "telegram-user-7",
      }),
    ).toMatchObject({ created: true, actorId: alice.principal!.actorId })
    expect(
      await authority.revokeChannelIdentity(bob, {
        channel: "telegram",
        externalUserId: "telegram-user-7",
      }),
    ).toEqual({ revoked: false })
  })

  test("a channel-bound org member is refused on an owner-visibility workspace and admitted by a rank on its project", async () => {
    const { authority, database } = await setup()
    const alice = await signed(authority, "visibility-alice")
    const bob = await signed(authority, "visibility-bob")
    await authority.createHostedOrganization(alice, { name: "Visibility", orgId: "org_visibility" })
    await authority.addOrganizationMember(alice, { orgId: "org_visibility", userId: bob.principal!.userId, role: "member" })
    await authority.createWorkspace(alice, {
      workspaceId: "ws_hidden",
      orgId: "org_visibility",
      displayName: "hidden",
      backing: "local-worktree",
    })
    // The column an owner-visibility host assignment writes.
    await database.prepare("update workspaces set org_member_visible = 0 where workspace_id = 'ws_hidden'").run()
    await authority.bindChannelIdentity(bob, { channel: "telegram", externalUserId: "telegram-user-9" })
    const request = {
      channel: "telegram",
      externalUserId: "telegram-user-9",
      threadKey: "telegram:thread-9",
      workspaceId: "ws_hidden",
      action: "read" as const,
    }
    await expect(authority.authorizeChannelWorkspace(request)).rejects.toMatchObject({ status: 403 })
    const project = await database
      .prepare("select project_id from workspaces where workspace_id = 'ws_hidden'")
      .first<{ project_id: string }>()
    await database
      .prepare("insert into project_memberships (project_id, user_id, role, created_at, updated_at, revoked_at) values (?, ?, 'viewer', 1, 1, null)")
      .bind(project!.project_id, bob.principal!.userId)
      .run()
    expect(await authority.authorizeChannelWorkspace(request)).toEqual({ actorId: bob.principal!.actorId, actorKind: "human" })
  })

  test("records only the configured canonical service actor and enforces deployment, workspace, JTI, and revocation", async () => {
    const { authority } = await setup()
    const alice = await signed(authority, "service-alice")
    await authority.createHostedOrganization(alice, { name: "Services", orgId: "org_services" })
    await authority.createWorkspace(alice, {
      workspaceId: "ws_services",
      orgId: "org_services",
      displayName: "Services workspace",
      backing: "cloud-vm",
    })
    await expect(
      authority.recordRuntimeAccessTokenForService({
        jti: "jti_invalid_service",
        workspaceId: "ws_services",
        hostId: "host_service",
        principalKind: "service",
        actorId: "arbitrary-agent",
        actorKind: "agent",
        role: "owner",
        expiresAt: Date.now() + 60_000,
      }),
    ).rejects.toMatchObject({ status: 403 })
    await authority.recordRuntimeAccessTokenForService({
      jti: "jti_service",
      workspaceId: "ws_services",
      hostId: "host_service",
      principalKind: "service",
      actorId: "control-plane",
      actorKind: "agent",
      role: "owner",
      expiresAt: Date.now() + 60_000,
    })
    expect(
      await authority.runtimeAccessTokenActive({
        jti: "jti_service",
        workspaceId: "ws_services",
        hostId: "host_service",
      }),
    ).toEqual({ active: true })
    await expect(
      authority.recordRuntimeAccessTokenForService({
        jti: "jti_service",
        workspaceId: "ws_services",
        hostId: "host_service",
        principalKind: "service",
        actorId: "control-plane",
        actorKind: "agent",
        role: "owner",
        expiresAt: Date.now() + 60_000,
      }),
    ).rejects.toMatchObject({ code: "resource_conflict" })
    await authority.revokeRuntimeAccessToken(alice, { jti: "jti_service", workspaceId: "ws_services" })
    expect(
      await authority.runtimeAccessTokenActive({
        jti: "jti_service",
        workspaceId: "ws_services",
        hostId: "host_service",
      }),
    ).toMatchObject({ active: false, code: "runtime_access_token_revoked" })
  })

  test("rejects composition drift between the static Worker product and D1 policy", async () => {
    const { database } = await setup()
    expect(() =>
      composeBetterAuthD1Authority({
        env: {
          CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
          CLAXEDO_PRODUCT_POSTURE: "claxedo-hosted",
          CLAXEDO_DEPLOYMENT_ID: "deployment-a",
          CONTROL_PLANE_DB: database,
        },
        product: {
          kind: "user-deployed",
          organization: { id: "org_deployment", name: "Deployment" },
          ownerIdentity: { adapter: "better-auth", issuer: "https://auth.example.test", subject: "owner" },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "product_posture_mismatch" }))
  })

  test("fails composition before serving when the control-plane D1 binding is absent", () => {
    expect(() =>
      composeBetterAuthD1Authority({
        env: {
          CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
          CLAXEDO_PRODUCT_POSTURE: "claxedo-hosted",
          CLAXEDO_DEPLOYMENT_ID: "deployment-a",
          CONTROL_PLANE_DB: undefined as never,
        },
        product: { kind: "claxedo-hosted" },
      }),
    ).toThrowError(expect.objectContaining({ code: "hosted_dependency_missing" }))
  })

  test("rejects a user-deployed owner pinned to the unselected auth adapter", async () => {
    const { database } = await setup()
    expect(() =>
      composeBetterAuthD1Authority({
        env: {
          CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
          CLAXEDO_PRODUCT_POSTURE: "user-deployed",
          CLAXEDO_DEPLOYMENT_ID: "deployment-a",
          CONTROL_PLANE_DB: database,
        },
        product: {
          kind: "user-deployed",
          organization: { id: "org_deployment", name: "Deployment" },
          ownerIdentity: { adapter: "custom", issuer: "https://custom.example.test", subject: "owner" },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "product_identity_adapter_mismatch" }))
  })
})
