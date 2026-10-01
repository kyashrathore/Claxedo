import type { D1Database } from "@cloudflare/workers-types"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { createD1CoreAuthority } from "../../src/authority/adapters/d1/core-authority"

export async function provisionHostedOrgInvitation(input: {
  auth: D1Database
  control: D1Database
  issuer: string
  deploymentId: string
  orgId: string
  ownerSubject: string
  inviteeSubject: string
}) {
  const owner = await input.control
    .prepare(
      `
    select identity.user_id, actor.actor_id from auth_identities identity
    join actors actor on actor.user_id = identity.user_id and actor.kind = 'human'
    where identity.adapter = 'better-auth' and identity.issuer = ? and identity.subject = ? and identity.unlinked_at is null
  `,
    )
    .bind(input.issuer, input.ownerSubject)
    .first<{ user_id: string; actor_id: string }>()
  const invitee = await input.auth
    .prepare('select email from "user" where id = ? and "emailVerified" = 1')
    .bind(input.inviteeSubject)
    .first<{ email: string }>()
  if (!owner || !invitee) throw new Error("Invitation fixture requires a canonical owner and a verified recipient")
  const auth: SignedControlPlaneAuth = {
    mode: "signed",
    principal: {
      userId: owner.user_id,
      actorId: owner.actor_id,
      actorKind: "human",
      deploymentId: input.deploymentId,
      sessionId: "e2e-invitation",
      authenticatedAt: Date.now(),
      methods: ["oauth:github"],
      assurance: "single-factor",
      client: {
        kind: "browser",
        tokenKind: "browser-session",
        id: "e2e",
        resource: input.issuer,
        scopes: ["workspace:write"],
        origin: new URL(input.issuer).origin,
      },
      identity: { adapter: "better-auth", issuer: input.issuer, subject: input.ownerSubject },
    },
    user: { subject: owner.user_id, issuer: input.issuer, tokenIdentifier: `${input.issuer}|${input.ownerSubject}` },
  }
  let token = ""
  const authority = createD1CoreAuthority(input.control, {
    deploymentId: input.deploymentId,
    product: {
      kind: "user-deployed",
      organization: { id: input.orgId, name: "Hosted E2E" },
      ownerBootstrap: "one-use-claim",
    },
    invitations: {
      sendInvitation: async (invitation) => {
        token = invitation.token
      },
      verifiedEmail: async () => undefined,
    },
  })
  await authority.createOrgInvitation!(auth, { orgId: input.orgId, email: invitee.email, role: "member" })
  return token
}
