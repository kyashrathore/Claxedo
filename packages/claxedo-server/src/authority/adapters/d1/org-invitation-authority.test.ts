import { afterEach, describe, expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { D1WorkspaceAuthority } from "./workspace-authority"
import { D1AuditAuthority } from "./audit-authority"
import { d1UserAgentConfigRepository } from "./user-agent-config"
import { emptyUserAgentConfig } from "@claxedo/server-core/agent-config/config"
import { D1OrgMemberAuthority } from "./org-member-authority"
import { D1OrgInvitationAuthority } from "./org-invitation-authority"
import {
  miniflareControlPlaneDatabase,
  type ControlPlaneDatabase,
} from "../../../test-support/control-plane-migrations"
import { testRequestAuthenticationAdapter } from "../../../test-support/request-authentication"

const active: ControlPlaneDatabase[] = []
afterEach(async () => {
  for (const database of active.splice(0)) await database.dispose()
})

async function setup() {
  const controlPlane = await miniflareControlPlaneDatabase()
  active.push(controlPlane)
  const database = controlPlane.database
  let now = 1_800_000_000_000
  const workspace = new D1WorkspaceAuthority(database, {
    deploymentId: "deployment-test",
    product: { kind: "claxedo-hosted" },
    now: () => now,
  })
  const adapter = testRequestAuthenticationAdapter()
  const person = async (subject: string): Promise<SignedControlPlaneAuth> => {
    const principal = await adapter.authenticate(
      new Request("https://core.test", { headers: { authorization: `Bearer ${subject}` } }),
    )
    const mapped = await workspace.ensureApplicationIdentity(principal.identity)
    if (mapped.state !== "active") throw new Error(mapped.state)
    return {
      mode: "signed",
      principal: { ...principal, userId: mapped.userId, actorId: mapped.actorId },
      user: {
        subject: mapped.userId,
        issuer: principal.identity.issuer,
        tokenIdentifier: `${principal.identity.issuer}|${subject}`,
      },
    }
  }
  const owner = await person("owner")
  const invitee = await person("invitee")
  const other = await person("other")
  await workspace.createHostedOrganization(owner, { name: "Acme", orgId: "org_acme" })
  const sendInvitation = vi.fn(async (_input: { email: string; token: string }) => {})
  const verifiedEmail = vi.fn(async (auth: SignedControlPlaneAuth) => `${auth.principal!.identity.subject}@example.com`)
  const invitations = new D1OrgInvitationAuthority(workspace.accessContext(), { sendInvitation, verifiedEmail })
  const invite = async (email = "invitee@example.com", role: "member" | "admin" | "owner" = "admin") => {
    await invitations.createOrgInvitation(owner, { orgId: "org_acme", email, role })
    const token = sendInvitation.mock.calls.at(-1)![0].token
    const rows = await invitations.listOrgInvitations(owner, { orgId: "org_acme" })
    return { token, id: rows.find((row) => row.email === email.trim().toLowerCase())!.id }
  }
  return {
    database,
    workspace,
    invitations,
    owner,
    invitee,
    other,
    person,
    sendInvitation,
    verifiedEmail,
    invite,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe("D1 organization invitations", () => {
  test.each(["demoted", "removed", "demoted-in-batch"] as const)("an inviter %s cannot confer membership", async (state) => {
    const s = await setup()
    const admin = await s.invite("other@example.com", "admin")
    await s.invitations.acceptOrgInvitation(s.other, { token: admin.token })
    await s.invitations.createOrgInvitation(s.other, { orgId: "org_acme", email: "invitee@example.com", role: "member" })
    const token = s.sendInvitation.mock.calls.at(-1)![0].token
    const demote = () => s.database.prepare("update org_memberships set role = 'member' where org_id = 'org_acme' and user_id = ?").bind(s.other.principal!.userId).run()
    if (state === "removed") await new D1OrgMemberAuthority(s.workspace.accessContext()).removeOrgMember(s.owner, { orgId: "org_acme", userPublicId: s.other.principal!.userId })
    else if (state === "demoted") await demote()
    const database = state === "demoted-in-batch" ? new Proxy(s.database, {
      get(target, key) {
        if (key === "batch") return async (statements: Parameters<typeof target.batch>[0]) => {
          await demote()
          return target.batch(statements)
        }
        const value = Reflect.get(target, key)
        return typeof value === "function" ? value.bind(target) : value
      },
    }) : s.database
    const authority = new D1OrgInvitationAuthority({ ...s.workspace.accessContext(), database }, {
      verifiedEmail: s.verifiedEmail,
    })
    await expect(authority.acceptOrgInvitation(s.invitee, { token })).rejects.toMatchObject({ code: "org_invitation_invalid" })
    expect(await s.database.prepare("select 1 from org_memberships where org_id = 'org_acme' and user_id = ?").bind(s.invitee.principal!.userId).first()).toBeNull()
    expect(await s.database.prepare("select 1 from authority_audit_events where action = 'org.member.added' and user_id = ? and json_extract(metadata_json, '$.orgId') = 'org_acme'").bind(s.invitee.principal!.userId).first()).toBeNull()
  })

  test("refuses a second pending address without replacing its token or sending again", async () => {
    const s = await setup()
    const first = await s.invite("invitee@example.com")
    await expect(s.invite(" INVITEE@EXAMPLE.COM ")).rejects.toMatchObject({ code: "org_invitation_pending" })
    expect(s.sendInvitation).toHaveBeenCalledTimes(1)
    expect(await s.invitations.listOrgInvitations(s.owner, { orgId: "org_acme" })).toHaveLength(1)
    await expect(s.invitations.acceptOrgInvitation(s.invitee, { token: first.token })).resolves.toMatchObject({ role: "admin" })
  })

  test("concurrent creation deduplicates per address", async () => {
    const s = await setup()
    const results = await Promise.allSettled([s.invite("invitee@example.com"), s.invite(" INVITEE@EXAMPLE.COM ")])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(s.sendInvitation).toHaveBeenCalledTimes(1)
    expect(await s.invitations.listOrgInvitations(s.owner, { orgId: "org_acme" })).toHaveLength(1)
  })

  test("the org's hourly budget counts revoked sends and recovers after the window", async () => {
    const s = await setup()
    for (let index = 0; index < 20; index++) {
      const invitation = await s.invite(`person${index}@example.com`)
      await s.invitations.revokeOrgInvitation(s.owner, { orgId: "org_acme", invitationId: invitation.id })
    }
    await expect(s.invite("over-budget@example.com")).rejects.toMatchObject({ code: "org_invitation_rate_limited" })
    expect(s.sendInvitation).toHaveBeenCalledTimes(20)
    s.advance(60 * 60 * 1000)
    await expect(s.invite("over-budget@example.com")).resolves.toBeDefined()
  })

  test("concurrent creation cannot exceed the org budget", async () => {
    const s = await setup()
    for (let index = 0; index < 19; index++) await s.invite(`person${index}@example.com`)
    const results = await Promise.allSettled([s.invite("last1@example.com"), s.invite("last2@example.com")])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(s.sendInvitation).toHaveBeenCalledTimes(20)
  })

  test.each(["orphan", "orphan-with-audit-and-config", "other-invitation", "member"] as const)("revocation handles an admitted %s", async (state) => {
    const s = await setup()
    const workspace = new D1WorkspaceAuthority(s.database, {
      deploymentId: "deployment-test",
      product: { kind: "user-deployed", organization: { id: "org_acme", name: "Acme" }, ownerIdentity: s.owner.principal!.identity },
      now: s.workspace.accessContext().now,
    })
    const first = await s.invite("new@example.com", "member")
    const identity = { ...s.owner.principal!.identity, subject: "new" }
    const mapped = await workspace.admitInvitedIdentity(identity, "new@example.com")
    if (mapped.state !== "active") throw new Error(mapped.state)
    const newcomer = { ...s.owner, principal: { ...s.owner.principal!, identity, userId: mapped.userId, actorId: mapped.actorId } }
    if (state === "member") await s.invitations.acceptOrgInvitation(newcomer, { token: first.token })
    if (state === "orphan-with-audit-and-config") {
      await new D1AuditAuthority(s.database, { deploymentId: "deployment-test" }).auditDeny(newcomer, { action: "workspace.open", reason: "Not a member", workspaceId: "missing" })
      await d1UserAgentConfigRepository(s.database).write(mapped.userId, emptyUserAgentConfig())
      expect(await s.database.prepare("select 1 from authority_audit_events where user_id = ?").bind(mapped.userId).first()).not.toBeNull()
    }
    let second: { id: string } | undefined
    if (state === "other-invitation") {
      await s.workspace.createHostedOrganization(s.owner, { orgId: "org_second", name: "Second" })
      await s.invitations.createOrgInvitation(s.owner, { orgId: "org_second", email: "new@example.com", role: "member" })
      second = (await s.invitations.listOrgInvitations(s.owner, { orgId: "org_second" }))[0]
    }
    await s.invitations.revokeOrgInvitation(s.owner, { orgId: "org_acme", invitationId: first.id })
    const standing = async () => ({
      identity: !!(await s.database.prepare("select 1 from auth_identities where user_id = ?").bind(mapped.userId).first()),
      user: (await s.database.prepare("select state from users where user_id = ?").bind(mapped.userId).first<{ state: string }>())?.state,
      actor: (await s.database.prepare("select state from actors where user_id = ?").bind(mapped.userId).first<{ state: string }>())?.state,
    })
    const retired = { identity: false, user: "deleted", actor: "revoked" }
    expect(await standing()).toEqual(state.startsWith("orphan") ? retired : { identity: true, user: "active", actor: "active" })
    if (state.startsWith("orphan")) expect(await workspace.admitInvitedIdentity(identity, "new@example.com")).toEqual({ state: "unavailable" })
    if (state === "orphan-with-audit-and-config") {
      expect(await s.database.prepare("select 1 from authority_audit_events where user_id = ?").bind(mapped.userId).first()).not.toBeNull()
      expect(await s.database.prepare("select 1 from user_agent_config where user_id = ?").bind(mapped.userId).first()).not.toBeNull()
    }
    if (second) {
      await s.invitations.revokeOrgInvitation(s.owner, { orgId: "org_second", invitationId: second.id })
      expect(await standing()).toEqual(retired)
    }
  })

  test("a retired admission is admitted afresh by a later invitation", async () => {
    const s = await setup()
    const workspace = new D1WorkspaceAuthority(s.database, {
      deploymentId: "deployment-test",
      product: { kind: "user-deployed", organization: { id: "org_acme", name: "Acme" }, ownerIdentity: s.owner.principal!.identity },
      now: s.workspace.accessContext().now,
    })
    const identity = { ...s.owner.principal!.identity, subject: "new" }
    const first = await s.invite("new@example.com", "member")
    const before = await workspace.admitInvitedIdentity(identity, "new@example.com")
    await s.invitations.revokeOrgInvitation(s.owner, { orgId: "org_acme", invitationId: first.id })
    await s.invite("new@example.com", "member")
    const after = await workspace.admitInvitedIdentity(identity, "new@example.com")
    expect(after).toMatchObject({ state: "active" })
    expect(before.state === "active" && after.state === "active" && after.userId !== before.userId).toBe(true)
  })

  test("admission cannot race past revocation", async () => {
    const s = await setup()
    const first = await s.invite("new@example.com", "member")
    const database = new Proxy(s.database, {
      get(target, key) {
        if (key === "batch") return async (statements: Parameters<typeof target.batch>[0]) => {
          await s.invitations.revokeOrgInvitation(s.owner, { orgId: "org_acme", invitationId: first.id })
          return target.batch(statements)
        }
        const value = Reflect.get(target, key)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const workspace = new D1WorkspaceAuthority(database, {
      deploymentId: "deployment-test",
      product: { kind: "user-deployed", organization: { id: "org_acme", name: "Acme" }, ownerIdentity: s.owner.principal!.identity },
      now: s.workspace.accessContext().now,
    })
    expect(await workspace.admitInvitedIdentity({ ...s.owner.principal!.identity, subject: "new" }, "new@example.com")).toEqual({ state: "unavailable" })
    expect(await s.database.prepare("select 1 from auth_identities where subject = 'new'").first()).toBeNull()
  })

  test("missing email capability refuses creation before storing an invitation", async () => {
    const s = await setup()
    const invitations = new D1OrgInvitationAuthority(s.workspace.accessContext(), { verifiedEmail: s.verifiedEmail })
    await expect(invitations.createOrgInvitation(s.owner, { orgId: "org_acme", email: "new@example.com", role: "member" }))
      .rejects.toMatchObject({ code: "org_invitation_delivery_unavailable" })
    expect(await invitations.listOrgInvitations(s.owner, { orgId: "org_acme" })).toEqual([])
  })

  test("delivery failure invalidates the link even if its inviter is concurrently demoted", async () => {
    const s = await setup()
    const admin = await s.invite("other@example.com", "admin")
    await s.invitations.acceptOrgInvitation(s.other, { token: admin.token })
    s.sendInvitation.mockImplementationOnce(async () => {
      await s.database.prepare("update org_memberships set role = 'member' where org_id = 'org_acme' and user_id = ?").bind(s.other.principal!.userId).run()
      throw Object.assign(new Error("Email unavailable"), { code: "E_RECIPIENT_SUPPRESSED" })
    })
    await expect(s.invitations.createOrgInvitation(s.other, { orgId: "org_acme", email: "invitee@example.com", role: "member" })).resolves.toBeUndefined()
    const invitation = (await s.invitations.listOrgInvitations(s.owner, { orgId: "org_acme" })).find((row) => row.email === "invitee@example.com")!
    expect(invitation.revoked_at).not.toBeNull()
    const token = s.sendInvitation.mock.calls.at(-1)![0].token
    await expect(s.invitations.acceptOrgInvitation(s.invitee, { token })).rejects.toMatchObject({ code: "org_invitation_invalid" })
  })

  test("creation never resolves an account, normalizes the email and stores only the hash", async () => {
    const { invite, sendInvitation, verifiedEmail, database } = await setup()
    const known = await invite(" INVITEE@EXAMPLE.COM ")
    await invite("unknown@example.com")
    expect(verifiedEmail).not.toHaveBeenCalled()
    expect(sendInvitation.mock.calls.map(([input]) => input.email)).toEqual([
      "invitee@example.com",
      "unknown@example.com",
    ])
    const stored = await database.prepare("select * from org_invitations").all()
    expect(JSON.stringify(stored)).not.toContain(known.token)
    expect(stored.results).toHaveLength(2)
  })

  test("creating and revoking an invitation are each audited once, attributed to the admin", async () => {
    const { invite, invitations, owner, invitee, database } = await setup()
    const { id } = await invite("audited@example.com", "member")
    await expect(
      invitations.createOrgInvitation(invitee, { orgId: "org_acme", email: "x@example.com", role: "member" }),
    ).rejects.toMatchObject({ code: "org_admin_required" })
    await invitations.revokeOrgInvitation(owner, { orgId: "org_acme", invitationId: id })
    expect(await invitations.revokeOrgInvitation(owner, { orgId: "org_acme", invitationId: id })).toEqual({ revoked: false })
    const audits = await database
      .prepare("select action, user_id, metadata_json from authority_audit_events where action like 'org.invitation.%' order by created_at, action")
      .all<{ action: string; user_id: string; metadata_json: string }>()
    expect(audits.results.map((row) => [row.action, row.user_id, JSON.parse(row.metadata_json)])).toEqual([
      ["org.invitation.created", owner.principal!.userId, { orgId: "org_acme", invitationId: id, email: "audited@example.com", role: "member" }],
      ["org.invitation.revoked", owner.principal!.userId, { orgId: "org_acme", invitationId: id }],
    ])
  })

  test("acceptance grants the invited role and writes exactly one membership audit", async () => {
    const { invite, invitations, invitee, owner, database } = await setup()
    const { token, id } = await invite()
    expect(await invitations.acceptOrgInvitation(invitee, { token })).toMatchObject({
      user_id: invitee.principal!.userId,
      role: "admin",
    })
    const membership = await database
      .prepare("select role from org_memberships where org_id = ? and user_id = ? and revoked_at is null")
      .bind("org_acme", invitee.principal!.userId)
      .first()
    expect(membership).toEqual({ role: "admin" })
    const audits = await database
      .prepare(
        "select action, user_id, metadata_json from authority_audit_events where action = 'org.member.added' and user_id = ? and json_extract(metadata_json, '$.orgId') = 'org_acme'",
      )
      .bind(invitee.principal!.userId)
      .all<{ action: string; user_id: string; metadata_json: string }>()
    expect(audits.results).toHaveLength(1)
    expect(JSON.parse(audits.results[0].metadata_json)).toMatchObject({
      orgId: "org_acme",
      targetUserId: invitee.principal!.userId,
      before: null,
      after: "admin",
      invitationId: id,
      inviterUserId: owner.principal!.userId,
    })
    await expect(invitations.acceptOrgInvitation(invitee, { token })).rejects.toMatchObject({
      code: "org_invitation_invalid",
    })
    expect(
      (await database
        .prepare("select count(*) as n from authority_audit_events where action = 'org.member.added' and user_id = ? and json_extract(metadata_json, '$.orgId') = 'org_acme'")
        .bind(invitee.principal!.userId)
        .first<{ n: number }>())!.n,
    ).toBe(1)
  })

  test.each(["expired", "revoked"] as const)("%s invitations cannot join", async (state) => {
    const { invite, invitations, owner, invitee, advance, database } = await setup()
    const { token, id } = await invite()
    if (state === "expired") advance(7 * 24 * 60 * 60 * 1000)
    else
      expect(await invitations.revokeOrgInvitation(owner, { orgId: "org_acme", invitationId: id })).toEqual({
        revoked: true,
      })
    await expect(invitations.acceptOrgInvitation(invitee, { token })).rejects.toMatchObject({
      code: "org_invitation_invalid",
    })
    expect(
      await database
        .prepare("select role from org_memberships where org_id = ? and user_id = ?")
        .bind("org_acme", invitee.principal!.userId)
        .first(),
    ).toBeNull()
  })

  test("a non-admin cannot create, list or revoke invitations", async () => {
    const { invitations, invite, invitee, owner } = await setup()
    const { token } = await invite("invitee@example.com", "member")
    await invitations.acceptOrgInvitation(invitee, { token })
    await expect(
      invitations.createOrgInvitation(invitee, { orgId: "org_acme", email: "other@example.com", role: "member" }),
    ).rejects.toMatchObject({ code: "org_admin_required" })
    await expect(invitations.listOrgInvitations(invitee, { orgId: "org_acme" })).rejects.toMatchObject({
      code: "org_admin_required",
    })
    const another = await invite("other@example.com")
    await expect(
      invitations.revokeOrgInvitation(invitee, { orgId: "org_acme", invitationId: another.id }),
    ).rejects.toMatchObject({ code: "org_admin_required" })
    await expect(
      invitations.revokeOrgInvitation(owner, { orgId: "other_org", invitationId: another.id }),
    ).rejects.toMatchObject({ code: "org_admin_required" })
  })

  test("a different or unverified email cannot consume an invitation", async () => {
    const { invitations, invite, invitee, other, verifiedEmail } = await setup()
    const { token } = await invite()
    await expect(invitations.acceptOrgInvitation(other, { token })).rejects.toMatchObject({
      code: "org_invitation_email_mismatch",
    })
    verifiedEmail.mockResolvedValueOnce(undefined as never)
    await expect(invitations.acceptOrgInvitation(invitee, { token })).rejects.toMatchObject({
      code: "org_invitation_email_mismatch",
    })
    await expect(invitations.acceptOrgInvitation(invitee, { token })).resolves.toMatchObject({ role: "admin" })
  })

  test("an invite created before sign-up joins through the same accept call", async () => {
    const { invitations, invite, person } = await setup()
    const { token } = await invite("new@example.com", "member")
    const newcomer = await person("new")
    expect(await invitations.acceptOrgInvitation(newcomer, { token })).toMatchObject({
      user_id: newcomer.principal!.userId,
      role: "member",
    })
  })

  test("concurrent accepts consume the invitation and audit only once", async () => {
    const { invitations, invite, invitee, database } = await setup()
    const { token } = await invite()
    const outcomes = await Promise.allSettled([
      invitations.acceptOrgInvitation(invitee, { token }),
      invitations.acceptOrgInvitation(invitee, { token }),
    ])
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(
      (await database
        .prepare("select count(*) as n from authority_audit_events where action = 'org.member.added' and user_id = ? and json_extract(metadata_json, '$.orgId') = 'org_acme'")
        .bind(invitee.principal!.userId)
        .first<{ n: number }>())!.n,
    ).toBe(1)
  })
})
