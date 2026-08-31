import {
  assertDesktopCredentialBinding,
  DesktopAuthDescriptorError,
  parseDesktopAuthDescriptor,
  type BoundDesktopCredential,
  type DesktopAuthDescriptor,
} from "./auth-descriptor"
import { createOAuthFlow, type OAuthConfig, type OAuthSeams } from "./oauth-flow"
import type { TokenSet } from "./oauth-flow"
import type { RefreshExchange } from "./electron-seams"

export type RefreshOutcome =
  { ok: true; tokens: TokenSet } | { ok: false; reason: "revoked" | "unavailable"; detail: string }

export type RemoteRevocation = { state: "confirmed" } | { state: "uncertain"; detail: string }

export type DesktopNativeAuth = {
  cancel(): void
  discover(): Promise<DesktopAuthDescriptor>
  validate(credential: BoundDesktopCredential): Promise<DesktopAuthDescriptor>
  signIn(): Promise<
    | { ok: true; credential: BoundDesktopCredential }
    | {
        ok: false
        reason: "no-secure-storage" | "callback-failed" | "timeout" | "already-running"
        detail: string
      }
  >
  refresh(credential: BoundDesktopCredential): Promise<RefreshOutcome>
  revoke(credential: BoundDesktopCredential): Promise<RemoteRevocation>
}

type SelectedDesktopAdapter = {
  oauth: OAuthConfig
  refresh(refreshToken: string): Promise<RefreshOutcome>
  revoke(credential: BoundDesktopCredential): Promise<RemoteRevocation>
}

const DESCRIPTOR_PATH = "/api/claxedo/auth/descriptor"
const NETWORK_TIMEOUT_MS = 30_000

/**
 * Whether a failed revocation response says the token itself is not valid.
 *
 * Only a 400/401 naming the token counts. A 403, a 404, a 5xx, or a rate
 * limit says nothing about the credential and must stay `uncertain`, because
 * treating those as revoked would silently drop a live remote session.
 */
export async function revocationRejectedTheToken(response: Response) {
  if (response.status !== 400 && response.status !== 401) return false
  const body = await response
    .clone()
    .json()
    .catch(() => undefined)
  if (!body || typeof body !== "object") return false
  const record = body as { error?: unknown; error_description?: unknown }
  const code = typeof record.error === "string" ? record.error : ""
  const description = typeof record.error_description === "string" ? record.error_description : ""
  if (code === "invalid_token" || code === "invalid_grant") return true
  return code === "invalid_request" && /\b(invalid|unknown|expired|revoked)\b.*\btoken\b/i.test(description)
}

export function createDesktopNativeAuth(input: {
  coreOrigin: string
  seams: OAuthSeams
  refresh: RefreshExchange
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
}): DesktopNativeAuth {
  const fetchImpl = input.fetch ?? fetch
  const now = input.now ?? Date.now
  const timeoutMs = input.timeoutMs ?? NETWORK_TIMEOUT_MS
  let activeFlow: ReturnType<typeof createOAuthFlow> | undefined

  const discover = async () => {
    let response: Response
    try {
      response = await fetchImpl(`${input.coreOrigin}${DESCRIPTOR_PATH}`, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new DesktopAuthDescriptorError(
        "descriptor_unavailable",
        `Authentication descriptor could not be loaded: ${String(error)}`,
      )
    }
    if (!response.ok) {
      throw new DesktopAuthDescriptorError(
        "descriptor_unavailable",
        `Authentication descriptor request failed: ${response.status}`,
      )
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new DesktopAuthDescriptorError("invalid_descriptor", "Authentication descriptor is not valid JSON")
    }
    return parseDesktopAuthDescriptor(body, input.coreOrigin, now())
  }

  const select = (descriptor: DesktopAuthDescriptor): SelectedDesktopAdapter => {
    if (descriptor.adapter === "better-auth") {
      return {
        oauth: {
          authorizeUrl: descriptor.authorizeUrl,
          tokenUrl: descriptor.tokenUrl,
          clientId: descriptor.binding.id,
          scope: descriptor.binding.scopes.join(" "),
          resource: descriptor.binding.resource,
          timeoutMs,
        },
        refresh: (refreshToken) =>
          input.refresh({
            tokenUrl: descriptor.tokenUrl,
            clientId: descriptor.binding.id,
            refreshToken,
            resource: descriptor.binding.resource,
          }),
        revoke: async (credential) => {
          if (descriptor.revocation.protocol !== "rfc7009") {
            return {
              state: "uncertain",
              detail: "Better Auth revocation contract changed before logout",
            }
          }
          try {
            const response = await fetchImpl(descriptor.revocation.endpoint, {
              method: "POST",
              headers: {
                accept: "application/json",
                "content-type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({
                client_id: descriptor.binding.id,
                token: credential.tokens.refreshToken,
                token_type_hint: "refresh_token",
              }).toString(),
              redirect: "manual",
              signal: AbortSignal.timeout(timeoutMs),
            })
            if (response.ok) return { state: "confirmed" }
            // A token the authorization server refuses to recognize cannot
            // still be live, so this IS the outcome revocation wanted. RFC 7009
            // §2.2 asks for 200 on an unknown token; Better Auth answers 400
            // `invalid_request` / "Invalid access token" instead. Reading that
            // as merely "uncertain" left an intent that could never confirm,
            // and `signIn` refuses to start while one is pending — a desktop
            // whose token had already expired could never sign in again.
            if (await revocationRejectedTheToken(response)) return { state: "confirmed" }
            return {
              state: "uncertain",
              detail: `Better Auth revocation request failed: ${response.status}`,
            }
          } catch (error) {
            return { state: "uncertain", detail: `Better Auth revocation could not be confirmed: ${String(error)}` }
          }
        },
      }
    }

    return {
      oauth: {
        authorizeUrl: descriptor.authorizeUrl,
        tokenUrl: descriptor.tokenUrl,
        clientId: descriptor.binding.id,
        scope: descriptor.binding.scopes.join(" "),
        timeoutMs,
      },
      refresh: (refreshToken) =>
        input.refresh({
          tokenUrl: descriptor.tokenUrl,
          clientId: descriptor.binding.id,
          refreshToken,
        }),
      // Clerk token revocation is a Backend API operation requiring the
      // deployment's server credential. The current descriptor intentionally
      // exposes only an adapter-native marker, not a public-client request
      // shape. Do not reinterpret it as RFC 7009 or send the refresh token to
      // an invented endpoint; local removal remains explicit but uncertain.
      revoke: async () => ({
        state: "uncertain",
        detail: "Clerk adapter-native remote revocation is not exposed to this public desktop client",
      }),
    }
  }

  const validate = async (credential: BoundDesktopCredential) => {
    const descriptor = await discover()
    assertDesktopCredentialBinding(credential.binding, descriptor)
    return descriptor
  }

  return {
    cancel() {
      activeFlow?.cancel()
    },
    discover,
    validate,
    async signIn() {
      const descriptor = await discover()
      const adapter = select(descriptor)
      const flow = createOAuthFlow(adapter.oauth, input.seams)
      activeFlow = flow
      try {
        const result = await flow.signIn()
        if (!result.ok) return result
        if (!result.tokens.refreshToken) {
          return {
            ok: false,
            reason: "callback-failed",
            detail: "Authorization server returned no refresh token for the native session",
          }
        }
        return {
          ok: true,
          credential: {
            binding: descriptor.binding,
            tokens: { ...result.tokens, refreshToken: result.tokens.refreshToken },
          },
        }
      } finally {
        if (activeFlow === flow) activeFlow = undefined
      }
    },
    async refresh(credential) {
      const descriptor = await validate(credential)
      return select(descriptor).refresh(credential.tokens.refreshToken)
    },
    async revoke(credential) {
      try {
        const descriptor = await validate(credential)
        return await select(descriptor).revoke(credential)
      } catch (error) {
        return {
          state: "uncertain",
          detail: `Remote revocation was not attempted because the current descriptor could not bind the credential: ${String(error)}`,
        }
      }
    },
  }
}
