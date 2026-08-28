import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type { SessionAccessPolicy, SessionAccessPolicyInput } from "../session-access-policy"
import { sessionV2Proxy } from "./session-v2-proxy"

function policy(overrides: Partial<SessionAccessPolicy> = {}): SessionAccessPolicy {
  return {
    sessionAuthority: "managed-private",
    authorize: async () => ({ allowed: true }),
    authorizePrefix: async () => ({ allowed: true }),
    filterSessions: async (input) => input.sessionIds,
    registerSession: async () => ({ allowed: true }),
    ...overrides,
  }
}

function app(input: {
  policy?: SessionAccessPolicy
  forward: (request: Request) => Promise<Response> | Response
}) {
  const hono = new Hono()
  hono.use("*", async (c, next) => {
    c.set("relayHostAuth" as never, {
      actor_id: "actor_1",
      actor_kind: "human",
      org_id: "org_1",
      workspace_id: "ws_1",
      host_id: "host_1",
      role: "editor",
    } as never)
    await next()
  })
  hono.all("/api/session", sessionV2Proxy({
    ...(input.policy ? { policy: input.policy } : {}),
    forward: (c) => Promise.resolve(input.forward(c.req.raw)),
  }))
  hono.all("/api/session/*", sessionV2Proxy({
    ...(input.policy ? { policy: input.policy } : {}),
    forward: (c) => Promise.resolve(input.forward(c.req.raw)),
  }))
  return hono
}

describe("Session V2 private proxy", () => {
  test("authorizes a session-scoped write using the path session id before forwarding", async () => {
    const admissions: SessionAccessPolicyInput[] = []
    let forwarded = 0
    const response = await app({
      policy: policy({
        authorizePrefix: async (value) => {
          admissions.push(value)
          return { allowed: false, status: 403, code: "session_private", message: "private" }
        },
      }),
      forward: () => {
        forwarded += 1
        return Response.json({ data: { admitted: true } })
      },
    }).request("/api/session/ses_private/prompt", { method: "POST" })

    expect(response.status).toBe(403)
    expect(forwarded).toBe(0)
    expect(admissions).toEqual([expect.objectContaining({
      actor: { actorId: "actor_1", actorKind: "human" },
      authority: expect.objectContaining({ workspaceId: "ws_1", orgId: "org_1" }),
      method: "POST",
      operation: "session_v2_proxy",
      path: "/api/session/ses_private/prompt",
      sessionId: "ses_private",
    })])
  })

  test("filters list and active collection responses through the session authority", async () => {
    const fixture = policy({
      filterSessions: async (input) => input.sessionIds.filter((id) => id === "ses_visible"),
    })
    const runtime = app({
      policy: fixture,
      forward: (request) => new URL(request.url).pathname === "/api/session/active"
        ? Response.json({ data: { ses_visible: { type: "running" }, ses_private: { type: "running" } } })
        : Response.json({
            data: [{ id: "ses_visible", title: "Visible" }, { id: "ses_private", title: "Private" }],
            cursor: { next: "opaque" },
          }),
    })

    expect(await (await runtime.request("/api/session")).json()).toEqual({
      data: [{ id: "ses_visible", title: "Visible" }],
      cursor: { next: "opaque" },
    })
    expect(await (await runtime.request("/api/session/active")).json()).toEqual({
      data: { ses_visible: { type: "running" } },
    })
  })

  test("refuses managed create and fork before either can mutate the upstream", async () => {
    let forwarded = 0
    const runtime = app({
      policy: policy(),
      forward: () => {
        forwarded += 1
        return Response.json({ data: { id: "unexpected" } }, { status: 201 })
      },
    })

    const create = await runtime.request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "ses_reserved" }),
    })
    const fork = await runtime.request("/api/session/ses_parent/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "ses_child" }),
    })

    expect(create.status).toBe(503)
    expect(await create.json()).toMatchObject({ error: { code: "session_v2_managed_creation_unavailable" } })
    expect(fork.status).toBe(503)
    expect(await fork.json()).toMatchObject({ error: { code: "session_v2_managed_fork_unavailable" } })
    expect(forwarded).toBe(0)
  })

  test("fails closed when a managed collection response cannot be filtered", async () => {
    const response = await app({
      policy: policy(),
      forward: () => Response.json({ data: "not-a-session-list" }),
    }).request("/api/session")

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: "session_v2_invalid_response" } })
  })

  test("keeps the byte-for-byte local proxy path when no private policy is installed", async () => {
    const response = await app({
      forward: () => new Response("raw", { status: 207, headers: { "x-upstream": "yes" } }),
    }).request("/api/session", { method: "POST" })

    expect(response.status).toBe(207)
    expect(response.headers.get("x-upstream")).toBe("yes")
    expect(await response.text()).toBe("raw")
  })
})
