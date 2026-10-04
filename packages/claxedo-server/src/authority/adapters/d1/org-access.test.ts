import { inviteOrgMember } from "../../../test-support/invite-org-member"
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
  miniflareControlPlaneDatabase,
  type ControlPlaneDatabase,
} from "../../../test-support/control-plane-migrations"

const active: ControlPlaneDatabase[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((database) => database.dispose()))
})

async function setup() {
  const controlPlane = await miniflareControlPlaneDatabase()
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
  test("an invitation joins a member, an admin changes their role and lists them; each change is audited", async () => {
    const { authority, alice, bob, audit, database } = await setup()

    expect(await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" }))
      .toMatchObject({ user_id: id(bob), role: "member" })
    expect(await authority.updateOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "admin" }))
      .toMatchObject({ user_id: id(bob), role: "admin" })

    const members = await authority.listOrgMembers!(alice, { orgId: "org_acme" })
    expect(members.map(({ user_id, role }) => ({ user_id, role }))).toEqual([
      { user_id: id(alice), role: "owner" },
      { user_id: id(bob), role: "admin" },
    ])
    expect(members.every((member) => typeof member.joined_at === "number")).toBe(true)
    expect((await audit("org.member.")).filter((row) => row.orgId === "org_acme" && row.targetUserId === id(bob))).toEqual([
      { action: "org.member.added", actor: id(bob), orgId: "org_acme", targetUserId: id(bob), before: null, after: "member", invitationId: expect.stringMatching(/^inv_/), inviterUserId: id(alice) },
      { action: "org.member.role_changed", actor: id(alice), orgId: "org_acme", targetUserId: id(bob), before: "member", after: "admin" },
    ])
  })

  test("only owners and admins change membership, and only an owner moves the owner role", async () => {
    const { authority, alice, bob, carol, outsider, audit, database } = await setup()
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })

    await expect(inviteOrgMember(database, bob, { orgId: "org_acme", userPublicId: id(carol), role: "member" }))
      .rejects.toMatchObject({ code: "org_admin_required" })
    await expect(inviteOrgMember(database, outsider, { orgId: "org_acme", userPublicId: id(carol), role: "member" }))
      .rejects.toMatchObject({ code: "org_admin_required" })

    await authority.updateOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob), role: "admin" })
    await inviteOrgMember(database, bob, { orgId: "org_acme", userPublicId: id(carol), role: "member" })
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
    const { authority, alice, carol, database } = await setup()

    await expect(authority.updateOrgMember!(alice, { orgId: "org_acme", userPublicId: id(alice), role: "admin" }))
      .rejects.toMatchObject({ code: "org_owner_protected" })
    await expect(authority.removeOrgMember!(alice, { orgId: "org_acme", userPublicId: id(alice) }))
      .rejects.toMatchObject({ code: "org_owner_protected" })

    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(carol), role: "owner" })
    await expect(authority.updateOrgMember!(carol, { orgId: "org_acme", userPublicId: id(alice), role: "member" }))
      .rejects.toMatchObject({ code: "org_owner_protected" })
    expect(await authority.updateOrgMember!(alice, { orgId: "org_acme", userPublicId: id(carol), role: "admin" }))
      .toMatchObject({ role: "admin" })
    expect((await authority.listOrgMembers!(alice, { orgId: "org_acme" })).filter((row) => row.role === "owner"))
      .toEqual([expect.objectContaining({ user_id: id(alice) })])
  })

  test("removing a member revokes their teams and grants in one batch, and their next request is refused", async () => {
    const { authority, database, alice, bob, projectId, audit } = await setup()
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    const team = (await authority.createTeamInOrg!(alice, { orgId: "org_acme", name: "Eng" })) as { team_id: string }
    await authority.addTeamMember!(alice, { teamId: team.team_id, userPublicId: id(bob) })
    await authority.grantTeamProject!(alice, { teamId: team.team_id, projectId, role: "editor" })
    await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "admin" })
    expect(await authority.projectRole(bob, { projectId: projectId as never })).toMatchObject({ role: "admin" })

    expect(await authority.removeOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob) })).toEqual({
      removed: true,
      team_memberships_revoked: 1,
      project_memberships_revoked: 1,
      session_shares_revoked: 0,
      runtime_tokens_revoked: 0,
    })

    expect(await authority.projectRole(bob, { projectId: projectId as never })).toEqual({ ok: false })
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
      },
    ])
    expect(await authority.removeOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob) })).toMatchObject({ removed: false })

    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    expect(await authority.projectRole(bob, { projectId: projectId as never })).toMatchObject({ ok: true, role: "viewer" })
  })
})

describe("D1 per-member project grants", () => {
  test("grant, re-grant with a role change, revoke and re-grant, each audited with the role before and after", async () => {
    const { authority, alice, bob, projectId, audit, database } = await setup()
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    const role = async () => await authority.projectRole(bob, { projectId: projectId as never })
    expect(await role()).toMatchObject({ role: "viewer" })

    expect(await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "editor" }))
      .toEqual({ project_id: projectId, user_id: id(bob), role: "editor" })
    expect(await role()).toMatchObject({ role: "editor" })
    await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "admin" })
    expect(await role()).toMatchObject({ role: "admin" })

    expect(await authority.revokeProjectMember!(alice, { projectId, userPublicId: id(bob) })).toEqual({ revoked: true })
    expect(await authority.revokeProjectMember!(alice, { projectId, userPublicId: id(bob) })).toEqual({ revoked: false })
    expect(await role()).toMatchObject({ role: "viewer" })
    await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "editor" })
    expect(await role()).toMatchObject({ role: "editor" })

    const change = { actor: id(alice), orgId: "org_acme", projectId, targetUserId: id(bob) }
    expect(await audit("project.member.")).toEqual([
      { action: "project.member.granted", ...change, before: null, after: "editor" },
      { action: "project.member.granted", ...change, before: "editor", after: "admin" },
      { action: "project.member.revoked", ...change, before: "admin", after: null },
      { action: "project.member.granted", ...change, before: null, after: "editor" },
    ])
  })

  test("the owner row never changes, a grantee outside the organization is refused, and only project admins grant", async () => {
    const { authority, alice, bob, carol, outsider, projectId, audit, database } = await setup()
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(carol), role: "member" })

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
  test("a team grant is listed, changes role and is revoked, and its members' project role follows it", async () => {
    const { authority, alice, bob, projectId, audit, database } = await setup()
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    const team = (await authority.createTeamInOrg!(alice, { orgId: "org_acme", name: "Eng" })) as { team_id: string }
    await authority.addTeamMember!(alice, { teamId: team.team_id, userPublicId: id(bob) })
    const role = async () => await authority.projectRole(bob, { projectId: projectId as never })

    await authority.grantTeamProject!(alice, { teamId: team.team_id, projectId, role: "admin" })
    expect(await authority.listTeamProjects!(alice, { teamId: team.team_id }))
      .toEqual([expect.objectContaining({ team_id: team.team_id, project_id: projectId, role: "admin" })])
    expect(await authority.listTeamProjects!(bob, { teamId: team.team_id })).toHaveLength(1)
    expect(await role()).toMatchObject({ role: "admin" })

    await authority.grantTeamProject!(alice, { teamId: team.team_id, projectId, role: "editor" })
    expect(await role()).toMatchObject({ role: "editor" })
    expect(await authority.revokeTeamProject!(alice, { teamId: team.team_id, projectId })).toEqual({ revoked: true })
    expect(await authority.listTeamProjects!(alice, { teamId: team.team_id })).toEqual([])
    expect(await role()).toMatchObject({ role: "viewer" })

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
    const { authority, alice, bob, outsider, projectId, database } = await setup()
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    const acmeTeam = (await authority.createTeamInOrg!(alice, { orgId: "org_acme", name: "Eng" })) as { team_id: string }
    const otherTeam = (await authority.createTeamInOrg!(outsider, { orgId: "org_other", name: "Ops" })) as { team_id: string }

    await expect(authority.grantTeamProject!(outsider, { teamId: otherTeam.team_id, projectId, role: "editor" }))
      .rejects.toMatchObject({ code: "project_not_found" })
    await expect(authority.grantTeamProject!(alice, { teamId: otherTeam.team_id, projectId, role: "editor" }))
      .rejects.toMatchObject({ code: "team_not_found" })
    await expect(authority.addTeamMember!(alice, { teamId: acmeTeam.team_id, userPublicId: id(outsider) }))
      .rejects.toMatchObject({ code: "team_member_org_membership_required" })
    await expect(authority.addTeamMember!(alice, { teamId: acmeTeam.team_id, providerSubject: "no-such-account" }))
      .rejects.toMatchObject({ code: "team_member_org_membership_required" })
    await expect(authority.grantTeamProject!(bob, { teamId: acmeTeam.team_id, projectId, role: "editor" }))
      .rejects.toMatchObject({ code: "team_not_found" })
    await expect(authority.revokeTeamProject!(bob, { teamId: acmeTeam.team_id, projectId }))
      .rejects.toMatchObject({ code: "team_not_found" })
    expect(await authority.listTeamProjects!(outsider, { teamId: acmeTeam.team_id })).toEqual([])
  })
})

describe("D1 organization and team lookups", () => {
  test("an organization or team the caller cannot administer answers exactly as one that does not exist", async () => {
    const { authority, alice, bob, outsider, projectId, database } = await setup()
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    const acmeTeam = (await authority.createTeamInOrg!(alice, { orgId: "org_acme", name: "Eng" })) as { team_id: string }
    const refusal = async (attempt: Promise<unknown>) => {
      const error = await attempt.then(() => undefined, (cause: unknown) => cause as { code?: string; status?: number })
      return { code: error?.code, status: error?.status }
    }

    expect(await refusal(authority.createTeamInOrg!(bob, { orgId: "org_other", name: "X" })))
      .toEqual(await refusal(authority.createTeamInOrg!(bob, { orgId: "org_missing", name: "X" })))
    for (const who of [bob, outsider]) {
      const missingOrg = await refusal(authority.createTeamInOrg!(who, { orgId: "org_missing", name: "X" }))
      expect(await refusal(authority.createTeamInOrg!(who, { orgId: "org_acme", name: "X" }))).toEqual(missingOrg)
      expect(await refusal(authority.ensureDefaultTeam!(who, { orgId: "org_acme" })))
        .toEqual(await refusal(authority.ensureDefaultTeam!(who, { orgId: "org_missing" })))
      for (const change of [
        (teamId: string) => authority.addTeamMember!(who, { teamId, userPublicId: id(bob) }),
        (teamId: string) => authority.removeTeamMember!(who, { teamId, userPublicId: id(bob) }),
        (teamId: string) => authority.grantTeamProject!(who, { teamId, projectId, role: "editor" }),
        (teamId: string) => authority.revokeTeamProject!(who, { teamId, projectId }),
      ]) {
        expect(await refusal(change(acmeTeam.team_id))).toEqual(await refusal(change("team_missing")))
      }
    }
  })
})

describe("D1 grants on another person's workspace", () => {
  test("no org role, project grant or team grant reaches another person's workspace, and the grants still show on the project", async () => {
    const { authority, alice, bob, carol, person, projectId, database } = await setup()
    const dave = await person("dave")
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(carol), role: "member" })
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(dave), role: "admin" })
    await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "admin" })
    const team = (await authority.createTeamInOrg!(alice, { orgId: "org_acme", name: "Eng" })) as { team_id: string }
    await authority.addTeamMember!(alice, { teamId: team.team_id, userPublicId: id(carol) })
    await authority.grantTeamProject!(alice, { teamId: team.team_id, projectId, role: "admin" })
    const listed = async (auth: SignedControlPlaneAuth) =>
      (await authority.listWorkspaces(auth) as Array<{ workspace_id: string }>).map((row) => row.workspace_id)

    for (const other of [bob, carol, dave]) {
      for (const workspaceId of ["ws_acme", "ws_private"]) {
        await expect(authority.openWorkspace(other, { workspaceId })).rejects.toMatchObject({ status: 403 })
        await expect(authority.resolveRuntimeMachineAccess(other.principal!.actorId, workspaceId))
          .rejects.toMatchObject({ status: 403 })
        await expect(token(authority, other, `jti_${id(other)}_${workspaceId}`, "viewer", workspaceId))
          .rejects.toMatchObject({ status: 403 })
      }
      expect(await listed(other)).not.toContain("ws_acme")
      expect(await listed(other)).not.toContain("ws_private")
    }
    expect(await authority.openWorkspace(alice, { workspaceId: "ws_private" })).toMatchObject({ role: "owner" })
    expect((await authority.listProjectAccess!(alice, { projectId })).entries).toEqual(expect.arrayContaining([
      { kind: "user", user_id: id(bob), role: "admin", source: "member" },
      { kind: "team", team_id: team.team_id, name: "Eng", role: "admin", source: `team:${team.team_id}` },
    ]))
    expect(await authority.projectRole(bob, { projectId: projectId as never })).toMatchObject({ role: "admin" })
    expect(await authority.projectRole(carol, { projectId: projectId as never })).toMatchObject({ role: "admin" })
  })

  test("creating a project makes its creator the owner of no one else's workspace in it", async () => {
    const { authority, alice, carol, database } = await setup()
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(carol), role: "admin" })
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
    })

    expect(await authority.projectRole(carol, { projectId: tools.project_id as never })).toMatchObject({ role: "owner" })
    expect(await authority.openWorkspace(carol, { workspaceId: "ws_tools" })).toMatchObject({ role: "owner" })
    await expect(authority.openWorkspace(carol, { workspaceId: "ws_alice_tools" })).rejects.toMatchObject({ status: 403 })
  })
})

describe("D1 project access listing", () => {
  test("lists the owner, each member grant, each team grant and each organization role, to project and org admins only", async () => {
    const { authority, alice, bob, carol, outsider, projectId, database } = await setup()
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(carol), role: "admin" })
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
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(bob), role: "admin" })
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(carol), role: "member" })
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
    const { authority, alice, bob, carol, projectId, audit, database } = await setup()
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(carol), role: "member" })

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

  test("every founding owner's membership, of a personal or a created organization, is audited once and attributed to the founder", async () => {
    const { database, alice, bob, carol, outsider, audit, person } = await setup()
    await person("alice")
    const personal = async (auth: SignedControlPlaneAuth) => (await database
      .prepare("select org_id from orgs where kind = 'personal' and owner_user_id = ?")
      .bind(id(auth))
      .first<{ org_id: string }>())!.org_id
    const founded = (auth: SignedControlPlaneAuth, orgId: string) =>
      ({ action: "org.member.added", actor: id(auth), orgId, targetUserId: id(auth), before: null, after: "owner" })

    expect((await audit("org.member.added")).toSorted(byJson)).toEqual([
      founded(alice, await personal(alice)),
      founded(bob, await personal(bob)),
      founded(carol, await personal(carol)),
      founded(outsider, await personal(outsider)),
      founded(alice, "org_acme"),
      founded(outsider, "org_other"),
    ].toSorted(byJson))
    expect(await database
      .prepare("select count(*) as n from authority_audit_events where action = 'org.member.added' and actor_id is null")
      .first<{ n: number }>()).toEqual({ n: 0 })
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
    const { authority, alice, bob, projectId, audit, database } = await setup()
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    const team = (await authority.createTeamInOrg!(alice, { orgId: "org_acme", name: "Eng" })) as { team_id: string }
    await authority.addTeamMember!(alice, { teamId: team.team_id, userPublicId: id(bob) })
    await authority.grantTeamProject!(alice, { teamId: team.team_id, projectId, role: "editor" })
    await authority.grantProjectMember!(alice, { projectId, userPublicId: id(bob), role: "editor" })
    const before = await audit("")

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
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    const context = new D1WorkspaceAuthority(
      racing(database, (target) => target.prepare("update org_memberships set revoked_at = 1 where user_id = ?").bind(id(bob)).run()),
      { deploymentId: "deployment-a", product: { kind: "claxedo-hosted" } },
    ).accessContext()

    await expect(new D1OrgMemberAuthority(context).updateOrgMember(alice, { orgId: "org_acme", userPublicId: id(bob), role: "admin" }))
      .rejects.toMatchObject({ code: "resource_conflict" })
    expect((await authority.listOrgMembers!(alice, { orgId: "org_acme" })).map((row) => row.user_id)).toEqual([id(alice)])
  })

  test("a removal that finds the member already gone writes no allow row", async () => {
    const { database, alice, bob, audit } = await setup()
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })
    const context = new D1WorkspaceAuthority(
      racing(database, (target) => target.prepare("update org_memberships set revoked_at = 1 where user_id = ?").bind(id(bob)).run()),
      { deploymentId: "deployment-a", product: { kind: "claxedo-hosted" } },
    ).accessContext()

    await expect(new D1OrgMemberAuthority(context).removeOrgMember(alice, { orgId: "org_acme", userPublicId: id(bob) }))
      .rejects.toMatchObject({ code: "resource_conflict" })
    expect(await audit("org.member.removed")).toEqual([])
  })

  test("removing a workspace owner from the org takes their rank on their own workspace, and re-admitting them does not revive the token they held", async () => {
    const { authority, alice, carol, database } = await setup()
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(carol), role: "admin" })
    await authority.createWorkspace(carol, {
      workspaceId: "ws_carol",
      orgId: "org_acme",
      displayName: "carol",
      backing: "cloud-vm",
      repoUrl: "https://github.com/acme/app",
    })
    const held = await token(authority, carol, "jti_carol_removed", "editor", "ws_carol")

    expect(await authority.removeOrgMember!(alice, { orgId: "org_acme", userPublicId: id(carol) }))
      .toMatchObject({ removed: true, runtime_tokens_revoked: 1 })
    await expect(authority.openWorkspace(carol, { workspaceId: "ws_carol" })).rejects.toMatchObject({ status: 403 })
    await expect(authority.resolveRuntimeMachineAccess(carol.principal!.actorId, "ws_carol"))
      .rejects.toMatchObject({ status: 403 })

    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(carol), role: "member" })
    expect(await authority.openWorkspace(carol, { workspaceId: "ws_carol" })).toMatchObject({ role: "owner" })
    expect(await held()).toBe(false)
  })

  test("lowering or revoking a grant, leaving a team or a demotion leaves the workspace owner's own runtime tokens active", async () => {
    const { authority, alice, carol, projectId, database } = await setup()
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(carol), role: "admin" })
    await authority.createWorkspace(carol, {
      workspaceId: "ws_carol",
      orgId: "org_acme",
      displayName: "carol",
      backing: "cloud-vm",
      repoUrl: "https://github.com/acme/app",
    })
    await authority.grantProjectMember!(alice, { projectId, userPublicId: id(carol), role: "admin" })
    const team = (await authority.createTeamInOrg!(alice, { orgId: "org_acme", name: "Eng" })) as { team_id: string }
    await authority.addTeamMember!(alice, { teamId: team.team_id, userPublicId: id(carol) })
    await authority.grantTeamProject!(alice, { teamId: team.team_id, projectId, role: "admin" })
    const own = await token(authority, carol, "jti_carol_own", "admin", "ws_carol")

    await authority.grantProjectMember!(alice, { projectId, userPublicId: id(carol), role: "viewer" })
    await authority.revokeProjectMember!(alice, { projectId, userPublicId: id(carol) })
    await authority.grantTeamProject!(alice, { teamId: team.team_id, projectId, role: "viewer" })
    await authority.revokeTeamProject!(alice, { teamId: team.team_id, projectId })
    await authority.grantTeamProject!(alice, { teamId: team.team_id, projectId, role: "editor" })
    await authority.removeTeamMember!(alice, { teamId: team.team_id, userPublicId: id(carol) })
    await authority.updateOrgMember!(alice, { orgId: "org_acme", userPublicId: id(carol), role: "member" })

    expect(await own()).toBe(true)
  })

  test("removal revokes the person's direct session shares and participations in the organization, audited, so re-admission restores no consent", async () => {
    const { authority, database, alice, bob, audit } = await setup()
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(bob), role: "admin" })
    const register = async (who: SignedControlPlaneAuth, workspaceId: string, sessionId: string) => {
      await authority.createWorkspace(who, { workspaceId, orgId: "org_acme", displayName: workspaceId, backing: "cloud-vm" })
      await authority.reserveSession(who, { operationId: `op_${sessionId}`, sessionId, workspaceId, kind: "create" })
      await authority.registerRuntimeSession({
        createdAt: Date.now(),
        updatedAt: Date.now(),
        principalKind: "user",
        actorId: who.principal!.actorId,
        actorKind: "human",
        operationId: `op_${sessionId}`,
        sessionId,
        workspaceId,
      })
    }
    await register(alice, "ws_cloud", "ses_1")
    await register(bob, "ws_bob", "ses_bob")
    await authority.grantSessionShare!(alice, { sessionId: "ses_1", workspaceId: "ws_cloud", grantedToUserId: id(bob) })

    expect(await authority.removeOrgMember!(alice, { orgId: "org_acme", userPublicId: id(bob) }))
      .toMatchObject({ removed: true, session_shares_revoked: 1 })
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(bob), role: "member" })

    expect(await database.prepare("select count(*) as n from session_share_grants where target_user_id = ? and revoked_at is null")
      .bind(id(bob)).first<{ n: number }>()).toEqual({ n: 0 })
    expect(await audit("org.member.removed")).toEqual([expect.objectContaining({
      targetUserId: id(bob),
      sessionSharesRevoked: 1,
    })])
  })
})

describe("D1 user-deployed invitation membership", () => {
  test("a stranger stays out; a pending invitation to their verified email admits them, and only the accept makes them a member", async () => {
    const controlPlane = await miniflareControlPlaneDatabase()
    active.push(controlPlane)
    const identity = (subject: string): AuthIdentity => ({ adapter: "better-auth", issuer: "https://auth.example.test", subject })
    const tokens: string[] = []
    const authority = composeBetterAuthD1Authority({
      env: { CLAXEDO_ADAPTER_PROFILE: "better-auth-d1", CLAXEDO_PRODUCT_POSTURE: "user-deployed", CLAXEDO_DEPLOYMENT_ID: "deployment-a", CONTROL_PLANE_DB: controlPlane.database },
      product: { kind: "user-deployed", organization: { id: "org_deploy", name: "Deploy" }, ownerIdentity: identity("alice") },
      invitations: {
        sendInvitation: async ({ token }) => { tokens.push(token) },
        verifiedEmail: async (auth) => `${auth.principal!.identity.subject}@example.test`,
      },
    })
    const alice = await signed(authority, "alice")
    expect(await authority.ensureApplicationIdentity(identity("bob"))).toMatchObject({ state: "provisioning" })
    expect(await authority.admitInvitedIdentity(identity("bob"), "bob@example.test")).toMatchObject({ state: "unavailable" })

    await authority.createOrgInvitation!(alice, { orgId: "org_deploy", email: "bob@example.test", role: "admin" })
    expect(await authority.admitInvitedIdentity(identity("mallory"), "mallory@example.test")).toMatchObject({ state: "unavailable" })
    expect(await authority.admitInvitedIdentity(identity("bob"), " Bob@Example.test ")).toMatchObject({ state: "active" })
    const bob = await signed(authority, "bob")
    expect(await authority.listOrgs(bob)).toEqual([])

    await authority.acceptOrgInvitation!(bob, { token: tokens[0] })
    expect(await authority.listOrgMembers!(alice, { orgId: "org_deploy" }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ user_id: id(bob), role: "admin" })]))
    expect(await authority.admitInvitedIdentity(identity("carol"), "bob@example.test")).toMatchObject({ state: "unavailable" })
  })
})
