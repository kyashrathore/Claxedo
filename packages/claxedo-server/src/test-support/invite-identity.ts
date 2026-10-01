import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity } from "@claxedo/server-core/platform/auth/authentication"
import type { OrgMemberRole } from "@claxedo/server-core/platform/auth/org-access-authority"
import type { D1WorkspaceAuthority } from "../authority/adapters/d1/workspace-authority"
import { D1OrgInvitationAuthority } from "../authority/adapters/d1/org-invitation-authority"

/**
 * Invites an identity that has never signed in to a user-deployed instance and
 * admits it on that pending invitation, as its first signed request would.
 * The returned accept joins it once the caller has signed it in.
 */
export async function inviteIdentity(
  authority: D1WorkspaceAuthority,
  owner: SignedControlPlaneAuth,
  input: { orgId: string; identity: AuthIdentity; role: OrgMemberRole },
) {
  const email = `${input.identity.subject}@example.test`
  let token = ""
  const invitations = new D1OrgInvitationAuthority(authority.accessContext(), {
    sendInvitation: async (invitation) => { token = invitation.token },
    verifiedEmail: async () => email,
  })
  await invitations.createOrgInvitation(owner, { orgId: input.orgId, email, role: input.role })
  const admitted = await authority.admitInvitedIdentity(input.identity, email)
  if (admitted.state !== "active") throw new Error(`invited identity was not admitted: ${admitted.state}`)
  return (invitee: SignedControlPlaneAuth) => invitations.acceptOrgInvitation(invitee, { token })
}
