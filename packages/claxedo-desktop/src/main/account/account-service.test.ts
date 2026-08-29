import { describe, expect, test } from "bun:test"
import { createAccountService, type AccountState, type RefreshOutcome } from "./account-service"
import { createCredentialStore } from "./credential-store"
import type { CredentialStore, TokenSet } from "./credential-store"
import { REDIRECT_PATH } from "./oauth-flow"
import type { OAuthSeams } from "./oauth-flow"

/**
 * What main does with the credential once it has one.
 *
 * The claims worth holding are all about what does NOT come back out: no token
 * on any return path, no renderer-chosen url, no retry loop against a revoked
 * session. Each is a line someone could add in good faith while making a
 * feature work.
 */

const CONFIG = {
  authorizeUrl: "https://accounts.example.com/oauth/authorize",
  tokenUrl: "https://accounts.example.com/oauth/token",
  clientId: "client_desktop",
  scope: "openid",
  timeoutMs: 1_000,
}

const TOKENS: TokenSet = { accessToken: "at_1", refreshToken: "rt_1", expiresAt: 10_000 }

function memoryStore(initial?: TokenSet) {
  let held = initial
  const store: CredentialStore & { held: () => TokenSet | undefined } = {
    available: () => ({ usable: true }),
    save: (tokens) => {
      held = tokens
    },
    load: () => held,
    clear: () => {
      held = undefined
    },
    held: () => held,
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
  }
}

describe("run", () => {
  test("builds the request from the table and attaches the credential", async () => {
    const { api, requests, store } = service({ store: memoryStore(TOKENS) })
    api.restore()

    await api.run("workspace.checkpoints.list", { id: "ws_1" })

    expect(requests[0]).toMatchObject({
      url: "https://control.test/api/workspace/ws_1/checkpoints",
      method: "GET",
      headers: { authorization: "Bearer at_1" },
    })
    expect(store.held()).toEqual(TOKENS)
  })

  test("returns decoded data, never the response or the token", async () => {
    // Handing back a Response would hand back the headers, and one of them is
    // the single thing this whole design withholds.
    const { api } = service({ store: memoryStore(TOKENS) })
    api.restore()

    const result = await api.run("account.get")

    expect(result).toEqual({ ok: true })
    expect(result).not.toBeInstanceOf(Response)
    expect(JSON.stringify(result)).not.toContain("at_1")
  })

  test("refuses an operation the table does not name", async () => {
    const { api, requests } = service({ store: memoryStore(TOKENS) })
    api.restore()

    await expect(api.run("hostedFetch" as never, { url: "https://evil.test" })).rejects.toThrow(/no hosted operation/)
    expect(requests).toEqual([])
  })

  test("refuses before making a request when not signed in", async () => {
    const { api, requests } = service()

    await expect(api.run("account.get")).rejects.toThrow(/not signed in/)
    expect(requests).toEqual([])
  })

  test("signs out on a 401 rather than retrying", async () => {
    // A retry loop against a revoked token is a signed-out desktop hammering
    // the control plane while showing the user nothing.
    let calls = 0
    const { api, store } = service({
      store: memoryStore(TOKENS),
      fetch: async () => {
        calls++
        return new Response("", { status: 401 })
      },
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
        file: {
          read: () => contents,
          write: (next) => {
            contents = next
          },
          clear: () => {
            contents = undefined
          },
        },
        platform: "darwin",
      }),
    }
  }

  test("restores through a real store after the access token expired, and renews", async () => {
    // The path a user actually walks: sign in, close the laptop overnight,
    // reopen it. Every boot before this found nothing on disk, because `load`
    // had deleted the record — refresh token included — the first time it read
    // it past `expiresAt`.
    const disk = diskStore()
    disk.store.save(TOKENS)

    const { api, requests } = service({
      store: disk.store,
      now: 50_000,
      refresh: async (token) => ({
        ok: true,
        tokens: { accessToken: "at_2", refreshToken: token, expiresAt: 60_000 },
      }),
    })

    expect(api.restore()).toMatchObject({ status: "signed" })
    await expect(api.run("account.get")).resolves.toEqual({ ok: true })
    expect(requests[0]!.headers.authorization).toBe("Bearer at_2")
    expect(disk.contents()).toBeDefined()
  })

  test("stays signed out when the stored credential cannot be renewed", async () => {
    const disk = diskStore()
    disk.store.save({ accessToken: "at", expiresAt: 10_000 })

    const { api } = service({ store: disk.store, now: 50_000, refresh: async () => ({ ok: true, tokens: TOKENS }) })

    expect(api.restore()).toEqual({ status: "unsigned" })
    expect(disk.contents()).toBeUndefined()
  })
})

describe("restore", () => {
  test("adopts a stored credential at boot", async () => {
    const { api } = service({ store: memoryStore(TOKENS) })

    expect(api.restore()).toMatchObject({ status: "signed" })
  })

  test("stays unsigned when the store has nothing", () => {
    expect(service().api.restore()).toEqual({ status: "unsigned" })
  })

  test("reports unavailable secure storage without adopting or deleting a credential", () => {
    const store = memoryStore(TOKENS)
    let loads = 0
    store.available = () => ({
      usable: false,
      reason: "no-secure-storage",
      detail: "the OS credential store is locked",
    })
    store.load = () => {
      loads++
      return undefined
    }

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
