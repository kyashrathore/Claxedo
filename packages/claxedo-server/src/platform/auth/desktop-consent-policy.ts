import { isRecord } from "@claxedo/helpers/guards"
import type { BetterAuthPlugin } from "better-auth"
import { createAuthMiddleware } from "better-auth/api"

function promptTokens(prompt: unknown): string[] {
  const values = Array.isArray(prompt) ? prompt : [prompt]
  return values.flatMap((value) => (typeof value === "string" ? value.split(" ").filter(Boolean) : []))
}

function withConsentPrompt(parameters: unknown, desktopClientId: string): Record<string, unknown> | undefined {
  if (!isRecord(parameters) || parameters.client_id !== desktopClientId) return undefined
  return { ...parameters, prompt: [...new Set([...promptTokens(parameters.prompt), "consent"])].join(" ") }
}

function isConsentContinuation(request: Request | undefined) {
  return request !== undefined && new URL(request.url).pathname.endsWith("/oauth2/consent")
}

/**
 * The desktop client is a public PKCE client that accepts any loopback port,
 * so any local process can open its authorize URL with its own verifier.
 * Better Auth answers a client with stored consent and a live browser session
 * by redirecting straight to the redirect URI with a code, which would mint
 * full-scope tokens with nothing for the person to see. Forcing the consent
 * prompt on the server, not in the desktop's own request, is what holds
 * against a caller that builds the URL itself. An accepted consent re-enters
 * `/oauth2/authorize` inside the `/oauth2/consent` request, and forcing the
 * prompt there would send the person back to the consent screen forever.
 */
export function desktopConsentPolicy(desktopClientId: string): BetterAuthPlugin {
  return {
    id: "claxedo-desktop-consent-policy",
    hooks: {
      before: [{
        matcher: (ctx) => ctx.path === "/oauth2/authorize" && !isConsentContinuation(ctx.request),
        handler: createAuthMiddleware(async (ctx) => {
          const query = withConsentPrompt(ctx.query, desktopClientId)
          const body = ctx.method === "POST" ? withConsentPrompt(ctx.body, desktopClientId) : undefined
          if (!query && !body) return undefined
          return { context: { ...(query ? { query } : {}), ...(body ? { body } : {}) } }
        }),
      }],
    },
  }
}
