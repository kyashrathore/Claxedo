import { afterEach, describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import type { D1Database } from "@cloudflare/workers-types"
import type { D1CoreAuthorityBoundary } from "./core-authority"
import { D1WorkspaceAuthority } from "./workspace-authority"
import { D1OrgMemberAuthority } from "./org-member-authority"
import { D1ProjectMemberAuthority } from "./project-member-authority"
import { composeBetterAuthD1Authority } from "../worker/better-auth-d1-compose"
import {
  controlPlaneMigrations,
  miniflareControlPlaneDatabase,
  type ControlPlaneDatabase,
} from "../../../test-support/control-plane-migrations"

const active: ControlPlaneDatabase[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((database) => database.dispose()))
})

async function setup() {
  const controlPlane = await miniflareControlPlaneDatabase(controlPlaneMigrations())
  active.push(controlPlane)
  const { database } = controlPlane
  const authority = composeBetterAuthD1Authority({
    env: {
      CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
      CLAXEDO_PRODUCT_POSTURE: "claxedo-hosted",
      CLAXEDO_DEPLOYMENT_ID: "deployment-a",
      CONTROL_PLANE_DB: database,
    },
    product: { kind: "claxedo-hosted" },
  })
  const person = (subject: string) => signed(authority, subject)
  const alice = await person("alice")
  const bob = await person("bob")
  const carol = await person("carol")
  const outsider = await person("outsider")
  await authority.createHostedOrganization(alice, { name: "Acme", orgId: "org_acme" })
  await authority.createHostedOrganization(outsider, { name: "Other", orgId: "org_other" })
  const created = await authority.createWorkspace(alice, {
    workspaceId: "ws_acme",
    orgId: "org_acme",
    displayName: "acme",
    backing: "local-worktree",
  })
  await database.prepare("update workspaces set org_member_visible = 0 where workspace_id = 'ws_acme'").run()
  const audit = async (prefix: string) =>
    (await database
      .prepare("select action, user_id, metadata_json from authority_audit_events where action like ? order by rowid")
      .bind(`${prefix}%`)
      .all<{ action: string; user_id: string; metadata_json: string }>()).results.map((row) => ({
      action: row.action,
      actor: row.user_id,
      ...JSON.parse(row.metadata_json),
    }))
  return { authority, database, alice, bob, carol, outsider, projectId: created.project_id, audit, person }
}

async function signed(authority: D1CoreAuthorityBoundary, subject: string): Promise<SignedControlPlaneAuth> {
  const identity: AuthIdentity = { adapter: "better-auth", issuer: "https://auth.example.test", subject }
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
    user: { subject: mapped.userId, tokenIdentifier: `${identity.issuer}|${subject}`, issuer: identity.issuer },
  }
}

const id = (auth: SignedControlPlaneAuth) => auth.principal!.userId

describe("D1 organization members", () => {
  test("an admin adds a member, changes their role and lists them with when they joined; each change is audited", async () => {
    const { authority, alice, bob, audit } = await setup()

    expect(await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" }))
      .toMatchObject({ user_id: id(bob), role: "member" })
    expect(await authority.updateOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "admin" }))
      .toMatchObject({ user_id: id(bob), role: "admin" })

    const members = await authority.listOrgMembers!(alice, { orgId: "org_acme" })
    expect(members.map(({ user_id, role }) => ({ user_id, role }))).toEqual([
      { user_id: id(alice), role: "owner" },
      { user_id: id(bob), role: "admin" },
    ])
    expect(members.every((member) => typeof member.joined_at === "number")).toBe(true)
    expect(await audit("org.member.")).toEqual([
      { action: "org.member.added", actor: id(alice), orgId: "org_acme", targetUserId: id(bob), before: null, after: "member" },
      { action: "org.member.role_changed", actor: id(alice), orgId: "org_acme", targetUserId: id(bob), before: "member", after: "admin" },
    ])
  })

  test("adds an existing account by provider subject and refuses an account that does not exist", async () => {
    const { authority, alice, carol } = await setup()

    expect(await authority.addOrgMember!(alice, { orgId: "org_acme", providerSubject: "carol", role: "member" }))
      .toMatchObject({ user_id: id(carol) })
    await expect(authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: "usr_nobody", role: "member" }))
      .rejects.toMatchObject({ code: "org_member_not_found" })
    await expect(authority.addOrgMember!(alice, { orgId: "org_acme", role: "member" }))
      .rejects.toMatchObject({ code: "org_member_target_required" })
  })

  test("only owners and admins change membership, and only an owner moves the owner role", async () => {
    const { authority, alice, bob, carol, outsider, audit } = await setup()
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })

    await expect(authority.addOrgMember!(bob, { orgId: "org_acme", userPublicId: id(carol), role: "member" }))
      .rejects.toMatchObject({ code: "org_admin_required" })
    await expect(authority.addOrgMember!(outsider, { orgId: "org_acme", userPublicId: id(carol), role: "member" }))
      .rejects.toMatchObject({ code: "org_admin_required" })

    await authority.updateOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "admin" })
    await authority.addOrgMember!(bob, { orgId: "org_acme", userPublicId: id(carol), role: "member" })
    await expect(authority.updateOrgMember!(bob, { orgId: "org_acme", userPublicId: id(carol), role: "owner" }))
      .rejects.toMatchObject({ code: "org_owner_required" })

    await authority.updateOrgMember!(alice, { orgId: "org_acme", userPublicId: id(carol), role: "owner" })
    await expect(authority.removeOrgMember!(bob, { orgId: "org_acme", userPublicId: id(carol) }))
      .rejects.toMatchObject({ code: "org_owner_required" })
    await expect(authority.updateOrgMember!(bob, { orgId: "org_acme", userPublicId: id(carol), role: "member" }))
      .rejects.toMatchObject({ code: "org_owner_required" })
    expect((await audit("org.member.")).map((row) => row.action)).toEqual([
      "org.member.added",
      "org.member.role_changed",
      "org.member.added",
      "org.member.role_changed",
    ])
  })

  test("the founding owner can be neither demoted nor removed, so the organization always keeps an owner", async () => {
    const { authority, alice, carol } = await setup()

    await expect(authority.updateOrgMember!(alice, { orgId: "org_acme", userPublicId: id(alice), role: "admin" }))
      .rejects.toMatchObject({ code: "org_owner_protected" })
    await expect(authority.removeOrgMember!(alice, { orgId: "org_acme", userPublicId: id(alice) }))
      .rejects.toMatchObject({ code: "org_owner_protected" })

    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(carol), role: "owner" })
    await expect(authority.updateOrgMember!(carol, { orgId: "org_acme", userPublicId: id(alice), role: "member" }))
      .rejects.toMatchObject({ code: "org_owner_protected" })
    expect(await authority.updateOrgMember!(alice, { orgId: "org_acme", userPublicId: id(carol), role: "admin" }))
      .toMatchObject({ role: "admin" })
    expect((await authority.listOrgMembers!(alice, { orgId: "org_acme" })).filter((row) => row.role === "owner"))
      .toEqual([expect.objectContaining({ user_id: id(alice) })])
  })

  test("removing a member revokes their teams and grants in one batch, and their next request is refused", async () => {
    const { authority, database, alice, bob, projectId, audit } = await setup()
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    const team = (await authority.createTeamInOrg!(alice, { orgId: "org_acme", name: "Eng" })) as { team_id: string }
    await authority.addTeamMember!(alice, { teamId: team.team_id, userPublicId: id(bob) })
    await authority.grantTeamProject!(alice, { teamId: team.team_id, projectId, role: "editor" })
    await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "admin" })
    expect(await authority.openWorkspace(bob, { workspaceId: "ws_acme" })).toMatchObject({ role: "admin" })

    expect(await authority.removeOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob) })).toEqual({
      removed: true,
      team_memberships_revoked: 1,
      project_memberships_revoked: 1,
    })

    await expect(authority.openWorkspace(bob, { workspaceId: "ws_acme" })).rejects.toMatchObject({ status: 403 })
    expect(await authority.projectRole(bob, { projectId: projectId as never })).toEqual({ ok: false })
    await expect(authority.resolveRuntimeMachineAccess(bob.principal!.actorId, "ws_acme", "viewer"))
      .rejects.toMatchObject({ status: 403 })
    expect(await database
      .prepare("select count(*) as n from team_memberships where user_id = ? and revoked_at is null")
      .bind(id(bob)).first<{ n: number }>()).toEqual({ n: 0 })
    expect((await audit("org.member.removed"))).toEqual([
      { action: "org.member.removed", actor: id(alice), orgId: "org_acme", targetUserId: id(bob), before: "member", after: null },
    ])
    expect(await authority.removeOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob) })).toEqual({
      removed: false,
      team_memberships_revoked: 0,
      project_memberships_revoked: 0,
    })

    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    expect(await authority.projectRole(bob, { projectId: projectId as never })).toMatchObject({ ok: true, role: "viewer" })
    await expect(authority.openWorkspace(bob, { workspaceId: "ws_acme" })).rejects.toMatchObject({ status: 403 })
  })
})

describe("D1 per-member project grants", () => {
  test("grant, re-grant with a role change, revoke and re-grant, each audited with the role before and after", async () => {
    const { authority, alice, bob, projectId, audit } = await setup()
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    await expect(authority.openWorkspace(bob, { workspaceId: "ws_acme" })).rejects.toMatchObject({ status: 403 })

    expect(await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "editor" }))
      .toEqual({ project_id: projectId, user_id: id(bob), role: "editor" })
    expect(await authority.openWorkspace(bob, { workspaceId: "ws_acme" })).toMatchObject({ role: "editor" })
    await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "admin" })
    expect(await authority.projectRole(bob, { projectId: projectId as never })).toMatchObject({ role: "admin" })

    expect(await authority.revokeProjectMember!(alice, { projectId, userPublicId: id(bob) })).toEqual({ revoked: true })
    expect(await authority.revokeProjectMember!(alice, { projectId, userPublicId: id(bob) })).toEqual({ revoked: false })
    await expect(authority.openWorkspace(bob, { workspaceId: "ws_acme" })).rejects.toMatchObject({ status: 403 })
    await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "viewer" })
    expect(await authority.openWorkspace(bob, { workspaceId: "ws_acme" })).toMatchObject({ role: "viewer" })

    const change = { actor: id(alice), orgId: "org_acme", projectId, targetUserId: id(bob) }
    expect(await audit("project.member.")).toEqual([
      { action: "project.member.granted", ...change, before: null, after: "editor" },
      { action: "project.member.granted", ...change, before: "editor", after: "admin" },
      { action: "project.member.revoked", ...change, before: "admin", after: null },
      { action: "project.member.granted", ...change, before: null, after: "viewer" },
    ])
  })

  test("the owner row never changes, a grantee outside the organization is refused, and only project admins grant", async () => {
    const { authority, alice, bob, carol, outsider, projectId, audit } = await setup()
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(carol), role: "member" })

    await expect(authority.grantProjectMember!(alice, { projectId, userPublicId: id(alice), role: "viewer" }))
      .rejects.toMatchObject({ code: "project_member_owner_immutable" })
    await expect(authority.revokeProjectMember!(alice, { projectId, userPublicId: id(alice) }))
      .rejects.toMatchObject({ code: "project_member_owner_immutable" })
    await expect(authority.grantProjectMember!(alice, { projectId, userPublicId: id(outsider), role: "viewer" }))
      .rejects.toMatchObject({ code: "project_member_org_membership_required" })
    await expect(authority.grantProjectMember!(bob, { projectId, userPublicId: id(carol), role: "viewer" }))
      .rejects.toMatchObject({ code: "project_admin_required" })
    await expect(authority.grantProjectMember!(outsider, { projectId, userPublicId: id(carol), role: "viewer" }))
      .rejects.toMatchObject({ code: "project_not_found" })

    await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "admin" })
    expect(await authority.grantProjectMember!(bob, { projectId, userPublicId: id(carol), role: "editor" }))
      .toMatchObject({ role: "editor" })
    expect((await audit("project.member.")).map((row) => [row.actor, row.targetUserId])).toEqual([
      [id(alice), id(bob)],
      [id(bob), id(carol)],
    ])
  })
})

describe("D1 team project grants", () => {
  test("a team grant is listed, changes role, is revoked, and its members' rank follows it on every rank reader", async () => {
    const { authority, alice, bob, projectId, audit } = await setup()
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    const team = (await authority.createTeamInOrg!(alice, { orgId: "org_acme", name: "Eng" })) as { team_id: string }
    await authority.addTeamMember!(alice, { teamId: team.team_id, userPublicId: id(bob) })

    await authority.grantTeamProject!(alice, { teamId: team.team_id, projectId, role: "editor" })
    expect(await authority.listTeamProjects!(alice, { teamId: team.team_id }))
      .toEqual([expect.objectContaining({ team_id: team.team_id, project_id: projectId, role: "editor" })])
    expect(await authority.listTeamProjects!(bob, { teamId: team.team_id })).toHaveLength(1)
    expect(await authority.openWorkspace(bob, { workspaceId: "ws_acme" })).toMatchObject({ role: "editor" })
    expect(await authority.resolveRuntimeMachineAccess(bob.principal!.actorId, "ws_acme", "editor"))
      .toMatchObject({ role: "editor" })

    await authority.grantTeamProject!(alice, { teamId: team.team_id, projectId, role: "viewer" })
    expect(await authority.openWorkspace(bob, { workspaceId: "ws_acme" })).toMatchObject({ role: "viewer" })
    expect(await authority.revokeTeamProject!(alice, { teamId: team.team_id, projectId })).toEqual({ revoked: true })
    expect(await authority.listTeamProjects!(alice, { teamId: team.team_id })).toEqual([])
    await expect(authority.openWorkspace(bob, { workspaceId: "ws_acme" })).rejects.toMatchObject({ status: 403 })

    const change = { actor: id(alice), orgId: "org_acme", teamId: team.team_id, projectId }
    expect(await audit("team.project.")).toEqual([
      { action: "team.project.granted", ...change, before: null, after: "editor" },
      { action: "team.project.granted", ...change, before: "editor", after: "viewer" },
      { action: "team.project.revoked", ...change, before: "viewer", after: null },
    ])
    expect((await audit("team.member.")).map((row) => [row.action, row.targetUserId, row.before, row.after]))
      .toEqual([["team.member.added", id(bob), null, "member"]])
  })

  test("refuses a team or a member from another organization and a caller who does not administer the team's", async () => {
    const { authority, alice, bob, outsider, projectId } = await setup()
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    const acmeTeam = (await authority.createTeamInOrg!(alice, { orgId: "org_acme", name: "Eng" })) as { team_id: string }
    const otherTeam = (await authority.createTeamInOrg!(outsider, { orgId: "org_other", name: "Ops" })) as { team_id: string }

    await expect(authority.grantTeamProject!(outsider, { teamId: otherTeam.team_id, projectId, role: "editor" }))
      .rejects.toMatchObject({ code: "project_not_found" })
    await expect(authority.grantTeamProject!(alice, { teamId: otherTeam.team_id, projectId, role: "editor" }))
      .rejects.toMatchObject({ code: "org_admin_required" })
    await expect(authority.addTeamMember!(alice, { teamId: acmeTeam.team_id, userPublicId: id(outsider) }))
      .rejects.toMatchObject({ code: "team_member_org_membership_required" })
    await expect(authority.grantTeamProject!(bob, { teamId: acmeTeam.team_id, projectId, role: "editor" }))
      .rejects.toMatchObject({ code: "org_admin_required" })
    await expect(authority.revokeTeamProject!(bob, { teamId: acmeTeam.team_id, projectId }))
      .rejects.toMatchObject({ code: "org_admin_required" })
    expect(await authority.listTeamProjects!(outsider, { teamId: acmeTeam.team_id })).toEqual([])
  })
})

describe("D1 project access listing", () => {
  test("lists the owner, each member grant, each team grant and each organization role, to project and org admins only", async () => {
    const { authority, alice, bob, carol, outsider, projectId } = await setup()
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(carol), role: "admin" })
    const team = (await authority.createTeamInOrg!(alice, { orgId: "org_acme", name: "Eng" })) as { team_id: string }
    await authority.grantTeamProject!(alice, { teamId: team.team_id, projectId, role: "editor" })
    await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "viewer" })

    const listing = await authority.listProjectAccess!(carol, { projectId })
    expect(listing.org_id).toBe("org_acme")
    expect(listing.entries).toEqual(expect.arrayContaining([
      { kind: "user", user_id: id(alice), role: "owner", source: "owner" },
      { kind: "user", user_id: id(bob), role: "viewer", source: "member" },
      { kind: "team", team_id: team.team_id, name: "Eng", role: "editor", source: `team:${team.team_id}` },
      { kind: "user", user_id: id(alice), role: "admin", source: "org-role" },
      { kind: "user", user_id: id(bob), role: "viewer", source: "org-role" },
      { kind: "user", user_id: id(carol), role: "admin", source: "org-role" },
    ]))
    expect(listing.entries).toHaveLength(6)

    await expect(authority.listProjectAccess!(bob, { projectId })).rejects.toMatchObject({ code: "project_admin_required" })
    await expect(authority.listProjectAccess!(outsider, { projectId })).rejects.toMatchObject({ code: "project_not_found" })
    await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "admin" })
    expect((await authority.listProjectAccess!(bob, { projectId })).entries).toHaveLength(6)
  })
})

describe("D1 access changes under a concurrent revocation", () => {
  test("a change whose caller loses admin between the check and the write lands nothing, not even its audit row", async () => {
    const { authority, database, alice, bob, carol, projectId, audit } = await setup()
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "admin" })
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(carol), role: "member" })
    const demoteBobFirst = new Proxy(database, {
      get(target, key, receiver) {
        if (key === "batch") {
          return async (statements: Parameters<D1Database["batch"]>[0]) => {
            await target.prepare("update org_memberships set role = 'member' where user_id = ?").bind(id(bob)).run()
            return await target.batch(statements)
          }
        }
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const context = new D1WorkspaceAuthority(demoteBobFirst, {
      deploymentId: "deployment-a",
      product: { kind: "claxedo-hosted" },
    }).accessContext()

    await expect(new D1OrgMemberAuthority(context).updateOrgMember(bob, { orgId: "org_acme", userPublicId: id(carol), role: "admin" }))
      .rejects.toMatchObject({ code: "resource_conflict" })
    await database.prepare("update org_memberships set role = 'admin' where user_id = ?").bind(id(bob)).run()
    await expect(new D1ProjectMemberAuthority(context).grantProjectMember(bob, { projectId, userPublicId: id(carol), role: "editor" }))
      .rejects.toMatchObject({ code: "resource_conflict" })

    expect((await authority.listOrgMembers!(alice, { orgId: "org_acme" })).find((row) => row.user_id === id(carol)))
      .toMatchObject({ role: "member" })
    expect(await authority.projectRole(carol, { projectId: projectId as never })).toMatchObject({ role: "viewer" })
    expect((await audit("org.member.")).map((row) => row.action)).toEqual(["org.member.added", "org.member.added"])
    expect(await audit("project.member.")).toEqual([])
  })
})
