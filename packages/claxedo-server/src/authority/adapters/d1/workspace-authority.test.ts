import { readdir, readFile } from "node:fs/promises"
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

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../../../../migrations/control-plane/", import.meta.url))

/**
 * Every shipped migration, in the order production applies them.
 *
 * Read from the directory rather than listed here: a curated subset drifts
 * silently from what deployments run, and this file's subject — the placement
 * a workspace row carries — is rewritten by migrations a subset would omit.
 */
async function migrations() {
  return (await readdir(MIGRATIONS_DIRECTORY)).filter((name) => name.endsWith(".sql")).sort()
}

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
  for (const name of await migrations()) {
    const migration = (await readFile(MIGRATIONS_DIRECTORY + name, "utf8")).replace(/^\s*--.*$/gm, "")
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
  test("reads the principal's identity row once per request auth object", async () => {
    const { authority: seeded, database } = await setup({ kind: "claxedo-hosted" })
    let identityReads = 0
    const counted = new Proxy(database, {
      get(target, key, receiver) {
        if (key === "prepare") {
          return (sql: string) => {
            if (sql.includes("from auth_identities ai")) identityReads += 1
            return target.prepare(sql)
          }
        }
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const authority = new D1WorkspaceAuthority(counted, {
      deploymentId: "deployment-a",
      product: { kind: "claxedo-hosted" },
      now: () => 1_800_000_000_000,
      randomId: (prefix) => `${prefix}_memo`,
    })
    const auth = await signed(seeded, identity("alice"))

    await authority.usersMe(auth)
    await Promise.all([authority.listOrgs(auth), authority.resolveOrgId(auth), authority.listWorkspaces(auth)])
    expect(identityReads).toBe(1)

    const next = await signed(seeded, identity("alice"))
    await authority.usersMe(next)
    expect(identityReads).toBe(2)

    const stale = { ...next, principal: { ...next.principal!, actorId: "actor_unknown" } }
    await expect(authority.usersMe(stale)).rejects.toThrow(/stale or unlinked/)
    await expect(authority.usersMe(stale)).rejects.toThrow(/stale or unlinked/)
    expect(identityReads).toBe(4)
  })

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
    const providerIdentity = identity("custom-alice", "custom")
    await authority.linkApplicationIdentity(alice, { identity: providerIdentity })
    const orgResolution = await authority.ensureApplicationIdentity(providerIdentity)
    expect(orgResolution).toEqual({
      state: "active",
      userId: alice.principal!.userId,
      actorId: alice.principal!.actorId,
    })
    expect((await database.prepare("select count(*) as count from users").first<{ count: number }>())?.count).toBe(1)

    const bob = await signed(authority, identity("bob"))
    await expect(authority.linkApplicationIdentity(bob, { identity: providerIdentity })).rejects.toMatchObject({
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
    })
    await expect(
      authority.createWorkspace(alice, {
        workspaceId: "ws_acme_main",
        orgId: team.org_id,
        displayName: "main",
        repoUrl: "https://github.com/Acme/Widgets.git",
        backing: "cloud-vm",
      }),
    ).resolves.toEqual(created)
    const reused = await authority.createWorkspace(alice, {
      workspaceId: "ws_acme_feature",
      orgId: team.org_id,
      displayName: "feature",
      repoUrl: "git@github.com:Acme/Widgets.git",
      backing: "local-worktree",
    })
    expect(reused.project_id).toBe(created.project_id)
    await expect(
      authority.createWorkspace(alice, {
        workspaceId: "ws_acme_main",
        orgId: team.org_id,
        displayName: "collision",
        repoUrl: "https://github.com/acme/collision.git",
        backing: "cloud-vm",
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

  test("creates and deletes a cloud root for a resolved owner's actor, under the same admission a signed creator gets", async () => {
    const { authority, database } = await setup({ kind: "claxedo-hosted" })
    const alice = await signed(authority, identity("alice"))
    const bob = await signed(authority, identity("bob"))
    const team = await authority.createHostedOrganization(alice, { name: "Acme", orgId: "org_acme" })
    await authority.addOrganizationMember(alice, { orgId: team.org_id, userId: bob.principal!.userId, role: "member" })
    const project = await authority.createWorkspace(alice, {
      workspaceId: "ws_acme_main",
      orgId: team.org_id,
      displayName: "main",
      repoUrl: "https://github.com/Acme/Widgets.git",
      backing: "cloud-vm",
    })
    const principalOf = (auth: SignedControlPlaneAuth) =>
      ({ principalKind: "user", actorId: auth.principal!.actorId, actorKind: "human" }) as const
    const root = {
      orgId: team.org_id,
      projectId: project.project_id,
      displayName: "Fix the importer (primary, attempt 1)",
      repoUrl: "https://github.com/Acme/Widgets.git",
      gitBranch: "main",
    }

    await authority.createRuntimeCloudWorkspace(principalOf(alice), { ...root, workspaceId: "ws_root_1" })
    expect(await authority.openWorkspace(alice, { workspaceId: "ws_root_1" })).toMatchObject({
      role: "owner",
      workspace: { org_id: "org_acme", project_id: project.project_id, backing: "cloud-vm", placement: {}, git_branch: "main" },
    })
    expect(
      await database.prepare("select owner_user_id from workspaces where workspace_id = 'ws_root_1'").first(),
    ).toEqual({ owner_user_id: alice.principal!.userId })

    // A member who could not create a cloud workspace from the app cannot have
    // one created for them here either; nor can an actor this plane does not
    // know, a service principal, or a suspended owner.
    const refusals: Array<[string, Parameters<typeof authority.createRuntimeCloudWorkspace>[0]]> = [
      ["a member", principalOf(bob)],
      ["a stranger", { principalKind: "user", actorId: "act_unknown", actorKind: "human" }],
      ["the plane's own service actor", { principalKind: "service", actorId: "control-plane", actorKind: "agent" }],
    ]
    for (const [, principal] of refusals) {
      await expect(
        authority.createRuntimeCloudWorkspace(principal, { ...root, workspaceId: "ws_root_refused" }),
      ).rejects.toMatchObject({ status: 403 })
    }
    await expect(
      authority.createRuntimeCloudWorkspace(principalOf(alice), { ...root, orgId: "org_elsewhere", workspaceId: "ws_root_refused" }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      authority.createRuntimeCloudWorkspace(principalOf(alice), { ...root, projectId: "prj_unknown", workspaceId: "ws_root_refused" }),
    ).rejects.toMatchObject({ status: 403 })
    await database.prepare("update actors set state = 'suspended' where actor_id = ?").bind(alice.principal!.actorId).run()
    await expect(
      authority.createRuntimeCloudWorkspace(principalOf(alice), { ...root, workspaceId: "ws_root_refused" }),
    ).rejects.toMatchObject({ status: 403 })
    await database.prepare("update actors set state = 'active' where actor_id = ?").bind(alice.principal!.actorId).run()
    expect(
      await database.prepare("select workspace_id from workspaces where workspace_id = 'ws_root_refused'").first(),
    ).toBeNull()

    await expect(authority.deleteRuntimeWorkspace(principalOf(bob), { workspaceId: "ws_root_1" })).rejects.toMatchObject({
      status: 403,
    })
    await expect(authority.deleteRuntimeWorkspace(principalOf(alice), { workspaceId: "ws_root_1" })).resolves.toEqual({
      deleted: true,
    })
    await expect(authority.openWorkspace(alice, { workspaceId: "ws_root_1" })).rejects.toMatchObject({ status: 403 })
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
      workspace: { backing: "local-worktree", placement: { directory: "/srv/repos/widgets" } },
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
    })
    expect(await authority.openWorkspace(member, { workspaceId: "ws_shared" })).toMatchObject({ role: "viewer" })
    await expect(
      authority.createWorkspace(member, {
        workspaceId: "ws_denied",
        orgId: "org_deployment",
        displayName: "denied",
        backing: "cloud-vm",
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
      }),
    ).rejects.toMatchObject({ code: "organization_policy_denied" })
    expect((await database.prepare("select count(*) as count from orgs").first<{ count: number }>())?.count).toBe(1)
  })
})

describe("a workspace's row carries its placement", () => {
  async function two(authority: D1WorkspaceAuthority, alice: SignedControlPlaneAuth) {
    const orgId = await authority.resolveOrgId(alice)
    await authority.createWorkspace(alice, {
      workspaceId: "ws_vm",
      orgId,
      displayName: "vm",
      repoUrl: "https://github.com/acme/vm.git",
      backing: "cloud-vm",
    })
    await authority.createWorkspace(alice, {
      workspaceId: "ws_machine",
      orgId,
      displayName: "machine",
      repoUrl: "https://github.com/acme/machine.git",
      remoteDirectory: "/srv/machine",
      backing: "local-worktree",
    })
    return orgId
  }

  test("publishes the enrolled machine the owner assigned and the directory on it", async () => {
    const { authority, database } = await setup({ kind: "claxedo-hosted" })
    const alice = await signed(authority, identity("alice"))
    const orgId = await two(authority, alice)
    const owner = await database
      .prepare(`
        select w.owner_user_id, a.actor_id from workspaces w
        join actors a on a.user_id = w.owner_user_id
        where w.workspace_id = 'ws_machine'
      `)
      .first<{ owner_user_id: string; actor_id: string }>()
    await database.prepare(
      `insert into host_enrollments
         (enrollment_id, owner_user_id, owner_actor_id, host_id, public_key_json, display_name,
          last_seen_at, expires_at, created_at, updated_at)
       values ('enr_a', ?, ?, 'host-a', '{}', 'MacBook', 1, 1, 1, 1)`,
    ).bind(owner!.owner_user_id, owner!.actor_id).run()
    await database.prepare(
      `insert into host_workspace_assignments
         (workspace_id, host_id, org_id, owner_user_id, owner_actor_id, second_device_open_at, assigned_at, updated_at, revision)
       values ('ws_machine', 'host-a', ?, ?, ?, null, 1, 1, 1)`,
    ).bind(orgId, owner!.owner_user_id, owner!.actor_id).run()

    await expect(authority.openWorkspace(alice, { workspaceId: "ws_machine" })).resolves.toMatchObject({
      workspace: { backing: "local-worktree", placement: { host_enrollment_id: "enr_a", directory: "/srv/machine" } },
    })
    await expect(authority.openWorkspace(alice, { workspaceId: "ws_vm" })).resolves.toMatchObject({
      workspace: { backing: "cloud-vm", placement: {} },
    })

    const listed = new Map((await authority.listWorkspaces(alice)).map((row) => [row.workspace_id, row]))
    expect(listed.get("ws_machine")).toMatchObject({
      placement: { host_enrollment_id: "enr_a", directory: "/srv/machine" },
    })
    expect(listed.get("ws_vm")).toMatchObject({ placement: {} })
  })

  test("no workspace row carries an access mode any more", async () => {
    const { authority, database } = await setup({ kind: "claxedo-hosted" })
    const alice = await signed(authority, identity("alice"))
    await two(authority, alice)

    const columns = await database.prepare("select name from pragma_table_info('workspaces')").all<{ name: string }>()
    expect(columns.results.map((row) => row.name)).not.toContain("access")
    const opened = await authority.openWorkspace(alice, { workspaceId: "ws_machine" })
    expect(opened.workspace).not.toHaveProperty("access")
    expect((await authority.listWorkspaces(alice)).every((row) => !("access" in row))).toBe(true)
  })

  test("reachability is reported for machine-placed rows and withheld from provisioner-owned ones", async () => {
    const { authority } = await setup({ kind: "claxedo-hosted" })
    const alice = await signed(authority, identity("alice"))
    await two(authority, alice)

    const listed = new Map((await authority.listWorkspaces(alice)).map((row) => [row.workspace_id, row]))
    expect(listed.get("ws_vm")).not.toHaveProperty("host_online")
    expect(listed.get("ws_machine")).toMatchObject({ host_online: false })
  })
})

describe("workspace creation admission", () => {
  test("admits a create against the organization creation resolves, whatever the caller named", async () => {
    const { authority, database } = await setup({ kind: "claxedo-hosted" })
    const alice = await signed(authority, identity("alice"))
    const bob = await signed(authority, identity("bob"))

    // One organization each: the caller names nothing and is still admitted
    // against the organization their workspace would land in.
    const alone = await authority.resolveOrgId(alice)
    await expect(authority.authorizeWorkspaceCreate(alice, {})).resolves.toBeUndefined()
    await expect(authority.authorizeWorkspaceCreate(alice, { orgId: alone })).resolves.toBeUndefined()
    await expect(authority.authorizeWorkspaceCreate(bob, { orgId: alone })).rejects.toMatchObject({
      status: 403,
      code: "workspace_authorization_denied",
    })

    const team = await authority.createHostedOrganization(alice, { name: "Acme", orgId: "org_acme" })
    await authority.addOrganizationMember(alice, {
      orgId: team.org_id,
      userId: bob.principal!.userId,
      role: "member",
    })
    const created = await authority.createWorkspace(alice, {
      workspaceId: "ws_acme_main",
      orgId: team.org_id,
      displayName: "main",
      repoUrl: "https://github.com/Acme/Widgets.git",
      backing: "cloud-vm",
    })

    // Alice now belongs to two organizations, so an unnamed create is
    // ambiguous — the refusal `createCloudWorkspace` gives, given before the
    // caller's billable work rather than after it.
    await expect(authority.authorizeWorkspaceCreate(alice, {})).rejects.toMatchObject({ status: 403 })
    await expect(
      authority.createCloudWorkspace(alice, { workspaceId: "ws_ambiguous", displayName: "Ambiguous" }),
    ).rejects.toMatchObject({ status: 403 })
    expect(await database.prepare("select workspace_id from workspaces where workspace_id = 'ws_ambiguous'").first())
      .toBeNull()

    // The project is the selector creation reads, and admission reads the same
    // one: its organization, and whether this caller may administer it.
    await expect(authority.authorizeWorkspaceCreate(alice, { projectId: created.project_id }))
      .resolves.toBeUndefined()
    // Both selectors, as the hosted create route sends them. Creation derives
    // the organization from the project and ignores the named one, so a name
    // that disagrees is refused here rather than served in a tenant the caller
    // did not ask for.
    await expect(authority.authorizeWorkspaceCreate(alice, { orgId: team.org_id, projectId: created.project_id }))
      .resolves.toBeUndefined()
    await expect(authority.authorizeWorkspaceCreate(alice, { orgId: "org_elsewhere", projectId: created.project_id }))
      .rejects.toMatchObject({ status: 403 })
    await expect(authority.authorizeWorkspaceCreate(bob, { projectId: created.project_id }))
      .rejects.toMatchObject({ status: 403 })
    await expect(
      authority.createCloudWorkspace(bob, {
        workspaceId: "ws_member_denied",
        projectId: created.project_id,
        displayName: "Denied",
      }),
    ).rejects.toMatchObject({ status: 403 })

    await authority.addOrganizationMember(alice, {
      orgId: team.org_id,
      userId: bob.principal!.userId,
      role: "admin",
    })
    await expect(authority.authorizeWorkspaceCreate(bob, { projectId: created.project_id }))
      .resolves.toBeUndefined()
  })

  test("a user-deployed product admits creation only in its own organization", async () => {
    const { authority } = await setup({
      kind: "user-deployed",
      organization: { id: "org_house", name: "House" },
      ownerIdentity: identity("alice"),
    })
    const alice = await signed(authority, identity("alice"))

    await expect(authority.authorizeWorkspaceCreate(alice, {})).resolves.toBeUndefined()
    await expect(authority.authorizeWorkspaceCreate(alice, { orgId: "org_house" })).resolves.toBeUndefined()
    await expect(authority.authorizeWorkspaceCreate(alice, { orgId: "org_elsewhere" })).rejects.toMatchObject({
      status: 403,
    })
  })
})
