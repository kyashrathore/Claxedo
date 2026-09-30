import { afterEach, describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import type { D1Database } from "@cloudflare/workers-types"
import type { D1CoreAuthorityBoundary } from "./core-authority"
import { D1WorkspaceAuthority } from "./workspace-authority"
import { D1OrgMemberAuthority } from "./org-member-authority"
import { D1ProjectMemberAuthority } from "./project-member-authority"
import { D1AuditAuthority } from "./audit-authority"
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
    repoUrl: "https://github.com/acme/app",
  })
  await authority.createWorkspace(alice, {
    workspaceId: "ws_private",
    orgId: "org_acme",
    displayName: "private",
    backing: "cloud-vm",
    repoUrl: "https://github.com/acme/app",
    orgMemberVisible: false,
  })
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

const byJson = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b))

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
    expect((await audit("org.member.")).filter((row) => row.targetUserId === id(bob))).toEqual([
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
    expect((await audit("org.member.")).filter((row) => row.orgId === "org_acme").map((row) => row.action)).toEqual([
      "org.member.added",
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
      session_shares_revoked: 0,
      session_participations_revoked: 0,
      runtime_tokens_revoked: 0,
    })

    await expect(authority.openWorkspace(bob, { workspaceId: "ws_acme" })).rejects.toMatchObject({ status: 403 })
    expect(await authority.projectRole(bob, { projectId: projectId as never })).toEqual({ ok: false })
    await expect(authority.resolveRuntimeMachineAccess(bob.principal!.actorId, "ws_acme", "viewer"))
      .rejects.toMatchObject({ status: 403 })
    expect(await database
      .prepare("select count(*) as n from team_memberships where user_id = ? and revoked_at is null")
      .bind(id(bob)).first<{ n: number }>()).toEqual({ n: 0 })
    expect((await audit("org.member.removed"))).toEqual([
      {
        action: "org.member.removed",
        actor: id(alice),
        orgId: "org_acme",
        targetUserId: id(bob),
        before: "member",
        after: null,
        sessionSharesRevoked: 0,
        sessionParticipationsRevoked: 0,
      },
    ])
    expect(await authority.removeOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob) })).toMatchObject({ removed: false })

    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    expect(await authority.projectRole(bob, { projectId: projectId as never })).toMatchObject({ ok: true, role: "viewer" })
    expect(await authority.openWorkspace(bob, { workspaceId: "ws_acme" })).toMatchObject({ role: "viewer" })
  })
})

describe("D1 per-member project grants", () => {
  test("grant, re-grant with a role change, revoke and re-grant, each audited with the role before and after", async () => {
    const { authority, alice, bob, projectId, audit } = await setup()
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    expect(await authority.openWorkspace(bob, { workspaceId: "ws_acme" })).toMatchObject({ role: "viewer" })

    expect(await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "editor" }))
      .toEqual({ project_id: projectId, user_id: id(bob), role: "editor" })
    expect(await authority.openWorkspace(bob, { workspaceId: "ws_acme" })).toMatchObject({ role: "editor" })
    await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "admin" })
    expect(await authority.projectRole(bob, { projectId: projectId as never })).toMatchObject({ role: "admin" })

    expect(await authority.revokeProjectMember!(alice, { projectId, userPublicId: id(bob) })).toEqual({ revoked: true })
    expect(await authority.revokeProjectMember!(alice, { projectId, userPublicId: id(bob) })).toEqual({ revoked: false })
    expect(await authority.openWorkspace(bob, { workspaceId: "ws_acme" })).toMatchObject({ role: "viewer" })
    await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "editor" })
    expect(await authority.openWorkspace(bob, { workspaceId: "ws_acme" })).toMatchObject({ role: "editor" })

    const change = { actor: id(alice), orgId: "org_acme", projectId, targetUserId: id(bob) }
    expect(await audit("project.member.")).toEqual([
      { action: "project.member.granted", ...change, before: null, after: "editor" },
      { action: "project.member.granted", ...change, before: "editor", after: "admin" },
      { action: "project.member.revoked", ...change, before: "admin", after: null },
      { action: "project.member.granted", ...change, before: null, after: "editor" },
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

    await authority.grantTeamProject!(alice, { teamId: team.team_id, projectId, role: "admin" })
    expect(await authority.listTeamProjects!(alice, { teamId: team.team_id }))
      .toEqual([expect.objectContaining({ team_id: team.team_id, project_id: projectId, role: "admin" })])
    expect(await authority.listTeamProjects!(bob, { teamId: team.team_id })).toHaveLength(1)
    expect(await authority.openWorkspace(bob, { workspaceId: "ws_acme" })).toMatchObject({ role: "admin" })
    expect(await authority.resolveRuntimeMachineAccess(bob.principal!.actorId, "ws_acme", "editor"))
      .toMatchObject({ role: "admin" })

    await authority.grantTeamProject!(alice, { teamId: team.team_id, projectId, role: "editor" })
    expect(await authority.openWorkspace(bob, { workspaceId: "ws_acme" })).toMatchObject({ role: "editor" })
    expect(await authority.revokeTeamProject!(alice, { teamId: team.team_id, projectId })).toEqual({ revoked: true })
    expect(await authority.listTeamProjects!(alice, { teamId: team.team_id })).toEqual([])
    expect(await authority.openWorkspace(bob, { workspaceId: "ws_acme" })).toMatchObject({ role: "viewer" })
    await expect(authority.resolveRuntimeMachineAccess(bob.principal!.actorId, "ws_acme", "editor"))
      .rejects.toMatchObject({ status: 403 })

    const change = { actor: id(alice), orgId: "org_acme", teamId: team.team_id, projectId }
    expect(await audit("team.project.")).toEqual([
      { action: "team.project.granted", ...change, before: null, after: "admin" },
      { action: "team.project.granted", ...change, before: "admin", after: "editor" },
      { action: "team.project.revoked", ...change, before: "editor", after: null },
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

describe("D1 grants on another person's workspace", () => {
  test("a member or team grant reaches another person's workspace only once it is visible to org members", async () => {
    const { authority, database, alice, bob, carol, projectId } = await setup()
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(carol), role: "member" })
    await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "admin" })
    const team = (await authority.createTeamInOrg!(alice, { orgId: "org_acme", name: "Eng" })) as { team_id: string }
    await authority.addTeamMember!(alice, { teamId: team.team_id, userPublicId: id(carol) })
    await authority.grantTeamProject!(alice, { teamId: team.team_id, projectId, role: "admin" })
    const reserve = (auth: SignedControlPlaneAuth, operation: string) =>
      authority.reserveSession(auth, { operationId: operation, sessionId: `ses_${operation}`, workspaceId: "ws_private", kind: "create", title: "t" })

    for (const person of [bob, carol]) {
      await expect(authority.openWorkspace(person, { workspaceId: "ws_private" })).rejects.toMatchObject({ status: 403 })
      await expect(authority.resolveRuntimeMachineAccess(person.principal!.actorId, "ws_private", "viewer"))
        .rejects.toMatchObject({ status: 403 })
      await expect(token(authority, person, `jti_hidden_${id(person)}`, "viewer", "ws_private")).rejects.toMatchObject({ status: 403 })
      await expect(reserve(person, `hidden_${id(person)}`)).rejects.toMatchObject({ status: 403 })
    }

    await database.prepare("update workspaces set org_member_visible = 1 where workspace_id = 'ws_private'").run()
    for (const person of [bob, carol]) {
      expect(await authority.openWorkspace(person, { workspaceId: "ws_private" })).toMatchObject({ role: "admin" })
      expect(await authority.resolveRuntimeMachineAccess(person.principal!.actorId, "ws_private", "editor"))
        .toMatchObject({ role: "admin" })
      expect(await (await token(authority, person, `jti_visible_${id(person)}`, "admin", "ws_private"))()).toBe(true)
      expect(await reserve(person, `visible_${id(person)}`)).toMatchObject({ sessionId: `ses_visible_${id(person)}` })
    }
  })

  test("creating a project makes its creator the owner of no one else's workspace in it", async () => {
    const { authority, database, alice, carol } = await setup()
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(carol), role: "admin" })
    const tools = await authority.createWorkspace(carol, {
      workspaceId: "ws_tools",
      orgId: "org_acme",
      displayName: "tools",
      backing: "cloud-vm",
      repoUrl: "https://github.com/acme/tools",
    })
    await authority.createWorkspace(alice, {
      workspaceId: "ws_alice_tools",
      orgId: "org_acme",
      displayName: "alice tools",
      backing: "cloud-vm",
      repoUrl: "https://github.com/acme/tools",
      orgMemberVisible: false,
    })
    await authority.updateOrgMember!(alice, { orgId: "org_acme", userPublicId: id(carol), role: "member" })

    expect(await authority.projectRole(carol, { projectId: tools.project_id as never })).toMatchObject({ role: "owner" })
    expect(await authority.openWorkspace(carol, { workspaceId: "ws_tools" })).toMatchObject({ role: "owner" })
    await expect(authority.openWorkspace(carol, { workspaceId: "ws_alice_tools" })).rejects.toMatchObject({ status: 403 })
    await database.prepare("update workspaces set org_member_visible = 1 where workspace_id = 'ws_alice_tools'").run()
    expect(await authority.openWorkspace(carol, { workspaceId: "ws_alice_tools" })).toMatchObject({ role: "admin" })
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
    expect((await audit("org.member.")).filter((row) => row.orgId === "org_acme").map((row) => row.action))
      .toEqual(["org.member.added", "org.member.added", "org.member.added"])
    expect(await audit("project.member.")).toEqual([])
  })
})

function racing(database: D1Database, first: (database: D1Database) => Promise<unknown>) {
  return new Proxy(database, {
    get(target, key, receiver) {
      if (key === "batch") {
        return async (statements: Parameters<D1Database["batch"]>[0]) => {
          await first(target)
          return await target.batch(statements)
        }
      }
      const value: unknown = Reflect.get(target, key, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

async function token(
  authority: D1CoreAuthorityBoundary,
  auth: SignedControlPlaneAuth,
  jti: string,
  role: "viewer" | "editor" | "admin",
  workspaceId = "ws_acme",
) {
  await authority.recordRuntimeAccessToken(auth, {
    jti,
    workspaceId,
    hostId: "host_acme",
    actorId: auth.principal!.actorId,
    actorKind: "human",
    role,
    expiresAt: Date.now() + 600_000,
  })
  return async () => (await authority.runtimeAccessTokenActive({ jti, workspaceId, hostId: "host_acme" }) as { active: boolean }).active
}

describe("D1 access changes that must not undo or outlive a decision", () => {
  test("only an org admin sets up the default team, and setting it up again restores nothing an admin removed or changed", async () => {
    const { authority, alice, bob, carol, projectId, audit } = await setup()
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(carol), role: "member" })

    await expect(authority.ensureDefaultTeam!(bob, { orgId: "org_acme" })).rejects.toMatchObject({ code: "org_admin_required" })
    expect(await audit("team.")).toEqual([])

    const { team_id: teamId } = (await authority.ensureDefaultTeam!(alice, { orgId: "org_acme" })) as { team_id: string }
    expect((await audit("team.")).map((row) => [row.action, row.targetUserId ?? row.projectId, row.before, row.after]).toSorted(byJson))
      .toEqual([
        ["team.created", undefined, undefined, undefined],
        ["team.member.added", id(alice), null, "owner"],
        ["team.member.added", id(bob), null, "member"],
        ["team.member.added", id(carol), null, "member"],
        ["team.project.granted", projectId, null, "editor"],
      ].toSorted(byJson))

    await authority.removeTeamMember!(alice, { teamId, userPublicId: id(bob) })
    await authority.addTeamMember!(alice, { teamId, userPublicId: id(carol), role: "admin" })
    await authority.grantTeamProject!(alice, { teamId, projectId, role: "viewer" })
    const before = (await audit("team.")).length
    await authority.ensureDefaultTeam!(alice, { orgId: "org_acme" })

    const members = (await authority.listTeamMembers!(alice, { teamId })) as Array<{ user_id: string; role: string }>
    expect(members.map((row) => [row.user_id, row.role]).toSorted(byJson)).toEqual([[id(alice), "owner"], [id(carol), "admin"]].toSorted(byJson))
    expect(await authority.listTeamProjects!(alice, { teamId })).toEqual([expect.objectContaining({ role: "viewer" })])
    expect(await audit("team.")).toHaveLength(before)
  })

  test("the founding owner's membership is audited when the organization is created", async () => {
    const { alice, outsider, audit } = await setup()
    expect(await audit("org.member.added")).toEqual([
      { action: "org.member.added", actor: id(alice), orgId: "org_acme", targetUserId: id(alice), before: null, after: "owner" },
      { action: "org.member.added", actor: id(outsider), orgId: "org_other", targetUserId: id(outsider), before: null, after: "owner" },
    ])
  })

  test("audit retention evicts deny rows and never an access change, however many deny rows a caller provokes", async () => {
    const { database, alice, audit } = await setup()
    const retained = new D1AuditAuthority(database, { deploymentId: "deployment-a", retentionLimit: 3 })
    const denied = async () => (await database
      .prepare("select count(*) as n from authority_audit_events where result = 'deny'")
      .first<{ n: number }>())?.n

    for (let attempt = 0; attempt < 5; attempt++) {
      await retained.auditDeny(alice, { action: "workspaces.open.denied", reason: "denied", workspaceId: "ws_private" })
    }

    expect(await denied()).toBe(3)
    expect(await audit("org.member.added")).toEqual(expect.arrayContaining([
      expect.objectContaining({ orgId: "org_acme", targetUserId: id(alice), after: "owner" }),
    ]))
  })

  test("a change that finds the role already in place changes nothing and writes no audit row", async () => {
    const { authority, alice, bob, projectId, audit } = await setup()
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    const team = (await authority.createTeamInOrg!(alice, { orgId: "org_acme", name: "Eng" })) as { team_id: string }
    await authority.addTeamMember!(alice, { teamId: team.team_id, userPublicId: id(bob) })
    await authority.grantTeamProject!(alice, { teamId: team.team_id, projectId, role: "editor" })
    await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "editor" })
    const before = await audit("")

    expect(await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" }))
      .toMatchObject({ role: "member" })
    expect(await authority.updateOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" }))
      .toMatchObject({ role: "member" })
    expect(await authority.addTeamMember!(alice, { teamId: team.team_id, userPublicId: id(bob), role: "member" }))
      .toMatchObject({ role: "member" })
    expect(await authority.grantTeamProject!(alice, { teamId: team.team_id, projectId, role: "editor" }))
      .toMatchObject({ role: "editor" })
    expect(await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "editor" }))
      .toMatchObject({ role: "editor" })

    expect(await audit("")).toEqual(before)
  })

  test("a role change racing a removal does not reinstate the member", async () => {
    const { authority, database, alice, bob } = await setup()
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    const context = new D1WorkspaceAuthority(
      racing(database, (target) => target.prepare("update org_memberships set revoked_at = 1 where user_id = ?").bind(id(bob)).run()),
      { deploymentId: "deployment-a", product: { kind: "claxedo-hosted" } },
    ).accessContext()

    await expect(new D1OrgMemberAuthority(context).updateOrgMember(alice, { orgId: "org_acme", userPublicId: id(bob), role: "admin" }))
      .rejects.toMatchObject({ code: "resource_conflict" })
    expect((await authority.listOrgMembers!(alice, { orgId: "org_acme" })).map((row) => row.user_id)).toEqual([id(alice)])
  })

  test("a removal that finds the member already gone writes no allow row", async () => {
    const { authority, database, alice, bob, audit } = await setup()
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    const context = new D1WorkspaceAuthority(
      racing(database, (target) => target.prepare("update org_memberships set revoked_at = 1 where user_id = ?").bind(id(bob)).run()),
      { deploymentId: "deployment-a", product: { kind: "claxedo-hosted" } },
    ).accessContext()

    await expect(new D1OrgMemberAuthority(context).removeOrgMember(alice, { orgId: "org_acme", userPublicId: id(bob) }))
      .rejects.toMatchObject({ code: "resource_conflict" })
    expect(await audit("org.member.removed")).toEqual([])
  })

  test("removal, an org downgrade and each grant revocation revoke the runtime tokens they minted, so re-admission does not revive them", async () => {
    const { authority, alice, bob, projectId } = await setup()
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "editor" })

    const memberToken = await token(authority, bob, "jti_member", "editor")
    await authority.revokeProjectMember!(alice, { projectId, userPublicId: id(bob) })
    await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "editor" })
    expect(await memberToken()).toBe(false)

    const team = (await authority.createTeamInOrg!(alice, { orgId: "org_acme", name: "Eng" })) as { team_id: string }
    await authority.addTeamMember!(alice, { teamId: team.team_id, userPublicId: id(bob) })
    await authority.grantTeamProject!(alice, { teamId: team.team_id, projectId, role: "admin" })
    const teamToken = await token(authority, bob, "jti_team", "admin")
    await authority.revokeTeamProject!(alice, { teamId: team.team_id, projectId })
    await authority.grantTeamProject!(alice, { teamId: team.team_id, projectId, role: "admin" })
    expect(await teamToken()).toBe(false)

    const teamMemberToken = await token(authority, bob, "jti_team_member", "admin")
    await authority.removeTeamMember!(alice, { teamId: team.team_id, userPublicId: id(bob) })
    await authority.addTeamMember!(alice, { teamId: team.team_id, userPublicId: id(bob) })
    expect(await teamMemberToken()).toBe(false)

    await authority.updateOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "admin" })
    const adminToken = await token(authority, bob, "jti_admin", "admin")
    await authority.updateOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    await authority.updateOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "admin" })
    expect(await adminToken()).toBe(false)

    const removedToken = await token(authority, bob, "jti_removed", "editor")
    expect(await removedToken()).toBe(true)
    expect(await authority.removeOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob) }))
      .toMatchObject({ removed: true, runtime_tokens_revoked: 1 })
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "admin" })
    expect(await removedToken()).toBe(false)
  })

  test("removal revokes the person's direct session shares and participations in the organization, audited, so re-admission restores no consent", async () => {
    const { authority, database, alice, bob, projectId, audit } = await setup()
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "editor" })
    await authority.createWorkspace(alice, { workspaceId: "ws_cloud", orgId: "org_acme", displayName: "cloud", backing: "cloud-vm" })
    await authority.reserveSession(alice, { operationId: "op_1", sessionId: "ses_1", workspaceId: "ws_cloud", kind: "create", title: "private" })
    await authority.registerRuntimeSession({
      createdAt: Date.now(),
      updatedAt: Date.now(),
      principalKind: "user",
      actorId: alice.principal!.actorId,
      actorKind: "human",
      operationId: "op_1",
      sessionId: "ses_1",
      workspaceId: "ws_cloud",
      title: "private",
    })
    await authority.grantSessionShare!(alice, { sessionId: "ses_1", workspaceId: "ws_cloud", grantedToUserId: id(bob) })
    await authority.grantSessionParticipant(alice, { sessionId: "ses_1", workspaceId: "ws_cloud", participantActorId: bob.principal!.actorId })

    expect(await authority.removeOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob) }))
      .toMatchObject({ removed: true, session_shares_revoked: 1, session_participations_revoked: 1 })
    await authority.addOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })

    expect(await database.prepare("select count(*) as n from session_share_grants where target_user_id = ? and revoked_at is null")
      .bind(id(bob)).first<{ n: number }>()).toEqual({ n: 0 })
    expect(await database.prepare("select count(*) as n from session_participants where actor_id = ? and revoked_at is null")
      .bind(bob.principal!.actorId).first<{ n: number }>()).toEqual({ n: 0 })
    expect(await audit("org.member.removed")).toEqual([expect.objectContaining({
      targetUserId: id(bob),
      sessionSharesRevoked: 1,
      sessionParticipationsRevoked: 1,
    })])
  })
})

describe("D1 user-deployed identity admission", () => {
  test("admits through the organization member rules: an admin cannot demote an owner or the founder, and each admission is audited", async () => {
    const controlPlane = await miniflareControlPlaneDatabase(controlPlaneMigrations())
    active.push(controlPlane)
    const identity = (subject: string): AuthIdentity => ({ adapter: "better-auth", issuer: "https://auth.example.test", subject })
    const authority = composeBetterAuthD1Authority({
      env: {
        CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
        CLAXEDO_PRODUCT_POSTURE: "user-deployed",
        CLAXEDO_DEPLOYMENT_ID: "deployment-a",
        CONTROL_PLANE_DB: controlPlane.database,
      },
      product: { kind: "user-deployed", organization: { id: "org_deploy", name: "Deploy" }, ownerIdentity: identity("alice") },
    })
    const alice = await signed(authority, "alice")
    await authority.admitUserDeployedIdentity(alice, { identity: identity("bob"), role: "admin" })
    const bob = await signed(authority, "bob")
    const carolAdmission = await authority.admitUserDeployedIdentity(alice, { identity: identity("carol"), role: "member" })
    const carolId = (carolAdmission as { userId: string }).userId
    await authority.updateOrgMember!(alice, { orgId: "org_deploy", userPublicId: carolId, role: "owner" })

    await expect(authority.admitUserDeployedIdentity(bob, { identity: identity("carol"), role: "member" }))
      .rejects.toMatchObject({ code: "org_owner_required" })
    await expect(authority.admitUserDeployedIdentity(bob, { identity: identity("alice"), role: "admin" }))
      .rejects.toMatchObject({ code: "org_owner_protected" })
    expect((await authority.listOrgMembers!(alice, { orgId: "org_deploy" })).map((row) => [row.user_id, row.role]).toSorted(byJson))
      .toEqual([[id(alice), "owner"], [id(bob), "admin"], [carolId, "owner"]].toSorted(byJson))
    const admitted = (await controlPlane.database
      .prepare("select metadata_json from authority_audit_events where action = 'org.member.added' order by rowid")
      .all<{ metadata_json: string }>()).results.map((row) => JSON.parse(row.metadata_json).targetUserId)
    expect(admitted).toEqual([id(bob), carolId])
  })
})
