import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthMiddleware } from "better-auth/api"

/**
 * Better Auth lets the unauthenticated `/device/code` caller pre-bind the new
 * request to any `user_id`, which skips the claim a signed-in `GET /device`
 * makes for the person who actually loads it. The field is refused whatever
 * its parsed value: for a form body the library rereads the raw parameters
 * and binds the first non-empty one.
 */
export function deviceCodeRequestPolicy(): BetterAuthPlugin {
  return {
    id: "claxedo-device-code-request-policy",
    hooks: {
      before: [{
        matcher: (ctx) => ctx.path === "/device/code",
        handler: createAuthMiddleware(async (ctx) => {
          const body: unknown = ctx.body
          if (typeof body !== "object" || body === null || !Object.hasOwn(body, "user_id")) return
          throw new APIError("BAD_REQUEST", {
            error: "invalid_request",
            error_description: "user_id is not accepted on a device authorization request",
          })
        }),
      }],
    },
  }
}
