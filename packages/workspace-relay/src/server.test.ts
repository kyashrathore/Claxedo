import { describe, expect, test } from "bun:test"
import { decodeJwt, generateKeyPair } from "jose"
import { WorkspaceRelayAuthError, mintRuntimeAccessToken, verifyRelayHostToken } from "./auth"
import { CURRENT_CHANNEL_IDENTITY_VERSION } from "@claxedo/workspace-relay-protocol"
import { createWorkspaceRelayDurableObjectRoom, type WorkspaceRelayDurableObjectRoomOptions } from "./cloudflare"
import { createWorkspaceRelayDirectory } from "./directory"
import type { RuntimeAccessVerifierClaims } from "@claxedo/workspace-relay-protocol"
import {
  authorizeWorkspaceRelayRequest,
  createCachedRevocationClient,
  disposeAuditSampler,
  runtimeAccessTokenRevocationDelayMs,
  workspaceRelayForwardHeaders,
  workspaceRelayForwardRequestInit,
  workspaceRelayTargetUrl,
  type WorkspaceRelayAuditEvent,
  type WorkspaceRelayOptions,
} from "./server"
import { parseWorkspaceRelayTarget } from "./relay-target"

/**
 * Thea `fetch` double was called with. `fetch` accepts a string, a `URL`
 * or a `Request`, and only the string case survives `String()` — the other two
 * stringify to `[object Object]`, which would make every URL assertion below
 * pass or fail for the wrong reason.
 */
function fetchUrl(input: string | URL | Request) {
  if (typeof input === "string") return input
  return input instanceof URL ? input.href : input.url
}

/**
 * The Durable Object room is the relay's only request path, so the shared
 * authorization and forwarding rules are exercised through it.
 */
function relayRoom(options: WorkspaceRelayDurableObjectRoomOptions) {
  const room = createWorkspaceRelayDurableObjectRoom(options)
  return { request: (url: string, init?: RequestInit) => room.fetch(new Request(url, init)) }
}

function relayBacking(input: { backing?: "cloud-vm" | "local-worktree" }) {
  return { backing: input.backing ?? "cloud-vm" } as const
}

async function harness(
  input: Partial<Pick<WorkspaceRelayDurableObjectRoomOptions,
    | "isRuntimeAccessTokenActive"
    | "audit"
    | "fetch"
    | "directory"
    | "forwardTimeoutMs"
    | "relayHostTokenCacheTtlMs"
    | "runtimeAccessTokenCacheTtlMs"
    | "tokenVerifier"
    | "traceSampleRate"
  >> & {
    backing?: "cloud-vm" | "local-worktree"
  } = {},
) {
  const runtime = await generateKeyPair("EdDSA", { extractable: true })
  const relayHost = await generateKeyPair("EdDSA", { extractable: true })
  const forwarded: Array<{ url: string; request: Request }> = []
  const auditEvents: WorkspaceRelayAuditEvent[] = []
  const room = relayRoom({
    runtimeAccessKey: runtime.publicKey,
    relayHostSigningKey: relayHost.privateKey,
    relayHostAlgorithm: "EdDSA",
    resolveTarget: (claims) => ({
      workspaceId: claims.workspace_id,
      hostId: claims.host_id,
      baseUrl: "https://host.example.test",
      ...relayBacking(input),
    }),
    audit: (event) => {
      auditEvents.push(event)
      return input.audit?.(event)
    },
    ...(input.isRuntimeAccessTokenActive ? { isRuntimeAccessTokenActive: input.isRuntimeAccessTokenActive } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.directory ? { directory: input.directory } : {}),
    ...(input.forwardTimeoutMs !== undefined ? { forwardTimeoutMs: input.forwardTimeoutMs } : {}),
    ...(input.relayHostTokenCacheTtlMs !== undefined ? { relayHostTokenCacheTtlMs: input.relayHostTokenCacheTtlMs } : {}),
    ...(input.runtimeAccessTokenCacheTtlMs !== undefined ? { runtimeAccessTokenCacheTtlMs: input.runtimeAccessTokenCacheTtlMs } : {}),
    ...(input.tokenVerifier ? { tokenVerifier: input.tokenVerifier } : {}),
    ...(input.traceSampleRate !== undefined ? { traceSampleRate: input.traceSampleRate, traceLog: () => {} } : {}),
  })
  return {
    room,
    runtime,
    relayHost,
    forwarded,
    auditEvents,
    token: (role: "viewer" | "editor" | "admin" | "owner" = "editor", sessionId?: string) => mintRuntimeAccessToken({
      principalKind: "user",
      actorId: "actor_1",
      actorKind: "human",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role,
      ...(sessionId ? { sessionId } : {}),
    }, runtime.privateKey, "EdDSA"),
  }
}

describe("workspace relay server", () => {
  test("a channel actor's provenance reaches the host on the Relay Host Token", async () => {
    const relay = await harness()
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((url, init) => {
      relay.forwarded.push({ url: fetchUrl(url), request: new Request(url, init) })
      return Promise.resolve(new Response("ok"))
    }) as typeof fetch

    try {
      const runtimeAccessToken = await mintRuntimeAccessToken({
        principalKind: "user",
        actorId: "actor_1",
        actorKind: "human",
        orgId: "org_1",
        workspaceId: "ws_1",
        hostId: "host_1",
        role: "editor",
        channelIdentity: { channel: "telegram", externalUserId: "123456789", identityVersion: CURRENT_CHANNEL_IDENTITY_VERSION },
      }, relay.runtime.privateKey, "EdDSA")
      const res = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health", {
        headers: { authorization: `Bearer ${runtimeAccessToken}` },
      })

      expect(res.status).toBe(200)
      const auth = relay.forwarded[0]?.request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
      await expect(verifyRelayHostToken(auth!, relay.relayHost.publicKey, {
        workspaceId: "ws_1",
        hostId: "host_1",
      })).resolves.toMatchObject({
        parent_jti: decodeJwt(runtimeAccessToken).jti,
        channel_identity: { channel: "telegram", external_user_id: "123456789", identity_version: CURRENT_CHANNEL_IDENTITY_VERSION },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("forwards HTTP requests with a Relay Host Token", async () => {
    const relay = await harness()
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((url, init) => {
      const request = new Request(url, init)
      relay.forwarded.push({ url: fetchUrl(url), request })
      return Promise.resolve(new Response("ok", {
        status: 201,
        headers: {
          "content-type": "text/plain",
        },
      }))
    }) as typeof fetch

    try {
      const runtimeAccessToken = await relay.token()
      const res = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health?verbose=1", {
        headers: {
          authorization: `Bearer ${runtimeAccessToken}`,
        },
      })

      expect(res.status).toBe(201)
      await expect(res.text()).resolves.toBe("ok")
      expect(relay.forwarded[0]?.url).toBe("https://host.example.test/api/wr/health?verbose=1")
      const auth = relay.forwarded[0]?.request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
      expect(auth).toBeTruthy()
      await expect(verifyRelayHostToken(auth!, relay.relayHost.publicKey, {
        workspaceId: "ws_1",
        hostId: "host_1",
      })).resolves.toMatchObject({
        parent_jti: decodeJwt(runtimeAccessToken).jti,
        role: "editor",
        backing: "cloud-vm",
      })
      expect(relay.auditEvents).toContainEqual({
        action: "relay.request.accepted",
        result: "allow",
        principalKind: "user",
      actorId: "actor_1",
      actorKind: "human",
        role: "editor",
        workspaceId: "ws_1",
        hostId: "host_1",
        method: "GET",
        path: "/workspaces/ws_1/api/wr/health",
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("reports the authorization phases in server-timing for a sampled request", async () => {
    const relay = await harness({
      traceSampleRate: 1,
      fetch: (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch,
    })

    const res = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        authorization: `Bearer ${await relay.token()}`,
      },
    })

    expect(res.status).toBe(200)
    const timing = res.headers.get("server-timing") ?? ""
    for (const phase of ["rat-verify", "rat-active", "target-resolve", "audit", "rht-mint", "upstream-fetch", "relay-room-total"]) {
      expect(timing).toContain(`${phase};dur=`)
    }
  })

  test("default CORS policy still allows product and localhost origins", async () => {
    const relay = await harness({
      fetch: (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch,
    })

    for (const origin of ["https://app.claxedo.com", "https://claxedo.com", "http://localhost:4444"]) {
      const res = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health", {
        headers: {
          authorization: `Bearer ${await relay.token()}`,
          origin,
        },
      })
      expect(res.headers.get("access-control-allow-origin")).toBe(origin)
    }
  })

  test("reuses cached Relay Host Tokens while preserving revocation checks", async () => {
    const forwardedAuth: string[] = []
    let revocationCalls = 0
    const relay = await harness({
      traceSampleRate: 1,
      relayHostTokenCacheTtlMs: 30_000,
      isRuntimeAccessTokenActive: () => {
        revocationCalls++
        return { active: true }
      },
      fetch: ((_url, init) => {
        forwardedAuth.push(new Request("http://host.test", init).headers.get("authorization") ?? "")
        return Promise.resolve(new Response("ok"))
      }) as typeof fetch,
    })
    const token = await relay.token()

    const first = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: { authorization: `Bearer ${token}` },
    })
    const second = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(revocationCalls).toBe(2)
    expect(forwardedAuth.length).toBe(2)
    expect(forwardedAuth[0]).toBe(forwardedAuth[1])
    expect(second.headers.get("server-timing") ?? "").toContain("rht-cache;dur=")
  })

  test("isolates cached Relay Host Tokens by verified actor identity", async () => {
    const forwarded: string[] = []
    const relay = await harness({
      relayHostTokenCacheTtlMs: 30_000,
      tokenVerifier: {
        async verify(token) {
          return {
            subject: "shared-subject",
            scopes: ["workspace:write"],
            claims: {
              iss: "claxedo-control-plane",
              aud: "workspace-relay",
              principal_kind: "user",
              actor_id: token === "actor-a-token" ? "actor_a" : "actor_b",
              actor_kind: "human",
              actor_public_id: token === "actor-a-token" ? "usr_public_a" : "usr_public_b",
              actor_name: token === "actor-a-token" ? "Ada" : "Grace",
              org_id: "org_1",
              workspace_id: "ws_1",
              host_id: "host_1",
              role: "editor",
              scope: "workspace",
              exp: Math.floor(Date.now() / 1000) + 300,
              iat: Math.floor(Date.now() / 1000),
              jti: "shared-jti",
            },
          }
        },
      },
      fetch: ((_url, init) => {
        forwarded.push(new Request("http://host.test", init).headers.get("authorization")!.replace(/^Bearer /, ""))
        return Promise.resolve(new Response("ok"))
      }) as typeof fetch,
    })

    for (const token of ["actor-a-token", "actor-b-token"]) {
      const response = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health", {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(response.status).toBe(200)
    }

    await expect(Promise.all(forwarded.map((token) => verifyRelayHostToken(token, relay.relayHost.publicKey, {
      workspaceId: "ws_1",
      hostId: "host_1",
    })))).resolves.toMatchObject([
      { actor_id: "actor_a", actor_kind: "human", actor_public_id: "usr_public_a", actor_name: "Ada" },
      { actor_id: "actor_b", actor_kind: "human", actor_public_id: "usr_public_b", actor_name: "Grace" },
    ])
    expect(new Set(forwarded).size).toBe(2)
  })

  test("coalesces concurrent Relay Host Token mints after authorization gates pass", async () => {
    const forwardedAuth: string[] = []
    let revocationCalls = 0
    const relay = await harness({
      traceSampleRate: 1,
      relayHostTokenCacheTtlMs: 30_000,
      isRuntimeAccessTokenActive: () => {
        revocationCalls++
        return { active: true }
      },
      fetch: ((_url, init) => {
        forwardedAuth.push(new Request("http://host.test", init).headers.get("authorization") ?? "")
        return Promise.resolve(new Response("ok"))
      }) as typeof fetch,
    })
    const token = await relay.token()
    const responses = await Promise.all(Array.from({ length: 16 }, () =>
      relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health", {
        headers: { authorization: `Bearer ${token}` },
      })
    ))

    expect(responses.every((response) => response.status === 200)).toBe(true)
    expect(revocationCalls).toBe(16)
    expect(new Set(forwardedAuth).size).toBe(1)
    expect(responses.filter((response) => (response.headers.get("server-timing") ?? "").includes("rht-mint;dur="))).toHaveLength(1)
    expect(responses.filter((response) => (response.headers.get("server-timing") ?? "").includes("rht-cache;dur="))).toHaveLength(15)
  })

  test("caches verified Runtime Access Token claims while preserving revocation checks", async () => {
    let verifyCalls = 0
    let activeCalls = 0
    const relay = await harness({
      runtimeAccessTokenCacheTtlMs: 30_000,
      tokenVerifier: {
        async verify(token) {
          verifyCalls++
          return {
            principalKind: "user",
      actorId: "actor_1",
      actorKind: "human",
            scopes: ["workspace:write"],
            claims: {
              iss: "claxedo-control-plane",
              aud: "workspace-relay",
              principal_kind: "user",
              actor_id: "user_1",
              actor_kind: "human",
              org_id: "org_1",
              workspace_id: "ws_1",
              host_id: "host_1",
              role: "editor",
              scope: "workspace",
              exp: Math.floor(Date.now() / 1000) + 300,
              iat: Math.floor(Date.now() / 1000),
              jti: token,
            },
          }
        },
      },
      isRuntimeAccessTokenActive: () => {
        activeCalls++
        return activeCalls === 1
          ? { active: true }
          : { active: false, code: "runtime_access_token_revoked", reason: "Runtime Access Token has been revoked" }
      },
      fetch: (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch,
    })

    const first = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: { authorization: "Bearer rat-hot" },
    })
    const second = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: { authorization: "Bearer rat-hot" },
    })

    expect(first.status).toBe(200)
    expect(second.status).toBe(401)
    expect(verifyCalls).toBe(1)
    expect(activeCalls).toBe(2)
    await expect(second.json()).resolves.toEqual({
      error: {
        code: "runtime_access_token_revoked",
        message: "Runtime Access Token has been revoked",
      },
    })
  })

  test("bounds revocation of cached HTTP requests by the revocation cache TTL", async () => {
    const revocationCacheTtlMs = 10_000
    let clockNow = 1_000_000
    let active = true
    const revocation = createCachedRevocationClient(async () =>
      active
        ? { active: true as const }
        : { active: false as const, code: "runtime_access_token_revoked", reason: "Runtime Access Token has been revoked" },
    { ttlMs: revocationCacheTtlMs, now: () => clockNow })
    const relay = await harness({
      // The claims and Relay Host Token caches stay warm for the whole test:
      // the delay bound must come from the revocation cache alone.
      runtimeAccessTokenCacheTtlMs: 60_000,
      relayHostTokenCacheTtlMs: 60_000,
      isRuntimeAccessTokenActive: (claims) => revocation({
        jti: claims.jti,
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
      }),
      fetch: (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch,
    })
    const token = await relay.token()
    const request = () => relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: { authorization: `Bearer ${token}` },
    })

    expect((await request()).status).toBe(200)
    active = false

    // Inside the TTL the cached positive answer still stands: this is the
    // bounded consistency window, not unlimited access.
    clockNow += revocationCacheTtlMs - 1
    expect((await request()).status).toBe(200)

    // Past runtimeAccessTokenRevocationDelayMs for the HTTP path, the stale
    // positive cannot be served again.
    clockNow += 2
    const denied = await request()
    expect(denied.status).toBe(401)
    await expect(denied.json()).resolves.toEqual({
      error: {
        code: "runtime_access_token_revoked",
        message: "Runtime Access Token has been revoked",
      },
    })
    expect(runtimeAccessTokenRevocationDelayMs({ revocationCacheTtlMs })).toBe(revocationCacheTtlMs)
  })

  test("fails closed when the revocation authority is unreachable", async () => {
    const relay = await harness({
      isRuntimeAccessTokenActive: () => {
        throw new Error("revocation resolver unreachable")
      },
      fetch: (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch,
    })
    const token = await relay.token()

    const res = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "relay_request_failed",
        message: "Workspace relay request was denied",
      },
    })
  })

  test("does not reuse cached Runtime Access Token claims across workspace ids", async () => {
    let verifyCalls = 0
    const relay = await harness({
      runtimeAccessTokenCacheTtlMs: 30_000,
      tokenVerifier: {
        async verify() {
          verifyCalls++
          return {
            principalKind: "user",
      actorId: "actor_1",
      actorKind: "human",
            scopes: ["workspace:write"],
            claims: {
              iss: "claxedo-control-plane",
              aud: "workspace-relay",
              principal_kind: "user",
              actor_id: "user_1",
              actor_kind: "human",
              org_id: "org_1",
              workspace_id: "ws_1",
              host_id: "host_1",
              role: "editor",
              scope: "workspace",
              exp: Math.floor(Date.now() / 1000) + 300,
              iat: Math.floor(Date.now() / 1000),
              jti: "jti_same_token",
            },
          }
        },
      },
      fetch: (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch,
    })

    const first = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: { authorization: "Bearer rat-replayed" },
    })
    const second = await relay.room.request("http://relay.test/workspaces/ws_2/api/wr/health", {
      headers: { authorization: "Bearer rat-replayed" },
    })

    expect(first.status).toBe(200)
    expect(second.status).toBe(403)
    expect(verifyCalls).toBe(2)
    await expect(second.json()).resolves.toEqual({
      error: {
        code: "relay_token_workspace_mismatch",
        message: "Workspace relay request was denied",
      },
    })
  })

  test("allows Runtime Access Token verification cache to be disabled", async () => {
    let verifyCalls = 0
    const relay = await harness({
      runtimeAccessTokenCacheTtlMs: 0,
      tokenVerifier: {
        async verify() {
          verifyCalls++
          return {
            principalKind: "user",
      actorId: "actor_1",
      actorKind: "human",
            scopes: ["workspace:write"],
            claims: {
              iss: "claxedo-control-plane",
              aud: "workspace-relay",
              principal_kind: "user",
              actor_id: "user_1",
              actor_kind: "human",
              org_id: "org_1",
              workspace_id: "ws_1",
              host_id: "host_1",
              role: "editor",
              scope: "workspace",
              exp: Math.floor(Date.now() / 1000) + 300,
              iat: Math.floor(Date.now() / 1000),
              jti: "jti_uncached",
            },
          }
        },
      },
      fetch: (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch,
    })

    const first = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: { authorization: "Bearer rat-uncached" },
    })
    const second = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: { authorization: "Bearer rat-uncached" },
    })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(verifyCalls).toBe(2)
  })

  test("owns CORS response headers instead of forwarding upstream duplicates", async () => {
    const relay = await harness({
      fetch: (() => Promise.resolve(new Response("ok", {
        headers: {
          "access-control-allow-origin": "http://upstream.example.test",
          "access-control-allow-methods": "GET",
          "content-type": "text/plain",
        },
      }))) as unknown as typeof fetch,
    })

    const res = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        authorization: `Bearer ${await relay.token()}`,
        origin: "http://localhost:4482",
      },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:4482")
    expect(res.headers.get("access-control-allow-origin")?.split(",")).toEqual(["http://localhost:4482"])
    expect(res.headers.get("access-control-allow-headers")).toContain("X-OpenCode-Directory")
    expect(res.headers.get("access-control-allow-headers")).toContain("X-Claxedo-Runner")
    expect(res.headers.get("access-control-allow-headers")).toContain("Last-Event-ID")
    expect(res.headers.get("access-control-allow-headers")).toContain("X-Fetch-Bypass-Throttle")
    await expect(res.text()).resolves.toBe("ok")
  })

  test("rejects missing or mismatched Runtime Access Tokens before forwarding", async () => {
    const relay = await harness()
    const missing = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health")
    expect(missing.status).toBe(401)
    await expect(missing.json()).resolves.toEqual({
      error: {
        code: "runtime_access_token_required",
        message: "Runtime Access Token is required",
      },
    })

    const token = await mintRuntimeAccessToken({
      principalKind: "user",
      actorId: "actor_1",
      actorKind: "human",
      orgId: "org_1",
      workspaceId: "ws_2",
      hostId: "host_1",
      role: "editor",
    }, relay.runtime.privateKey, "EdDSA")
    const mismatch = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        authorization: `Bearer ${token}`,
      },
    })

    expect(mismatch.status).toBe(403)
    await expect(mismatch.json()).resolves.toEqual({
      error: {
        code: "relay_token_workspace_mismatch",
        message: "Workspace relay request was denied",
      },
    })
    expect(relay.auditEvents.map((event) => event.reason)).toEqual([
      "runtime_access_token_required",
      "relay_token_workspace_mismatch",
    ])
  })

  test("a token scoped to one session reaches that session, its stream and its questions, and nothing else", async () => {
    const relay = await harness({
      fetch: ((url, init) => {
        relay.forwarded.push({ url: fetchUrl(url), request: new Request(url, init) })
        return Promise.resolve(new Response("ok"))
      }) as typeof fetch,
    })
    const token = await relay.token("viewer", "ses_1")
    const call = (path: string, method = "GET") =>
      relay.room.request(`http://relay.test/workspaces/ws_1${path}`, { method, headers: { authorization: `Bearer ${token}` } })

    for (const [path, method] of [
      ["/session/ses_1", "GET"],
      ["/session/ses_1/prompt_async", "POST"],
      ["/session/ses_1/permissions/perm_1", "POST"],
      ["/api/wr/events?sessionID=ses_1", "GET"],
      ["/question/question_1/reply", "POST"],
    ] as const) {
      expect((await call(path, method)).status, `${method} ${path}`).toBe(200)
    }
    for (const path of [
      "/session",
      "/session/ses_10",
      "/session/ses_2/message",
      "/api/wr/events",
      "/api/wr/events?sessionID=ses_2",
      "/file?path=README.md",
      "/api/wr/pty",
      "/session/ses_1/..%2F..%2Fapi%2Fwr%2Fpty",
      "/question",
    ]) {
      expect((await call(path)).status, path).toBe(403)
    }
    const refused = await call("/api/wr/pty")
    await expect(refused.json()).resolves.toEqual({
      error: {
        code: "relay_scope_denied",
        message: "Runtime Access Token scope does not reach this relay request",
      },
    })
    expect(relay.forwarded).toHaveLength(5)
    expect(relay.auditEvents).toContainEqual(expect.objectContaining({
      action: "relay.request.denied",
      reason: "relay_scope_denied",
      path: "/workspaces/ws_1/api/wr/pty",
    }))
  })

  test("a workspace-wide token reaches the terminal, however its path is spelled", async () => {
    const relay = await harness({
      fetch: ((url, init) => {
        relay.forwarded.push({ url: fetchUrl(url), request: new Request(url, init) })
        return Promise.resolve(new Response("ok"))
      }) as typeof fetch,
    })
    // %3F/%23 decode to ?/# which forwarding resolves away, hitting the real
    // /api/wr/pty — the scope is asked of the resolved pathname, not the raw
    // decoded string.
    const paths = ["//api/wr/pty", "/%2Fapi/wr/pty", "/api/wr/pty%3Fx", "/api/wr/pty%23x"]

    for (const path of paths) {
      const scoped = await relay.room.request(`http://relay.test/workspaces/ws_1${path}`, {
        headers: { authorization: `Bearer ${await relay.token("viewer", "ses_1")}` },
      })
      expect(scoped.status).toBe(403)
      const owner = await relay.room.request(`http://relay.test/workspaces/ws_1${path}`, {
        headers: { authorization: `Bearer ${await relay.token("owner")}` },
      })
      expect(owner.status).toBe(200)
    }

    expect(relay.forwarded.map((item) => item.url)).toEqual(
      Array.from({ length: 4 }, () => "https://host.example.test/api/wr/pty"),
    )
  })

  test("the Relay Host Token carries the session scope the Runtime Access Token named", async () => {
    const relay = await harness({
      fetch: ((url, init) => {
        relay.forwarded.push({ url: fetchUrl(url), request: new Request(url, init) })
        return Promise.resolve(new Response("ok"))
      }) as typeof fetch,
    })
    await relay.room.request("http://relay.test/workspaces/ws_1/session/ses_1", {
      headers: { authorization: `Bearer ${await relay.token("viewer", "ses_1")}` },
    })
    const forwarded = relay.forwarded[0].request.headers.get("authorization")?.replace(/^Bearer /, "")
    expect(decodeJwt(forwarded!)).toMatchObject({ session_id: "ses_1", role: "viewer" })
  })

  test("allows editor admin and owner relay write requests", async () => {
    const relay = await harness({
      fetch: ((url, init) => {
        relay.forwarded.push({ url: fetchUrl(url), request: new Request(url, init) })
        return Promise.resolve(new Response("ok"))
      }) as typeof fetch,
    })

    const roles = ["editor", "admin", "owner"] as const
    const methods = ["POST", "PATCH", "DELETE"] as const
    for (const role of roles) {
      const res = await relay.room.request(`http://relay.test/workspaces/ws_1/api/session/${role}`, {
        method: methods[roles.indexOf(role)],
        headers: {
          authorization: `Bearer ${await relay.token(role)}`,
        },
      })

      expect(res.status).toBe(200)
    }

    expect(relay.forwarded.map((item) => item.request.method)).toEqual(["POST", "PATCH", "DELETE"])
    expect(relay.auditEvents.filter((event) => event.result === "deny")).toEqual([])
    expect(relay.auditEvents.filter((event) => event.action === "relay.request.accepted")).toEqual([
      expect.objectContaining({
        role: "editor",
        method: "POST",
        path: "/workspaces/ws_1/api/session/editor",
      }),
      expect.objectContaining({
        role: "admin",
        method: "PATCH",
        path: "/workspaces/ws_1/api/session/admin",
      }),
      expect.objectContaining({
        role: "owner",
        method: "DELETE",
        path: "/workspaces/ws_1/api/session/owner",
      }),
    ])
  })

  test("rejects inactive Runtime Access Tokens before forwarding", async () => {
    const relay = await harness({
      isRuntimeAccessTokenActive: () => ({
        active: false,
        code: "runtime_access_token_revoked",
        reason: "Runtime Access Token has been revoked",
      }),
      fetch: ((url, init) => {
        relay.forwarded.push({ url: fetchUrl(url), request: new Request(url, init) })
        return Promise.resolve(new Response("unexpected"))
      }) as typeof fetch,
    })

    const res = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        authorization: `Bearer ${await relay.token()}`,
      },
    })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "runtime_access_token_revoked",
        message: "Runtime Access Token has been revoked",
      },
    })
    expect(relay.forwarded).toEqual([])
    expect(relay.auditEvents).toContainEqual({
      action: "relay.request.denied",
      result: "deny",
      reason: "runtime_access_token_revoked",
      principalKind: "user",
      actorId: "actor_1",
      actorKind: "human",
      role: "editor",
      workspaceId: "ws_1",
      hostId: "host_1",
      method: "GET",
      path: "/workspaces/ws_1/api/wr/health",
    })
  })

  test("returns the upstream response body as a stream", async () => {
    const relay = await harness()
    const originalFetch = globalThis.fetch
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    globalThis.fetch = (() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(next) {
        controller = next
        next.enqueue(new TextEncoder().encode("first"))
      },
    })))) as unknown as typeof fetch

    try {
      const res = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/events", {
        headers: {
          authorization: `Bearer ${await relay.token()}`,
        },
      })
      const reader = res.body!.getReader()
      await expect(reader.read()).resolves.toMatchObject({
        done: false,
        value: new TextEncoder().encode("first"),
      })
      controller?.enqueue(new TextEncoder().encode("second"))
      controller?.close()
      await expect(new Response(new ReadableStream({
        async start(next) {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            next.enqueue(chunk.value)
          }
          next.close()
        },
      })).text()).resolves.toBe("second")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("maps an upstream timeout to 504", async () => {
    const relay = await harness({
      forwardTimeoutMs: 10,
      fetch: ((_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted")
            err.name = "AbortError"
            reject(err)
          })
        })) as typeof fetch,
    })
    const res = await relay.room.request("http://relay.test/workspaces/ws_1/api/slow", {
      headers: {
        authorization: `Bearer ${await relay.token()}`,
        origin: "http://localhost:4482",
      },
    })

    expect(res.status).toBe(504)
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:4482")
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "upstream_timeout",
        message: "Workspace upstream timed out",
      },
    })
  })

  test("forwards SSE streams without buffering the full response", async () => {
    const relay = await harness()
    const originalFetch = globalThis.fetch
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    globalThis.fetch = (() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(next) {
        controller = next
        next.enqueue(new TextEncoder().encode("event: ready\n\n"))
      },
    }), {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    }))) as unknown as typeof fetch

    try {
      const res = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/events", {
        headers: {
          authorization: `Bearer ${await relay.token()}`,
        },
      })
      expect(res.headers.get("content-type")).toBe("text/event-stream")
      const reader = res.body!.getReader()
      await expect(reader.read()).resolves.toMatchObject({
        done: false,
        value: new TextEncoder().encode("event: ready\n\n"),
      })
      controller?.enqueue(new TextEncoder().encode("data: next\n\n"))
      controller?.close()
      await expect(new Response(new ReadableStream({
        async start(next) {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            next.enqueue(chunk.value)
          }
          next.close()
        },
      })).text()).resolves.toBe("data: next\n\n")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("fails closed when a tunnelled target has no active host tunnel presence", async () => {
    const relay = await harness({
      backing: "local-worktree",
      directory: createWorkspaceRelayDirectory(),
    })

    const res = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        authorization: `Bearer ${await relay.token()}`,
      },
    })

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "host_tunnel_offline",
        message: "The machine serving this workspace is offline",
      },
    })
    expect(relay.auditEvents).toContainEqual({
      action: "relay.request.denied",
      result: "deny",
      reason: "host_tunnel_offline",
      principalKind: "user",
      actorId: "actor_1",
      actorKind: "human",
      role: "editor",
      workspaceId: "ws_1",
      hostId: "host_1",
      method: "GET",
      path: "/workspaces/ws_1/api/wr/health",
    })
  })

  test("denies a resolved target outside the allowed destinations without fetching it", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    let fetched = false
    // A programmatic resolveTarget never passed through the resolver wire
    // parse, so the destination rule is re-applied at authorize time.
    const relay = relayRoom({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "http://metadata.internal.test",
        backing: "cloud-vm",
      }),
      fetch: (() => {
        fetched = true
        return Promise.resolve(new Response("ok"))
      }) as unknown as typeof fetch,
    })

    const res = await relay.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        authorization: `Bearer ${await mintRuntimeAccessToken({
          principalKind: "user",
          actorId: "actor_1",
          actorKind: "human",
          orgId: "org_1",
          workspaceId: "ws_1",
          hostId: "host_1",
          role: "editor",
        }, runtime.privateKey, "EdDSA")}`,
      },
    })

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "relay_target_unavailable",
        message: "Workspace relay target is unavailable",
      },
    })
    expect(fetched).toBe(false)
  })

  describe("workspaceRelayForwardHeaders", () => {
    test("preserves the existing relay-controlled headers", () => {
      const input = new Headers({
        host: "client.example.test",
        "content-type": "application/json",
        "accept-encoding": "gzip, br",
        authorization: "Bearer client-supplied",
        "x-workspace-id": "client-supplied",
      })
      const out = workspaceRelayForwardHeaders(input, "relay-host-token-value", "ws_1")

      expect(out.get("host")).toBeNull()
      expect(out.get("accept-encoding")).toBe("identity")
      expect(out.get("authorization")).toBe("Bearer relay-host-token-value")
      expect(out.get("x-workspace-id")).toBe("ws_1")
      expect(out.get("content-type")).toBe("application/json")
    })

    test("strips x-forwarded-for from inbound headers", () => {
      const input = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })
      const out = workspaceRelayForwardHeaders(input, "tok", "ws_1")
      // The relay refuses to pass through any client-supplied forwarded chain;
      // we mark the request with x-forwarded-by instead. See server.ts.
      expect(out.get("x-forwarded-for")).toBeNull()
    })

    test("strips x-forwarded-host from inbound headers", () => {
      const input = new Headers({ "x-forwarded-host": "evil.example.test" })
      const out = workspaceRelayForwardHeaders(input, "tok", "ws_1")
      expect(out.get("x-forwarded-host")).toBeNull()
    })

    test("strips x-forwarded-proto from inbound headers", () => {
      const input = new Headers({ "x-forwarded-proto": "https" })
      const out = workspaceRelayForwardHeaders(input, "tok", "ws_1")
      expect(out.get("x-forwarded-proto")).toBeNull()
    })

    test("strips x-real-ip from inbound headers", () => {
      const input = new Headers({ "x-real-ip": "1.2.3.4" })
      const out = workspaceRelayForwardHeaders(input, "tok", "ws_1")
      expect(out.get("x-real-ip")).toBeNull()
    })

    test("strips hop-by-hop headers from forwarded requests", () => {
      const input = new Headers({
        connection: "keep-alive, upgrade",
        "keep-alive": "timeout=5",
        "proxy-authenticate": "Basic",
        "proxy-authorization": "Basic abc",
        te: "trailers",
        trailer: "x-checksum",
        "transfer-encoding": "chunked",
        upgrade: "websocket",
      })
      const out = workspaceRelayForwardHeaders(input, "tok", "ws_1")

      expect(out.get("connection")).toBeNull()
      expect(out.get("keep-alive")).toBeNull()
      expect(out.get("proxy-authenticate")).toBeNull()
      expect(out.get("proxy-authorization")).toBeNull()
      expect(out.get("te")).toBeNull()
      expect(out.get("trailer")).toBeNull()
      expect(out.get("transfer-encoding")).toBeNull()
      expect(out.get("upgrade")).toBeNull()
    })

    test("strips any x-claxedo-internal-* header (case-insensitive)", () => {
      const input = new Headers()
      input.append("x-claxedo-internal-actor", "spoofed-user")
      input.append("X-Claxedo-Internal-Trust", "high")
      const out = workspaceRelayForwardHeaders(input, "tok", "ws_1")
      expect(out.get("x-claxedo-internal-actor")).toBeNull()
      expect(out.get("x-claxedo-internal-trust")).toBeNull()
    })

    test("strips any x-supervisor-* header (case-insensitive)", () => {
      const input = new Headers()
      input.append("x-supervisor-token", "spoofed")
      input.append("X-Supervisor-Backplane-Token", "spoofed")
      const out = workspaceRelayForwardHeaders(input, "tok", "ws_1")
      expect(out.get("x-supervisor-token")).toBeNull()
      expect(out.get("x-supervisor-backplane-token")).toBeNull()
    })

    test("adds x-forwarded-by: workspace-relay marker", () => {
      const input = new Headers()
      const out = workspaceRelayForwardHeaders(input, "tok", "ws_1")
      expect(out.get("x-forwarded-by")).toBe("workspace-relay")
    })

    test("client-supplied x-forwarded-by is overwritten by the relay marker", () => {
      const input = new Headers({ "x-forwarded-by": "evil-proxy" })
      const out = workspaceRelayForwardHeaders(input, "tok", "ws_1")
      expect(out.get("x-forwarded-by")).toBe("workspace-relay")
    })

    test("does not strip unrelated x-* headers", () => {
      const input = new Headers({
        "x-request-id": "req_123",
        "x-custom-trace": "trace-abc",
      })
      const out = workspaceRelayForwardHeaders(input, "tok", "ws_1")
      expect(out.get("x-request-id")).toBe("req_123")
      expect(out.get("x-custom-trace")).toBe("trace-abc")
    })

    test("cloud-vm path: Cookie header passes through (default behavior)", () => {
      const input = new Headers({ cookie: "session=abc; foo=bar" })
      const out = workspaceRelayForwardHeaders(input, "tok", "ws_1")
      // Default (no options) is cloud-vm — cookies must pass through untouched.
      expect(out.get("cookie")).toBe("session=abc; foo=bar")
    })

    test("cloud-vm path: Cookie header passes through when hostTunnel: false", () => {
      const input = new Headers({ cookie: "session=abc" })
      const out = workspaceRelayForwardHeaders(input, "tok", "ws_1", { hostTunnel: false })
      expect(out.get("cookie")).toBe("session=abc")
    })

    test("host-tunnel path: Cookie header is stripped", () => {
      const input = new Headers({ cookie: "session=abc; secret=xyz" })
      const out = workspaceRelayForwardHeaders(input, "tok", "ws_1", { hostTunnel: true })
      // The tunnel ends on a machine whose cookie jar the browser may share;
      // passthrough leaks sensitive cookies to it.
      expect(out.get("cookie")).toBeNull()
    })

    test("host-tunnel path: Cookie header is stripped (case-insensitive)", () => {
      const input = new Headers()
      input.set("Cookie", "session=abc")
      const out = workspaceRelayForwardHeaders(input, "tok", "ws_1", { hostTunnel: true })
      expect(out.get("cookie")).toBeNull()
      expect(out.get("Cookie")).toBeNull()
    })

    test("host-tunnel path: Existing dangerous-header strip still happens", () => {
      const input = new Headers({
        cookie: "session=abc",
        "x-forwarded-for": "1.2.3.4",
        "x-forwarded-host": "evil.example.test",
        "x-forwarded-proto": "https",
        "x-real-ip": "1.2.3.4",
        connection: "upgrade",
        "x-claxedo-internal-actor": "spoofed",
        "x-supervisor-backplane-token": "spoofed",
      })
      const out = workspaceRelayForwardHeaders(input, "tok", "ws_1", { hostTunnel: true })
      expect(out.get("cookie")).toBeNull()
      expect(out.get("x-forwarded-for")).toBeNull()
      expect(out.get("x-forwarded-host")).toBeNull()
      expect(out.get("x-forwarded-proto")).toBeNull()
      expect(out.get("x-real-ip")).toBeNull()
      expect(out.get("connection")).toBeNull()
      expect(out.get("x-claxedo-internal-actor")).toBeNull()
      expect(out.get("x-supervisor-backplane-token")).toBeNull()
      expect(out.get("x-forwarded-by")).toBe("workspace-relay")
      expect(out.get("authorization")).toBe("Bearer tok")
      expect(out.get("x-workspace-id")).toBe("ws_1")
    })

    test("workspaceRelayForwardRequestInit builds the shared upstream fetch init", async () => {
      const controller = new AbortController()
      const init = workspaceRelayForwardRequestInit(
        new Request("http://relay.test/workspaces/ws_1/api/wr/items", {
          method: "POST",
          headers: {
            cookie: "session=abc",
            "x-forwarded-for": "1.2.3.4",
          },
          body: "payload",
        }),
        "tok",
        "ws_1",
        { signal: controller.signal, hostTunnel: false },
      )

      expect(init.method).toBe("POST")
      expect(init.redirect).toBe("manual")
      expect(init.signal).toBe(controller.signal)
      expect(init.body).toBeDefined()
      const headers = init.headers as Headers
      expect(headers.get("cookie")).toBe("session=abc")
      expect(headers.get("x-forwarded-for")).toBeNull()
      expect(headers.get("authorization")).toBe("Bearer tok")
      expect(headers.get("x-workspace-id")).toBe("ws_1")
    })

    test("workspaceRelayForwardRequestInit omits bodies for GET and HEAD", () => {
      const getInit = workspaceRelayForwardRequestInit(
        new Request("http://relay.test/workspaces/ws_1/api/wr/items", { method: "GET" }),
        "tok",
        "ws_1",
      )
      const headInit = workspaceRelayForwardRequestInit(
        new Request("http://relay.test/workspaces/ws_1/api/wr/items", { method: "HEAD" }),
        "tok",
        "ws_1",
      )

      expect(getInit.body).toBeUndefined()
      expect(headInit.body).toBeUndefined()
    })

    test("forwarded HTTP request has dangerous headers stripped end-to-end", async () => {
      const relay = await harness({
        fetch: ((url, init) => {
          relay.forwarded.push({ url: fetchUrl(url), request: new Request(url, init) })
          return Promise.resolve(new Response("ok"))
        }) as typeof fetch,
      })

      const res = await relay.room.request("http://relay.test/workspaces/ws_1/api/wr/health", {
        headers: {
          authorization: `Bearer ${await relay.token()}`,
          "x-forwarded-for": "1.2.3.4",
          "x-forwarded-host": "evil.example.test",
          "x-forwarded-proto": "https",
          "x-real-ip": "1.2.3.4",
          "x-claxedo-internal-actor": "spoofed",
          "x-supervisor-backplane-token": "spoofed",
        },
      })

      expect(res.status).toBe(200)
      const upstream = relay.forwarded[0]?.request
      expect(upstream).toBeDefined()
      expect(upstream.headers.get("x-forwarded-for")).toBeNull()
      expect(upstream.headers.get("x-forwarded-host")).toBeNull()
      expect(upstream.headers.get("x-forwarded-proto")).toBeNull()
      expect(upstream.headers.get("x-real-ip")).toBeNull()
      expect(upstream.headers.get("x-claxedo-internal-actor")).toBeNull()
      expect(upstream.headers.get("x-supervisor-backplane-token")).toBeNull()
      expect(upstream.headers.get("x-forwarded-by")).toBe("workspace-relay")
    })
  })

  // P-shared.2: TokenVerifier seam.
  describe("tokenVerifier override", () => {
    test("uses the injected verifier instead of decoding the JWT", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      const calls: string[] = []
      const relay = relayRoom({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        resolveTarget: (claims) => ({
          workspaceId: claims.workspace_id,
          hostId: claims.host_id,
          baseUrl: "https://host.example.test",
          backing: "cloud-vm",
        }),
        tokenVerifier: {
          async verify(token) {
            calls.push(token)
            return {
              actorId: "u-from-verifier",
        actorKind: "human",
        principalKind: "user",
              scopes: ["workspace:write"],
              claims: {
                principal_kind: "user",
                actor_id: "u-from-verifier",
                actor_kind: "human",
                org_id: "org_1",
                workspace_id: "ws_1",
                host_id: "host_1",
                role: "editor",
                scope: "workspace",
                aud: "workspace-relay",
                iss: "claxedo-control-plane",
                exp: Math.floor(Date.now() / 1000) + 300,
                iat: Math.floor(Date.now() / 1000),
                jti: "jti_custom",
              },
            }
          },
        },
      })
      const originalFetch = globalThis.fetch
      globalThis.fetch = ((url, init) => {
        new Request(url, init)
        return Promise.resolve(new Response("ok", { status: 200 }))
      }) as typeof fetch
      try {
        const res = await relay.request("http://relay.test/workspaces/ws_1/api/wr/health", {
          headers: { authorization: "Bearer arbitrary-string-not-a-jwt" },
        })
        expect(res.status).toBe(200)
        expect(calls).toEqual(["arbitrary-string-not-a-jwt"])
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    test("denies custom verifier claims for the wrong workspace before target resolution", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      let resolved = false
      const relay = relayRoom({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        resolveTarget: (claims) => {
          resolved = true
          return {
            workspaceId: claims.workspace_id,
            hostId: claims.host_id,
            baseUrl: "https://host.example.test",
            backing: "cloud-vm",
          }
        },
        tokenVerifier: {
          async verify() {
            return {
              actorId: "u-from-verifier",
        actorKind: "human",
        principalKind: "user",
              scopes: ["workspace:write"],
              claims: {
                iss: "claxedo-control-plane",
                aud: "workspace-relay",
                principal_kind: "user",
                actor_id: "u-from-verifier",
                actor_kind: "human",
                org_id: "org_1",
                workspace_id: "ws_other",
                host_id: "host_1",
                role: "editor",
                scope: "workspace",
                exp: Math.floor(Date.now() / 1000) + 300,
                iat: Math.floor(Date.now() / 1000),
                jti: "jti_custom",
              },
            }
          },
        },
      })

      const res = await relay.request("http://relay.test/workspaces/ws_1/api/wr/health", {
        headers: { authorization: "Bearer custom" },
      })

      expect(res.status).toBe(403)
      expect(resolved).toBe(false)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "relay_token_workspace_mismatch",
          message: "Workspace relay request was denied",
        },
      })
    })

    test("denies custom verifier claims with missing or malformed roles", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      const claims = {
        iss: "claxedo-control-plane",
        aud: "workspace-relay",
        principal_kind: "user",
                actor_id: "u-from-verifier",
                actor_kind: "human",
        org_id: "org_1",
        workspace_id: "ws_1",
        host_id: "host_1",
        exp: Math.floor(Date.now() / 1000) + 300,
        iat: Math.floor(Date.now() / 1000),
        jti: "jti_custom",
      }
      const relay = relayRoom({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        resolveTarget: () => ({
          workspaceId: "ws_1",
          hostId: "host_1",
          baseUrl: "https://host.example.test",
          backing: "cloud-vm",
        }),
        tokenVerifier: {
          async verify() {
            return {
              actorId: "u-from-verifier",
        actorKind: "human",
        principalKind: "user",
              scopes: ["workspace:write"],
              claims: {
                ...claims,
                role: "maintainer",
              } as unknown as RuntimeAccessVerifierClaims,
            }
          },
        },
      })

      const res = await relay.request("http://relay.test/workspaces/ws_1/api/wr/health", {
        headers: { authorization: "Bearer custom" },
      })

      expect(res.status).toBe(401)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "relay_token_claims_invalid",
          message: "Workspace relay request was denied",
        },
      })
    })

    test("denies custom verifier claims with incomplete claim fields", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      const relay = relayRoom({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        resolveTarget: () => ({
          workspaceId: "ws_1",
          hostId: "host_1",
          baseUrl: "https://host.example.test",
          backing: "cloud-vm",
        }),
        tokenVerifier: {
          async verify() {
            return {
              actorId: "u-from-verifier",
        actorKind: "human",
        principalKind: "user",
              scopes: ["workspace:write"],
              claims: {
                iss: "claxedo-control-plane",
                aud: "workspace-relay",
                principal_kind: "user",
                actor_id: "u-from-verifier",
                actor_kind: "human",
                workspace_id: "ws_1",
                host_id: "host_1",
                role: "editor",
              } as unknown as RuntimeAccessVerifierClaims,
            }
          },
        },
      })

      const res = await relay.request("http://relay.test/workspaces/ws_1/api/wr/health", {
        headers: { authorization: "Bearer custom" },
      })

      expect(res.status).toBe(401)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "relay_token_claims_invalid",
          message: "Workspace relay request was denied",
        },
      })
    })

    /**
     * Verifier-claims harness for the post-verification clock checks: the
     * verifier succeeds and returns the claims it is given, so only the
     * relay's own time validation can refuse the request.
     */
    async function verifierRelayForClaims(claims: Record<string, unknown>) {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      return relayRoom({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        resolveTarget: (resolved) => ({
          workspaceId: resolved.workspace_id,
          hostId: resolved.host_id,
          baseUrl: "https://host.example.test",
          backing: "cloud-vm",
        }),
        tokenVerifier: {
          async verify() {
            return {
              subject: "u-from-verifier",
              scopes: ["workspace:write"],
              claims: claims as RuntimeAccessVerifierClaims,
            }
          },
        },
      })
    }

    function verifierClaims(overrides: Record<string, unknown> = {}) {
      return {
        iss: "claxedo-control-plane",
        aud: "workspace-relay",
        principal_kind: "user",
        actor_id: "u-from-verifier",
        actor_kind: "human",
        org_id: "org_1",
        workspace_id: "ws_1",
        host_id: "host_1",
        role: "editor",
        scope: "workspace",
        exp: Math.floor(Date.now() / 1000) + 300,
        iat: Math.floor(Date.now() / 1000),
        jti: "jti_custom",
        ...overrides,
      }
    }

    test("rejects expired claims returned by an otherwise-successful verifier", async () => {
      const now = Math.floor(Date.now() / 1000)
      const relay = await verifierRelayForClaims(verifierClaims({ iat: now - 600, exp: now - 300 }))

      const res = await relay.request("http://relay.test/workspaces/ws_1/api/wr/health", {
        headers: { authorization: "Bearer custom" },
      })

      expect(res.status).toBe(401)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "relay_token_claims_invalid",
          message: "Workspace relay request was denied",
        },
      })
    })

    test("admits verifier claims expired inside the clock-skew tolerance", async () => {
      const now = Math.floor(Date.now() / 1000)
      const relay = await verifierRelayForClaims(verifierClaims({ iat: now - 300, exp: now - 30 }))
      const originalFetch = globalThis.fetch
      globalThis.fetch = (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch
      try {
        const res = await relay.request("http://relay.test/workspaces/ws_1/api/wr/health", {
          headers: { authorization: "Bearer custom" },
        })
        expect(res.status).toBe(200)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    test("rejects verifier claims with nbf beyond the clock-skew tolerance", async () => {
      const now = Math.floor(Date.now() / 1000)
      const relay = await verifierRelayForClaims(verifierClaims({ nbf: now + 120 }))

      const res = await relay.request("http://relay.test/workspaces/ws_1/api/wr/health", {
        headers: { authorization: "Bearer custom" },
      })

      expect(res.status).toBe(401)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "relay_token_claims_invalid",
          message: "Workspace relay request was denied",
        },
      })
    })

    test("rejects verifier claims with an nbf that is not a finite number", async () => {
      const relay = await verifierRelayForClaims(verifierClaims({ nbf: "tomorrow" }))

      const res = await relay.request("http://relay.test/workspaces/ws_1/api/wr/health", {
        headers: { authorization: "Bearer custom" },
      })

      expect(res.status).toBe(401)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "relay_token_claims_invalid",
          message: "Workspace relay request was denied",
        },
      })
    })

    test("rejects verifier claims with an absurdly distant exp", async () => {
      const now = Math.floor(Date.now() / 1000)
      const relay = await verifierRelayForClaims(verifierClaims({ exp: now + 48 * 60 * 60 }))

      const res = await relay.request("http://relay.test/workspaces/ws_1/api/wr/health", {
        headers: { authorization: "Bearer custom" },
      })

      expect(res.status).toBe(401)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "relay_token_claims_invalid",
          message: "Workspace relay request was denied",
        },
      })
    })

    test("denies requests when the custom verifier throws", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      const relay = relayRoom({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        resolveTarget: () => ({
          workspaceId: "ws_1",
          hostId: "host_1",
          baseUrl: "https://host.example.test",
          backing: "cloud-vm",
        }),
        tokenVerifier: {
          async verify() {
            throw new Error("verifier unavailable")
          },
        },
      })

      const res = await relay.request("http://relay.test/workspaces/ws_1/api/wr/health", {
        headers: { authorization: "Bearer custom" },
      })

      expect(res.status).toBe(401)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "relay_request_failed",
          message: "Workspace relay request was denied",
        },
      })
    })
  })
})

describe("authorizeWorkspaceRelayRequest audit sampling", () => {
  async function samplingHarness(input: {
    auditAcceptSampleRate?: number
    auditFlushIntervalMs?: number
    random?: () => number
  } = {}) {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const auditEvents: WorkspaceRelayAuditEvent[] = []
    const options: WorkspaceRelayOptions = {
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "https://host.example.test",
        backing: "cloud-vm",
      }),
      audit: (event) => {
        auditEvents.push(event)
      },
      ...(input.auditAcceptSampleRate !== undefined ? { auditAcceptSampleRate: input.auditAcceptSampleRate } : {}),
      ...(input.auditFlushIntervalMs !== undefined ? { auditFlushIntervalMs: input.auditFlushIntervalMs } : {}),
      ...(input.random ? { random: input.random } : {}),
    }
    return {
      auditEvents,
      authorize: (n: number, token?: string) => authorizeWorkspaceRelayRequest(
        options,
        new Request(`http://relay.test/workspaces/ws_1/api/wr/health?n=${n}`, token ? { headers: { authorization: `Bearer ${token}` } } : {}),
        "ws_1",
      ),
      dispose: () => disposeAuditSampler(options),
      token: () =>
        mintRuntimeAccessToken({
          principalKind: "user",
          actorId: "user_1",
          actorKind: "human",
          orgId: "org_1",
          workspaceId: "ws_1",
          hostId: "host_1",
          role: "editor",
        }, runtime.privateKey, "EdDSA"),
    }
  }

  test("accept events ALL emit when sample rate is 1.0", async () => {
    const harness = await samplingHarness({ auditAcceptSampleRate: 1.0 })
    const token = await harness.token()
    for (let i = 0; i < 100; i++) {
      expect((await harness.authorize(i, token)).ok).toBe(true)
    }
    const accepted = harness.auditEvents.filter((e) => e.action === "relay.request.accepted")
    expect(accepted).toHaveLength(100)
  })

  test("accept events sampled at 0.5 emit a fraction (deterministic)", async () => {
    let counter = 0
    const random = () => {
      counter += 1
      // Half of each ten-value cycle falls below the 0.5 rate.
      const seq = [0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 0.45, 0.55]
      return seq[counter % seq.length]
    }
    const harness = await samplingHarness({ auditAcceptSampleRate: 0.5, random })
    const token = await harness.token()
    for (let i = 0; i < 100; i++) {
      await harness.authorize(i, token)
    }
    const accepted = harness.auditEvents.filter((e) => e.action === "relay.request.accepted")
    expect(accepted.length).toBeGreaterThanOrEqual(30)
    expect(accepted.length).toBeLessThanOrEqual(70)
    harness.dispose()
  })

  test("accept events sampled at 0.0 emit zero accepts", async () => {
    const harness = await samplingHarness({ auditAcceptSampleRate: 0.0 })
    const token = await harness.token()
    for (let i = 0; i < 25; i++) {
      await harness.authorize(i, token)
    }
    const accepted = harness.auditEvents.filter((e) => e.action === "relay.request.accepted")
    expect(accepted).toHaveLength(0)
    harness.dispose()
  })

  test("deny events ALWAYS emit regardless of sample rate", async () => {
    const harness = await samplingHarness({ auditAcceptSampleRate: 0.0 })
    for (let i = 0; i < 5; i++) {
      const denied = await harness.authorize(i)
      expect(denied.ok ? undefined : denied.response.status).toBe(401)
    }
    const denied = harness.auditEvents.filter((e) => e.action === "relay.request.denied")
    expect(denied).toHaveLength(5)
    harness.dispose()
  })

  test("emits relay.request.suppressed_summary periodically with count", async () => {
    const harness = await samplingHarness({
      auditAcceptSampleRate: 0.0,
      auditFlushIntervalMs: 50,
    })
    const token = await harness.token()
    for (let i = 0; i < 7; i++) {
      await harness.authorize(i, token)
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
    const summaries = harness.auditEvents.filter(
      (e) => e.action === "relay.request.suppressed_summary",
    )
    expect(summaries.length).toBeGreaterThanOrEqual(1)
    const total = summaries.reduce((acc, e) => acc + (e.suppressedCount ?? 0), 0)
    expect(total).toBe(7)
    harness.dispose()
  })
})

describe("parseWorkspaceRelayTarget", () => {
  const row = {
    workspaceId: "ws_1",
    hostId: "host_1",
    baseUrl: "https://host.example.test",
  }

  test("reads the placement from backing alone", () => {
    expect(parseWorkspaceRelayTarget({ ...row, backing: "local-worktree" })).toEqual({
      ...row,
      backing: "local-worktree",
    })
  })

  test("refuses a target that still states access", () => {
    expect(parseWorkspaceRelayTarget({ ...row, access: "user-hosted", backing: "local-worktree" })).toBeUndefined()
    expect(parseWorkspaceRelayTarget({ ...row, access: "cloud", backing: "cloud-vm" })).toBeUndefined()
  })

  test("admits a durable-object target only with no baseUrl", () => {
    expect(parseWorkspaceRelayTarget({ ...row, hostId: "session-do:ses_1", baseUrl: "", backing: "durable-object" })).toEqual({
      ...row,
      hostId: "session-do:ses_1",
      baseUrl: "",
      backing: "durable-object",
    })
    expect(parseWorkspaceRelayTarget({ ...row, backing: "durable-object" })).toBeUndefined()
  })

  test("refuses a backing that names no placement", () => {
    expect(parseWorkspaceRelayTarget({ ...row, backing: "user-hosted" })).toBeUndefined()
    expect(parseWorkspaceRelayTarget(row)).toBeUndefined()
  })

  test("refuses a cloud-vm baseUrl that is not HTTPS or loopback HTTP", () => {
    // The relay fetches this URL with the Relay Host Token attached; any
    // other scheme or a plaintext remote destination would carry it away.
    expect(parseWorkspaceRelayTarget({ ...row, backing: "cloud-vm", baseUrl: "ftp://host.example.test" })).toBeUndefined()
    expect(parseWorkspaceRelayTarget({ ...row, backing: "cloud-vm", baseUrl: "file:///etc/passwd" })).toBeUndefined()
    expect(parseWorkspaceRelayTarget({ ...row, backing: "cloud-vm", baseUrl: "ws://host.example.test" })).toBeUndefined()
    expect(parseWorkspaceRelayTarget({ ...row, backing: "cloud-vm", baseUrl: "not a url" })).toBeUndefined()
    expect(parseWorkspaceRelayTarget({ ...row, backing: "cloud-vm", baseUrl: "http://internal.example.test" })).toBeUndefined()
    expect(parseWorkspaceRelayTarget({ ...row, backing: "cloud-vm", baseUrl: "http://169.254.169.254" })).toBeUndefined()
  })

  test("admits HTTPS and loopback HTTP cloud-vm baseUrls", () => {
    for (const baseUrl of [
      "https://host.example.test",
      "http://127.0.0.1:8787",
      "http://localhost:8787",
      "http://[::1]:8787",
      // WHATWG parsing canonicalises every 127.0.0.0/8 spelling before the check.
      "http://0x7f.1:8787",
    ]) {
      expect(parseWorkspaceRelayTarget({ ...row, backing: "cloud-vm", baseUrl })).toMatchObject({ baseUrl })
    }
  })

  test("admits the local-worktree wire value but refuses other schemes", () => {
    // The tunnel adapters never fetch a local-worktree baseUrl — the control
    // plane sends "" — but embedded forwarders do, so only the placeholder
    // or a well-formed HTTP(S) URL may pass.
    expect(parseWorkspaceRelayTarget({ ...row, baseUrl: "", backing: "local-worktree" })).toEqual({
      ...row,
      baseUrl: "",
      backing: "local-worktree",
    })
    expect(parseWorkspaceRelayTarget({ ...row, baseUrl: "http://127.0.0.1:4000", backing: "local-worktree" })).toBeTruthy()
    expect(parseWorkspaceRelayTarget({ ...row, baseUrl: "ftp://host.example.test", backing: "local-worktree" })).toBeUndefined()
    expect(parseWorkspaceRelayTarget({ ...row, baseUrl: "javascript:alert(1)", backing: "local-worktree" })).toBeUndefined()
  })
})

describe("workspaceRelayTargetUrl", () => {
  const target = {
    workspaceId: "ws_1",
    hostId: "host_1",
    baseUrl: "https://host.example.test/base",
    backing: "cloud-vm" as const,
  }

  test("joins request paths under the target's base path", () => {
    expect(workspaceRelayTargetUrl(target, "/api/wr/health", "?v=1").href)
      .toBe("https://host.example.test/base/api/wr/health?v=1")
  })

  test("keeps a path carrying a scheme or authority on the target origin", () => {
    // `new URL(path, base)` would resolve "http:evil.example/x" absolute and
    // send the fetch — Relay Host Token included — to that origin.
    for (const path of ["/http:evil.example/x", "//evil.example/x", "/https:evil.example/x"]) {
      const url = workspaceRelayTargetUrl(target, path, "")
      expect(url.origin).toBe("https://host.example.test")
    }
    expect(workspaceRelayTargetUrl(target, "/http:evil.example/x", "").pathname)
      .toBe("/base/http:evil.example/x")
  })
})

/**
 * The relay is opaque to the recovery contract: nothing here imports it, and
 * these tests assert bytes and status rather than a decoded outcome.
 */
describe("forwarding a session recovery request", () => {
  const submission = JSON.stringify({
    requestId: "req_1",
    action: "cancel_turn",
    target: { scope: "turn", workspaceId: "ws_1", sessionId: "ses_1", turnId: "msg_1", ownerGeneration: "lease_1" },
    scopeRevision: "lease_1",
    attempt: 1,
  })
  const refusal = JSON.stringify({
    kind: "refused",
    refusal: { kind: "generation_conflict", message: "Session ses_1 is running another turn" },
  })

  test("reaches the runtime as the same bytes, and returns its refusal status and body unchanged", async () => {
    const relay = await harness({
      fetch: ((url, init) => {
        relay.forwarded.push({ url: fetchUrl(url), request: new Request(url, init) })
        return Promise.resolve(new Response(refusal, { status: 409, headers: { "content-type": "application/json" } }))
      }) as typeof fetch,
    })

    const res = await relay.room.request("http://relay.test/workspaces/ws_1/session/ses_1/recovery?directory=%2Fwork", {
      method: "POST",
      headers: { authorization: `Bearer ${await relay.token()}`, "content-type": "application/json" },
      body: submission,
    })

    expect(res.status).toBe(409)
    expect(res.headers.get("content-type")).toBe("application/json")
    await expect(res.text()).resolves.toBe(refusal)

    const upstream = relay.forwarded[0]
    expect(upstream?.url).toBe("https://host.example.test/session/ses_1/recovery?directory=%2Fwork")
    expect(upstream?.request.method).toBe("POST")
    await expect(upstream.request.text()).resolves.toBe(submission)
  })

  test("returns the same operation receipt for a read, without touching its body", async () => {
    const receipt = JSON.stringify({ kind: "operation", operation: { operationId: "op_1", requestId: "req_1" } })
    const relay = await harness({
      fetch: ((url, init) => {
        relay.forwarded.push({ url: fetchUrl(url), request: new Request(url, init) })
        return Promise.resolve(new Response(receipt, { status: 200, headers: { "content-type": "application/json" } }))
      }) as typeof fetch,
    })

    const res = await relay.room.request("http://relay.test/workspaces/ws_1/session/ses_1/recovery/operations/op_1", {
      headers: { authorization: `Bearer ${await relay.token()}` },
    })

    expect(res.status).toBe(200)
    await expect(res.text()).resolves.toBe(receipt)
    expect(relay.forwarded[0]?.url).toBe("https://host.example.test/session/ses_1/recovery/operations/op_1")
  })

  test("answers an upstream that never replies with a transport failure, never a recovery outcome", async () => {
    const relay = await harness({
      forwardTimeoutMs: 10,
      fetch: ((_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const aborted = new Error("aborted")
          aborted.name = "AbortError"
          reject(aborted)
        })
      })) as typeof fetch,
    })

    const res = await relay.room.request("http://relay.test/workspaces/ws_1/session/ses_1/recovery", {
      method: "POST",
      headers: { authorization: `Bearer ${await relay.token()}`, "content-type": "application/json" },
      body: submission,
    })

    expect(res.status).toBe(504)
    const body = await res.json() as Record<string, unknown>
    expect(body).toEqual({ error: { code: "upstream_timeout", message: "Workspace upstream timed out" } })
    // A caller that decoded every non-200 as a recovery outcome would read a
    // lost response as a refusal the owner never made.
    expect(body.kind).toBeUndefined()
  })

  test("answers an unreachable upstream with a transport failure, never a recovery outcome", async () => {
    const relay = await harness({
      fetch: ((_url: string | URL | Request) => Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof fetch,
    })

    const res = await relay.room.request("http://relay.test/workspaces/ws_1/session/ses_1/recovery", {
      method: "POST",
      headers: { authorization: `Bearer ${await relay.token()}`, "content-type": "application/json" },
      body: submission,
    })

    expect(res.status).toBe(503)
    const body = await res.json() as Record<string, unknown>
    expect(body).toEqual({ error: { code: "upstream_unavailable", message: "Workspace upstream is unavailable" } })
    expect(body.kind).toBeUndefined()
  })
})

test("stale routing tokens are rejected before forwarding even after a positive request", async () => {
  const runtime = await generateKeyPair("EdDSA")
  const host = await generateKeyPair("EdDSA")
  let current = "old"
  let forwarded = 0
  const relay = relayRoom({
    runtimeAccessKey: runtime.publicKey,
    relayHostSigningKey: host.privateKey,
    relayHostAlgorithm: "EdDSA",
    resolveTarget: (claims) => {
      if (claims.routing_id !== current) throw new WorkspaceRelayAuthError("runtime_access_token_invalid", "stale route")
      return { workspaceId: claims.workspace_id, hostId: claims.host_id, baseUrl: "https://reused.test", backing: "cloud-vm" }
    },
    fetch: (async () => { forwarded++; return Response.json({ ok: true }) }) as unknown as typeof fetch,
  })
  const mint = (routingId: string) => mintRuntimeAccessToken({
    principalKind: "user", actorKind: "human", actorId: "actor", orgId: "org",
    workspaceId: "workspace", hostId: "host", role: "owner", routingId,
  }, runtime.privateKey, "EdDSA")
  const old = await mint("old")
  const request = (token: string) => relay.request("http://relay.test/workspaces/workspace/health", { headers: { authorization: `Bearer ${token}` } })
  expect((await request(old)).status).toBe(200)
  current = "new"
  expect((await request(old)).status).toBe(401)
  expect((await request(await mint("new"))).status).toBe(200)
  expect((await request(old)).status).toBe(401)
  expect(forwarded).toBe(2)
})
