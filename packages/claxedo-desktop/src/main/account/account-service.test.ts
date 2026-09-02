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
    onStateChange?: Parameters<typeof createAccountService>[0]["onStateChange"]
    scheduleRevalidation?: Parameters<typeof createAccountService>[0]["scheduleRevalidation"]
  } = {},
) {
  const store = input.store ?? memoryStore()
  const selectedAuth = input.auth ?? authHarness()
  const requests: Array<{ url: string; init: Parameters<Parameters<typeof createAccountService>[0]["fetch"]>[1] }> = []
  const service = createAccountService({
    auth: selectedAuth.auth,
    store,
    now: () => input.now ?? 1_000,
    ...(input.onStateChange ? { onStateChange: input.onStateChange } : {}),
    ...(input.scheduleRevalidation ? { scheduleRevalidation: input.scheduleRevalidation } : {}),
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

    expect(await h.service.run("account.mode")).toEqual({ ok: true })
    expect(h.auth.validates()).toBe(2)
    expect(h.requests[0]?.url).toBe("https://core.example/api/claxedo/mode")
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
    await expect(h.service.run("account.mode")).rejects.toThrow("not signed in")
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
    await expect(h.service.run("account.mode")).rejects.toThrow("not signed in")
  })

  /**
   * A routine redeploy 503'd the descriptor for ~2s and the desktop went to
   * "Sign in": remote access stopped, the enrollment lease lapsed, and every
   * other device was told the host was offline. An endpoint we could not
   * reach has made no statement about this credential, so the session must
   * survive the blip and recover on the next attempt.
   */
  test("an unreachable descriptor never rejects the credential, and the next attempt recovers", async () => {
    let reachable = false
    const h = harness({
      store: memoryStore(CREDENTIAL),
      auth: authHarness({
        validate: async () => {
          if (!reachable) throw new DesktopAuthDescriptorError("descriptor_unavailable", "failed: 503")
        },
      }),
    })

    await h.service.restore()
    await expect(h.service.run("account.mode")).rejects.toThrow("not signed in")
    // Fail closed — but the credential itself was never in question.
    expect(h.service.state()).toMatchObject({ status: "unavailable" })
    expect(h.store.held(), "the credential is intact — nothing rejected it").toBeDefined()
    expect(h.store.rejected).toEqual([])

    reachable = true
    await expect(h.service.run("account.mode")).resolves.toBeDefined()
    expect(h.service.state(), "recovery must be observable as a return to signed").toMatchObject({ status: "signed" })
  })

  /**
   * The live outage: a ~2s descriptor 503 during a redeploy left the desktop
   * on "Sign in" — and remote access suspended — with nothing to bring it
   * back, because only boot and an interactive sign-in ever produce `signed`.
   * The retry is what makes the blip self-healing, and the signed transition
   * it produces is what resumes the Host Connector.
   */
  test("recovers on its own after an unreachable deployment returns, with no user action", async () => {
    let reachable = false
    let scheduled: (() => void) | undefined
    const transitions: string[] = []
    const h = harness({
      store: memoryStore(CREDENTIAL),
      auth: authHarness({
        validate: async () => {
          if (!reachable) throw new DesktopAuthDescriptorError("descriptor_unavailable", "failed: 503")
        },
      }),
      onStateChange: (next: { status: string }) => transitions.push(next.status),
      scheduleRevalidation: (run: () => void) => {
        scheduled = run
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
    })

    await h.service.restore()
    expect(h.service.state()).toMatchObject({ status: "unavailable" })
    expect(scheduled, "a blip must arm a retry").toBeDefined()

    reachable = true
    scheduled!()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.service.state()).toMatchObject({ status: "signed" })
    expect(transitions.at(-1)).toBe("signed")
  })

  /**
   * The running case, distinct from a blip during restore: the credential is
   * already adopted when the deployment goes unreachable. This is what
   * happened live — signed, serving, then a redeploy's 503 — and the session
   * must come back on the next successful validate rather than staying
   * unavailable until someone signs in again.
   */
  /**
   * The rail showed "Signed in" with both "Cancel sign in" and "Log out":
   * a second sign-in while signed replaced the working session with
   * `pending`, and cancelling it logged the user out. Signed is the goal.
   */
  test("sign-in while already signed keeps the session and starts no flow", async () => {
    let flows = 0
    const h = harness({
      store: memoryStore(CREDENTIAL),
      auth: authHarness({
        signIn: async () => {
          flows++
          return { ok: true, credential: CREDENTIAL }
        },
      }),
    })
    await h.service.restore()
    expect(h.service.state()).toMatchObject({ status: "signed" })

    await expect(h.service.signIn()).resolves.toEqual({ ok: true })

    expect(flows, "no browser flow for an account that is already signed").toBe(0)
    expect(h.service.state()).toMatchObject({ status: "signed" })
  })

  /** A failed profile lookup must not leave the rail spinning forever: still signed, lookup failed. */
  test("a failed identity lookup stays signed and says the lookup failed", async () => {
    const h = harness({ store: memoryStore(CREDENTIAL) })
    const service = createAccountService({
      auth: h.auth.auth,
      store: h.store,
      now: () => 1_000,
      fetch: async () => Response.json({ ok: true }),
      resolveIdentity: async () => {
        throw new Error("userinfo failed: 401")
      },
    })
    await service.restore()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(service.state()).toEqual({ status: "signed", identity: { userId: "" }, identityLookup: "failed" })
  })

  test("a blip while already signed suspends, then returns to signed on the next success", async () => {
    let reachable = true
    const h = harness({
      store: memoryStore(CREDENTIAL),
      auth: authHarness({
        validate: async () => {
          if (!reachable) throw new DesktopAuthDescriptorError("descriptor_unavailable", "failed: 503")
        },
      }),
    })

    await h.service.restore()
    expect(h.service.state()).toMatchObject({ status: "signed" })

    reachable = false
    await expect(h.service.run("account.mode")).rejects.toThrow("not signed in")
    expect(h.service.state(), "fail closed while the deployment is unreachable, and say it is transient").toMatchObject({
      status: "unavailable",
      transient: true,
    })

    reachable = true
    await expect(h.service.run("account.mode")).resolves.toBeDefined()
    expect(h.service.state(), "the session must return without a new sign-in").toMatchObject({ status: "signed" })
  })

  /**
   * A refresh-family rotation revokes the access tokens minted before it, so a
   * desktop can hold a locally-unexpired token the server has already retired
   * while its refresh grant is alive. Observed live: every operation 401'd,
   * remote access could not start, and the account still showed as signed in.
   * One renewal recovers it; treating that 401 as revocation did not.
   */
  test("renews once and retries when the server retires an unexpired access token", async () => {
    let seenTokens: string[] = []
    const h = harness({
      store: memoryStore(CREDENTIAL),
      fetch: async (url, init) => {
        const token = String((init?.headers as Record<string, string>)?.authorization ?? "")
        seenTokens.push(token)
        if (token.includes("at_1")) {
          return Response.json({ error: { code: "invalid_credentials" } }, { status: 401 })
        }
        return Response.json({ ok: true })
      },
    })

    await h.service.restore()
    await expect(h.service.run("account.mode")).resolves.toMatchObject({ ok: true })
    expect(seenTokens.length, "the retired token, then the renewed one").toBe(2)
    expect(h.service.state(), "a recoverable 401 must not sign the user out").toMatchObject({ status: "signed" })
  })

  test("a 401 that survives renewal is a real revocation and ends the session", async () => {
    const h = harness({
      store: memoryStore(CREDENTIAL),
      fetch: async () => Response.json({ error: { code: "invalid_credentials" } }, { status: 401 }),
    })

    await h.service.restore()
    await expect(h.service.run("account.mode")).rejects.toThrow("session rejected")
    expect(h.service.state()).toMatchObject({ status: "unavailable", reason: "revoked" })
  })

  test("a descriptor that answers and rejects still ends the session", async () => {
    const h = harness({
      store: memoryStore(CREDENTIAL),
      auth: authHarness({
        validate: async () => {
          throw new DesktopAuthDescriptorError("invalid_descriptor", "not valid JSON")
        },
      }),
    })

    await h.service.restore()
    expect(h.service.state()).toMatchObject({ status: "unavailable", reason: "callback-failed" })
  })

  test("serializes refresh and compare-and-swap replaces the complete binding plus tokens", async () => {
    const selectedAuth = authHarness()
    const h = harness({
      store: memoryStore({ ...CREDENTIAL, tokens: { ...CREDENTIAL.tokens, expiresAt: 1_001 } }),
      auth: selectedAuth,
      now: 1_000,
    })
    await h.service.restore()

    await Promise.all([h.service.run("account.mode"), h.service.run("account.mode")])
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

  test("a failed refresh answers later operations without re-running until the cool-down passes", async () => {
    let clock = 1_000
    let refreshAttempts = 0
    const selectedAuth = authHarness({
      refresh: async () => {
        refreshAttempts += 1
        return { ok: false, reason: "unavailable", detail: "refresh request failed: stalled" }
      },
    })
    const store = memoryStore({ ...CREDENTIAL, tokens: { ...CREDENTIAL.tokens, expiresAt: 1_001 } })
    const service = createAccountService({
      auth: selectedAuth.auth,
      store,
      now: () => clock,
      fetch: async () => Response.json({ ok: true }),
    })
    await service.restore()

    await expect(service.run("account.mode")).rejects.toThrow("could not renew the session")
    // Boot issues hosted operations serially; each must NOT wait out another
    // full refresh against a deployment already known to be stalling.
    await expect(service.run("account.mode")).rejects.toThrow("could not renew the session")
    await expect(service.run("org.list")).rejects.toThrow("could not renew the session")
    expect(refreshAttempts).toBe(1)

    clock += 21_000
    await expect(service.run("account.mode")).rejects.toThrow("could not renew the session")
    expect(refreshAttempts).toBe(2)
  })

  test("a 401 costs exactly one renewal, then ends the session", async () => {
    const selectedAuth = authHarness()
    let attempts = 0
    const h = harness({
      store: memoryStore(CREDENTIAL),
      auth: selectedAuth,
      fetch: async () => {
        attempts += 1
        return new Response("", { status: 401 })
      },
    })
    await h.service.restore()

    await expect(h.service.run("account.mode")).rejects.toThrow("session rejected")
    expect(h.store.held()).toBeUndefined()
    // Bounded: one renewal and one re-issue. The point of the original
    // assertion — never loop against a token the server keeps refusing —
    // still holds; what changed is that a token retired early by a
    // refresh-family rotation now gets its single second chance.
    expect(selectedAuth.refreshes()).toBe(1)
    expect(attempts).toBe(2)
  })

  test("keeps a bound session when the request carried no credential at all", async () => {
    const store = memoryStore(CREDENTIAL)
    const h = harness({
      store,
      fetch: async () => Response.json({
        error: { code: "missing_bearer_token", message: "Bearer token is required" },
      }, { status: 401 }),
    })
    await h.service.restore()

    // Sending no credential is a client bug, not a statement about the
    // session, so it must not cost the user their sign-in.
    await expect(h.service.run("account.mode")).rejects.toThrow("Bearer token is required")
    expect(store.held()).toBeDefined()
    expect(h.service.state()).toMatchObject({ status: "signed" })
  })

  /**
   * `invalid_bearer_token` is what this control plane returns for ANY rejected
   * token — verified live against the deployment with a junk bearer. It was
   * being read as a Clerk-era "wrong token shape, nothing to renew", which
   * returned before the renewal path and left the desktop wedged: signed in
   * by appearance, 401 on every operation, remote access unable to start.
   */
  test("an invalid_bearer_token is renewed and retried, not treated as a misconfiguration", async () => {
    const seen: string[] = []
    const h = harness({
      store: memoryStore(CREDENTIAL),
      fetch: async (url, init) => {
        const token = String((init?.headers as Record<string, string>)?.authorization ?? "")
        seen.push(token)
        if (token.includes("at_1")) {
          return Response.json(
            { error: { code: "invalid_bearer_token", message: "Authentication credential is invalid" } },
            { status: 401 },
          )
        }
        return Response.json({ ok: true })
      },
    })
    await h.service.restore()

    await expect(h.service.run("account.mode")).resolves.toMatchObject({ ok: true })
    expect(seen.length).toBe(2)
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
