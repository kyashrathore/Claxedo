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

function authHarness(overrides: Partial<DesktopNativeAuth> = {}) {
  let validates = 0
  let refreshes = 0
  let revokes = 0
  const auth: DesktopNativeAuth = {
    cancel() {},
    discover: async () => ({ binding: BINDING }) as never,
    validate: async () => {
      validates++
      return { binding: BINDING } as never
    },
    signIn: async () => ({ ok: true, credential: CREDENTIAL }),
    refresh: async () => {
      refreshes++
      return { ok: true, tokens: { accessToken: "at_2", refreshToken: "rt_2", expiresAt: 20_000 } }
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

  test("failed sign-in returns to unsigned with the canonical diagnostic", async () => {
    const h = harness({
      auth: authHarness({
        signIn: async () => ({ ok: false, reason: "callback-failed", detail: "token exchange failed: 503" }),
      }),
    })

    await expect(h.service.signIn()).resolves.toEqual({
      ok: false,
      reason: "callback-failed",
      detail: "token exchange failed: 503",
    })
    expect(h.service.state()).toEqual({ status: "unsigned", detail: "token exchange failed: 503" })
  })

  test("a concurrent sign-in waits for the durable logout boundary before replacing the credential", async () => {
    let finish!: () => void
    const remote = new Promise<void>((resolve) => {
      finish = resolve
    })
    const h = harness({
      store: memoryStore(CREDENTIAL),
      auth: authHarness({
        revoke: async () => {
          await remote
          return { state: "confirmed" }
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

    await expect(h.service.run("account.get")).rejects.toThrow("session rejected")
    expect(h.store.held()).toBeUndefined()
    expect(selectedAuth.refreshes()).toBe(0)
  })

  test("keeps a bound session when the control plane reports a token-shape error", async () => {
    const store = memoryStore(CREDENTIAL)
    const h = harness({
      store,
      fetch: async () => Response.json({
        error: { code: "invalid_bearer_token", message: "Bearer token is invalid" },
      }, { status: 401 }),
    })
    await h.service.restore()

    await expect(h.service.run("account.get")).rejects.toThrow("Bearer token is invalid")
    expect(store.held()).toBeDefined()
    expect(h.service.state()).toMatchObject({ status: "signed" })
  })

  test("envelopes binary exports without exposing the authenticated response", async () => {
    const h = harness({
      store: memoryStore(CREDENTIAL),
      fetch: async () => new Response(new Uint8Array([0, 1, 255]), {
        headers: { "content-type": "application/pdf" },
      }),
    })
    await h.service.restore()

    await expect(h.service.run("documents.export", { id: "document_1" })).resolves.toEqual({
      bytesBase64: "AAH/",
      contentType: "application/pdf",
    })
  })

  test("opens named streams only against the credential-bound core", async () => {
    let request: { url: string; headers: Record<string, string> } | undefined
    const chunks: string[] = []
    const h = harness({
      store: memoryStore(CREDENTIAL),
      fetch: async (url, init) => {
        request = { url, headers: init.headers }
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: ready\n\n"))
            controller.close()
          },
        }), { headers: { "content-type": "text/event-stream" } })
      },
    })
    await h.service.restore()

    await h.service.openStream({
      name: "session.events",
      params: { lastEventId: "evt_9" },
      onChunk: (chunk) => chunks.push(chunk),
    })

    expect(request).toEqual({
      url: "https://core.example/api/wr/events",
      headers: {
        authorization: "Bearer at_1",
        Accept: "text/event-stream",
        "Last-Event-ID": "evt_9",
      },
    })
    expect(chunks.join("")).toBe("event: ready\n\n")
    await expect(h.service.run("session.events")).rejects.toThrow("is a stream")
  })
})
