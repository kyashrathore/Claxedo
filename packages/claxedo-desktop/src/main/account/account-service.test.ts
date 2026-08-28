import { describe, expect, test } from "bun:test"

import {
  DesktopAuthDescriptorError,
  type BoundDesktopCredential,
  type DesktopCredentialBinding,
} from "./auth-descriptor"
import { createAccountService } from "./account-service"
import { CredentialStoreConflict, type CredentialStore, type StoredDesktopCredential } from "./credential-store"
import type { DesktopNativeAuth } from "./desktop-native-auth"

const BINDING: DesktopCredentialBinding = {
  kind: "desktop",
  tokenKind: "access-token",
  adapter: "better-auth",
  deploymentId: "dep_1",
  configurationVersion: "config_1",
  issuer: "https://core.example/api/auth",
  flow: "authorization-code-pkce",
  tokenEndpointOrigin: "https://core.example",
  controlPlaneOrigin: "https://core.example",
  id: "desktop_1",
  resource: "https://core.example/api/claxedo",
  scopes: ["openid", "offline_access"],
}

const CREDENTIAL: BoundDesktopCredential = {
  binding: BINDING,
  tokens: { accessToken: "at_1", refreshToken: "rt_1", expiresAt: 10_000 },
}

function memoryStore(initial?: BoundDesktopCredential) {
  let held: StoredDesktopCredential | undefined = initial
    ? { ...initial, revision: "r1", persistenceState: "active" }
    : undefined
  let revision = 1
  const rejected: string[] = []
  const store: CredentialStore & { held(): StoredDesktopCredential | undefined; rejected: string[] } = {
    available: () => ({ usable: true, backend: "keychain", detail: "protected" }),
    save(next, expected) {
      if (expected === null && held) throw new CredentialStoreConflict()
      if (typeof expected === "string" && held?.revision !== expected) throw new CredentialStoreConflict()
      held = { ...next, revision: `r${++revision}`, persistenceState: "active" }
      return held
    },
    load: () => held,
    beginRevocation(expected) {
      if (held?.revision !== expected || held.persistenceState !== "active") throw new CredentialStoreConflict()
      const nextRevision = `r${++revision}`
      held = { ...held, revision: nextRevision, persistenceState: "revocation-pending" }
      return nextRevision
    },
    completeRevocation(expected) {
      if (held?.revision !== expected) return false
      held = undefined
      return true
    },
    reject(expected, reason) {
      if (held?.revision === expected) {
        held = undefined
        rejected.push(reason)
      }
    },
    clear: () => {
      held = undefined
    },
    held: () => held,
    rejected,
  }
  return store
}

function service<S extends CredentialStore = ReturnType<typeof memoryStore>>(overrides: {
  store?: S
  fetch?: Parameters<typeof createAccountService>[0]["fetch"]
  refresh?: (token: string) => Promise<RefreshOutcome>
  exchange?: OAuthSeams["exchange"]
  resolveIdentity?: Parameters<typeof createAccountService>[0]["resolveIdentity"]
  now?: number
  errors?: Array<{ stage: string; error: unknown }>
  states?: AccountState[]
} = {}) {
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = []
  const store = (overrides.store ?? memoryStore()) as S
  let callback: ((url: string) => unknown) | undefined
  // Resolved when the flow hands the authorize URL to the browser, so a
  // sign-in test can read the `state` it must echo back rather than guessing
  // at the flow's internal timing.
  let announce: (url: string) => void = () => {}
  const opened = new Promise<string>((resolve) => {
    announce = resolve
  })
  const seams: OAuthSeams = {
    openExternal: async (url) => announce(url),
    listen: async (handler) => {
      callback = handler
      return { port: 49_152, close: async () => {} }
    },
    exchange: overrides.exchange ?? (async () => TOKENS),
    safeStorage: () => ({ available: true, platform: "darwin" }),
    setTimeout: () => ({ cancel: () => {} }),
  }
  const api = createAccountService({
    config: CONFIG,
    seams,
    store,
    serverOrigin: "https://control.test",
    now: () => overrides.now ?? 1_000,
    fetch:
      overrides.fetch ??
      (async (url, init) => {
        requests.push({ url, ...init })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }),
    ...(overrides.refresh ? { refresh: overrides.refresh } : {}),
    ...(overrides.resolveIdentity ? { resolveIdentity: overrides.resolveIdentity } : {}),
    ...(overrides.errors ? { onError: (stage, error) => overrides.errors!.push({ stage, error }) } : {}),
    ...(overrides.states ? { onStateChange: (next) => overrides.states!.push(next) } : {}),
  })
  return {
    api,
    requests,
    store,
    deliverCallback: (state: string) => callback?.(`${REDIRECT_PATH}?code=c&state=${state}`),
    /** Runs one sign-in end to end, echoing the flow's own `state` back. */
    completeSignIn: async () => {
      const result = api.signIn()
      const authorizeUrl = await opened
      callback?.(`${REDIRECT_PATH}?code=c&state=${new URL(authorizeUrl).searchParams.get("state")}`)
      return await result
    },
    revoke: async () => {
      revokes++
      return { state: "confirmed" }
    },
    ...overrides,
  }
  return { auth, validates: () => validates, refreshes: () => refreshes, revokes: () => revokes }
}

function harness(
  input: {
    store?: ReturnType<typeof memoryStore>
    auth?: ReturnType<typeof authHarness>
    now?: number
    fetch?: Parameters<typeof createAccountService>[0]["fetch"]
  } = {},
) {
  const store = input.store ?? memoryStore()
  const selectedAuth = input.auth ?? authHarness()
  const requests: Array<{ url: string; init: Parameters<Parameters<typeof createAccountService>[0]["fetch"]>[1] }> = []
  const service = createAccountService({
    auth: selectedAuth.auth,
    store,
    now: () => input.now ?? 1_000,
    fetch:
      input.fetch ??
      (async (url, init) => {
        requests.push({ url, init })
        return Response.json({ ok: true })
      }),
  })
  return { service, store, auth: selectedAuth, requests }
}

describe("bound desktop account lifecycle", () => {
  test("validates on restore and again before every API use, then uses only the bound core", async () => {
    const h = harness({ store: memoryStore(CREDENTIAL) })
    await h.service.restore()

    expect(await h.service.run("account.get")).toEqual({ ok: true })
    expect(h.auth.validates()).toBe(2)
    expect(h.requests[0]?.url).toBe("https://core.example/api/claxedo/bootstrap")
    expect(h.requests[0]?.init.headers.authorization).toBe("Bearer at_1")
    expect(JSON.stringify(h.service.state())).not.toContain("at_1")
    expect(JSON.stringify(h.service.state())).not.toContain("rt_1")
  })

  test("quarantines exact stored revision and refuses requests after binding drift", async () => {
    const selectedAuth = authHarness({
      validate: async () => {
        throw new DesktopAuthDescriptorError("credential_binding_mismatch", "configuration changed")
      },
    })
    const h = harness({ store: memoryStore(CREDENTIAL), auth: selectedAuth })

    await h.service.restore()
    await expect(h.service.run("account.get")).rejects.toThrow("not signed in")
    expect(h.store.held()).toBeUndefined()
    expect(h.store.rejected).toEqual(["configuration changed"])
    expect(h.requests).toEqual([])
  })

  test("does not adopt a credential while the fresh descriptor is expired or unavailable", async () => {
    const h = harness({
      store: memoryStore(CREDENTIAL),
      auth: authHarness({
        validate: async () => {
          throw new DesktopAuthDescriptorError("expired_descriptor", "expired")
        },
      }),
    })

    await h.service.restore()
    expect(h.service.state()).toMatchObject({ status: "unavailable" })
    expect(h.store.held()).toBeDefined()
    await expect(h.service.run("account.get")).rejects.toThrow("not signed in")
  })

  test("serializes refresh and compare-and-swap replaces the complete binding plus tokens", async () => {
    const selectedAuth = authHarness()
    const h = harness({
      store: memoryStore({ ...CREDENTIAL, tokens: { ...CREDENTIAL.tokens, expiresAt: 1_001 } }),
      auth: selectedAuth,
      now: 1_000,
    })
    await h.service.restore()

    await Promise.all([h.service.run("account.get"), h.service.run("account.mode")])
    expect(selectedAuth.refreshes()).toBe(1)
    expect(h.store.held()).toMatchObject({
      binding: BINDING,
      tokens: { accessToken: "at_2", refreshToken: "rt_2" },
    })
  })

  test("makes a durable pending record unusable before remote logout and surfaces uncertainty tokenlessly", async () => {
    let pendingDuringRevoke = false
    const store = memoryStore(CREDENTIAL)
    const h = harness({
      store,
      auth: authHarness({
        revoke: async () => {
          pendingDuringRevoke = store.held()?.persistenceState === "revocation-pending"
          return { state: "uncertain", detail: "offline" }
        },
      }),
    })
    await h.service.restore()

    await h.service.signOut()
    expect(pendingDuringRevoke).toBe(true)
    expect(h.service.state()).toEqual({ status: "unsigned", remoteRevocation: "uncertain", detail: "offline" })
    expect(h.store.held()?.persistenceState).toBe("revocation-pending")
    expect(JSON.stringify(h.service.state())).not.toContain("rt_1")
  })

  test("retries a crash-surviving revocation intent on restore and deletes it only after confirmation", async () => {
    const store = memoryStore(CREDENTIAL)
    const first = harness({
      store,
      auth: authHarness({ revoke: async () => ({ state: "uncertain", detail: "offline" }) }),
    })
    await first.service.restore()
    await first.service.signOut()
    expect(store.held()?.persistenceState).toBe("revocation-pending")

    const restarted = harness({ store })
    await restarted.service.restore()
    expect(restarted.service.state()).toEqual({ status: "unsigned", remoteRevocation: "confirmed" })
    expect(store.held()).toBeUndefined()
  })

  test("does not let sign-in silently replace an uncertain retryable revocation intent", async () => {
    let revocations = 0
    const store = memoryStore(CREDENTIAL)
    const selectedAuth = authHarness({
      revoke: async () => {
        revocations++
        return revocations < 3 ? { state: "uncertain", detail: "offline" } : { state: "confirmed" }
      },
    })
    const h = harness({ store, auth: selectedAuth })
    await h.service.restore()
    await h.service.signOut()

    expect(await h.service.signIn()).toMatchObject({ ok: false, detail: expect.stringContaining("retryable intent") })
    expect(store.held()?.persistenceState).toBe("revocation-pending")
    expect(h.service.state()).toEqual({ status: "unsigned", remoteRevocation: "uncertain", detail: "offline" })

    expect(await h.service.signIn()).toEqual({ ok: true })
    expect(store.held()).toMatchObject({ persistenceState: "active", binding: BINDING })
    expect(revocations).toBe(3)
  })

  test("sign-in persists the descriptor-bound credential but returns no tokens", async () => {
    const h = harness()
    const result = await h.service.signIn()

    expect(result).toEqual({ ok: true })
    expect(h.store.held()).toMatchObject(CREDENTIAL)
    expect(JSON.stringify(result)).not.toContain("at_1")
    expect(JSON.stringify(result)).not.toContain("rt_1")
  })

  test("a concurrent sign-in waits for the durable logout boundary before replacing the credential", async () => {
    let finish!: () => void
    const remote = new Promise<void>((resolve) => {
      finish = resolve
    })
    api.restore()

    await expect(api.run("account.get")).rejects.toThrow(/session rejected/)
    expect(calls).toBe(1)
    expect(store.held()).toBeUndefined()
    expect(api.state()).toMatchObject({ status: "unavailable", reason: "revoked" })
  })

  test("keeps the session when the control plane rejects a non-JWT bearer", async () => {
    // Opaque Clerk OAuth access tokens fail JWKS as invalid_bearer_token. That
    // is a token-format problem, not a revoked refresh grant.
    const { api, store } = service({
      store: memoryStore(TOKENS),
      fetch: async () => new Response(JSON.stringify({
        error: { code: "invalid_bearer_token", message: "Bearer token is invalid" },
      }), { status: 401, headers: { "content-type": "application/json" } }),
    })
    api.restore()

    await expect(api.run("account.get")).rejects.toThrow(/Bearer token is invalid/)
    expect(store.held()).toEqual(TOKENS)
    expect(api.state()).toMatchObject({ status: "signed" })
  })

  test("surfaces a non-401 failure without discarding the session", async () => {
    // A 500 is the server's problem, not the credential's. Clearing on it would
    // sign the user out every time the control plane hiccups.
    const { api, store } = service({
      store: memoryStore(TOKENS),
      fetch: async () => new Response("", { status: 500 }),
    })
    api.restore()

    await expect(api.run("account.get")).rejects.toThrow(/failed: 500/)
    expect(store.held()).toEqual(TOKENS)
  })

  test("does not return an account-scoped response that completed after sign-out", async () => {
    let release!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => {
      release = resolve
    })
    const { api } = service({ store: memoryStore(TOKENS), fetch: async () => await pending })
    api.restore()

    const operation = api.run("account.get")
    await Promise.resolve()
    await api.signOut()
    release(new Response(JSON.stringify({ userId: "old-owner" }), { status: 200 }))

    await expect(operation).rejects.toThrow("not signed in")
    expect(api.state()).toEqual({ status: "unsigned" })
  })
})

describe("refresh", () => {
  const RENEWED: TokenSet = { accessToken: "at_2", refreshToken: "rt_2", expiresAt: 20_000 }

  test("renews before expiry and stores the new token", async () => {
    const { api, requests, store } = service({
      store: memoryStore(TOKENS),
      now: 9_999,
      refresh: async () => ({ ok: true, tokens: RENEWED }),
    })
    api.restore()

    await api.run("account.get")

    expect(requests[0]!.headers.authorization).toBe("Bearer at_2")
    expect(store.held()).toEqual(RENEWED)
  })

  test("carries the session past the access token's expiry", async () => {
    // The whole point. `now` is well beyond `expiresAt`, which used to be a
    // permanent sign-out: the operation must simply succeed, on the new token.
    const { api, requests, store } = service({
      store: memoryStore(TOKENS),
      now: 50_000,
      refresh: async (token) => {
        expect(token).toBe("rt_1")
        return { ok: true, tokens: RENEWED }
      },
    })
    api.restore()

    await expect(api.run("account.get")).resolves.toEqual({ ok: true })
    expect(requests[0]!.headers.authorization).toBe("Bearer at_2")
    expect(api.state()).toMatchObject({ status: "signed" })
    expect(store.held()).toEqual(RENEWED)
  })

  test("does not renew a token that is still comfortably valid", async () => {
    let refreshes = 0
    const { api } = service({
      store: memoryStore(TOKENS),
      now: 1_000,
      refresh: async () => {
        refreshes++
        return { ok: true, tokens: TOKENS }
      },
    })
    api.restore()

    await api.run("account.get")

    expect(refreshes).toBe(0)
  })

  test("runs one exchange for concurrent callers rather than one each", async () => {
    // A renderer painting a screen asks for four things at once, and they cross
    // the skew window together. Four exchanges with the same refresh token
    // means, against a rotating server, three `invalid_grant`s — which would
    // sign the user out of the session the first one just renewed.
    let started = 0
    let release: (outcome: RefreshOutcome) => void = () => {}
    const pendingExchange = new Promise<RefreshOutcome>((resolve) => {
      release = resolve
    })
    const { api, requests } = service({
      store: memoryStore(TOKENS),
      now: 9_999,
      refresh: async () => {
        started++
        return await pendingExchange
      },
    })
    api.restore()

    const calls = [api.run("account.get"), api.run("account.get"), api.run("account.get")]
    await Promise.resolve()
    release({ ok: true, tokens: RENEWED })
    await Promise.all(calls)

    expect(started).toBe(1)
    expect(requests).toHaveLength(3)
    expect(requests.map((request) => request.headers.authorization)).toEqual([
      "Bearer at_2",
      "Bearer at_2",
      "Bearer at_2",
    ])
  })

  test("signs out when the authorization server says the grant is dead", async () => {
    // `invalid_grant` is a real revocation: the refresh token will never work
    // again, so holding the session open would leave the user in a signed-in
    // shell that can do nothing.
    const { api, requests, store } = service({
      store: memoryStore(TOKENS),
      now: 9_999,
      refresh: async () => ({ ok: false, reason: "revoked", detail: "invalid_grant" }),
    })
    api.restore()

    await expect(api.run("account.get")).rejects.toThrow(/not signed in/)
    expect(requests).toEqual([])
    expect(store.held()).toBeUndefined()
    expect(api.state()).toMatchObject({ status: "unavailable", reason: "revoked" })
  })

  test("keeps the session when renewal could not reach an answer", async () => {
    // An offline laptop is not a revoked session. Discarding the credential
    // here would sign the user out on a dropped wifi connection and take the
    // refresh token with it, so reconnecting could not recover.
    let attempts = 0
    const { api, store } = service({
      store: memoryStore(TOKENS),
      now: 9_999,
      refresh: async () => {
        attempts++
        return attempts === 1
          ? { ok: false, reason: "unavailable", detail: "network unreachable" }
          : { ok: true, tokens: RENEWED }
      },
    })
    api.restore()

    await expect(api.run("account.get")).rejects.toThrow(/could not renew the session/)
    expect(store.held()).toEqual(TOKENS)
    expect(api.state()).toMatchObject({ status: "signed" })

    // And the next attempt, once the network is back, simply works.
    await expect(api.run("account.get")).resolves.toEqual({ ok: true })
    expect(store.held()).toEqual(RENEWED)
  })

  test("treats a thrown exchange as transient, not as revocation", async () => {
    // An exception carries no verdict about the credential. Reading one into it
    // means any bug in the seam permanently signs the user out.
    const { api, store } = service({
      store: memoryStore(TOKENS),
      now: 9_999,
      refresh: async () => {
        throw new Error("boom")
      },
    })
    api.restore()

    await expect(api.run("account.get")).rejects.toThrow(/could not renew the session/)
    expect(store.held()).toEqual(TOKENS)
    expect(api.state()).toMatchObject({ status: "signed" })
  })

  test("signs out when the credential carries nothing to renew with", async () => {
    // A provider that issued no refresh token — the default scope asks for one,
    // but not every provider honours it. Renewal is impossible, so this really
    // is the end of the session; the exchange must not even be attempted.
    let attempts = 0
    const { api, requests, store } = service({
      store: memoryStore({ accessToken: "at", expiresAt: 10_000 }),
      now: 9_999,
      refresh: async () => {
        attempts++
        return { ok: true, tokens: RENEWED }
      },
    })
    api.restore()

    await expect(api.run("account.get")).rejects.toThrow(/not signed in/)
    expect(attempts).toBe(0)
    expect(requests).toEqual([])
    expect(store.held()).toBeUndefined()
    expect(api.state()).toMatchObject({ status: "unavailable", reason: "revoked" })
  })

  test("does not revive a session that was signed out while it was renewing", async () => {
    let release: (outcome: RefreshOutcome) => void = () => {}
    const { api, store } = service({
      store: memoryStore(TOKENS),
      now: 9_999,
      refresh: () =>
        new Promise<RefreshOutcome>((resolve) => {
          release = resolve
        }),
    })
    api.restore()

    const call = api.run("account.get")
    await Promise.resolve()
    await api.signOut()
    release({ ok: true, tokens: RENEWED })

    await expect(call).rejects.toThrow(/not signed in/)
    expect(store.held()).toBeUndefined()
    expect(api.state()).toEqual({ status: "unsigned" })
  })
})

describe("restart", () => {
  /** Reversible, not secure — the point is to exercise the real store. */
  function diskStore() {
    let contents: string | undefined
    return {
      contents: () => contents,
      store: createCredentialStore({
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (plain) => Buffer.from(`enc:${plain}`),
          decryptString: (encrypted) => encrypted.toString().replace(/^enc:/, ""),
          getSelectedStorageBackend: () => "unknown",
        },
      }),
    })
    await h.service.restore()

    const logout = h.service.signOut()
    const signIn = h.service.signIn()
    finish()
    await Promise.all([logout, signIn])

    expect(h.service.state()).toMatchObject({ status: "signed" })
    expect(h.store.held()).toMatchObject(CREDENTIAL)
  })

  test("a 401 ends the session without refresh-and-retry", async () => {
    const selectedAuth = authHarness()
    const h = harness({
      store: memoryStore(CREDENTIAL),
      auth: selectedAuth,
      fetch: async () => new Response("", { status: 401 }),
    })
    await h.service.restore()

    expect(service({ store }).api.restore()).toEqual({
      status: "unavailable",
      reason: "no-secure-storage",
      detail: "the OS credential store is locked",
    })
    expect(loads).toBe(1)
    expect(store.held()).toEqual(TOKENS)
  })

  test("never throws, because this runs during launch", () => {
    // A stale or unreadable credential must not be able to prevent the app
    // from starting.
    const store = memoryStore()
    store.load = () => {
      throw new Error("keyring locked")
    }

    expect(() => service({ store }).api.restore()).not.toThrow()
  })
})

describe("signIn", () => {
  test("adopts the credential and reports signed", async () => {
    const { api, store, completeSignIn } = service()

    await expect(completeSignIn()).resolves.toMatchObject({ ok: true })
    expect(api.state()).toMatchObject({ status: "signed" })
    expect(store.held()).toEqual(TOKENS)
  })

  test("publishes display identity from resolveIdentity after sign-in", async () => {
    const { api, completeSignIn } = service({
      resolveIdentity: async () => ({
        userId: "user_yash",
        displayName: "Yash Rathore",
        email: "yash@example.com",
      }),
    })

    await expect(completeSignIn()).resolves.toMatchObject({ ok: true })
    await Promise.resolve()
    expect(api.state()).toEqual({
      status: "signed",
      identity: {
        userId: "user_yash",
        displayName: "Yash Rathore",
        email: "yash@example.com",
      },
    })
  })

  test("stays signed with an empty identity when resolveIdentity fails", async () => {
    const errors: Array<{ stage: string; error: unknown }> = []
    const { api, completeSignIn } = service({
      errors,
      resolveIdentity: async () => {
        throw new Error("userinfo down")
      },
    })

    await expect(completeSignIn()).resolves.toMatchObject({ ok: true })
    expect(api.state()).toEqual({ status: "signed", identity: { userId: "" } })
    expect(errors.map((entry) => entry.stage)).toContain("identity")
  })

  test("publishes adopted credentials before a never-settling identity lookup", async () => {
    const { api, completeSignIn } = service({
      resolveIdentity: async () => await new Promise<{ userId: string }>(() => {}),
    })

    await expect(completeSignIn()).resolves.toMatchObject({ ok: true })
    expect(api.state()).toEqual({ status: "signed", identity: { userId: "" } })
  })

  test("does not republish identity after sign-out while userinfo is in flight", async () => {
    let resolveIdentity!: (identity: { userId: string; displayName?: string }) => void
    const { api, completeSignIn } = service({
      resolveIdentity: () => new Promise((resolve) => {
        resolveIdentity = resolve
      }),
    })

    await expect(completeSignIn()).resolves.toMatchObject({ ok: true })
    await api.signOut()
    resolveIdentity({ userId: "user_stale", displayName: "Stale User" })
    await Promise.resolve()

    expect(api.state()).toEqual({ status: "unsigned" })
  })

  test("leaves no live token and no pending state when the credential cannot be stored", async () => {
    // `save` throws when the keyring has gone away. Publishing the token in
    // memory first would leave `run()` able to spend a credential this process
    // could not keep, while `state` sat at `pending` for the rest of the
    // session — a resting state that means "a sign-in is happening" long after
    // one stopped.
    const store = memoryStore()
    store.save = () => {
      throw new Error("refusing to store a credential: the keyring is gone")
    }
    const errors: Array<{ stage: string; error: unknown }> = []
    const { api, requests, completeSignIn } = service({ store, errors })

    const result = await completeSignIn()

    expect(result).toMatchObject({ ok: false, reason: "no-secure-storage" })
    expect(api.state()).toMatchObject({ status: "unavailable", reason: "no-secure-storage" })
    expect(api.state().status).not.toBe("pending")
    expect(store.held()).toBeUndefined()
    // The half that a state assertion alone would miss: nothing spendable is
    // left behind in memory either.
    await expect(api.run("account.get")).rejects.toThrow(/not signed in/)
    expect(requests).toEqual([])
    expect(errors.map((entry) => entry.stage)).toContain("persist")
  })

  test("leaves no live token when a renewal cannot be stored", async () => {
    // The same transaction, on the other adoption path.
    const store = memoryStore(TOKENS)
    const { api, requests } = service({
      store,
      now: 9_999,
      refresh: async () => ({ ok: true, tokens: { accessToken: "at_2", refreshToken: "rt_2", expiresAt: 20_000 } }),
    })
    api.restore()
    store.save = () => {
      throw new Error("keyring locked")
    }

    await expect(api.run("account.get")).rejects.toThrow(/could not be stored/)
    expect(requests).toEqual([])
    expect(api.state()).toMatchObject({ status: "unavailable" })
    await expect(api.run("account.get")).rejects.toThrow(/not signed in/)
  })

  test("does not adopt a successful OAuth result after sign-out cancelled the attempt", async () => {
    let release!: (tokens: TokenSet) => void
    const exchange = new Promise<TokenSet>((resolve) => {
      release = resolve
    })
    const { api, store, completeSignIn } = service({ exchange: async () => await exchange })

    const signingIn = completeSignIn()
    await Promise.resolve()
    await api.signOut()
    release(TOKENS)

    await expect(signingIn).resolves.toMatchObject({ ok: false })
    expect(api.state()).toEqual({ status: "unsigned" })
    expect(store.held()).toBeUndefined()
  })

  test("returns to unsigned after the browser callback times out", async () => {
    // A resting `unavailable`/`pending` after timeout hid Sign in in the rail.
    // Unsigned is the retryable resting state for a failed browser round-trip.
    let fireTimeout: (() => void) | undefined
    let announce: (url: string) => void = () => {}
    const opened = new Promise<string>((resolve) => {
      announce = resolve
    })
    const api = createAccountService({
      config: CONFIG,
      seams: {
        openExternal: async (url) => announce(url),
        listen: async () => ({ port: 49_152, close: async () => {} }),
        exchange: async () => TOKENS,
        safeStorage: () => ({ available: true, platform: "darwin" }),
        setTimeout: (fn) => {
          fireTimeout = fn
          return { cancel: () => { fireTimeout = undefined } }
        },
      },
      store: memoryStore(),
      serverOrigin: "https://control.test",
      now: () => 1_000,
      fetch: async () => new Response("{}", { status: 200 }),
    })

    const signingIn = api.signIn()
    await opened
    expect(api.state()).toEqual({ status: "pending" })
    fireTimeout!()
    await expect(signingIn).resolves.toMatchObject({ ok: false, reason: "timeout" })
    expect(api.state()).toEqual({ status: "unsigned" })
  })
})

describe("signOut", () => {
  test("clears the credential and reports unsigned", async () => {
    const { api, store } = service({ store: memoryStore(TOKENS) })
    api.restore()

    await api.signOut()

    expect(store.held()).toBeUndefined()
    expect(api.state()).toEqual({ status: "unsigned" })
  })

  test("publishes the authoritative transition for lifecycle consumers", async () => {
    const states: AccountState[] = []
    const { api } = service({ store: memoryStore(TOKENS), states })
    api.restore()

    await api.signOut()

    expect(states.at(-1)).toEqual({ status: "unsigned" })
  })
})

describe("the service surface", () => {
  test("exposes no way to obtain the token", async () => {
    // The guard that matters for everything downstream: if a method here
    // returned the credential, every IPC handler could hand it to the renderer
    // by accident.
    const { api } = service({ store: memoryStore(TOKENS) })
    api.restore()

    const members = Object.keys(api)
    expect(members.sort()).toEqual(["openStream", "restore", "run", "signIn", "signOut", "state"])
    expect(JSON.stringify(api.state())).not.toContain("at_1")
  })
})
