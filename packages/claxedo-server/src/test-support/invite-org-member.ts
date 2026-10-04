import type { D1Database } from "@cloudflare/workers-types"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { OrgMemberRole } from "@claxedo/server-core/platform/auth/org-access-authority"
import { D1WorkspaceAuthority } from "../authority/adapters/d1/workspace-authority"
import { D1OrgMemberAuthority } from "../authority/adapters/d1/org-member-authority"
import { D1OrgInvitationAuthority } from "../authority/adapters/d1/org-invitation-authority"

export async function inviteOrgMember(
  database: D1Database,
  auth: SignedControlPlaneAuth,
  args: { userPublicId: string; orgId: string; role: OrgMemberRole },
) {
  const principal = auth.principal!
  const context = new D1WorkspaceAuthority(database, {
    deploymentId: principal.deploymentId,
    product: { kind: "claxedo-hosted" },
  }).accessContext()
  const identity = await database
    .prepare(
      `
    select identity.adapter, identity.issuer, identity.subject, identity.user_id, actor.actor_id
    from auth_identities identity join actors actor on actor.user_id = identity.user_id and actor.kind = 'human'
    where identity.unlinked_at is null and identity.user_id = ?
  `,
    )
    .bind(args.userPublicId)
    .first<{ adapter: "better-auth"; issuer: string; subject: string; user_id: string; actor_id: string }>()
  if (!identity) throw new Error("Invitation fixture needs an existing canonical target")
  const active = await database
    .prepare("select role from org_memberships where org_id = ? and user_id = ? and revoked_at is null")
    .bind(args.orgId, identity.user_id)
    .first()
  if (active)
    return new D1OrgMemberAuthority(context).updateOrgMember(auth, {
      orgId: args.orgId,
      userPublicId: identity.user_id,
      role: args.role,
    })
  const email = `${identity.user_id}@example.test`
  let token = ""
  const invitations = new D1OrgInvitationAuthority(context, {
    sendInvitation: async (input) => {
      token = input.token
    },
    verifiedEmail: async () => email,
  })
  await invitations.createOrgInvitation(auth, { orgId: args.orgId, email, role: args.role })
  const invitee: SignedControlPlaneAuth = {
    mode: "signed",
    principal: {
      ...principal,
      userId: identity.user_id,
      actorId: identity.actor_id,
      identity: { adapter: identity.adapter, issuer: identity.issuer, subject: identity.subject },
    },
    user: {
      subject: identity.user_id,
      issuer: identity.issuer,
      tokenIdentifier: `${identity.issuer}|${identity.subject}`,
    },
  }
  return invitations.acceptOrgInvitation(invitee, { token })
}
