import { afterEach, describe, expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { D1WorkspaceAuthority } from "./workspace-authority"
import { D1OrgInvitationAuthority } from "./org-invitation-authority"
import {
  controlPlaneMigrations,
  miniflareControlPlaneDatabase,
  type ControlPlaneDatabase,
} from "../../../test-support/control-plane-migrations"
import { testRequestAuthenticationAdapter } from "../../../test-support/request-authentication"

const active: ControlPlaneDatabase[] = []
afterEach(async () => {
  for (const database of active.splice(0)) await database.dispose()
})

async function setup() {
  const controlPlane = await miniflareControlPlaneDatabase(controlPlaneMigrations())
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

  test("acceptance grants the invited role and writes exactly one membership audit", async () => {
    const { invite, invitations, invitee, database } = await setup()
    const { token } = await invite()
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
        "select action, user_id, metadata_json from authority_audit_events where action = 'org.member.added' and user_id = ?",
      )
      .bind(invitee.principal!.userId)
      .all<{ action: string; user_id: string; metadata_json: string }>()
    expect(audits.results).toHaveLength(1)
    expect(JSON.parse(audits.results[0]!.metadata_json)).toMatchObject({
      orgId: "org_acme",
      targetUserId: invitee.principal!.userId,
      before: null,
      after: "admin",
    })
    await expect(invitations.acceptOrgInvitation(invitee, { token })).rejects.toMatchObject({
      code: "org_invitation_invalid",
    })
    expect(
      (await database
        .prepare("select count(*) as n from authority_audit_events where action = 'org.member.added' and user_id = ?")
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
        .prepare("select count(*) as n from authority_audit_events where action = 'org.member.added' and user_id = ?")
        .bind(invitee.principal!.userId)
        .first<{ n: number }>())!.n,
    ).toBe(1)
  })
})
