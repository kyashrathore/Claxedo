import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import { eventsHandler, eventVisibleTo } from "./events"
import {
  ControlPlaneAuthError,
  type ControlPlaneAuthConfig,
  type ControlPlaneAuthContext,
} from "../control-plane/auth"
import { claxedoBus } from "../bus"

// Rubric S1: /api/claxedo/events must reject unauthenticated requests when
// signed cloud auth is enabled, and must remain a pass-through when running
// in local/unsigned mode. The bus subscription should only attach AFTER auth
// passes — anonymous connections must never observe events.

const baseConfig: ControlPlaneAuthConfig = {
  enabled: true,
  issuer: "https://example.clerk.dev",
  jwksUrl: "https://example.clerk.dev/.well-known/jwks.json",
  audience: "claxedo-server",
}

function mountHandler(options: Parameters<typeof eventsHandler>[0]) {
  const app = new Hono()
  app.get("/api/claxedo/events", eventsHandler(options))
  return app
}

describe("eventsHandler — auth gate (rubric S1)", () => {
  test("returns 401 when signed cloud auth is enabled and no bearer token is present", async () => {
    const app = mountHandler({
      authConfig: baseConfig,
      verifier: async () => {
        throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Bearer token is invalid")
      },
    })
    const res = await app.request("/api/claxedo/events")
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe("missing_bearer_token")
  })

  test("returns 401 when bearer token is invalid", async () => {
    const app = mountHandler({
      authConfig: baseConfig,
      verifier: async () => {
        throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Bearer token is invalid")
      },
    })
    const res = await app.request("/api/claxedo/events", {
      headers: { authorization: "Bearer not-a-real-token" },
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe("invalid_bearer_token")
  })

  test("the bus subscription does NOT attach when auth fails", async () => {
    // Snapshot the subscriber count before and after a rejected request to
    // prove that no leak occurred. The bus's subscribe API doesn't expose a
    // count, so we observe indirectly: publish an event, count handlers
    // invoked. If a subscription leaked, the count would include the leaked
    // handler.
    let handlerInvocations = 0
    const sentinel = claxedoBus.subscribe(() => {
      handlerInvocations++
    })

    const app = mountHandler({
      authConfig: baseConfig,
      verifier: async () => {
        throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Bearer token is invalid")
      },
    })
    await app.request("/api/claxedo/events")

    claxedoBus.publish({
      type: "agent.lifecycle",
      tabId: "sanity",
      eventType: "Idle",
    })

    expect(handlerInvocations).toBe(1) // only the sentinel — no leaked handler
    sentinel()
  })

  test("local/unsigned-local mode does not require authorization", async () => {
    const app = mountHandler({
      authConfig: { enabled: false, mode: "local-only", reason: "CLAXEDO_SIGNED_CLOUD_AUTH not set" },
    })
    // Resolve immediately without writing to localStorage / network. Use
    // AbortController so the SSE handler doesn't keep the test hanging.
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 50)
    let res: Response | undefined
    try {
      res = await Promise.resolve(app.request("/api/claxedo/events", { signal: ac.signal }))
    } catch {
      // expected when the abort fires before the response promise resolves
    }
    // Either the response started (200) or the abort fired before headers
    // landed. The key assertion is that we did NOT get a 401 in unsigned mode.
    if (res) expect(res.status).toBe(200)
  })
})

// Per-event authorization: a valid bearer must not grant the whole bus.
// `ownerUserId`/`orgId` on bus events are enforced server-side, not left as
// client-side routing hints.

const signedAs = (subject: string, orgId?: string): ControlPlaneAuthContext => ({
  mode: "signed",
  token: "test-token",
  user: {
    subject,
    tokenIdentifier: `https://example.clerk.dev|${subject}`,
    issuer: "https://example.clerk.dev",
    ...(orgId ? { orgId } : {}),
  },
})

const unsignedLocal: ControlPlaneAuthContext = { mode: "unsigned-local", reason: "test" }

describe("eventVisibleTo — per-event authorization", () => {
  test("workgraph.changed is visible only to its owner", () => {
    const event = { type: "workgraph.changed", ownerUserId: "user_a", ts: 1 } as const
    expect(eventVisibleTo(signedAs("user_a"), event)).toBe(true)
    expect(eventVisibleTo(signedAs("user_b"), event)).toBe(false)
  })

  test("document.changed is visible only within its org", () => {
    const event = {
      type: "document.changed",
      documentId: "doc-1",
      orgId: "org_x",
      projectId: "proj-1",
      ts: 1,
    } as const
    expect(eventVisibleTo(signedAs("user_a", "org_x"), event)).toBe(true)
    expect(eventVisibleTo(signedAs("user_b", "org_y"), event)).toBe(false)
    // No org claim on the token → no org-scoped events.
    expect(eventVisibleTo(signedAs("user_c"), event)).toBe(false)
  })

  test("provision is visible only within its org; org-less events stay local-only", () => {
    const scoped = { type: "provision", workspaceId: "ws-1", orgId: "org_x", step: "ready", ts: 1 } as const
    expect(eventVisibleTo(signedAs("user_a", "org_x"), scoped)).toBe(true)
    expect(eventVisibleTo(signedAs("user_b", "org_y"), scoped)).toBe(false)

    const orgless = { type: "provision", workspaceId: "ws-2", step: "ready", ts: 1 } as const
    expect(eventVisibleTo(signedAs("user_a", "org_x"), orgless)).toBe(false)
    expect(eventVisibleTo(unsignedLocal, orgless)).toBe(true)
  })

  test("unscoped event types are default-denied to signed subscribers", () => {
    const signed = signedAs("user_a", "org_x")
    // Content-bearing runtime events: the original leak. `tail`, `prompt`,
    // and `lastAssistantMessage` are real terminal/agent content.
    expect(eventVisibleTo(signed, { type: "pty.stream", id: "p1", kind: "data", tail: "secret output" })).toBe(false)
    expect(
      eventVisibleTo(signed, { type: "agent.lifecycle", tabId: "t1", eventType: "Idle", prompt: "secret prompt" }),
    ).toBe(false)
    expect(
      eventVisibleTo(signed, {
        type: "session.lifecycle",
        phase: "created",
        directory: "/home/other-user/project",
        ts: 1,
      }),
    ).toBe(false)
    expect(
      eventVisibleTo(signed, { type: "worktree.ready", directory: "/home/other-user/wt", name: "wt", branch: "main" }),
    ).toBe(false)
  })

  test("unsigned-local sees everything (single-user mode)", () => {
    expect(eventVisibleTo(unsignedLocal, { type: "workgraph.changed", ownerUserId: "anyone", ts: 1 })).toBe(true)
    expect(eventVisibleTo(unsignedLocal, { type: "pty.stream", id: "p1", kind: "data", tail: "output" })).toBe(true)
  })
})

describe("eventsHandler — signed stream is filtered per-event", () => {
  test("a signed subscriber receives their own workgraph.changed but not another user's", async () => {
    const app = mountHandler({
      authConfig: baseConfig,
      verifier: async () => ({
        mode: "signed",
        user: {
          subject: "user_a",
          tokenIdentifier: "https://example.clerk.dev|user_a",
          issuer: "https://example.clerk.dev",
        },
      }),
    })

    const ac = new AbortController()
    const res = await app.request("/api/claxedo/events", {
      headers: { authorization: "Bearer valid-token" },
      signal: ac.signal,
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()

    // Let the SSE callback run so the bus subscription attaches.
    await new Promise((resolve) => setTimeout(resolve, 10))

    // user_b's event first: if the filter were missing it would arrive
    // before user_a's own event in the stream below.
    claxedoBus.publish({ type: "workgraph.changed", ownerUserId: "user_b", ts: 1 })
    claxedoBus.publish({ type: "workgraph.changed", ownerUserId: "user_a", ts: 2 })

    const decoder = new TextDecoder()
    let received = ""
    while (!received.includes("user_a")) {
      const { value, done } = await reader.read()
      if (done) break
      received += decoder.decode(value, { stream: true })
    }
    ac.abort()

    expect(received).toContain("user_a")
    expect(received).not.toContain("user_b")
  }, 10_000)
})
