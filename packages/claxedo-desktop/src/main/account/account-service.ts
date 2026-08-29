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
import {
  isStreamHostedOperation,
  resolveHostedOperation,
  type HostedOperationName,
} from "./hosted-operations"
import type { CredentialStore, TokenSet } from "./credential-store"
import { accountPerfMark, accountPerfNow } from "./account-perf"

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
  /**
   * Loads display identity for a live access token (OIDC userinfo).
   *
   * Optional: when absent the service still signs in, and the rail falls back
   * to the generic "Account" label until something else supplies a name.
   */
  resolveIdentity?: (accessToken: string) => Promise<AccountIdentity>
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

  /**
   * Publish signed state with whatever profile userinfo can supply.
   *
   * Sign-in must not fail when userinfo is down — the credential is already
   * adopted — but the rail's label is `displayName ?? email ?? "Account"`, so
   * leaving `userId: ""` forever is what made a successful login look anonymous.
   */
  const publishSigned = async (accessToken: string, startedIn: number) => {
    let identity: AccountIdentity = { userId: "" }
    if (options.resolveIdentity) {
      try {
        identity = await options.resolveIdentity(accessToken)
      } catch (error) {
        options.onError?.("identity", error)
      }
    }
    if (startedIn !== era) return
    setState({ status: "signed", identity })
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
        const startedIn = era
        setState({ status: "signed", identity: { userId: "" } })
        // Profile is best-effort and must not delay launch.
        void publishSigned(stored.accessToken, startedIn)
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
        if (result.reason === "already-running") {
          // Another attempt owns `pending`; do not clobber it.
          return result
        }
        if (result.reason === "no-secure-storage") {
          setState({ status: "unavailable", reason: "no-secure-storage", detail: result.detail })
          return result
        }
        // timeout / callback-failed — back to unsigned so the rail can offer
        // Sign in again instead of resting on a dead `pending`/`unavailable`.
        setState({ status: "unsigned" })
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
      await publishSigned(result.tokens.accessToken, startedIn)
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
      if (isStreamHostedOperation(name)) {
        throw new Error(`hosted operation "${name}" is a stream; use account.stream.open`)
      }
      const startedIn = era
      const credential = await currentAccessToken()
      if (!credential.ok) throw new Error(credential.detail)
      if (startedIn !== era) throw new Error("not signed in")
      const request = resolveHostedOperation(name, input)
      const controller = new AbortController()
      activeRequests.add(controller)
      const fetchStarted = accountPerfNow()
      let response: Response
      try {
        response = await options.fetch(`${options.serverOrigin}${request.path}`, {
          method: request.method,
          headers: {
            authorization: `Bearer ${credential.token}`,
            ...(request.body ? { "content-type": "application/json" } : {}),
            ...(request.headers ?? {}),
          },
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
          signal: controller.signal,
        })
      } finally {
        activeRequests.delete(controller)
      }
      accountPerfMark("account.unary_main_fetch_ms", {
        operation: name,
        ms: accountPerfNow() - fetchStarted,
        status: response.status,
      })
      if (startedIn !== era) throw new Error("not signed in")
      if (response.status === 401) {
        const body = await response.json().catch(() => undefined) as {
          error?: { code?: string; message?: string }
        } | undefined
        const code = body?.error?.code
        // Opaque or wrong-shaped OAuth tokens fail JWKS as invalid_bearer_token.
        // That is not a revoked refresh grant — do not wipe the local session.
        if (code === "invalid_bearer_token" || code === "missing_bearer_token") {
          throw new Error(
            body?.error?.message
              ?? "Control plane rejected the account token. Enable JWT access tokens on the Clerk OAuth app, then sign out and sign in again.",
          )
        }
        // The server disagrees with our credential. Not refreshed-and-retried
        // here: renewal already happened ahead of expiry on the way in, so a
        // 401 is not staleness — it is revocation, and a retry loop against a
        // revoked token is how a signed-out desktop hammers the control plane
        // while showing the user nothing.
        signOutLocally("revoked", "the server rejected this session")
        throw new Error("session rejected")
      }
      if (!response.ok) {
        const body = await response.json().catch(() => undefined) as {
          error?: { code?: string; message?: string }
          code?: string
          message?: string
        } | undefined
        if (name === "session.shares.list" && response.status >= 500) {
          throw new Error(
            "Could not load session people. This session may only exist locally — People shares a control-plane session.",
          )
        }
        // Status + body must survive Electron IPC (Error properties do not).
        // Callers that need 409 bodies (connections.connect) parse this prefix.
        const detail = body?.error?.message ?? body?.message
        throw new Error(
          `HOSTED_HTTP ${response.status} ${JSON.stringify({
            detail: detail ?? `operation "${name}" failed: ${response.status}`,
            body: body ?? null,
          })}`,
        )
      }
      if (startedIn !== era) throw new Error("not signed in")
      // Binary export: never return a raw Response (headers include auth
      // surface). Envelope the bytes so IPC stays JSON-shaped.
      if (name === "documents.export") {
        const bytes = Buffer.from(await response.arrayBuffer())
        return {
          bytesBase64: bytes.toString("base64"),
          contentType: response.headers.get("content-type") ?? undefined,
        }
      }
      // Decoded. Returning the Response would hand the renderer the headers,
      // and one of them is the one thing this design exists to withhold.
      const value = await response.json().catch(() => undefined)
      if (startedIn !== era) throw new Error("not signed in")
      return value
    },

    /**
     * Open a named SSE stream. Main owns the fetch + AbortController; the
     * caller (IPC) forwards text chunks to the renderer that opened it.
     */
    async openStream(input: {
      name: HostedOperationName
      params?: Record<string, unknown>
      signal?: AbortSignal
      onChunk: (text: string) => void
    }): Promise<void> {
      if (!isStreamHostedOperation(input.name)) {
        throw new Error(`hosted operation "${input.name}" is not a stream`)
      }
      const startedIn = era
      const credential = await currentAccessToken()
      if (!credential.ok) throw new Error(credential.detail)
      if (startedIn !== era) throw new Error("not signed in")
      const request = resolveHostedOperation(input.name, input.params ?? {})
      const controller = new AbortController()
      activeRequests.add(controller)
      const onAbort = () => controller.abort()
      input.signal?.addEventListener("abort", onAbort, { once: true })
      const openStarted = accountPerfNow()
      let firstChunk = true
      let httpOkAt: number | undefined
      try {
        const response = await options.fetch(`${options.serverOrigin}${request.path}`, {
          method: request.method,
          headers: {
            authorization: `Bearer ${credential.token}`,
            Accept: "text/event-stream",
            ...(request.headers ?? {}),
          },
          signal: controller.signal,
        })
        if (startedIn !== era) throw new Error("not signed in")
        if (response.status === 401) {
          signOutLocally("revoked", "the server rejected this session")
          throw new Error("session rejected")
        }
        if (!response.ok || !response.body) {
          const detail = (await response.text().catch(() => "")).trim()
          throw new Error(
            `HOSTED_HTTP ${response.status} ${JSON.stringify({
              detail: detail || `operation "${input.name}" failed: ${response.status}`,
              body: null,
            })}`,
          )
        }
        httpOkAt = accountPerfNow()
        accountPerfMark("account.stream_http_ok_ms", {
          operation: input.name,
          ms: httpOkAt - openStarted,
          status: response.status,
        })
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        while (true) {
          if (startedIn !== era) throw new Error("not signed in")
          const next = await reader.read()
          if (next.done) break
          const text = decoder.decode(next.value, { stream: true })
          if (firstChunk && text.length > 0) {
            firstChunk = false
            accountPerfMark("account.stream_open_to_first_byte_ms", {
              operation: input.name,
              ms: accountPerfNow() - openStarted,
              after_http_ok_ms: httpOkAt === undefined ? undefined : accountPerfNow() - httpOkAt,
            })
          }
          input.onChunk(text)
        }
        const tail = decoder.decode()
        if (tail.length > 0) {
          if (firstChunk) {
            firstChunk = false
            accountPerfMark("account.stream_open_to_first_byte_ms", {
              operation: input.name,
              ms: accountPerfNow() - openStarted,
              after_http_ok_ms: httpOkAt === undefined ? undefined : accountPerfNow() - httpOkAt,
            })
          }
          input.onChunk(tail)
        }
      } finally {
        input.signal?.removeEventListener("abort", onAbort)
        activeRequests.delete(controller)
      }
    },
  }
}
