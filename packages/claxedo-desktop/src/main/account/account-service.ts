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
 * be testable only inside Electron, which in practice means the renewal paths —
 * the ones that matter, because they only run once a session has been open long
 * enough for nobody to be watching — would never be tested at all.
 *
 * A 401 is NOT a renewal trigger. Renewal happens ahead of expiry, off
 * `shouldRefresh`; a 401 arriving despite that is the server saying this
 * session is over, and the disposition for it is sign-out. See `run()`.
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

/**
 * What a refresh-token exchange can say.
 *
 * A result rather than a thrown error, because the two failures have opposite
 * dispositions and an exception carries no reliable way to tell them apart:
 *
 * - `revoked` — the authorization server named this grant dead (`invalid_grant`,
 *   or a 401 on the token endpoint). The session really is over; keeping it
 *   would leave the user looking at a signed-in shell that can do nothing.
 * - `unavailable` — nobody said anything about the credential: the network was
 *   down, the endpoint 5xx'd, the answer was unparseable. Signing out on this
 *   means an offline laptop logs the user out of a session that is still
 *   perfectly valid, and the refresh token is gone by the time they reconnect.
 */
export type RefreshOutcome =
  | { ok: true; tokens: TokenSet }
  | { ok: false; reason: "revoked" | "unavailable"; detail: string }

/** The access token to use for one request, or why there is none. */
type Credential = { ok: true; token: string } | { ok: false; detail: string }

export type AccountServiceOptions = {
  config: OAuthConfig
  seams: OAuthSeams
  store: CredentialStore
  /** Hosted Server's origin. Owned here so the renderer cannot choose it. */
  serverOrigin: string
  /** Injected transport; receives an absolute URL built from the table. */
  fetch: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
  ) => Promise<Response>
  /** Exchanges a refresh token. Absent means refresh is unsupported. */
  refresh?: (refreshToken: string) => Promise<RefreshOutcome>
  now: () => number
  onError?: (stage: string, error: unknown) => void
  /** Canonical state transition feed for main-process lifecycle consumers. */
  onStateChange?: (next: AccountState, previous: AccountState) => void
}

export function createAccountService(options: AccountServiceOptions) {
  const flow = createOAuthFlow(options.config, options.seams)
  let state: AccountState = { status: "unsigned" }
  let tokens: TokenSet | undefined
  /** The one refresh exchange allowed to be in flight. See `renew`. */
  let renewing: Promise<Credential> | undefined
  const activeRequests = new Set<AbortController>()
  /**
   * Bumped by every sign-out. A refresh that was already in flight when the
   * user signed out must not adopt its answer on arrival — that would put a
   * live token back into a process the user just cleared.
   */
  let era = 0

  const setState = (next: AccountState) => {
    const previous = state
    state = next
    options.onStateChange?.(next, previous)
    return next
  }

  const cancelActiveWork = () => {
    flow.cancel()
    for (const request of activeRequests) request.abort(new Error("account session ended"))
    activeRequests.clear()
  }

  /**
   * Take a token set as this process's credential — persisted first.
   *
   * The order is the point. Assigning `tokens` and then storing would, on a
   * keyring that has gone away, leave a live token in memory that `run()` will
   * happily spend while `state` is stuck at whatever it was mid-transition. A
   * credential this process cannot keep is a credential it does not have, so a
   * failed write leaves nothing adopted and nothing pending.
   */
  const adopt = (next: TokenSet): { ok: true } | { ok: false; detail: string } => {
    try {
      options.store.save(next)
    } catch (error) {
      options.onError?.("persist", error)
      tokens = undefined
      // `no-secure-storage` because that is what `save` refuses over: the store
      // checks the backend at write time precisely so a keyring that vanished
      // mid-session is caught here. The detail carries the real cause either
      // way, and the renderer's reading of the reason — "retrying will not
      // help" — is right for both.
      const detail = `the credential could not be stored: ${String(error)}`
      setState({ status: "unavailable", reason: "no-secure-storage", detail })
      return { ok: false, detail }
    }
    tokens = next
    return { ok: true }
  }

  /** The access token to use now, refreshing first when it is close to expiry. */
  const currentAccessToken = async (): Promise<Credential> => {
    const held = tokens
    if (!held) return { ok: false, detail: "not signed in" }
    if (!shouldRefresh({ expiresAt: held.expiresAt, now: options.now() })) return { ok: true, token: held.accessToken }
    if (!options.refresh || !held.refreshToken) {
      // Expired with no way to renew — a provider that issued no refresh token
      // ends here. Signing the user out rather than sending a token we know is
      // dead means they see "signed out" instead of a screen of failed
      // requests.
      signOutLocally("revoked", "the session expired and could not be renewed")
      return { ok: false, detail: "not signed in" }
    }
    return await renew(held.refreshToken)
  }

  /**
   * One refresh in flight, shared by every waiter.
   *
   * Concurrent `run()` calls arrive in bursts — a renderer painting a screen
   * asks for four things at once — and they all cross the skew window
   * together. Unserialized, each would POST its own exchange with the same
   * refresh token; against a server that rotates them, the first response
   * invalidates the token the other three are still using, and three
   * `invalid_grant`s sign the user out of the session that was just renewed.
   */
  const renew = (refreshToken: string): Promise<Credential> => {
    renewing ??= exchangeRefresh(refreshToken).finally(() => {
      renewing = undefined
    })
    return renewing
  }

  /** Never throws: every outcome is a `Credential`, and only revocation signs out. */
  const exchangeRefresh = async (refreshToken: string): Promise<Credential> => {
    const startedIn = era
    let outcome: RefreshOutcome
    try {
      outcome = await options.refresh!(refreshToken)
    } catch (error) {
      // A seam that threw told us nothing about the credential, so it is
      // treated as the failure that does not destroy one.
      options.onError?.("refresh", error)
      return { ok: false, detail: `could not renew the session: ${String(error)}` }
    }
    // The session this renewal belonged to ended while it was in flight.
    if (startedIn !== era) return { ok: false, detail: "not signed in" }
    if (!outcome.ok) {
      options.onError?.("refresh", outcome.detail)
      if (outcome.reason === "revoked") {
        signOutLocally("revoked", outcome.detail)
        return { ok: false, detail: "not signed in" }
      }
      // Transient. The credential stays exactly where it is, so the next call
      // after the network comes back renews normally.
      return { ok: false, detail: `could not renew the session: ${outcome.detail}` }
    }
    const adopted = adopt(outcome.tokens)
    if (!adopted.ok) return { ok: false, detail: adopted.detail }
    return { ok: true, token: outcome.tokens.accessToken }
  }

  function signOutLocally(reason: "revoked" | "callback-failed", detail: string) {
    era++
    cancelActiveWork()
    tokens = undefined
    options.store.clear()
    setState({ status: "unavailable", reason, detail })
  }

  return {
    state: () => state,

    /** Restores a stored credential at boot. Never throws — this runs on launch. */
    restore() {
      try {
        const storage = options.store.available()
        if (!storage.usable) {
          setState({
            status: "unavailable",
            reason: "no-secure-storage",
            detail: storage.detail,
          })
          // Give the store one non-decrypting pass so it can discard a legacy
          // `basic_text` record while preserving ciphertext behind a locked or
          // temporarily unavailable protected backend.
          options.store.load(options.now())
          return state
        }
        const stored = options.store.load(options.now())
        if (!stored) return state
        tokens = stored
        setState({ status: "signed", identity: { userId: "" } })
      } catch (error) {
        options.onError?.("restore", error)
      }
      return state
    },

    async signIn(): Promise<SignInResult> {
      const startedIn = era
      setState({ status: "pending" })
      const result = await flow.signIn()
      if (startedIn !== era) {
        return { ok: false, reason: "callback-failed", detail: "sign-in was cancelled" }
      }
      if (!result.ok) {
        setState(
          result.reason === "already-running"
            ? state
            : { status: "unavailable", reason: mapReason(result.reason), detail: result.detail },
        )
        return result
      }
      const adopted = adopt(result.tokens)
      if (!adopted.ok) {
        // `adopt` has already put the service in `unavailable`. Reporting
        // success here would leave the caller believing in a session that was
        // never stored, and leave `pending` as the resting state of a sign-in
        // that is over.
        return { ok: false, reason: "no-secure-storage", detail: adopted.detail }
      }
      setState({ status: "signed", identity: { userId: "" } })
      return result
    },

    async signOut() {
      era++
      cancelActiveWork()
      tokens = undefined
      options.store.clear()
      setState({ status: "unsigned" })
    },

    /**
     * Perform one named operation.
     *
     * The renderer reaches this with a NAME. The method, the path and the
     * Authorization header are all decided here, which is the whole reason the
     * credential can live in this process at all.
     */
    async run(name: HostedOperationName, input: Record<string, unknown> = {}): Promise<unknown> {
      const startedIn = era
      const credential = await currentAccessToken()
      if (!credential.ok) throw new Error(credential.detail)
      if (startedIn !== era) throw new Error("not signed in")
      const request = resolveHostedOperation(name, input)
      const controller = new AbortController()
      activeRequests.add(controller)
      let response: Response
      try {
        response = await options.fetch(`${options.serverOrigin}${request.path}`, {
          method: request.method,
          headers: {
            authorization: `Bearer ${credential.token}`,
            ...(request.body ? { "content-type": "application/json" } : {}),
          },
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
          signal: controller.signal,
        })
      } finally {
        activeRequests.delete(controller)
      }
      if (startedIn !== era) throw new Error("not signed in")
      if (response.status === 401) {
        // The server disagrees with our credential. Not refreshed-and-retried
        // here: renewal already happened ahead of expiry on the way in, so a
        // 401 is not staleness — it is revocation, and a retry loop against a
        // revoked token is how a signed-out desktop hammers the control plane
        // while showing the user nothing.
        signOutLocally("revoked", "the server rejected this session")
        throw new Error("session rejected")
      }
      if (!response.ok) throw new Error(`operation "${name}" failed: ${response.status}`)
      if (startedIn !== era) throw new Error("not signed in")
      // Decoded. Returning the Response would hand the renderer the headers,
      // and one of them is the one thing this design exists to withhold.
      const value = await response.json().catch(() => undefined)
      if (startedIn !== era) throw new Error("not signed in")
      return value
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
