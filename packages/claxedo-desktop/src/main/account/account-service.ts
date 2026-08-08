/**
 * Electron main's account: the credential, and the only calls it will make.
 *
 * The three modules beside this one each own one decision — `oauth-flow.ts` how
 * a sign-in proceeds, `credential-store.ts` where the result may be kept,
 * `hosted-operations.ts` what may be asked for. This assembles them and is the
 * only thing the IPC layer talks to.
 *
 * The credential never leaves this process. `run()` returns a DECODED result;
 * there is no method here that returns a token, a header, or a raw Response,
 * and `account-service.test.ts` asserts that rather than leaving it to review.
 *
 * Effects stay injected. A service that reached for `net.fetch` directly would
 * be testable only inside Electron, which in practice means the refresh-on-401
 * path — the one that matters — would never be tested at all.
 */

import { createOAuthFlow, type OAuthConfig, type OAuthSeams, type SignInResult } from "./oauth-flow"
import { shouldRefresh } from "./secure-storage"
import { resolveHostedOperation, type HostedOperationName } from "./hosted-operations"
import type { CredentialStore, TokenSet } from "./credential-store"

export type AccountIdentity = {
  userId: string
  displayName?: string
  email?: string
  orgId?: string
  method?: string
}

export type AccountState =
  | { status: "unsigned" }
  | { status: "pending" }
  | { status: "signed"; identity: AccountIdentity }
  | { status: "unavailable"; reason: "no-secure-storage" | "callback-failed" | "revoked"; detail: string }

export type AccountServiceOptions = {
  config: OAuthConfig
  seams: OAuthSeams
  store: CredentialStore
  /** Hosted Server's origin. Owned here so the renderer cannot choose it. */
  serverOrigin: string
  /** Injected transport; receives an absolute URL built from the table. */
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>
  /** Exchanges a refresh token. Absent means refresh is unsupported. */
  refresh?: (refreshToken: string) => Promise<TokenSet>
  now: () => number
  onError?: (stage: string, error: unknown) => void
}

export function createAccountService(options: AccountServiceOptions) {
  const flow = createOAuthFlow(options.config, options.seams)
  let state: AccountState = { status: "unsigned" }
  let tokens: TokenSet | undefined

  const adopt = (next: TokenSet) => {
    tokens = next
    options.store.save(next)
  }

  /** The access token to use now, refreshing first when it is close to expiry. */
  const currentAccessToken = async (): Promise<string | undefined> => {
    if (!tokens) return undefined
    if (!shouldRefresh({ expiresAt: tokens.expiresAt, now: options.now() })) return tokens.accessToken
    if (!options.refresh || !tokens.refreshToken) {
      // Expired with no way to renew. Signing the user out here rather than
      // sending a token we know is dead means they see "signed out" instead of
      // a screen of failed requests.
      signOutLocally("revoked", "the session expired and could not be renewed")
      return undefined
    }
    try {
      adopt(await options.refresh(tokens.refreshToken))
      return tokens.accessToken
    } catch (error) {
      options.onError?.("refresh", error)
      signOutLocally("revoked", String(error))
      return undefined
    }
  }

  function signOutLocally(reason: "revoked" | "callback-failed", detail: string) {
    tokens = undefined
    options.store.clear()
    state = { status: "unavailable", reason, detail }
  }

  return {
    state: () => state,

    /** Restores a stored credential at boot. Never throws — this runs on launch. */
    restore() {
      try {
        const stored = options.store.load(options.now())
        if (!stored) return state
        tokens = stored
        state = { status: "signed", identity: { userId: "" } }
      } catch (error) {
        options.onError?.("restore", error)
      }
      return state
    },

    async signIn(): Promise<SignInResult> {
      state = { status: "pending" }
      const result = await flow.signIn()
      if (!result.ok) {
        state =
          result.reason === "already-running"
            ? state
            : { status: "unavailable", reason: mapReason(result.reason), detail: result.detail }
        return result
      }
      adopt(result.tokens)
      state = { status: "signed", identity: { userId: "" } }
      return result
    },

    async signOut() {
      tokens = undefined
      options.store.clear()
      state = { status: "unsigned" }
    },

    /**
     * Perform one named operation.
     *
     * The renderer reaches this with a NAME. The method, the path and the
     * Authorization header are all decided here, which is the whole reason the
     * credential can live in this process at all.
     */
    async run(name: HostedOperationName, input: Record<string, unknown> = {}): Promise<unknown> {
      const token = await currentAccessToken()
      if (!token) throw new Error("not signed in")
      const request = resolveHostedOperation(name, input)
      const response = await options.fetch(`${options.serverOrigin}${request.path}`, {
        method: request.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(request.body ? { "content-type": "application/json" } : {}),
        },
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      })
      if (response.status === 401) {
        // The server disagrees with our credential. Not retried here: a retry
        // loop against a revoked token is how a signed-out desktop hammers the
        // control plane while showing the user nothing.
        signOutLocally("revoked", "the server rejected this session")
        throw new Error("session rejected")
      }
      if (!response.ok) throw new Error(`operation "${name}" failed: ${response.status}`)
      // Decoded. Returning the Response would hand the renderer the headers,
      // and one of them is the one thing this design exists to withhold.
      return await response.json().catch(() => undefined)
    },
  }
}

/**
 * The flow's failure reasons, narrowed to the ones the renderer can act on.
 *
 * `timeout` and `callback-failed` are the same thing to a user — sign-in did
 * not complete, try again — and giving the UI a third case to handle would buy
 * nothing. `no-secure-storage` is genuinely different: retrying will never
 * work, and the message has to say why.
 */
function mapReason(reason: "no-secure-storage" | "callback-failed" | "timeout") {
  return reason === "no-secure-storage" ? ("no-secure-storage" as const) : ("callback-failed" as const)
}
