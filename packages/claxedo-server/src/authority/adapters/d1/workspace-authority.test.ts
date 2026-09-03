import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"

import {
  D1WorkspaceAuthority,
  userDeployedOwnerBootstrapClaimHash,
  userDeployedOwnerIdentityHash,
  type D1AuthorityProductPolicy,
} from "./workspace-authority"

const MIGRATIONS = [
  fileURLToPath(new URL("../../../../migrations/control-plane/0001_service_installations.sql", import.meta.url)),
  fileURLToPath(new URL("../../../../migrations/control-plane/0002_workspace_authority.sql", import.meta.url)),
  fileURLToPath(new URL("../../../../migrations/control-plane/0003_private_sessions.sql", import.meta.url)),
  fileURLToPath(
    new URL("../../../../migrations/control-plane/0008_user_deployed_owner_bootstrap.sql", import.meta.url),
  ),
  fileURLToPath(
    new URL("../../../../migrations/control-plane/0013_org_team_session_sharing.sql", import.meta.url),
  ),
  fileURLToPath(
    new URL("../../../../migrations/control-plane/0017_adapter_custom.sql", import.meta.url),
  ),
]
const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function setup(product: D1AuthorityProductPolicy) {
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
  let sequence = 0
  const authority = new D1WorkspaceAuthority(database, {
    deploymentId: "deployment-a",
    product,
    now: () => 1_800_000_000_000 + sequence,
    randomId: (prefix) => `${prefix}_${String(++sequence).padStart(4, "0")}`,
  })
  return { authority, database }
}

function identity(subject: string, adapter: AuthIdentity["adapter"] = "better-auth"): AuthIdentity {
  return { adapter, issuer: `https://${adapter}.example.test`, subject }
}

async function signed(
  authority: D1WorkspaceAuthority,
  applicationIdentity: AuthIdentity,
  deploymentId = "deployment-a",
): Promise<SignedControlPlaneAuth> {
  const result = await authority.ensureApplicationIdentity(applicationIdentity)
  if (result.state !== "active") throw new Error(`identity did not become active: ${result.state}`)
  const principal: ControlPlanePrincipal = {
    userId: result.userId,
    actorId: result.actorId,
    actorKind: "human",
    deploymentId,
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

describe("D1 hosted workspace authority", () => {
  test("converges concurrent provider mapping and never accepts a token-only synthetic identity", async () => {
    const { authority, database } = await setup({ kind: "claxedo-hosted" })
    const aliceIdentity = identity("alice")
    const resolutions = await Promise.all(
      Array.from({ length: 12 }, () => authority.ensureApplicationIdentity(aliceIdentity)),
    )
    expect(new Set(resolutions.map((result) => (result.state === "active" ? result.userId : result.state))).size).toBe(
      1,
    )
    expect(new Set(resolutions.map((result) => (result.state === "active" ? result.actorId : result.state))).size).toBe(
      1,
    )
    expect((await database.prepare("select count(*) as count from users").first<{ count: number }>())?.count).toBe(1)
    expect((await database.prepare("select count(*) as count from actors").first<{ count: number }>())?.count).toBe(1)
    expect((await database.prepare("select count(*) as count from orgs").first<{ count: number }>())?.count).toBe(1)
    expect(
      (await database.prepare("select count(*) as count from org_memberships").first<{ count: number }>())?.count,
    ).toBe(1)

    const alice = await signed(authority, aliceIdentity)
    const clerkIdentity = identity("custom-alice", "custom")
    await authority.linkApplicationIdentity(alice, { identity: clerkIdentity })
    const clerkResolution = await authority.ensureApplicationIdentity(clerkIdentity)
    expect(clerkResolution).toEqual({
      state: "active",
      userId: alice.principal!.userId,
      actorId: alice.principal!.actorId,
    })
    expect((await database.prepare("select count(*) as count from users").first<{ count: number }>())?.count).toBe(1)

    const bob = await signed(authority, identity("bob"))
    await expect(authority.linkApplicationIdentity(bob, { identity: clerkIdentity })).rejects.toMatchObject({
      code: "identity_conflict",
    })

    await expect(
      authority.usersMe({
        mode: "signed",
        user: { subject: "alice", tokenIdentifier: "legacy|alice", issuer: "legacy" },
      }),
    ).rejects.toMatchObject({ status: 503, code: "identity_provisioning" })
    await expect(authority.usersMe(await signed(authority, aliceIdentity, "deployment-b"))).rejects.toMatchObject({
      status: 401,
      code: "invalid_bearer_token",
    })
  })

  test("keeps hosted organizations isolated and derives every workspace decision from current D1 rows", async () => {
    const { authority, database } = await setup({ kind: "claxedo-hosted" })
    const alice = await signed(authority, identity("alice"))
    const bob = await signed(authority, identity("bob"))
    const outsider = await signed(authority, identity("outsider"))
    const team = await authority.createHostedOrganization(alice, { name: "Acme", orgId: "org_acme" })
    await authority.addOrganizationMember(alice, {
      orgId: team.org_id,
      userId: bob.principal!.userId,
      role: "member",
    })

    await expect(authority.resolveOrgId(alice)).rejects.toMatchObject({
      status: 403,
      code: "workspace_authorization_denied",
    })
    const created = await authority.createWorkspace(alice, {
      workspaceId: "ws_acme_main",
      orgId: team.org_id,
      displayName: "main",
      repoUrl: "https://github.com/Acme/Widgets.git",
      backing: "cloud-vm",
      access: "cloud",
    })
    await expect(
      authority.createWorkspace(alice, {
        workspaceId: "ws_acme_main",
        orgId: team.org_id,
        displayName: "main",
        repoUrl: "https://github.com/Acme/Widgets.git",
        backing: "cloud-vm",
        access: "cloud",
      }),
    ).resolves.toEqual(created)
    const reused = await authority.createWorkspace(alice, {
      workspaceId: "ws_acme_feature",
      orgId: team.org_id,
      displayName: "feature",
      repoUrl: "git@github.com:Acme/Widgets.git",
      backing: "local-worktree",
      access: "user-hosted",
    })
    expect(reused.project_id).toBe(created.project_id)
    await expect(
      authority.createWorkspace(alice, {
        workspaceId: "ws_acme_main",
        orgId: team.org_id,
        displayName: "collision",
        repoUrl: "https://github.com/acme/collision.git",
        backing: "cloud-vm",
        access: "cloud",
      }),
    ).rejects.toMatchObject({ code: "resource_conflict" })
    expect(
      await database.prepare("select project_id from projects where repo_key = 'github.com/acme/collision'").first(),
    ).toBeNull()

    expect(await authority.openWorkspace(bob, { workspaceId: "ws_acme_main" })).toMatchObject({
      role: "viewer",
      workspace: { org_id: "org_acme", project_id: created.project_id },
    })
    expect(
      await authority.authorizeProject(bob, {
        projectId: created.project_id,
        orgId: "org_acme" as never,
        action: "read",
      }),
    ).toMatchObject({ ok: true, role: "viewer", orgId: "org_acme" })
    expect(
      await authority.authorizeProject(bob, {
        projectId: created.project_id,
        orgId: "org_acme" as never,
        action: "write",
      }),
    ).toEqual({ ok: false })
    expect(
      await authority.projectRole(bob, {
        projectId: created.project_id,
        orgId: "org_wrong" as never,
      }),
    ).toEqual({ ok: false })

    expect(await authority.listWorkspaces(outsider)).toEqual([])
    await expect(authority.openWorkspace(outsider, { workspaceId: "ws_acme_main" })).rejects.toMatchObject({
      status: 403,
    })
    await expect(
      authority.createWorkspace(bob, {
        workspaceId: "ws_member_denied",
        orgId: team.org_id,
        displayName: "denied",
        repoUrl: "https://github.com/acme/denied.git",
        backing: "cloud-vm",
        access: "cloud",
      }),
    ).rejects.toMatchObject({ status: 403, code: "workspace_authorization_denied" })
    expect(
      await database.prepare("select workspace_id from workspaces where workspace_id = 'ws_member_denied'").first(),
    ).toBeNull()
    expect(
      await database.prepare("select project_id from projects where repo_key = 'github.com/acme/denied'").first(),
    ).toBeNull()

    await authority.addOrganizationMember(alice, {
      orgId: team.org_id,
      userId: bob.principal!.userId,
      role: "admin",
    })
    await expect(
      authority.createWorkspace(bob, {
        workspaceId: "ws_admin",
        orgId: team.org_id,
        displayName: "admin",
        repoUrl: "https://github.com/acme/admin.git",
        backing: "cloud-vm",
        access: "cloud",
      }),
    ).resolves.toMatchObject({ org_id: "org_acme" })

    await expect(
      database
        .prepare(
          `
      update workspaces set org_id = 'org_wrong' where workspace_id = 'ws_acme_main'
    `,
        )
        .run(),
    ).rejects.toThrow(/workspace scope is immutable/)
    await expect(
      database
        .prepare(
          `
      update projects set repo_key = 'github.com/acme/other' where project_id = ?
    `,
        )
        .bind(created.project_id)
        .run(),
    ).rejects.toThrow(/project scope is immutable/)
  })
})

describe("D1 user-deployed workspace authority", () => {
  test("atomically consumes one deployment-bound owner claim and rejects expiry, replay, and a second identity", async () => {
    const claim = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"
    const ownerIdentity = identity("random-better-auth-user-id")
    const { authority, database } = await setup({
      kind: "user-deployed",
      organization: { id: "org_deployment", name: "My deployment" },
      ownerBootstrap: "one-use-claim",
    })
    await database
      .prepare(
        `insert into user_deployed_owner_bootstrap_claims
        (deployment_id, claim_hash, admitted_identity_hash, expires_at, consumed_at, consumed_adapter,
          consumed_issuer, consumed_subject, created_at) values (?, ?, ?, ?, null, null, null, null, ?)`,
      )
      .bind(
        "deployment-a",
        await userDeployedOwnerBootstrapClaimHash(claim),
        await userDeployedOwnerIdentityHash(ownerIdentity),
        1_900_000_000_000,
        1_700_000_000_000,
      )
      .run()

    expect(await authority.ensureApplicationIdentity(ownerIdentity)).toEqual({ state: "unavailable" })
    const [ownerAttempt, attackerAttempt] = await Promise.allSettled([
      authority.claimUserDeployedOwner(ownerIdentity, claim),
      authority.claimUserDeployedOwner(identity("attacker"), claim),
    ])
    expect(ownerAttempt.status).toBe("fulfilled")
    expect(attackerAttempt).toMatchObject({ status: "rejected", reason: { code: "resource_conflict" } })
    if (ownerAttempt.status !== "fulfilled") throw ownerAttempt.reason
    const owner = ownerAttempt.value
    expect(owner).toMatchObject({ state: "active" })
    expect(await authority.claimUserDeployedOwner(ownerIdentity, claim)).toEqual(owner)
    expect(
      await database
        .prepare(
          `select consumed_subject from user_deployed_owner_bootstrap_claims
      where deployment_id = 'deployment-a'`,
        )
        .first(),
    ).toEqual({ consumed_subject: ownerIdentity.subject })
    expect((await database.prepare("select count(*) as count from users").first<{ count: number }>())?.count).toBe(1)
    expect((await database.prepare("select count(*) as count from orgs").first<{ count: number }>())?.count).toBe(1)

    await expect(authority.claimUserDeployedOwner(identity("attacker"), claim)).rejects.toMatchObject({
      code: "resource_conflict",
    })
    expect((await database.prepare("select count(*) as count from users").first<{ count: number }>())?.count).toBe(1)

    const expired = await setup({
      kind: "user-deployed",
      organization: { id: "org_expired", name: "Expired" },
      ownerBootstrap: "one-use-claim",
    })
    await expired.database
      .prepare(
        `insert into user_deployed_owner_bootstrap_claims
        (deployment_id, claim_hash, admitted_identity_hash, expires_at, consumed_at, consumed_adapter,
          consumed_issuer, consumed_subject, created_at) values (?, ?, ?, ?, null, null, null, null, ?)`,
      )
      .bind(
        "deployment-a",
        await userDeployedOwnerBootstrapClaimHash(claim),
        await userDeployedOwnerIdentityHash(identity("late")),
        1_700_000_000_000,
        1_600_000_000_000,
      )
      .run()
    await expect(expired.authority.claimUserDeployedOwner(identity("late"), claim)).rejects.toMatchObject({
      code: "resource_conflict",
    })
    expect(await expired.database.prepare("select 1 from users").first()).toBeNull()
    expect(await expired.database.prepare("select 1 from orgs").first()).toBeNull()
  })

  test("pins bootstrap ownership, admits multiplayer members, and cannot create a second organization", async () => {
    const ownerIdentity = identity("owner")
    const { authority, database } = await setup({
      kind: "user-deployed",
      organization: { id: "org_deployment", name: "My deployment" },
      ownerIdentity,
    })
    expect(await authority.ensureApplicationIdentity(identity("uninvited"))).toEqual({
      state: "provisioning",
      retryAfterMs: 5_000,
    })

    const owner = await signed(authority, ownerIdentity)
    expect(await authority.listOrgs(owner)).toEqual([
      {
        org_id: "org_deployment",
        name: "My deployment",
        kind: "deployment",
        role: "owner",
      },
    ])
    expect(await authority.resolveOrgId(owner)).toBe("org_deployment")
    expect((await database.prepare("select count(*) as count from orgs").first<{ count: number }>())?.count).toBe(1)
    expect(await database.prepare("select 1 from orgs where kind = 'personal'").first()).toBeNull()
    await expect(authority.createHostedOrganization(owner, { name: "Forbidden" })).rejects.toMatchObject({
      code: "organization_policy_denied",
    })

    await authority.createCloudWorkspace(owner, {
      workspaceId: "ws_contract_cloud",
      displayName: "contract cloud",
    })
    await expect(authority.openWorkspace(owner, { workspaceId: "ws_contract_cloud" })).resolves.toMatchObject({
      role: "owner",
      workspace: { org_id: "org_deployment", backing: "cloud-vm" },
    })
    await expect(authority.deleteWorkspace(owner, { workspaceId: "ws_contract_cloud" })).resolves.toEqual({
      deleted: true,
    })
    await expect(authority.openWorkspace(owner, { workspaceId: "ws_contract_cloud" })).rejects.toMatchObject({
      status: 403,
    })

    await authority.registerLocalForSharing(owner, {
      workspaceId: "ws_contract_local",
      displayName: "contract local",
      remoteDirectory: "/srv/repos/widgets",
    })
    await expect(authority.openWorkspace(owner, { workspaceId: "ws_contract_local" })).resolves.toMatchObject({
      workspace: { access: "user-hosted", remote_directory: "/srv/repos/widgets" },
    })

    const memberIdentity = identity("member")
    const admission = await authority.admitUserDeployedIdentity(owner, { identity: memberIdentity, role: "member" })
    expect(admission.state).toBe("active")
    const member = await signed(authority, memberIdentity)
    await authority.createWorkspace(owner, {
      workspaceId: "ws_shared",
      orgId: "org_deployment",
      displayName: "shared",
      repoUrl: "https://github.com/acme/shared.git",
      backing: "cloud-vm",
      access: "cloud",
    })
    expect(await authority.openWorkspace(member, { workspaceId: "ws_shared" })).toMatchObject({ role: "viewer" })
    await expect(
      authority.createWorkspace(member, {
        workspaceId: "ws_denied",
        orgId: "org_deployment",
        displayName: "denied",
        backing: "cloud-vm",
        access: "cloud",
      }),
    ).rejects.toMatchObject({ status: 403, code: "workspace_authorization_denied" })

    await authority.addOrganizationMember(owner, {
      orgId: "org_deployment",
      userId: member.principal!.userId,
      role: "admin",
    })
    await expect(
      authority.createWorkspace(member, {
        workspaceId: "ws_member_admin",
        orgId: "org_deployment",
        displayName: "admin",
        backing: "cloud-vm",
        access: "cloud",
      }),
    ).resolves.toMatchObject({ org_id: "org_deployment" })

    await database
      .prepare(
        `
      update org_memberships set revoked_at = 1800000009999
      where org_id = 'org_deployment' and user_id = ?
    `,
      )
      .bind(member.principal!.userId)
      .run()
    await expect(authority.openWorkspace(member, { workspaceId: "ws_member_admin" })).rejects.toMatchObject({
      status: 403,
    })
    expect(await authority.listWorkspaces(member)).toEqual([])

    await expect(
      authority.createWorkspace(owner, {
        workspaceId: "ws_wrong_org",
        orgId: "org_other",
        displayName: "wrong",
        backing: "cloud-vm",
        access: "cloud",
      }),
    ).rejects.toMatchObject({ code: "organization_policy_denied" })
    expect((await database.prepare("select count(*) as count from orgs").first<{ count: number }>())?.count).toBe(1)
  })
})
