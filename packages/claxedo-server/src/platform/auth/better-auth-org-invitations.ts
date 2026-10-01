import type { D1Database } from "@cloudflare/workers-types"
import type { AuthIdentity } from "@claxedo/server-core/platform/auth/authentication"
import type { OrgInvitationDelivery } from "@claxedo/server-core/platform/auth/org-access-authority"
import type { AuthEmailSender } from "./better-auth-configuration"

/** The AUTH_DB email of a Better Auth identity from this issuer, only once the provider or link verified it. */
export async function betterAuthVerifiedEmail(input: { database: D1Database; issuer: string }, identity: AuthIdentity | undefined) {
  if (!identity || identity.adapter !== "better-auth" || identity.issuer !== input.issuer) return undefined
  const account = await input.database
    .prepare('select email from "user" where id = ? and "emailVerified" = 1')
    .bind(identity.subject)
    .first<{ email: string }>()
  return account?.email
}

export function betterAuthOrgInvitationDelivery(input: {
  database: D1Database
  issuer: string
  appOrigin: string
  sender?: AuthEmailSender
}): OrgInvitationDelivery {
  const sender = input.sender
  return {
    ...(sender
      ? {
          sendInvitation: ({ email, token }: { email: string; token: string }) =>
            sender.send({
              kind: "invitation",
              recipient: email,
              actionUrl: new URL(`/invitations/${encodeURIComponent(token)}`, input.appOrigin).toString(),
              token,
            }),
        }
      : {}),
    verifiedEmail: (auth) => betterAuthVerifiedEmail(input, auth.principal?.identity),
  }
}
