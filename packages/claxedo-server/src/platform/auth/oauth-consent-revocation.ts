import type { BetterAuthPlugin } from "better-auth"
import { createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api"

/** Better Auth deletes consent without revoking its opaque access or refresh tokens. */
export function oauthConsentRevocation(): BetterAuthPlugin {
  const pending = new WeakMap<object, { userId: string; clientId: string }>()
  return {
    id: "claxedo-consent-revocation",
    hooks: {
      before: [{
        matcher: (ctx) => ctx.path === "/oauth2/delete-consent",
        handler: createAuthMiddleware(async (ctx) => {
          const id = ctx.body?.id
          if (typeof id !== "string") return
          const consent = await ctx.context.adapter.findOne<{ userId: string; clientId: string }>({
            model: "oauthConsent", where: [{ field: "id", value: id }],
          })
          if (consent) pending.set(ctx.context, consent)
        }),
      }],
      after: [{
        matcher: (ctx) => ctx.path === "/oauth2/delete-consent",
        handler: createAuthMiddleware(async (ctx) => {
          const consent = pending.get(ctx.context)
          pending.delete(ctx.context)
          if (!consent || isAPIError(ctx.context.returned)) return
          const session = await getSessionFromCtx(ctx)
          if (!session || consent.userId !== session.user.id) return
          const where = [
            { field: "userId", value: consent.userId },
            { field: "clientId", value: consent.clientId },
          ]
          await ctx.context.adapter.deleteMany({ model: "oauthAccessToken", where })
          await ctx.context.adapter.deleteMany({ model: "oauthRefreshToken", where })
        }),
      }],
    },
  }
}
