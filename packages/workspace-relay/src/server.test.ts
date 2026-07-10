import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { decodeProtectedHeader, exportJWK, generateKeyPair } from "jose"
import { mintRelayHostToken, mintRuntimeAccessToken, verifyRelayHostToken } from "./auth"
import { createWorkspaceRelayDirectory } from "./directory"
import type { RuntimeAccessVerifierClaims } from "@claxedo/workspace-relay-protocol"
import {
  createWorkspaceRelay,
  workspaceRelayForwardHeaders,
  workspaceRelayForwardRequestInit,
  type WorkspaceRelayAuditEvent,
  type WorkspaceRelayOptions,
} from "./server"

function relayPair(input: { access?: "cloud" | "user-hosted"; backing?: "cloud-vm" | "local-worktree" }) {
  if (input.access === "user-hosted" || input.backing === "local-worktree") {
    return { access: "user-hosted", backing: "local-worktree" } as const
  }
  return { access: "cloud", backing: "cloud-vm" } as const
}

async function harness(
  input: Partial<Pick<WorkspaceRelayOptions,
    | "isRuntimeAccessTokenActive"
    | "audit"
    | "fetch"
    | "directory"
    | "forwardTimeoutMs"
    | "relayHostTokenCacheTtlMs"
    | "runtimeAccessTokenCacheTtlMs"
    | "tokenVerifier"
    | "allowedOrigins"
  >> & {
    access?: "cloud" | "user-hosted"
    backing?: "cloud-vm" | "local-worktree"
  } = {},
) {
  const runtime = await generateKeyPair("EdDSA", { extractable: true })
  const relayHost = await generateKeyPair("EdDSA", { extractable: true })
  const forwarded: Array<{ url: string; request: Request }> = []
  const auditEvents: WorkspaceRelayAuditEvent[] = []
  const app = createWorkspaceRelay({
    runtimeAccessKey: runtime.publicKey,
    relayHostSigningKey: relayHost.privateKey,
    relayHostAlgorithm: "EdDSA",
    resolveTarget: (claims) => ({
      workspaceId: claims.workspace_id,
      hostId: claims.host_id,
      baseUrl: "https://host.example.test",
      ...relayPair(input),
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
    ...(input.allowedOrigins ? { allowedOrigins: input.allowedOrigins } : {}),
  })
  return {
    app,
    runtime,
    relayHost,
    forwarded,
    auditEvents,
    token: (role: "viewer" | "editor" | "admin" | "owner" = "editor") => mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role,
    }, runtime.privateKey, "EdDSA"),
  }
}

describe("workspace relay server", () => {
  test("forwards HTTP requests with a Relay Host Token", async () => {
    const relay = await harness()
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((url, init) => {
      const request = new Request(url, init)
      relay.forwarded.push({ url: String(url), request })
      return Promise.resolve(new Response("ok", {
        status: 201,
        headers: {
          "content-type": "text/plain",
        },
      }))
    }) as typeof fetch

    try {
      const res = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/health?verbose=1", {
        headers: {
          authorization: `Bearer ${await relay.token()}`,
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
        role: "editor",
        access: "cloud",
        backing: "cloud-vm",
      })
      expect(relay.auditEvents).toContainEqual({
        action: "relay.request.accepted",
        result: "allow",
        subject: "user_1",
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

  test("adds server-timing entries for real relay phases", async () => {
    const relay = await harness({
      fetch: (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch,
    })

    const res = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        authorization: `Bearer ${await relay.token()}`,
      },
    })

    expect(res.status).toBe(200)
    const timing = res.headers.get("server-timing") ?? ""
    for (const phase of ["rat-verify", "rat-active", "target-resolve", "rht-mint", "upstream-fetch", "relay-total"]) {
      expect(timing).toContain(`${phase};dur=`)
    }
  })

  test("custom allowedOrigins replaces the built-in default CORS list", async () => {
    const relay = await harness({
      allowedOrigins: ["https://selfhost.example.com"],
      fetch: (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch,
    })

    const productOrigin = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        authorization: `Bearer ${await relay.token()}`,
        origin: "https://app.claxedo.com",
      },
    })
    expect(productOrigin.headers.get("access-control-allow-origin")).toBeNull()

    const selfHostOrigin = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        authorization: `Bearer ${await relay.token()}`,
        origin: "https://selfhost.example.com",
      },
    })
    expect(selfHostOrigin.headers.get("access-control-allow-origin")).toBe("https://selfhost.example.com")
  })

  test("default CORS policy still allows product and localhost origins", async () => {
    const relay = await harness({
      fetch: (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch,
    })

    for (const origin of ["https://app.claxedo.com", "https://opencode.ai", "http://localhost:4444"]) {
      const res = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
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

    const first = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: { authorization: `Bearer ${token}` },
    })
    const second = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(revocationCalls).toBe(2)
    expect(forwardedAuth.length).toBe(2)
    expect(forwardedAuth[0]).toBe(forwardedAuth[1])
    expect(second.headers.get("server-timing") ?? "").toContain("rht-cache;dur=")
  })

  test("coalesces concurrent Relay Host Token mints after authorization gates pass", async () => {
    const forwardedAuth: string[] = []
    let revocationCalls = 0
    const relay = await harness({
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
      relay.app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
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
            subject: "user_1",
            scopes: ["workspace:write"],
            claims: {
              iss: "claxedo-control-plane",
              aud: "workspace-relay",
              sub: "user_1",
              org_id: "org_1",
              workspace_id: "ws_1",
              host_id: "host_1",
              role: "editor",
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

    const first = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: { authorization: "Bearer rat-hot" },
    })
    const second = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
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

  test("does not reuse cached Runtime Access Token claims across workspace ids", async () => {
    let verifyCalls = 0
    const relay = await harness({
      runtimeAccessTokenCacheTtlMs: 30_000,
      tokenVerifier: {
        async verify() {
          verifyCalls++
          return {
            subject: "user_1",
            scopes: ["workspace:write"],
            claims: {
              iss: "claxedo-control-plane",
              aud: "workspace-relay",
              sub: "user_1",
              org_id: "org_1",
              workspace_id: "ws_1",
              host_id: "host_1",
              role: "editor",
              exp: Math.floor(Date.now() / 1000) + 300,
              iat: Math.floor(Date.now() / 1000),
              jti: "jti_same_token",
            },
          }
        },
      },
      fetch: (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch,
    })

    const first = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: { authorization: "Bearer rat-replayed" },
    })
    const second = await relay.app.request("http://relay.test/workspaces/ws_2/api/wr/health", {
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
            subject: "user_1",
            scopes: ["workspace:write"],
            claims: {
              iss: "claxedo-control-plane",
              aud: "workspace-relay",
              sub: "user_1",
              org_id: "org_1",
              workspace_id: "ws_1",
              host_id: "host_1",
              role: "editor",
              exp: Math.floor(Date.now() / 1000) + 300,
              iat: Math.floor(Date.now() / 1000),
              jti: "jti_uncached",
            },
          }
        },
      },
      fetch: (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch,
    })

    const first = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: { authorization: "Bearer rat-uncached" },
    })
    const second = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
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

    const res = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
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
    const missing = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/health")
    expect(missing.status).toBe(401)
    await expect(missing.json()).resolves.toEqual({
      error: {
        code: "runtime_access_token_required",
        message: "Runtime Access Token is required",
      },
    })

    const token = await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_2",
      hostId: "host_1",
      role: "editor",
    }, relay.runtime.privateKey, "EdDSA")
    const mismatch = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
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

  test("enforces viewer relay access as read-only", async () => {
    const relay = await harness({
      fetch: ((url, init) => {
        relay.forwarded.push({ url: String(url), request: new Request(url, init) })
        return Promise.resolve(new Response("ok"))
      }) as typeof fetch,
    })

    const get = await relay.app.request("http://relay.test/workspaces/ws_1/api/session", {
      headers: {
        authorization: `Bearer ${await relay.token("viewer")}`,
      },
    })
    const post = await relay.app.request("http://relay.test/workspaces/ws_1/api/session", {
      method: "POST",
      headers: {
        authorization: `Bearer ${await relay.token("viewer")}`,
      },
    })

    expect(get.status).toBe(200)
    expect(post.status).toBe(403)
    await expect(post.json()).resolves.toEqual({
      error: {
        code: "relay_role_denied",
        message: "Workspace role does not allow this relay request",
      },
    })
    expect(relay.forwarded).toHaveLength(1)
    expect(relay.auditEvents).toContainEqual({
      action: "relay.request.denied",
      result: "deny",
      reason: "relay_role_denied",
      subject: "user_1",
      role: "viewer",
      workspaceId: "ws_1",
      hostId: "host_1",
      method: "POST",
      path: "/workspaces/ws_1/api/session",
    })
  })

  test("denies viewer access to terminal routes including WebSocket upgrades", async () => {
    const relay = await harness({
      fetch: ((url, init) => {
        relay.forwarded.push({ url: String(url), request: new Request(url, init) })
        return Promise.resolve(new Response("unexpected"))
      }) as typeof fetch,
    })
    const token = await relay.token("viewer")

    const list = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/pty", {
      headers: { authorization: `Bearer ${token}` },
    })
    const connect = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/pty/pty_1/connect", {
      headers: {
        authorization: `Bearer ${token}`,
        connection: "Upgrade",
        upgrade: "websocket",
      },
    })
    const encodedConnect = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/%70ty/pty_1/connect", {
      headers: {
        authorization: `Bearer ${token}`,
        connection: "Upgrade",
        upgrade: "websocket",
      },
    })

    expect(list.status).toBe(403)
    expect(connect.status).toBe(403)
    expect(encodedConnect.status).toBe(403)
    await expect(connect.json()).resolves.toEqual({
      error: {
        code: "relay_role_denied",
        message: "Workspace role does not allow this relay request",
      },
    })
    expect(relay.forwarded).toEqual([])
  })

  test("allows editor admin and owner relay write requests", async () => {
    const relay = await harness({
      fetch: ((url, init) => {
        relay.forwarded.push({ url: String(url), request: new Request(url, init) })
        return Promise.resolve(new Response("ok"))
      }) as typeof fetch,
    })

    const roles = ["editor", "admin", "owner"] as const
    const methods = ["POST", "PATCH", "DELETE"] as const
    for (const role of roles) {
      const res = await relay.app.request(`http://relay.test/workspaces/ws_1/api/session/${role}`, {
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
        relay.forwarded.push({ url: String(url), request: new Request(url, init) })
        return Promise.resolve(new Response("unexpected"))
      }) as typeof fetch,
    })

    const res = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
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
      subject: "user_1",
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
      const res = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/events", {
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

  test("maps Hono forwarder upstream timeout to 504", async () => {
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
    const res = await relay.app.request("http://relay.test/workspaces/ws_1/api/slow", {
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
      const res = await relay.app.request("http://relay.test/workspaces/ws_1/api/claxedo/events", {
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

  test("fails closed when a user-hosted target has no active host tunnel presence", async () => {
    const relay = await harness({
      access: "user-hosted",
      backing: "local-worktree",
      directory: createWorkspaceRelayDirectory(),
    })

    const res = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      headers: {
        authorization: `Bearer ${await relay.token()}`,
      },
    })

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "user_hosted_app_offline",
        message: "User-hosted workspace is offline",
      },
    })
    expect(relay.auditEvents).toContainEqual({
      action: "relay.request.denied",
      result: "deny",
      reason: "user_hosted_app_offline",
      subject: "user_1",
      role: "editor",
      workspaceId: "ws_1",
      hostId: "host_1",
      method: "GET",
      path: "/workspaces/ws_1/api/wr/health",
    })
  })

  describe("/.well-known/jwks.json", () => {
    test("returns 503 when no public keys are configured", async () => {
      const relay = await harness()
      const res = await relay.app.request("http://relay.test/.well-known/jwks.json")
      expect(res.status).toBe(503)
    })

    test("returns a valid JWKS shape with the current RHT public key", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      const jwk = await exportJWK(relayHost.publicKey)
      const kid = createHash("sha256").update(String(jwk.x ?? "")).digest("hex").slice(0, 16)

      const app = createWorkspaceRelay({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        relayHostPublicKeys: [{ publicKey: relayHost.publicKey, kid }],
        resolveTarget: async () => undefined,
      })

      const res = await app.request("http://relay.test/.well-known/jwks.json")
      expect(res.status).toBe(200)
      expect(res.headers.get("cache-control")).toBe("public, max-age=300")
      expect(res.headers.get("content-type")).toMatch(/application\/json/)

      const body = (await res.json()) as { keys: Array<Record<string, unknown>> }
      expect(Array.isArray(body.keys)).toBe(true)
      expect(body.keys.length).toBe(1)
      const key = body.keys[0]!
      expect(key.kty).toBe("OKP")
      expect(key.crv).toBe("Ed25519")
      expect(key.alg).toBe("EdDSA")
      expect(key.use).toBe("sig")
      expect(key.kid).toBe(kid)
      expect(typeof key.x).toBe("string")
    })

    test("includes both current and next keys when next is configured", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const current = await generateKeyPair("EdDSA", { extractable: true })
      const next = await generateKeyPair("EdDSA", { extractable: true })
      const currentJwk = await exportJWK(current.publicKey)
      const nextJwk = await exportJWK(next.publicKey)
      const currentKid = createHash("sha256").update(String(currentJwk.x ?? "")).digest("hex").slice(0, 16)
      const nextKid = createHash("sha256").update(String(nextJwk.x ?? "")).digest("hex").slice(0, 16)

      const app = createWorkspaceRelay({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: current.privateKey,
        relayHostAlgorithm: "EdDSA",
        relayHostPublicKeys: [
          { publicKey: current.publicKey, kid: currentKid },
          { publicKey: next.publicKey, kid: nextKid },
        ],
        resolveTarget: async () => undefined,
      })

      const res = await app.request("http://relay.test/.well-known/jwks.json")
      expect(res.status).toBe(200)
      const body = (await res.json()) as { keys: Array<Record<string, unknown>> }
      expect(body.keys).toHaveLength(2)
      expect(body.keys.map((k) => k.kid)).toEqual([currentKid, nextKid])
    })

    test("the kid published in JWKS matches the kid embedded in a freshly minted RHT", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      const jwk = await exportJWK(relayHost.publicKey)
      const kid = createHash("sha256").update(String(jwk.x ?? "")).digest("hex").slice(0, 16)

      const app = createWorkspaceRelay({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        relayHostPublicKeys: [{ publicKey: relayHost.publicKey, kid }],
        relayHostMintKid: kid,
        resolveTarget: (claims) => ({
          workspaceId: claims.workspace_id,
          hostId: claims.host_id,
          baseUrl: "https://host.example.test",
          access: "cloud",
          backing: "cloud-vm",
        }),
        fetch: ((url, init) => {
          const request = new Request(url, init)
          mintedRequests.push(request)
          return Promise.resolve(new Response("ok"))
        }) as typeof fetch,
      })
      const mintedRequests: Request[] = []

      const ratToken = await mintRuntimeAccessToken({
        subject: "user_1",
        orgId: "org_1",
        workspaceId: "ws_1",
        hostId: "host_1",
        role: "editor",
      }, runtime.privateKey, "EdDSA")

      const res = await app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
        headers: { authorization: `Bearer ${ratToken}` },
      })
      expect(res.status).toBe(200)

      const upstreamAuth = mintedRequests[0]?.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
      expect(upstreamAuth).toBeTruthy()
      const header = decodeProtectedHeader(upstreamAuth!)
      expect(header.kid).toBe(kid)

      // And the same kid is published in JWKS.
      const jwksRes = await app.request("http://relay.test/.well-known/jwks.json")
      const body = (await jwksRes.json()) as { keys: Array<Record<string, unknown>> }
      expect(body.keys.some((k) => k.kid === kid)).toBe(true)

      // And the RHT verifies against the published key.
      await expect(verifyRelayHostToken(upstreamAuth!, relayHost.publicKey, {
        workspaceId: "ws_1",
        hostId: "host_1",
      })).resolves.toMatchObject({
        workspace_id: "ws_1",
        host_id: "host_1",
      })

      // Reference mintRelayHostToken so the import isn't stripped.
      void mintRelayHostToken
    })
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
      expect(out.get("X-Daytona-Skip-Preview-Warning")).toBe("true")
      expect(out.get("content-type")).toBe("application/json")
    })

    test("applies trusted upstream headers after client and relay headers", () => {
      const input = new Headers({
        "x-daytona-preview-token": "client-supplied",
        "x-workspace-id": "client-supplied",
      })
      const out = workspaceRelayForwardHeaders(input, "tok", "ws_1", {
        upstreamHeaders: {
          "x-daytona-preview-token": "resolver-supplied",
          "x-empty-provider-header": "   ",
        },
      })

      expect(out.get("x-daytona-preview-token")).toBe("resolver-supplied")
      expect(out.get("x-workspace-id")).toBe("ws_1")
      expect(out.get("x-empty-provider-header")).toBeNull()
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

    test("cloud-vm path: Cookie header passes through when userHosted: false", () => {
      const input = new Headers({ cookie: "session=abc" })
      const out = workspaceRelayForwardHeaders(input, "tok", "ws_1", { userHosted: false })
      expect(out.get("cookie")).toBe("session=abc")
    })

    test("user-hosted path: Cookie header is stripped", () => {
      const input = new Headers({ cookie: "session=abc; secret=xyz" })
      const out = workspaceRelayForwardHeaders(input, "tok", "ws_1", { userHosted: true })
      // User-hosted workspaces run on the user's laptop where cookie jars may
      // be shared with the browser; passthrough leaks sensitive cookies.
      expect(out.get("cookie")).toBeNull()
    })

    test("user-hosted path: Cookie header is stripped (case-insensitive)", () => {
      const input = new Headers()
      input.set("Cookie", "session=abc")
      const out = workspaceRelayForwardHeaders(input, "tok", "ws_1", { userHosted: true })
      expect(out.get("cookie")).toBeNull()
      expect(out.get("Cookie")).toBeNull()
    })

    test("user-hosted path: Existing dangerous-header strip still happens", () => {
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
      const out = workspaceRelayForwardHeaders(input, "tok", "ws_1", { userHosted: true })
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
        { signal: controller.signal, userHosted: false },
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
          relay.forwarded.push({ url: String(url), request: new Request(url, init) })
          return Promise.resolve(new Response("ok"))
        }) as typeof fetch,
      })

      const res = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
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
      expect(upstream!.headers.get("x-forwarded-for")).toBeNull()
      expect(upstream!.headers.get("x-forwarded-host")).toBeNull()
      expect(upstream!.headers.get("x-forwarded-proto")).toBeNull()
      expect(upstream!.headers.get("x-real-ip")).toBeNull()
      expect(upstream!.headers.get("x-claxedo-internal-actor")).toBeNull()
      expect(upstream!.headers.get("x-supervisor-backplane-token")).toBeNull()
      expect(upstream!.headers.get("x-forwarded-by")).toBe("workspace-relay")
    })
  })

  // P-shared.2: TokenVerifier seam.
  describe("tokenVerifier override", () => {
    test("uses the injected verifier instead of decoding the JWT", async () => {
      const runtime = await generateKeyPair("EdDSA", { extractable: true })
      const relayHost = await generateKeyPair("EdDSA", { extractable: true })
      const calls: string[] = []
      const app = createWorkspaceRelay({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        resolveTarget: (claims) => ({
          workspaceId: claims.workspace_id,
          hostId: claims.host_id,
          baseUrl: "https://host.example.test",
          access: "cloud",
          backing: "cloud-vm",
        }),
        tokenVerifier: {
          async verify(token) {
            calls.push(token)
            return {
              subject: "u-from-verifier",
              scopes: ["workspace:write"],
              claims: {
                sub: "u-from-verifier",
                org_id: "org_1",
                workspace_id: "ws_1",
                host_id: "host_1",
                role: "editor",
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
        const request = new Request(url, init)
        return Promise.resolve(new Response("ok", { status: 200 }))
      }) as typeof fetch
      try {
        const res = await app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
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
      const app = createWorkspaceRelay({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        resolveTarget: (claims) => {
          resolved = true
          return {
            workspaceId: claims.workspace_id,
            hostId: claims.host_id,
            baseUrl: "https://host.example.test",
            access: "cloud",
            backing: "cloud-vm",
          }
        },
        tokenVerifier: {
          async verify() {
            return {
              subject: "u-from-verifier",
              scopes: ["workspace:write"],
              claims: {
                iss: "claxedo-control-plane",
                aud: "workspace-relay",
                sub: "u-from-verifier",
                org_id: "org_1",
                workspace_id: "ws_other",
                host_id: "host_1",
                role: "editor",
                exp: Math.floor(Date.now() / 1000) + 300,
                iat: Math.floor(Date.now() / 1000),
                jti: "jti_custom",
              },
            }
          },
        },
      })

      const res = await app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
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
        sub: "u-from-verifier",
        org_id: "org_1",
        workspace_id: "ws_1",
        host_id: "host_1",
        exp: Math.floor(Date.now() / 1000) + 300,
        iat: Math.floor(Date.now() / 1000),
        jti: "jti_custom",
      }
      const app = createWorkspaceRelay({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        resolveTarget: () => ({
          workspaceId: "ws_1",
          hostId: "host_1",
          baseUrl: "https://host.example.test",
          access: "cloud",
          backing: "cloud-vm",
        }),
        tokenVerifier: {
          async verify() {
            return {
              subject: "u-from-verifier",
              scopes: ["workspace:write"],
              claims: {
                ...claims,
                role: "maintainer",
              } as unknown as RuntimeAccessVerifierClaims,
            }
          },
        },
      })

      const res = await app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
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
      const app = createWorkspaceRelay({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        resolveTarget: () => ({
          workspaceId: "ws_1",
          hostId: "host_1",
          baseUrl: "https://host.example.test",
          access: "cloud",
          backing: "cloud-vm",
        }),
        tokenVerifier: {
          async verify() {
            return {
              subject: "u-from-verifier",
              scopes: ["workspace:write"],
              claims: {
                iss: "claxedo-control-plane",
                aud: "workspace-relay",
                sub: "u-from-verifier",
                workspace_id: "ws_1",
                host_id: "host_1",
                role: "editor",
              } as unknown as RuntimeAccessVerifierClaims,
            }
          },
        },
      })

      const res = await app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
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
      const app = createWorkspaceRelay({
        runtimeAccessKey: runtime.publicKey,
        relayHostSigningKey: relayHost.privateKey,
        relayHostAlgorithm: "EdDSA",
        resolveTarget: () => ({
          workspaceId: "ws_1",
          hostId: "host_1",
          baseUrl: "https://host.example.test",
          access: "cloud",
          backing: "cloud-vm",
        }),
        tokenVerifier: {
          async verify() {
            throw new Error("verifier unavailable")
          },
        },
      })

      const res = await app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
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

describe("workspace relay audit sampling (T16)", () => {
  async function samplingHarness(input: {
    auditAcceptSampleRate?: number
    auditFlushIntervalMs?: number
    random?: () => number
  } = {}) {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const auditEvents: WorkspaceRelayAuditEvent[] = []
    const app = createWorkspaceRelay({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "https://host.example.test",
        access: "cloud",
        backing: "cloud-vm",
      }),
      audit: (event) => {
        auditEvents.push(event)
      },
      ...(input.auditAcceptSampleRate !== undefined ? { auditAcceptSampleRate: input.auditAcceptSampleRate } : {}),
      ...(input.auditFlushIntervalMs !== undefined ? { auditFlushIntervalMs: input.auditFlushIntervalMs } : {}),
      ...(input.random ? { random: input.random } : {}),
    })
    return {
      app,
      auditEvents,
      runtime,
      relayHost,
      token: (role: "viewer" | "editor" | "admin" | "owner" = "editor", workspaceId = "ws_1") =>
        mintRuntimeAccessToken({
          subject: "user_1",
          orgId: "org_1",
          workspaceId,
          hostId: "host_1",
          role,
        }, runtime.privateKey, "EdDSA"),
    }
  }

  test("accept events ALL emit when sample rate is 1.0", async () => {
    const harness = await samplingHarness({ auditAcceptSampleRate: 1.0 })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch
    try {
      const token = await harness.token()
      for (let i = 0; i < 100; i++) {
        const res = await harness.app.request(`http://relay.test/workspaces/ws_1/api/wr/health?n=${i}`, {
          headers: { authorization: `Bearer ${token}` },
        })
        expect(res.status).toBe(200)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
    const accepted = harness.auditEvents.filter((e) => e.action === "relay.request.accepted")
    expect(accepted).toHaveLength(100)
  })

  test("accept events sampled at 0.5 emit a fraction (deterministic)", async () => {
    // Deterministic: alternate < and > 0.5 each call; with rate 0.5 the sampler
    // keeps when random() <= rate (or random() < rate, depending on impl). Use a
    // counter-based PRNG that yields a known mix.
    let counter = 0
    const random = () => {
      counter += 1
      // Cycle: 0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 0.45, 0.55 ... half below 0.5
      const seq = [0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 0.45, 0.55]
      return seq[counter % seq.length]!
    }
    const harness = await samplingHarness({ auditAcceptSampleRate: 0.5, random })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch
    try {
      const token = await harness.token()
      for (let i = 0; i < 100; i++) {
        await harness.app.request(`http://relay.test/workspaces/ws_1/api/wr/health?n=${i}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      }
    } finally {
      globalThis.fetch = originalFetch
    }
    const accepted = harness.auditEvents.filter((e) => e.action === "relay.request.accepted")
    // Loose bound to avoid flakiness even if sampler implementation differs slightly.
    expect(accepted.length).toBeGreaterThanOrEqual(30)
    expect(accepted.length).toBeLessThanOrEqual(70)
    harness.app.disposeAuditSampler()
  })

  test("accept events sampled at 0.0 emit zero accepts", async () => {
    const harness = await samplingHarness({ auditAcceptSampleRate: 0.0 })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch
    try {
      const token = await harness.token()
      for (let i = 0; i < 25; i++) {
        await harness.app.request(`http://relay.test/workspaces/ws_1/api/wr/health?n=${i}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      }
    } finally {
      globalThis.fetch = originalFetch
    }
    const accepted = harness.auditEvents.filter((e) => e.action === "relay.request.accepted")
    expect(accepted).toHaveLength(0)
    harness.app.disposeAuditSampler()
  })

  test("deny events ALWAYS emit regardless of sample rate", async () => {
    const harness = await samplingHarness({ auditAcceptSampleRate: 0.0 })
    // Trigger 5 denies via missing auth.
    for (let i = 0; i < 5; i++) {
      const res = await harness.app.request(`http://relay.test/workspaces/ws_1/api/wr/health?n=${i}`)
      expect(res.status).toBe(401)
    }
    const denied = harness.auditEvents.filter((e) => e.action === "relay.request.denied")
    expect(denied).toHaveLength(5)
    harness.app.disposeAuditSampler()
  })

  test("emits relay.request.suppressed_summary periodically with count", async () => {
    const harness = await samplingHarness({
      auditAcceptSampleRate: 0.0,
      auditFlushIntervalMs: 50,
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch
    try {
      const token = await harness.token()
      for (let i = 0; i < 7; i++) {
        await harness.app.request(`http://relay.test/workspaces/ws_1/api/wr/health?n=${i}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      }
      // Wait long enough for at least one flush interval to elapse.
      await new Promise((resolve) => setTimeout(resolve, 120))
    } finally {
      globalThis.fetch = originalFetch
    }
    const summaries = harness.auditEvents.filter(
      (e) => e.action === "relay.request.suppressed_summary",
    )
    expect(summaries.length).toBeGreaterThanOrEqual(1)
    // Sum of suppressed counts across summary events should equal total suppressed (7).
    const total = summaries.reduce((acc, e) => acc + (e.suppressedCount ?? 0), 0)
    expect(total).toBe(7)
    harness.app.disposeAuditSampler()
  })
})

describe("workspace relay drain (T9)", () => {
  test("/health returns 200 when not draining", async () => {
    const relay = await harness()
    const res = await relay.app.request("http://relay.test/health")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; service: string }
    expect(body.ok).toBe(true)
    expect(body.service).toBe("workspace-relay")
  })

  test("allows Claxedo app origins to preflight authorized workspace requests", async () => {
    const relay = await harness()
    const res = await relay.app.request("http://relay.test/workspaces/ws_1/api/wr/health", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.claxedo.com",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.claxedo.com")
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization")
  })

  test("/health returns 503 when isDraining() returns true", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    let draining = false
    const app = createWorkspaceRelay({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "https://host.example.test",
        access: "cloud",
        backing: "cloud-vm",
      }),
      isDraining: () => draining,
    })

    const ok = await app.request("http://relay.test/health")
    expect(ok.status).toBe(200)

    draining = true
    const draininRes = await app.request("http://relay.test/health")
    expect(draininRes.status).toBe(503)
    const body = (await draininRes.json()) as { ok: boolean; service: string; draining: boolean }
    expect(body.ok).toBe(false)
    expect(body.draining).toBe(true)
  })

  test("workspace request returns 503 when draining (before auth)", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const app = createWorkspaceRelay({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "https://host.example.test",
        access: "cloud",
        backing: "cloud-vm",
      }),
      isDraining: () => true,
    })
    // No Authorization header — proves draining short-circuits before auth.
    const res = await app.request("http://relay.test/workspaces/ws_1/anything")
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "relay_draining",
        message: "Workspace relay is shutting down; try another instance",
      },
    })
  })
})

describe("workspace relay /metrics endpoint (T31)", () => {
  async function metricsHarness(input: {
    metricsToken?: string
    metricsRemoteAddress?: (req: Request) => string | undefined
    fragmentation?: () => { fragmentsBuffered: number; oversizedClosed: number }
    slowConsumer?: () => { overflowEvents: number; timerFired: number; droppedRequests: number }
    drainPending?: () => number
    auditAcceptSampleRate?: number
    auditFlushIntervalMs?: number
  } = {}) {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const directory = createWorkspaceRelayDirectory({ sweepIntervalMs: 0 })
    const auditEvents: WorkspaceRelayAuditEvent[] = []
    const app = createWorkspaceRelay({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      directory,
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "https://host.example.test",
        access: "cloud",
        backing: "cloud-vm",
      }),
      audit: (event) => {
        auditEvents.push(event)
      },
      ...(input.metricsToken !== undefined ? { metricsToken: input.metricsToken } : {}),
      ...(input.metricsRemoteAddress ? { metricsRemoteAddress: input.metricsRemoteAddress } : {}),
      ...(input.fragmentation || input.slowConsumer || input.drainPending
        ? {
            metricsSources: {
              ...(input.fragmentation ? { fragmentation: input.fragmentation } : {}),
              ...(input.slowConsumer ? { slowConsumer: input.slowConsumer } : {}),
              ...(input.drainPending ? { drainPending: input.drainPending } : {}),
            },
          }
        : {}),
      ...(input.auditAcceptSampleRate !== undefined ? { auditAcceptSampleRate: input.auditAcceptSampleRate } : {}),
      ...(input.auditFlushIntervalMs !== undefined ? { auditFlushIntervalMs: input.auditFlushIntervalMs } : {}),
    })
    return {
      app,
      directory,
      auditEvents,
      runtime,
      relayHost,
      token: (workspaceId = "ws_1") =>
        mintRuntimeAccessToken({
          subject: "user_1",
          orgId: "org_1",
          workspaceId,
          hostId: "host_1",
          role: "editor",
        }, runtime.privateKey, "EdDSA"),
    }
  }

  test("returns 200 with JSON body containing all expected counter sections (loopback)", async () => {
    const harness = await metricsHarness({
      metricsRemoteAddress: () => "127.0.0.1",
      fragmentation: () => ({ fragmentsBuffered: 3, oversizedClosed: 1 }),
      slowConsumer: () => ({ overflowEvents: 4, timerFired: 2, droppedRequests: 2 }),
      drainPending: () => 5,
    })

    const res = await harness.app.request("http://relay.test/metrics")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      fragmentation: { fragmentsBuffered: number; oversizedClosed: number }
      slowConsumer: { overflowEvents: number; timerFired: number; droppedRequests: number }
      directory: { activeHostCount: number }
      audit: { suppressedAccepts: number }
      drain?: { pendingCount: number }
    }
    expect(body.fragmentation).toEqual({ fragmentsBuffered: 3, oversizedClosed: 1 })
    expect(body.slowConsumer).toEqual({ overflowEvents: 4, timerFired: 2, droppedRequests: 2 })
    expect(body.directory).toEqual({ activeHostCount: 0 })
    expect(body.audit).toEqual({ suppressedAccepts: 0 })
    expect(body.drain).toEqual({ pendingCount: 5 })
    harness.app.disposeAuditSampler()
  })

  test("returns 401 from a non-loopback origin without metricsToken set", async () => {
    const harness = await metricsHarness({
      metricsRemoteAddress: () => "203.0.113.7",
    })
    const res = await harness.app.request("http://relay.test/metrics")
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "metrics_unauthorized",
        message: "Metrics endpoint is restricted to loopback or bearer-token clients",
      },
    })
    harness.app.disposeAuditSampler()
  })

  test("returns 401 from non-loopback when metricsToken set but Authorization missing/wrong", async () => {
    const harness = await metricsHarness({
      metricsToken: "secret-token",
      metricsRemoteAddress: () => "203.0.113.7",
    })
    const missing = await harness.app.request("http://relay.test/metrics")
    expect(missing.status).toBe(401)
    await expect(missing.json()).resolves.toEqual({
      error: {
        code: "metrics_unauthorized",
        message: "Metrics endpoint requires a valid bearer token",
      },
    })

    const wrong = await harness.app.request("http://relay.test/metrics", {
      headers: { authorization: "Bearer not-the-token" },
    })
    expect(wrong.status).toBe(401)
    await expect(wrong.json()).resolves.toEqual({
      error: {
        code: "metrics_unauthorized",
        message: "Metrics endpoint requires a valid bearer token",
      },
    })
    harness.app.disposeAuditSampler()
  })

  test("returns 200 with valid Authorization: Bearer <metricsToken> from non-loopback", async () => {
    const harness = await metricsHarness({
      metricsToken: "secret-token",
      metricsRemoteAddress: () => "203.0.113.7",
    })
    const res = await harness.app.request("http://relay.test/metrics", {
      headers: { authorization: "Bearer secret-token" },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { fragmentation: unknown }
    expect(body.fragmentation).toBeDefined()
    harness.app.disposeAuditSampler()
  })

  test("directory.activeHostCount reflects registered hosts", async () => {
    const harness = await metricsHarness({
      metricsRemoteAddress: () => "127.0.0.1",
    })
    harness.directory.registerHostTunnel({ hostId: "host_a", workspaceIds: ["ws_1"] })
    harness.directory.registerHostTunnel({ hostId: "host_b", workspaceIds: ["ws_2"] })

    const res = await harness.app.request("http://relay.test/metrics")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { directory: { activeHostCount: number } }
    expect(body.directory.activeHostCount).toBe(2)
    harness.app.disposeAuditSampler()
  })

  test("audit.suppressedAccepts reflects sampler's internal suppressed counter", async () => {
    const harness = await metricsHarness({
      metricsRemoteAddress: () => "127.0.0.1",
      auditAcceptSampleRate: 0.0,
      // No flush interval needed — we read suppressed before any flush fires.
      auditFlushIntervalMs: 60_000,
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch
    try {
      const token = await harness.token()
      for (let i = 0; i < 4; i++) {
        await harness.app.request(`http://relay.test/workspaces/ws_1/api/wr/health?n=${i}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      }
    } finally {
      globalThis.fetch = originalFetch
    }
    const res = await harness.app.request("http://relay.test/metrics")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { audit: { suppressedAccepts: number } }
    expect(body.audit.suppressedAccepts).toBe(4)
    harness.app.disposeAuditSampler()
  })

  test("metrics endpoint returns 200 even if no metricsSources are wired (best-effort defaults)", async () => {
    const harness = await metricsHarness({
      metricsRemoteAddress: () => "127.0.0.1",
    })
    const res = await harness.app.request("http://relay.test/metrics")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      fragmentation: { fragmentsBuffered: number; oversizedClosed: number }
      slowConsumer: { overflowEvents: number; timerFired: number; droppedRequests: number }
      directory: { activeHostCount: number }
      audit: { suppressedAccepts: number }
    }
    expect(body.fragmentation).toEqual({ fragmentsBuffered: 0, oversizedClosed: 0 })
    expect(body.slowConsumer).toEqual({ overflowEvents: 0, timerFired: 0, droppedRequests: 0 })
    expect(body.directory).toEqual({ activeHostCount: 0 })
    expect(body.audit).toEqual({ suppressedAccepts: 0 })
    harness.app.disposeAuditSampler()
  })

  test("when metricsToken unset and metricsRemoteAddress unset, fails closed", async () => {
    const harness = await metricsHarness({})
    const res = await harness.app.request("http://relay.test/metrics")
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "metrics_unauthorized",
        message: "Metrics endpoint is restricted to loopback or bearer-token clients",
      },
    })
    harness.app.disposeAuditSampler()
  })

  test("loopback IPv6 ::1 also passes the loopback check", async () => {
    const harness = await metricsHarness({
      metricsRemoteAddress: () => "::1",
    })
    const res = await harness.app.request("http://relay.test/metrics")
    expect(res.status).toBe(200)
    harness.app.disposeAuditSampler()
  })
})
