import { afterEach, describe, expect, test } from "vitest"
import { hostedCoreD1App } from "../../test-support/hosted-core-d1-app"

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()))
})

const hosted = () => hostedCoreD1App(disposers)

describe("hosted organization, team and project access routes on D1", () => {
  test("a team grant and a member grant show on the project's access listing and never open the owner's workspace", async () => {
    const { authority, person, call, join } = await hosted()
    const alice = await person("alice")
    const bob = await person("bob")

    const org = await call(alice.token, "POST", "/api/control/orgs", { name: "Acme" })
    expect(org.status).toBe(200)
    const orgId = (org.body as { org_id: string }).org_id
    const { project_id: projectId } = await authority.createWorkspace(alice.auth, {
      workspaceId: "ws_acme",
      orgId,
      displayName: "acme",
      backing: "local-worktree",
    })
    const opens = async () => (await call(bob.token, "GET", "/api/claxedo/agent-config/harness?workspaceId=ws_acme")).status
    const listed = async () =>
      ((await call(bob.token, "GET", "/api/workspace?host=machine")).body as { workspaces: Array<{ workspace_id: string }> })
        .workspaces.map((row) => row.workspace_id)
    const access = async () =>
      ((await call(alice.token, "GET", `/api/control/projects/${projectId}/access`)).body as { entries: unknown[] }).entries

    expect((await join(alice.token, orgId, bob)).body)
      .toMatchObject({ user_id: bob.userId, role: "member" })
    expect((await call(alice.token, "GET", `/api/control/orgs/${orgId}/members`)).body)
      .toEqual([
        expect.objectContaining({ user_id: alice.userId, role: "owner", joined_at: expect.any(Number) }),
        expect.objectContaining({ user_id: bob.userId, role: "member", joined_at: expect.any(Number) }),
      ])
    const team = (await call(alice.token, "POST", `/api/control/orgs/${orgId}/teams`, { name: "Eng" })).body as { team_id: string }
    expect((await call(alice.token, "POST", `/api/control/teams/${team.team_id}/members`, { userPublicId: bob.userId })).status).toBe(200)

    expect((await call(alice.token, "POST", `/api/control/teams/${team.team_id}/projects`, { projectId, role: "editor" })).status).toBe(200)
    expect((await call(bob.token, "GET", `/api/control/teams/${team.team_id}/projects`)).body)
      .toEqual([expect.objectContaining({ project_id: projectId, role: "editor" })])
    expect(await access()).toEqual(expect.arrayContaining([
      { kind: "team", team_id: team.team_id, name: "Eng", role: "editor", source: `team:${team.team_id}` },
    ]))
    expect(await opens()).toBe(404)
    expect(await listed()).toEqual([])

    expect((await call(alice.token, "DELETE", `/api/control/teams/${team.team_id}/projects`, { projectId })).body).toEqual({ revoked: true })
    expect((await call(bob.token, "POST", `/api/control/projects/${projectId}/members`, { userPublicId: bob.userId, role: "admin" })))
      .toMatchObject({ status: 403, body: { error: { code: "project_admin_required" } } })
    expect((await call(alice.token, "POST", `/api/control/projects/${projectId}/members`, { userPublicId: bob.userId, role: "editor" })).body)
      .toEqual({ project_id: projectId, user_id: bob.userId, role: "editor" })
    expect(await access()).toEqual(expect.arrayContaining([
      { kind: "user", user_id: alice.userId, role: "owner", source: "owner" },
      { kind: "user", user_id: bob.userId, role: "editor", source: "member" },
      { kind: "user", user_id: bob.userId, role: "viewer", source: "org-role" },
    ]))
    expect(await opens()).toBe(404)
    expect(await listed()).toEqual([])
    expect((await call(bob.token, "GET", `/api/control/projects/${projectId}/access`)))
      .toMatchObject({ status: 403, body: { error: { code: "project_admin_required" } } })

    expect((await call(alice.token, "DELETE", `/api/control/projects/${projectId}/members/${bob.userId}`)).body).toEqual({ revoked: true })
    expect((await access()).filter((entry) => (entry as { source: string }).source === "member")).toEqual([])
  })

  test("membership routes change roles, protect the founding owner, and a removed member is refused on the next request", async () => {
    const { authority, person, call, join } = await hosted()
    const alice = await person("alice")
    const bob = await person("bob")
    const orgId = ((await call(alice.token, "POST", "/api/control/orgs", { name: "Acme" })).body as { org_id: string }).org_id
    const { project_id: projectId } = await authority.createWorkspace(alice.auth, {
      workspaceId: "ws_acme",
      orgId,
      displayName: "acme",
      backing: "local-worktree",
    })
    await join(alice.token, orgId, bob)

    expect((await call(alice.token, "PATCH", `/api/control/orgs/${orgId}/members/${bob.userId}`, { role: "admin" })).body)
      .toMatchObject({ user_id: bob.userId, role: "admin" })
    expect(await call(bob.token, "PATCH", `/api/control/orgs/${orgId}/members/${alice.userId}`, { role: "member" }))
      .toMatchObject({ status: 409, body: { error: { code: "org_owner_protected" } } })
    expect(await call(bob.token, "DELETE", `/api/control/orgs/${orgId}/members/${alice.userId}`))
      .toMatchObject({ status: 409, body: { error: { code: "org_owner_protected" } } })
    expect(await call(alice.token, "POST", `/api/control/orgs/${orgId}/invitations`, { email: "bob@example.test", role: "boss" }))
      .toMatchObject({ status: 400, body: { error: { code: "invalid_input" } } })
    expect(await call(bob.token, "GET", `/api/control/projects/${projectId}/access`)).toMatchObject({ status: 200 })

    expect((await call(alice.token, "DELETE", `/api/control/orgs/${orgId}/members/${bob.userId}`)).body)
      .toMatchObject({ removed: true, team_memberships_revoked: 0, project_memberships_revoked: 0 })
    expect(await call(bob.token, "GET", `/api/control/projects/${projectId}/access`))
      .toMatchObject({ status: 404, body: { error: { code: "project_not_found" } } })
    expect(await call(bob.token, "GET", `/api/control/orgs/${orgId}/members`)).toMatchObject({ status: 200, body: [] })
  })

  test("a team member role that does not exist is refused and adds nobody", async () => {
    const { person, call, join } = await hosted()
    const alice = await person("alice")
    const bob = await person("bob")
    const orgId = ((await call(alice.token, "POST", "/api/control/orgs", { name: "Acme" })).body as { org_id: string }).org_id
    await join(alice.token, orgId, bob)
    const team = (await call(alice.token, "POST", `/api/control/orgs/${orgId}/teams`, { name: "Eng" })).body as { team_id: string }

    expect(await call(alice.token, "POST", `/api/control/teams/${team.team_id}/members`, { userPublicId: bob.userId, role: "boss" }))
      .toMatchObject({ status: 400, body: { error: { code: "team_member_role_invalid" } } })
    expect(((await call(alice.token, "GET", `/api/control/teams/${team.team_id}/members`)).body as Array<{ user_id: string }>)
      .map((row) => row.user_id)).not.toContain(bob.userId)
    expect((await call(alice.token, "POST", `/api/control/teams/${team.team_id}/members`, { userPublicId: bob.userId, role: "admin" })).body)
      .toMatchObject({ user_id: bob.userId, role: "admin" })
  })

  test("known, unverified and unknown addresses receive the same invitation receipt", async () => {
    const { person, account, call, sent } = await hosted()
    const alice = await person("alice")
    const carol = await account("carol", "carol@example.com", true)
    await account("dave", "dave@example.com", false)
    const orgId = ((await call(alice.token, "POST", "/api/control/orgs", { name: "Acme" })).body as { org_id: string }).org_id
    for (const email of [" Carol@Example.COM ", "dave@example.com", "nobody@example.com"]) {
      expect(await call(alice.token, "POST", `/api/control/orgs/${orgId}/invitations`, { email, role: "member" }))
        .toEqual({ status: 202, body: { message: "invitation sent" } })
    }
    expect((await call(carol.token, "POST", "/api/control/invitations/accept", { token: sent[0].token })).body)
      .toMatchObject({ user_id: carol.userId, role: "member" })
    expect(await call("dave", "POST", "/api/control/invitations/accept", { token: sent[1].token }))
      .toMatchObject({ status: 403, body: { error: { code: "org_invitation_email_mismatch" } } })
  })

  test("a caller who does not administer the org learns nothing about whether an email has an account", async () => {
    const { person, account, call, join } = await hosted()
    const alice = await person("alice")
    const bob = await person("bob")
    await account("carol", "carol@example.com", true)
    const orgId = ((await call(alice.token, "POST", "/api/control/orgs", { name: "Acme" })).body as { org_id: string }).org_id
    await join(alice.token, orgId, bob)

    const known = await call(bob.token, "POST", `/api/control/orgs/${orgId}/invitations`, { email: "carol@example.com", role: "member" })
    const unknown = await call(bob.token, "POST", `/api/control/orgs/${orgId}/invitations`, { email: "nobody@example.com", role: "member" })
    expect(known).toMatchObject({ status: 403, body: { error: { code: "org_admin_required" } } })
    expect(unknown).toEqual(known)
  })
})
