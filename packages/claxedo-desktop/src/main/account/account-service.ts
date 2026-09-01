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

import { DesktopAuthDescriptorError, type BoundDesktopCredential } from "./auth-descriptor"
import { CredentialStoreConflict, type CredentialStore, type StoredDesktopCredential } from "./credential-store"
import type { DesktopNativeAuth, RefreshOutcome } from "./desktop-native-auth"
import { shouldRefresh } from "./secure-storage"
import {
  isStreamHostedOperation,
  resolveHostedOperation,
  type HostedOperationName,
} from "./hosted-operations"
import { fetchHostedWithStallRecovery } from "./hosted-transport"
import { accountPerfMark, accountPerfNow } from "./account-perf"

export type { RefreshOutcome } from "./desktop-native-auth"

export type AccountIdentity = {
  userId: string
  displayName?: string
  email?: string
  orgId?: string
  method?: string
}

export type AccountState =
  | { status: "unsigned"; remoteRevocation?: "confirmed" | "uncertain"; detail?: string }
  | { status: "pending" }
  | { status: "signed"; identity: AccountIdentity }
  | { status: "unavailable"; reason: "no-secure-storage" | "callback-failed" | "revoked"; detail: string }

type Credential = { ok: true; token: string } | { ok: false; detail: string }

/**
 * After a refresh fails, further renewals answer with that failure instead of
 * re-running the exchange, for this long. Boot issues its hosted operations
 * serially, and each would otherwise wait out a full bounded refresh against a
 * deployment that is already known to be stalling.
 */
const REFRESH_FAILURE_COOLDOWN_MS = 20_000

export type AccountServiceOptions = {
  auth: DesktopNativeAuth
  store: CredentialStore
  fetch: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
  ) => Promise<Response>
  /**
   * Loads display identity for a live access token (OIDC userinfo).
   *
   * Optional: when absent the service still signs in, and the rail falls back
   * to the generic "Account" label until something else supplies a name.
   */
  resolveIdentity?: (accessToken: string) => Promise<AccountIdentity>
  now: () => number
  /**
   * Schedules the retry that recovers a session left unavailable by an
   * unreachable deployment. Injected so a test does not wait 30 seconds;
   * production uses `setTimeout`.
   */
  scheduleRevalidation?: (run: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  onError?: (stage: string, error: unknown) => void
  onStateChange?: (next: AccountState, previous: AccountState) => void
}

export function createAccountService(options: AccountServiceOptions) {
  let state: AccountState = { status: "unsigned" }
  let credential: StoredDesktopCredential | undefined
  let renewing: Promise<Credential> | undefined
  let renewFailure: { at: number; detail: string } | undefined
  let logoutInFlight: Promise<void> | undefined
  let era = 0
  const activeRequests = new Set<AbortController>()

  const setState = (next: AccountState) => {
    const previous = state
    state = next
    options.onStateChange?.(next, previous)
    return next
  }

  const cancelActiveWork = () => {
    options.auth.cancel()
    for (const request of activeRequests) request.abort(new Error("account session ended"))
    activeRequests.clear()
  }

  const clearLocal = () => {
    credential = undefined
    renewFailure = undefined
    options.store.clear()
  }

  const rejectHeld = (held: StoredDesktopCredential, reason: string) => {
    options.store.reject(held.revision, reason)
    if (credential?.revision === held.revision) credential = undefined
  }

  const adopt = (
    next: BoundDesktopCredential,
    expectedRevision?: string | null,
  ): { ok: true; credential: StoredDesktopCredential } | { ok: false; detail: string } => {
    try {
      const stored = options.store.save(next, expectedRevision)
      credential = stored
      renewFailure = undefined
      return { ok: true, credential: stored }
    } catch (error) {
      options.onError?.("persist", error)
      credential = undefined
      const detail = `the credential could not be stored: ${String(error)}`
      setState({ status: "unavailable", reason: "no-secure-storage", detail })
      return { ok: false, detail }
    }
  }

  const invalidate = (detail: string) => {
    era++
    cancelActiveWork()
    clearLocal()
    setState({ status: "unavailable", reason: "revoked", detail })
  }

  const validated = async (held: StoredDesktopCredential) => {
    try {
      await options.auth.validate(held)
      return { ok: true as const, transient: false as const }
    } catch (error) {
      options.onError?.("descriptor", error)
      if (error instanceof DesktopAuthDescriptorError && error.code === "credential_binding_mismatch") {
        rejectHeld(held, error.message)
      }
      // A deployment we could not REACH has said nothing about this
      // credential. Treating that silence as a verdict is what turned a ~2s
      // 503 during a routine redeploy into a signed-out desktop: the session
      // was intact, the credential was valid, and the only real fact was that
      // the descriptor endpoint was briefly unavailable. Observed live —
      // `[account] descriptor: ... failed: 503`, after which the desktop
      // showed "Sign in" and remote access stayed down until someone noticed.
      //
      // The operation still fails (we will not use a credential this
      // deployment has not validated), but the held session survives so the
      // next attempt re-validates and recovers on its own. A descriptor that
      // ANSWERS and rejects — a bad binding, a malformed document — is a real
      // verdict and still ends the session.
      const transient = error instanceof DesktopAuthDescriptorError && error.code === "descriptor_unavailable"
      setState({
        status: "unavailable",
        reason: "callback-failed",
        detail: transient
          ? `the selected deployment is unreachable: ${String(error)}`
          : `the selected deployment could not validate this credential: ${String(error)}`,
      })
      // Fail closed either way — a credential this deployment has not
      // validated must not keep being used, and the Host Connector suspends
      // on exactly this transition. What differs is the future: silence is
      // retried by the callers below, a refusal is not.
      return { ok: false as const, transient: transient as boolean }
    }
  }

  /**
   * Come back from a blip without the user doing anything.
   *
   * `unavailable` used to be terminal: the only producers of `signed` are boot
   * and an interactive sign-in, so a ~2s descriptor 503 during a redeploy left
   * the desktop showing "Sign in" — and remote access suspended — until
   * someone restarted it. Nothing was wrong with the credential; the only
   * fact was that one request had failed.
   *
   * So while a credential is held and the session is not signed, re-validate
   * on a timer. Success returns the state to `signed` through the normal
   * transition, which is what wakes the Host Connector's auth-lapse resume.
   * The timer stops itself the moment either condition stops holding, and is
   * unref'd so it never keeps the process alive.
   */
  const REVALIDATE_AFTER_UNREACHABLE_MS = 30_000
  let revalidating: ReturnType<typeof setTimeout> | undefined

  const scheduleRevalidation = () => {
    // Either shape of "we hold something worth revalidating": adopted, or
    // waiting to be adopted because the blip hit during restore.
    if (revalidating || (!credential && !deferredAdoption)) return
    revalidating = options.scheduleRevalidation
      ? options.scheduleRevalidation(() => {
          revalidating = undefined
          void currentAccessToken()
        }, REVALIDATE_AFTER_UNREACHABLE_MS)
      : setTimeout(() => {
          revalidating = undefined
          void currentAccessToken()
        }, REVALIDATE_AFTER_UNREACHABLE_MS)
    ;(revalidating as { unref?: () => void })?.unref?.()
  }

  /**
   * A credential that could not be adopted only because the deployment was
   * unreachable. Held so the next operation retries adoption instead of
   * waiting for another `restore()` — without this, a blip during launch left
   * the desktop signed out until it was restarted, which is how a 2s 503
   * outlived itself by hours.
   */
  let deferredAdoption: StoredDesktopCredential | undefined

  const adoptDeferred = async () => {
    const pending = deferredAdoption
    if (!pending) return false
    const check = await validated(pending)
    if (!check.ok) {
      if (!check.transient) deferredAdoption = undefined
      return false
    }
    deferredAdoption = undefined
    credential = pending
    publishSigned(pending.tokens.accessToken, era)
    return true
  }

  const exchangeRefresh = async (held: StoredDesktopCredential): Promise<Credential> => {
    const startedIn = era
    let outcome: RefreshOutcome
    try {
      outcome = await options.auth.refresh(held)
    } catch (error) {
      options.onError?.("refresh", error)
      return { ok: false, detail: `could not renew the session: ${String(error)}` }
    }
    if (startedIn !== era || credential?.revision !== held.revision) return { ok: false, detail: "not signed in" }
    if (!outcome.ok) {
      options.onError?.("refresh", outcome.detail)
      if (outcome.reason === "revoked") {
        invalidate(outcome.detail)
        return { ok: false, detail: "not signed in" }
      }
      return { ok: false, detail: `could not renew the session: ${outcome.detail}` }
    }

    const nextRefreshToken = outcome.tokens.refreshToken ?? held.tokens.refreshToken
    const next: BoundDesktopCredential = {
      binding: held.binding,
      tokens: { ...outcome.tokens, refreshToken: nextRefreshToken },
    }
    try {
      const stored = options.store.save(next, held.revision)
      credential = stored
      return { ok: true, token: stored.tokens.accessToken }
    } catch (error) {
      if (error instanceof CredentialStoreConflict) {
        const winner = options.store.load(options.now())
        if (
          winner &&
          (await validated(winner)).ok &&
          !shouldRefresh({ expiresAt: winner.tokens.expiresAt, now: options.now() })
        ) {
          credential = winner
          return { ok: true, token: winner.tokens.accessToken }
        }
        return { ok: false, detail: "another refresh changed the session; retry after it completes" }
      }
      options.onError?.("persist", error)
      credential = undefined
      const detail = `the renewed credential could not be stored: ${String(error)}`
      setState({ status: "unavailable", reason: "no-secure-storage", detail })
      return { ok: false, detail }
    }
  }

  const renew = (held: StoredDesktopCredential) => {
    // Electron's app-level single-instance lock makes this the one live writer
    // for a profile. The promise serializes that process; the persisted
    // revision rejects stale ownership/re-entrancy. This is not claimed as a
    // cross-process filesystem CAS (rename alone cannot provide one).
    if (renewing) return renewing
    // A failed refresh answers for the next window instead of re-running.
    // Hosted operations arrive serially during boot, and each one otherwise
    // re-attempts the full bounded refresh; when the deployment is stalling
    // (see hosted-transport.ts), that chained the splash screen behind one
    // ~30s refresh per operation for minutes. Failing fast lets the shell
    // bootstrap fall back and render while the account stays degraded.
    if (renewFailure && options.now() - renewFailure.at < REFRESH_FAILURE_COOLDOWN_MS) {
      return Promise.resolve<Credential>({ ok: false, detail: renewFailure.detail })
    }
    renewing = exchangeRefresh(held)
      .then((result) => {
        renewFailure = result.ok || result.detail === "not signed in"
          ? undefined
          : { at: options.now(), detail: result.detail }
        return result
      })
      .finally(() => {
        renewing = undefined
      })
    return renewing
  }

  const currentAccessToken = async (): Promise<Credential> => {
    if (!credential) await adoptDeferred()
    const held = credential
    if (!held) return { ok: false, detail: "not signed in" }
    const check = await validated(held)
    if (!check.ok) {
      if (check.transient) scheduleRevalidation()
      return { ok: false, detail: "not signed in" }
    }
    // The deployment just validated a credential we already hold, so whatever
    // made the session unavailable is over. Returning to `signed` here is the
    // transition the Host Connector's auth-lapse resume waits for.
    if (state.status !== "signed") publishSigned(held.tokens.accessToken, era)
    if (!shouldRefresh({ expiresAt: held.tokens.expiresAt, now: options.now() })) {
      return { ok: true, token: held.tokens.accessToken }
    }
    return await renew(held)
  }

  const reconcilePendingRevocation = async () => {
    const pending = options.store.load(options.now())
    if (pending?.persistenceState !== "revocation-pending") return true
    setState({
      status: "unsigned",
      remoteRevocation: "uncertain",
      detail: "remote logout is pending confirmation",
    })
    const outcome = await options.auth.revoke(pending)
    const confirmed = outcome.state === "confirmed" && options.store.completeRevocation(pending.revision)
    setState({
      status: "unsigned",
      remoteRevocation: confirmed ? "confirmed" : "uncertain",
      ...(!confirmed
        ? {
            detail:
              outcome.state === "uncertain"
                ? outcome.detail
                : "remote logout was confirmed, but the persisted revocation intent changed",
          }
        : {}),
    })
    return confirmed
  }

  /**
   * Publish signed state with whatever profile userinfo can supply.
   *
   * Sign-in must not fail when userinfo is down — the credential is already
   * adopted — but the rail's label is `displayName ?? email ?? "Account"`, so
   * leaving `userId: ""` forever is what made a successful login look anonymous.
   */
  const publishSigned = (accessToken: string, startedIn: number) => {
    if (startedIn !== era) return
    // Credentials are authoritative as soon as `adopt` persists them. Profile
    // lookup is display enrichment only: waiting on it turns a slow or hung
    // /userinfo endpoint into a sign-in that never completes.
    setState({ status: "signed", identity: { userId: "" } })
    if (!options.resolveIdentity) return
    void (async () => {
      // On restore the persisted access token is usually already expired
      // (5-minute TTL), so resolving identity with it answered 401 and every
      // relaunch showed a nameless account. Identity follows the same token
      // freshness rule as every hosted operation; the passed token is only
      // the fallback when renewal is unavailable (e.g. mid-adopt).
      const fresh = await currentAccessToken()
      const identity = await options.resolveIdentity!(fresh.ok ? fresh.token : accessToken)
      // Sign-out (or a superseding sign-in) may have happened while the
      // optional lookup was in flight. Never republish stale identity.
      if (startedIn !== era) return
      setState({ status: "signed", identity })
    })().catch((error) => {
      options.onError?.("identity", error)
    })
  }

  return {
    state: () => state,

    async restore() {
      try {
        const storage = options.store.available()
        if (!storage.usable) {
          setState({ status: "unavailable", reason: "no-secure-storage", detail: storage.detail })
          options.store.load(options.now())
          return state
        }
        const stored = options.store.load(options.now())
        if (!stored) return state
        if (stored.persistenceState === "revocation-pending") {
          await reconcilePendingRevocation()
          return state
        }
        const adoption = await validated(stored)
        if (!adoption.ok) {
          // Unreachable is not a refusal: keep it adoptable so the next
          // operation tries again instead of the user seeing "Sign in".
          deferredAdoption = adoption.transient ? stored : undefined
          if (adoption.transient) scheduleRevalidation()
          return state
        }
        deferredAdoption = undefined
        credential = stored
        const startedIn = era
        // Profile is best-effort and must not delay launch.
        publishSigned(stored.tokens.accessToken, startedIn)
      } catch (error) {
        options.onError?.("restore", error)
        setState({
          status: "unavailable",
          reason: "callback-failed",
          detail: `credential restore failed: ${String(error)}`,
        })
      }
      return state
    },

    async signIn() {
      await logoutInFlight
      if (!(await reconcilePendingRevocation())) {
        return {
          ok: false as const,
          reason: "callback-failed" as const,
          detail: "remote logout is still pending confirmation; sign-in did not replace its retryable intent",
        }
      }
      const startedIn = ++era
      setState({ status: "pending" })
      let result: Awaited<ReturnType<DesktopNativeAuth["signIn"]>>
      try {
        result = await options.auth.signIn()
      } catch (error) {
        const detail = `sign-in could not load the selected deployment: ${String(error)}`
        setState({ status: "unavailable", reason: "callback-failed", detail })
        return { ok: false as const, reason: "callback-failed" as const, detail }
      }
      if (startedIn !== era)
        return { ok: false as const, reason: "callback-failed" as const, detail: "sign-in was cancelled" }
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
        // Keep the non-secret failure detail on the authoritative state. The
        // IPC intentionally returns state rather than the OAuth result, so
        // dropping it here made a failed token exchange look exactly like a
        // user who never clicked Sign in and left no live diagnostic.
        options.onError?.("sign-in", result.detail)
        setState({ status: "unsigned", detail: result.detail })
        return result
      }
      const adopted = adopt(result.credential)
      if (!adopted.ok) {
        // `adopt` has already put the service in `unavailable`. Reporting
        // success here would leave the caller believing in a session that was
        // never stored, and leave `pending` as the resting state of a sign-in
        // that is over.
        return { ok: false, reason: "no-secure-storage", detail: adopted.detail }
      }
      publishSigned(result.credential.tokens.accessToken, startedIn)
      return { ok: true as const }
    },

    async signOut() {
      if (logoutInFlight) return await logoutInFlight
      const operation = (async () => {
        const held = credential
        const logoutEra = ++era
        cancelActiveWork()
        if (!held) {
          const stored = options.store.load(options.now())
          if (stored?.persistenceState === "revocation-pending") {
            await reconcilePendingRevocation()
          } else {
            options.store.clear()
            setState({ status: "unsigned" })
          }
          return
        }
        let pendingRevision: string | undefined
        try {
          pendingRevision = options.store.beginRevocation(held.revision)
        } catch (error) {
          options.onError?.("logout-persist", error)
          try {
            options.store.reject(held.revision, "logout could not persist a retryable revocation intent")
          } catch (rejectError) {
            options.onError?.("logout-quarantine", rejectError)
          }
        }
        credential = undefined
        setState({
          status: "unsigned",
          remoteRevocation: "uncertain",
          detail: pendingRevision
            ? "remote logout is pending confirmation"
            : "local access ended, but remote logout cannot be retried from this device",
        })
        const outcome = await options.auth.revoke(held)
        if (era !== logoutEra) return
        if (outcome.state === "confirmed" && pendingRevision) {
          options.store.completeRevocation(pendingRevision)
        }
        setState({
          status: "unsigned",
          remoteRevocation: outcome.state,
          ...(outcome.state === "uncertain" ? { detail: outcome.detail } : {}),
        })
      })()
      logoutInFlight = operation
      try {
        await operation
      } finally {
        if (logoutInFlight === operation) logoutInFlight = undefined
      }
    },

    async run(name: HostedOperationName, input: Record<string, unknown> = {}): Promise<unknown> {
      if (isStreamHostedOperation(name)) {
        throw new Error(`hosted operation "${name}" is a stream; use account.stream.open`)
      }
      const startedIn = era
      const access = await currentAccessToken()
      if (!access.ok) throw new Error(access.detail)
      const held = credential
      if (startedIn !== era || !held) throw new Error("not signed in")
      const request = resolveHostedOperation(name, input)
      const fetchStarted = accountPerfNow()
      // Stall recovery lives at this seam: reads that produce no response
      // headers are retried once on a fresh connection, mutations keep their
      // single attempt. See hosted-transport.ts for the live failure this
      // absorbs (the signed bootstrap froze on the splash behind one stalled
      // `account.get`).
      const issue = (token: string) =>
        fetchHostedWithStallRecovery(
          options.fetch,
          `${held.binding.controlPlaneOrigin}${request.path}`,
          {
            method: request.method,
            // Deliberately no invented desktop-version header/426 state: the
            // selected core exposes no version-admission contract yet. Add both
            // ends together when that server response is real and testable.
            headers: {
              authorization: `Bearer ${token}`,
              ...(request.body ? { "content-type": "application/json" } : {}),
              ...(request.headers ?? {}),
            },
            ...(request.body ? { body: JSON.stringify(request.body) } : {}),
          },
          (controller) => {
            activeRequests.add(controller)
            return () => activeRequests.delete(controller)
          },
        )
      let response = await issue(access.token)
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
        // `missing_bearer_token` means WE sent no credential — a client bug,
        // not a statement about the session, so it must not wipe it.
        //
        // `invalid_bearer_token` used to be treated the same way, on the
        // Clerk-era assumption that it only ever meant a wrong-SHAPED token
        // (JWKS refusing an opaque one) and therefore a misconfiguration no
        // amount of renewing could fix. This deployment returns that exact
        // code for an ordinary rejected token — expired, retired, unknown —
        // which wedged the desktop completely: no renewal (this branch
        // returned first), no invalidation, so the account read "Signed in"
        // while every operation 401'd and remote access could not start.
        // Verified against the live control plane: a junk bearer answers
        // {"error":{"code":"invalid_bearer_token", ...}}.
        //
        // So it falls through to renew-once-and-retry below, which resolves
        // both readings: a renewable session recovers, and one that is truly
        // unusable fails its retry and reaches the honest sign-out.
        if (code === "missing_bearer_token") {
          throw new Error(body?.error?.message ?? "The account request carried no credential.")
        }
        // Renewal ahead of expiry covers a token that aged out, but not one
        // the server retired EARLY — a refresh-family rotation revokes the
        // access tokens minted before it, so a desktop holding a
        // locally-unexpired token 401s forever while its refresh grant is
        // perfectly alive. Observed live: every operation 401'd, remote access
        // could not start, and the panel showed a signed-in account with no
        // explanation.
        //
        // So: renew ONCE and re-issue. This is not the retry loop the previous
        // comment warned about — a genuinely revoked session fails its
        // renewal, or answers 401 again, and both land on the invalidate
        // below. One attempt, then the honest sign-out.
        const renewed = await renew(held)
        if (startedIn !== era) throw new Error("not signed in")
        const recovered = renewed.ok && (response = await issue(renewed.token)).status !== 401
        if (!recovered) {
          invalidate("the server rejected this session")
          throw new Error("session rejected")
        }
        // Recovered: fall through to the normal response handling below.
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
      const access = await currentAccessToken()
      if (!access.ok) throw new Error(access.detail)
      const held = credential
      if (startedIn !== era || !held) throw new Error("not signed in")
      const request = resolveHostedOperation(input.name, input.params ?? {})
      const controller = new AbortController()
      activeRequests.add(controller)
      const onAbort = () => controller.abort()
      input.signal?.addEventListener("abort", onAbort, { once: true })
      const openStarted = accountPerfNow()
      let firstChunk = true
      let httpOkAt: number | undefined
      try {
        // The SSE open is a read: a stalled establishment (headers never
        // arrive) is retried once on a fresh connection instead of sitting
        // behind the transport's own multi-minute headers timeout. The read
        // loop below still uses `controller`, which stays registered for
        // logout/caller aborts for the stream's whole life.
        const response = await fetchHostedWithStallRecovery(
          options.fetch,
          `${held.binding.controlPlaneOrigin}${request.path}`,
          {
            method: request.method,
            headers: {
              authorization: `Bearer ${access.token}`,
              Accept: "text/event-stream",
              ...(request.headers ?? {}),
            },
          },
          (attempt) => {
            activeRequests.add(attempt)
            return () => activeRequests.delete(attempt)
          },
          controller.signal,
        )
        if (startedIn !== era) throw new Error("not signed in")
        if (response.status === 401) {
          // Same code split as `run()`: a bearer-shaped rejection is not a
          // revoked session, and a stream that invalidated on it signed the
          // user out for a transport-level token problem `run()` deliberately
          // survives. Only the remaining 401s mean revocation.
          const body = await response.json().catch(() => undefined) as {
            error?: { code?: string; message?: string }
          } | undefined
          const code = body?.error?.code
          if (code === "invalid_bearer_token" || code === "missing_bearer_token") {
            throw new Error(body?.error?.message ?? "Control plane rejected the account token")
          }
          invalidate("the server rejected this session")
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
