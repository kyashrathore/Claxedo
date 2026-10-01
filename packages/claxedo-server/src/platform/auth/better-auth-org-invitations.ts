import type { D1Database } from "@cloudflare/workers-types"
import type { OrgInvitationDelivery } from "@claxedo/server-core/platform/auth/org-access-authority"
import type { AuthEmailSender } from "./better-auth-configuration"

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
    async verifiedEmail(auth) {
      const identity = auth.principal?.identity
      if (!identity || identity.adapter !== "better-auth" || identity.issuer !== input.issuer) return undefined
      const account = await input.database
        .prepare('select email from "user" where id = ? and "emailVerified" = 1')
        .bind(identity.subject)
        .first<{ email: string }>()
      return account?.email
    },
  }
}
