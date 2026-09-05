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
const DESCRIPTOR_MEMO_MS = 5 * 60_000
const NETWORK_TIMEOUT_MS = 30_000

/**
 * Whether a failed revocation response says the token itself is not valid.
 *
 * Only a 400/401 naming the token counts. A 403, a 404, a 5xx, or a rate
 * limit says nothing about the credential and must stay `uncertain`, because
 * treating those as revoked would silently drop a live remote session.
 */
/**
 * A short, credential-free summary of why a revocation failed.
 *
 * Never includes the response body verbatim: only the OAuth error code and a
 * bounded description, both of which are protocol vocabulary, never token
 * material.
 */
export async function revocationFailureSummary(response: Response) {
  const body = await response
    .clone()
    .json()
    .catch(() => undefined)
  if (!body || typeof body !== "object") return ""
  const record = body as { error?: unknown; error_description?: unknown }
  const code = typeof record.error === "string" ? record.error : undefined
  const description = typeof record.error_description === "string" ? record.error_description.slice(0, 80) : undefined
  if (!code && !description) return ""
  return ` (${[code, description].filter(Boolean).join(": ")})`
}

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
  // Better Auth reports an unrecognized credential two ways, seen live on the
  // same deployment: `invalid_token` / "refresh token not found" and
  // `invalid_request` / "token not found". Match on the description naming the
  // TOKEN as unusable, in either word order.
  return (
    code === "invalid_request" &&
    /\btokens?\b/i.test(description) &&
    /\b(invalid|unknown|expired|revoked|not found|unrecognized)\b/i.test(description)
  )
}

/** A failure before any HTTP response: the socket, not the server, said no. */
function isConnectionLevelFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === "AbortError" || error.name === "TimeoutError") return false
  const cause = (error as { cause?: unknown }).cause
  const code = cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : ""
  return error.message.includes("fetch failed") || /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN/.test(code + error.message)
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

  const request = () => fetchImpl(`${input.coreOrigin}${DESCRIPTOR_PATH}`, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  })
  // One descriptor per validity window, not one per hosted operation. Every
  // signed request validates the credential's binding first, and fetching the
  // descriptor each time doubled every round trip through the edge (the
  // catalog took 5–20 s on a slow edge). The descriptor carries its own
  // `expiresAt`, which already is the freshness rule; a short ceiling keeps a
  // long-lived descriptor from outliving a redeploy for more than minutes.
  let remembered: { descriptor: DesktopAuthDescriptor; until: number } | undefined
  // Callers receive a copy: the descriptor's binding becomes the stored
  // credential's binding, and a shared object would let a mutated credential
  // rewrite what the next validation compares it against.
  const discover = async () => {
    if (!remembered || now() >= remembered.until) {
      const descriptor = await load()
      remembered = { descriptor, until: Math.min(descriptor.expiresAt, now() + DESCRIPTOR_MEMO_MS) }
    }
    return structuredClone(remembered.descriptor)
  }
  const load = async () => {
    let response: Response
    try {
      try {
        response = await request()
      } catch (first) {
        // One retry on a fresh connection. The edge in front of the control
        // plane occasionally resets a warm connection (ECONNRESET, "fetch
        // failed") and the very next attempt succeeds; without this, that one
        // reset failed the session renewal and every hosted operation behind
        // it for the whole refresh cooldown.
        if (!isConnectionLevelFailure(first)) throw first
        response = await request()
      }
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
    if (descriptor.adapter !== "better-auth") {
      throw new DesktopAuthDescriptorError("invalid_descriptor", "Only the Better Auth desktop flow is supported")
    }
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
              // Name what the server said. A bare status left the one state a
              // user cannot clear from the UI unexplainable from the outside.
              detail: `Better Auth revocation request failed: ${response.status}${await revocationFailureSummary(response)}`,
            }
          } catch (error) {
            return { state: "uncertain", detail: `Better Auth revocation could not be confirmed: ${String(error)}` }
          }
        },
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
