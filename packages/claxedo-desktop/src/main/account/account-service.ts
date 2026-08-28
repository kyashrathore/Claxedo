import { DesktopAuthDescriptorError, type BoundDesktopCredential } from "./auth-descriptor"
import { CredentialStoreConflict, type CredentialStore, type StoredDesktopCredential } from "./credential-store"
import type { DesktopNativeAuth, RefreshOutcome } from "./desktop-native-auth"
import { resolveHostedOperation, type HostedOperationName } from "./hosted-operations"
import { shouldRefresh } from "./secure-storage"

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

export type AccountServiceOptions = {
  auth: DesktopNativeAuth
  store: CredentialStore
  fetch: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
  ) => Promise<Response>
  now: () => number
  onError?: (stage: string, error: unknown) => void
  onStateChange?: (next: AccountState, previous: AccountState) => void
}

export function createAccountService(options: AccountServiceOptions) {
  let state: AccountState = { status: "unsigned" }
  let credential: StoredDesktopCredential | undefined
  let renewing: Promise<Credential> | undefined
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
      return true
    } catch (error) {
      options.onError?.("descriptor", error)
      if (error instanceof DesktopAuthDescriptorError && error.code === "credential_binding_mismatch") {
        rejectHeld(held, error.message)
      }
      setState({
        status: "unavailable",
        reason: "callback-failed",
        detail: `the selected deployment could not validate this credential: ${String(error)}`,
      })
      return false
    }
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
          (await validated(winner)) &&
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
    renewing ??= exchangeRefresh(held).finally(() => {
      renewing = undefined
    })
    return renewing
  }

  const currentAccessToken = async (): Promise<Credential> => {
    const held = credential
    if (!held) return { ok: false, detail: "not signed in" }
    if (!(await validated(held))) return { ok: false, detail: "not signed in" }
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
        if (!(await validated(stored))) return state
        credential = stored
        setState({ status: "signed", identity: { userId: "" } })
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
        setState({
          status: "unavailable",
          reason: result.reason === "no-secure-storage" ? "no-secure-storage" : "callback-failed",
          detail: result.detail,
        })
        return result
      }
      const adopted = adopt(result.credential)
      if (!adopted.ok) return { ok: false as const, reason: "no-secure-storage" as const, detail: adopted.detail }
      setState({ status: "signed", identity: { userId: "" } })
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
      const startedIn = era
      const access = await currentAccessToken()
      if (!access.ok) throw new Error(access.detail)
      const held = credential
      if (startedIn !== era || !held) throw new Error("not signed in")
      const request = resolveHostedOperation(name, input)
      const controller = new AbortController()
      activeRequests.add(controller)
      let response: Response
      try {
        response = await options.fetch(`${held.binding.controlPlaneOrigin}${request.path}`, {
          method: request.method,
          // Deliberately no invented desktop-version header/426 state: the
          // selected core exposes no version-admission contract yet. Add both
          // ends together when that server response is real and testable.
          headers: {
            authorization: `Bearer ${access.token}`,
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
        invalidate("the server rejected this session")
        throw new Error("session rejected")
      }
      if (!response.ok) throw new Error(`operation "${name}" failed: ${response.status}`)
      const value = await response.json().catch(() => undefined)
      if (startedIn !== era) throw new Error("not signed in")
      return value
    },
  }
}
