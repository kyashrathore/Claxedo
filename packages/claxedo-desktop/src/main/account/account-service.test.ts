import { describe, expect, test } from "bun:test"
import { createAccountService } from "./account-service"
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

function service(overrides: {
  store?: ReturnType<typeof memoryStore>
  fetch?: Parameters<typeof createAccountService>[0]["fetch"]
  refresh?: (token: string) => Promise<TokenSet>
  now?: number
} = {}) {
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = []
  const store = overrides.store ?? memoryStore()
  let callback: ((url: string) => unknown) | undefined
  const seams: OAuthSeams = {
    openExternal: async () => {},
    listen: async (handler) => {
      callback = handler
      return { port: 49_152, close: async () => {} }
    },
    exchange: async () => TOKENS,
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
  })
  return { api, requests, store, deliverCallback: (state: string) => callback?.(`${REDIRECT_PATH}?code=c&state=${state}`) }
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
})

describe("refresh", () => {
  test("renews before expiry and stores the new token", async () => {
    const renewed: TokenSet = { accessToken: "at_2", refreshToken: "rt_2", expiresAt: 20_000 }
    const { api, requests, store } = service({
      store: memoryStore(TOKENS),
      now: 9_999,
      refresh: async () => renewed,
    })
    api.restore()

    await api.run("account.get")

    expect(requests[0]!.headers.authorization).toBe("Bearer at_2")
    expect(store.held()).toEqual(renewed)
  })

  test("does not renew a token that is still comfortably valid", async () => {
    let refreshes = 0
    const { api } = service({
      store: memoryStore(TOKENS),
      now: 1_000,
      refresh: async () => {
        refreshes++
        return TOKENS
      },
    })
    api.restore()

    await api.run("account.get")

    expect(refreshes).toBe(0)
  })

  test("signs out when renewal fails instead of sending a dead token", async () => {
    // Otherwise the user sees a screenful of failed requests rather than
    // "signed out", and the real cause is three layers down.
    const { api, requests, store } = service({
      store: memoryStore(TOKENS),
      now: 9_999,
      refresh: async () => {
        throw new Error("refresh rejected")
      },
    })
    api.restore()

    await expect(api.run("account.get")).rejects.toThrow(/not signed in/)
    expect(requests).toEqual([])
    expect(store.held()).toBeUndefined()
  })

  test("signs out when the token is expired and nothing can renew it", async () => {
    const { api, requests } = service({ store: memoryStore({ accessToken: "at", expiresAt: 10_000 }), now: 9_999 })
    api.restore()

    await expect(api.run("account.get")).rejects.toThrow(/not signed in/)
    expect(requests).toEqual([])
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

describe("signOut", () => {
  test("clears the credential and reports unsigned", async () => {
    const { api, store } = service({ store: memoryStore(TOKENS) })
    api.restore()

    await api.signOut()

    expect(store.held()).toBeUndefined()
    expect(api.state()).toEqual({ status: "unsigned" })
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
    expect(members.sort()).toEqual(["restore", "run", "signIn", "signOut", "state"])
    expect(JSON.stringify(api.state())).not.toContain("at_1")
  })
})
