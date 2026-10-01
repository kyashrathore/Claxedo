import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  isOrgMemberRole,
  type OrgInvitation,
  type OrgInvitationDelivery,
  type OrgMemberRole,
} from "@claxedo/server-core/platform/auth/org-access-authority"
import { D1AccessAuthorityError, requireText, type AccessPrincipal, type D1AccessContext } from "./access-context"
import { may, maySql } from "./authorization"
import { D1OrgMemberAuthority } from "./org-member-authority"

export const D1_ORG_INVITATION_AUTHORITY_METHODS = [
  "createOrgInvitation",
  "listOrgInvitations",
  "revokeOrgInvitation",
  "acceptOrgInvitation",
] as const satisfies readonly (keyof WorkspaceAuthority)[]
export type D1OrgInvitationAuthorityPort = Pick<
  WorkspaceAuthority,
  (typeof D1_ORG_INVITATION_AUTHORITY_METHODS)[number]
>

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const PUBLIC_COLUMNS = "id, org_id, email, role, invited_by, created_at, expires_at, accepted_at, revoked_at"

type StoredInvitation = OrgInvitation & { token_hash: string }

export async function invitationTokenHash(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export class D1OrgInvitationAuthority implements D1OrgInvitationAuthorityPort {
  constructor(
    private readonly context: D1AccessContext,
    private readonly delivery?: OrgInvitationDelivery,
  ) {}

  async createOrgInvitation(auth: SignedControlPlaneAuth, args: { orgId: string; email: string; role: OrgMemberRole }) {
    const who = await this.context.principal(auth)
    const orgId = await this.adminOrganization(who, args.orgId)
    const email = requireText(args.email, "email").toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !isOrgMemberRole(args.role))
      throw new D1AccessAuthorityError("invalid_input")
    if (args.role === "owner" && !(await may(this.context.database, who, "own", { kind: "org", orgId }))) {
      throw new D1AccessAuthorityError("org_owner_required")
    }
    if (!this.delivery?.sendInvitation) throw new D1AccessAuthorityError("org_invitation_delivery_unavailable")
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")
    const tokenHash = await invitationTokenHash(token)
    const now = this.context.now()
    const administers = maySql(who, args.role === "owner" ? "own" : "administer", { kind: "org", orgId: "org.org_id" })
    const result = await this.context.database
      .prepare(
        `
      insert into org_invitations (id, org_id, email, role, token_hash, invited_by, created_at, expires_at)
      select ?, org.org_id, ?, ?, ?, ?, ?, ? from orgs org
      where org.org_id = ? and org.deleted_at is null and ${administers.sql}
    `,
      )
      .bind(
        `inv_${crypto.randomUUID()}`,
        email,
        args.role,
        tokenHash,
        who.userId,
        now,
        now + INVITATION_TTL_MS,
        orgId,
        ...administers.bind,
      )
      .run()
    if (result.meta.changes !== 1) throw new D1AccessAuthorityError("org_admin_required")
    try {
      await this.delivery.sendInvitation({ email, token })
    } catch {
      await this.context.database
        .prepare("update org_invitations set revoked_at = ? where token_hash = ? and accepted_at is null")
        .bind(this.context.now(), tokenHash)
        .run()
      console.error("Organization invitation delivery failed")
    }
  }

  async listOrgInvitations(auth: SignedControlPlaneAuth, args: { orgId: string }): Promise<OrgInvitation[]> {
    const who = await this.context.principal(auth)
    const orgId = await this.adminOrganization(who, args.orgId)
    return (
      await this.context.database
        .prepare(`select ${PUBLIC_COLUMNS} from org_invitations where org_id = ? order by created_at desc, id`)
        .bind(orgId)
        .all<OrgInvitation>()
    ).results
  }

  async revokeOrgInvitation(auth: SignedControlPlaneAuth, args: { orgId: string; invitationId: string }) {
    const who = await this.context.principal(auth)
    const orgId = await this.adminOrganization(who, args.orgId)
    const administers = maySql(who, "administer", { kind: "org", orgId: "org_invitations.org_id" })
    const result = await this.context.database
      .prepare(
        `
      update org_invitations set revoked_at = ?
      where id = ? and org_id = ? and revoked_at is null and accepted_at is null and ${administers.sql}
    `,
      )
      .bind(this.context.now(), requireText(args.invitationId, "invitationId"), orgId, ...administers.bind)
      .run()
    return { revoked: result.meta.changes === 1 }
  }

  async acceptOrgInvitation(auth: SignedControlPlaneAuth, args: { token: string }) {
    const who = await this.context.principal(auth)
    const tokenHash = await invitationTokenHash(requireText(args.token, "token"))
    const invitation = await this.context.database
      .prepare("select * from org_invitations where token_hash = ? and accepted_at is null")
      .bind(tokenHash)
      .first<StoredInvitation>()
    if (
      !invitation ||
      invitation.accepted_at !== null ||
      invitation.revoked_at !== null ||
      invitation.expires_at <= this.context.now()
    ) {
      throw new D1AccessAuthorityError("org_invitation_invalid")
    }
    this.context.assertOrganizationAllowed(invitation.org_id)
    const email = await this.delivery?.verifiedEmail(auth)
    if (!email || email.trim().toLowerCase() !== invitation.email)
      throw new D1AccessAuthorityError("org_invitation_email_mismatch")
    return new D1OrgMemberAuthority(this.context).acceptInvitationMembership(who, invitation)
  }

  private async adminOrganization(who: AccessPrincipal, value: string) {
    const orgId = requireText(value, "orgId")
    this.context.assertOrganizationAllowed(orgId)
    if (!(await may(this.context.database, who, "administer", { kind: "org", orgId })))
      throw new D1AccessAuthorityError("org_admin_required")
    return orgId
  }
}
