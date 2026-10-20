import type { BetterAuthPlugin } from "better-auth"
import { createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api"

type RevocationContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]

const REVOKING_PATHS: ReadonlySet<string> = new Set(["/reset-password", "/revoke-sessions"])

const revokesSessions = (path: string | undefined) => path !== undefined && REVOKING_PATHS.has(path)

async function revokedUserId(ctx: RevocationContext): Promise<string | null> {
  if (ctx.path === "/revoke-sessions") return (await getSessionFromCtx(ctx))?.user.id ?? null
  const token: unknown = ctx.body?.token || ctx.query?.token
  if (typeof token !== "string") return null
  const verification = await ctx.context.internalAdapter.findVerificationValue(`reset-password:${token}`)
  return verification?.value ?? null
}

/**
 * Ending every session leaves OAuth grants that carry `offline_access` alive:
 * Better Auth revokes only refresh tokens without that scope, the session
 * foreign key nulls `sessionId`, and opaque-token validation checks a session
 * only when `sessionId` is set. A password reset or "sign out everywhere" must
 * end those grants too.
 */
export function oauthSessionRevocation(): BetterAuthPlugin {
  const pending = new WeakMap<object, string>()
  return {
    id: "claxedo-oauth-session-revocation",
    hooks: {
      before: [{
        matcher: (ctx) => revokesSessions(ctx.path),
        handler: createAuthMiddleware(async (ctx) => {
          const userId = await revokedUserId(ctx)
          if (userId) pending.set(ctx.context, userId)
        }),
      }],
      after: [{
        matcher: (ctx) => revokesSessions(ctx.path),
        handler: createAuthMiddleware(async (ctx) => {
          const userId = pending.get(ctx.context)
          pending.delete(ctx.context)
          if (!userId || isAPIError(ctx.context.returned)) return
          const where = [{ field: "userId", value: userId }]
          await ctx.context.adapter.deleteMany({ model: "oauthAccessToken", where })
          await ctx.context.adapter.deleteMany({ model: "oauthRefreshToken", where })
        }),
      }],
    },
  }
}
