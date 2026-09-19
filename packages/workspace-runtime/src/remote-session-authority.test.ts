import { describe, expect, test } from "bun:test"
import { remoteWorkspaceSessionAccessPolicy } from "./remote-session-authority"
import { fetchBodyJson, fetchUrl } from "./test-support/fetch-double"
import { rec } from "./json-value"

const input = {
  actor: { actorId: "actor_b", actorKind: "human" as const },
  authority: {
    managed: true as const,
    workspaceId: "ws_1",
    orgId: "org_1",
    role: "editor" as const,
  },
  credential: "Bearer signed-rht",
  sessionId: "ses_private",
}

describe("remote workspace session authority", () => {
  test("uses the current host-role oracle for setup reads and administration", async () => {
    const bodies: unknown[] = []
    const policy = remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/api/runtime-authority/session-authorize",
      fetch: async (_url, init) => {
        bodies.push(fetchBodyJson(init?.body))
        return Response.json({ allowed: true })
      },
    })
    expect((await policy.authorizeHost!({
      ...input,
      operation: "agent_setup_read",
      minimumRole: "viewer",
    })).allowed).toBe(true)
    expect((await policy.authorizeHost!({
      ...input,
      operation: "agent_setup_write",
      minimumRole: "admin",
    })).allowed).toBe(true)
    expect(bodies).toEqual([{ action: "host_read" }, { action: "host_admin" }])
  })

  test("a host-authority answer that is not a refusal is the authority being unavailable, not a denial", async () => {
    const answers = [403, 500, 404, 429]
    const policy = remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/api/runtime-authority/session-authorize",
      fetch: async () => Response.json({ error: { code: "host_authority_denied", message: "no" } }, { status: answers.shift() }),
    })
    const host = () => policy.authorizeHost!({ ...input, operation: "session_event_stream", minimumRole: "viewer" })
    expect(await host()).toMatchObject({ allowed: false, status: 403, code: "host_authority_denied" })
    expect(await host()).toMatchObject({ allowed: false, status: 503 })
    expect(await host()).toMatchObject({ allowed: false, status: 503 })
    expect(await host()).toMatchObject({ allowed: false, status: 503 })
  })

  test("forwards only the opaque proof, session id, and read/write action", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const policy = remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/api/runtime-authority/session-authorize",
      fetch: async (url, init) => {
        requests.push({ url: fetchUrl(url), init })
        return Response.json({ allowed: true })
      },
    })

    expect((await policy.authorize({ ...input, operation: "message_read" })).allowed).toBe(true)
    expect((await policy.authorize({ ...input, operation: "prompt" })).allowed).toBe(true)
    expect(typeof policy.registerSession).toBe("function")
    expect((await policy.registerSession!({
      ...input,
      operation: "session_create",
      registrationOperationId: "op_register_1",
    })).allowed).toBe(true)
    expect(requests.map((request) => ({
      authorization: new Headers(request.init?.headers).get("authorization"),
      body: fetchBodyJson(request.init?.body),
    }))).toEqual([
      { authorization: "Bearer signed-rht", body: { sessionId: "ses_private", action: "read" } },
      { authorization: "Bearer signed-rht", body: { sessionId: "ses_private", action: "write" } },
      { authorization: "Bearer signed-rht", body: { sessionId: "ses_private", action: "register", operationId: "op_register_1" } },
    ])
  })

  test("reserves a child as the presented proof's principal and answers the operation the authority minted", async () => {
    const requests: Array<{ headers: Headers; body: unknown }> = []
    const policy = remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/authorize",
      fetch: async (_url, init) => {
        requests.push({ headers: new Headers(init?.headers), body: fetchBodyJson(init?.body) })
        return Response.json({ allowed: true, operationId: "session_registration_child" })
      },
    })
    expect(typeof policy.reserveSession).toBe("function")
    expect(await policy.reserveSession!({
      ...input,
      operation: "session_create",
      sessionId: "ses_child",
      parentSessionId: "ses_parent",
      sessionTitle: "Reviewer",
    })).toEqual({ allowed: true, operationId: "session_registration_child" })
    expect(requests).toHaveLength(1)
    expect(requests[0].headers.get("authorization")).toBe("Bearer signed-rht")
    expect(requests[0].body).toEqual({ sessionId: "ses_child", action: "reserve", parentSessionId: "ses_parent", title: "Reviewer" })

    for (const body of [{ allowed: true }, { allowed: true, operationId: 7 }, {}]) {
      const invalid = remoteWorkspaceSessionAccessPolicy({ url: "https://control.test/authorize", fetch: async () => Response.json(body) })
      expect(await invalid.reserveSession!({ ...input, operation: "session_create", sessionId: "ses_child", parentSessionId: "ses_parent" }))
        .toMatchObject({ allowed: false, status: 503, code: "session_authority_invalid_response" })
    }
    const refused = remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/authorize",
      fetch: async () => Response.json({ error: { code: "session_private", message: "not the owner's parent" } }, { status: 403 }),
    })
    expect(await refused.reserveSession!({ ...input, operation: "session_create", sessionId: "ses_child", parentSessionId: "ses_parent" }))
      .toEqual({ allowed: false, status: 403, code: "session_private", message: "not the owner's parent" })
    const { credential: _credential, ...unproven } = input
    expect(await policy.reserveSession!({ ...unproven, operation: "session_create", sessionId: "ses_child", parentSessionId: "ses_parent" }))
      .toMatchObject({ allowed: false, status: 503, code: "session_authority_unavailable" })
  })

  test("fails closed when proof, endpoint, network, or authority is unavailable", async () => {
    expect((await remoteWorkspaceSessionAccessPolicy().authorize({
      ...input,
      operation: "message_read",
    })).allowed).toBe(false)
    expect((await remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/authorize",
      fetch: async () => new Response(null, { status: 403 }),
    }).authorize({ ...input, operation: "message_read" })).allowed).toBe(false)
    expect((await remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/authorize",
      fetch: async () => { throw new Error("offline") },
    }).authorize({ ...input, operation: "message_read" })).allowed).toBe(false)
  })

  test("a session-authority answer that is not a refusal is the authority being unavailable, on the stream arm too", async () => {
    const answers = [403, 500, 429, 502]
    const policy = remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/api/runtime-authority/session-authorize",
      fetch: async () => Response.json({ error: { code: "session_private", message: "no" } }, { status: answers.shift() }),
    })
    const stream = () => policy.authorizeStream!({ ...input, operation: "session_event_stream", sessionId: "ses_1" })
    expect(await stream()).toMatchObject({ allowed: false, status: 403, code: "session_private" })
    expect(await stream()).toMatchObject({ allowed: false, status: 503 })
    expect(await stream()).toMatchObject({ allowed: false, status: 503 })
    expect(await stream()).toMatchObject({ allowed: false, status: 503 })
  })

  test("preserves retryable 503 authority responses", async () => {
    const decision = await remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/authorize",
      fetch: async () => Response.json({
        error: { code: "workspace_authority_unavailable", message: "retry later" },
      }, { status: 503 }),
    }).authorize({ ...input, operation: "message_read" })
    expect(decision).toEqual({
      allowed: false,
      status: 503,
      code: "workspace_authority_unavailable",
      message: "retry later",
    })
  })

  test("fails closed when the remote authority exceeds its deadline", async () => {
    const policy = remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/authorize",
      timeoutMs: 5,
      fetch: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      }),
    })

    await expect(policy.authorize({ ...input, operation: "message_read" })).resolves.toMatchObject({
      allowed: false,
      code: "session_authority_unavailable",
    })
  })
})

test("turn lease responses are validated and renewals send only the bound lease proof", async () => {
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = []
  const lease = { turnId: "turn_1", leaseId: "signed-lease", fencingToken: 3, acquiredAt: 100, expiresAt: 200 }
  const policy = remoteWorkspaceSessionAccessPolicy({
    url: "https://control.test/authorize",
    fetch: async (_url, init) => {
      const body = rec(fetchBodyJson(init?.body)) ?? {}
      requests.push({ headers: new Headers(init?.headers), body })
      return Response.json(body.action === "turn_release" ? { released: true } : lease)
    },
  })
  const turn = { ...input, operation: "prompt" as const, turnId: "turn_1" }
  expect(await policy.acquireTurn!(turn)).toEqual({ allowed: true, ...lease })
  expect(await policy.renewTurn!({ ...turn, leaseId: lease.leaseId, fencingToken: 3 })).toEqual({ allowed: true, ...lease })
  expect(await policy.releaseTurn!({ ...turn, leaseId: lease.leaseId, fencingToken: 3 })).toEqual({ released: true })
  expect(requests.map((request) => request.headers.get("authorization"))).toEqual(["Bearer signed-rht", null, null])
  expect(requests[1].body).toEqual({
    sessionId: "ses_private", action: "turn_renew", turnId: "turn_1", leaseId: "signed-lease", fencingToken: 3,
  })

  for (const body of [{}, { ...lease, fencingToken: 0 }, { ...lease, expiresAt: 99 }, { ...lease, leaseId: 1 }]) {
    const invalid = remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/authorize", fetch: async () => Response.json(body),
    })
    expect(await invalid.acquireTurn!(turn)).toMatchObject({ allowed: false, code: "session_authority_invalid_response" })
  }
})

describe("a share level narrows the authority's answer, not the runtime's question", () => {
  /**
   * The control plane's own rule, reduced to what a runtime can observe: a
   * `follow` grantee is refused every write action and admitted to every read
   * one. The runtime never names a level, so this is the only shape the
   * refusal can take.
   */
  function followGranteePlane() {
    const actions: string[] = []
    const policy = remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/api/runtime-authority/session-authorize",
      fetch: async (_url, init) => {
        const action = rec(fetchBodyJson(init?.body))?.action
        actions.push(String(action))
        if (action === "write" || String(action).startsWith("turn_")) {
          return Response.json(
            { error: { code: "workspace_authorization_denied", message: "denied" } },
            { status: 403 },
          )
        }
        return Response.json({ allowed: true, lease: "stream_lease", expiresAt: Date.now() + 60_000 })
      },
    })
    return { actions, policy }
  }

  test("refuses the prompt and both interaction answers, and admits the read and the session stream", async () => {
    const { actions, policy } = followGranteePlane()

    expect(await policy.authorize({ ...input, operation: "prompt" }))
      .toMatchObject({ allowed: false, status: 403, code: "workspace_authorization_denied" })
    expect(await policy.authorize({ ...input, operation: "permission_response" }))
      .toMatchObject({ allowed: false, status: 403 })
    expect(await policy.authorize({ ...input, operation: "question_response" }))
      .toMatchObject({ allowed: false, status: 403 })
    expect(await policy.acquireTurn!({ ...input, operation: "prompt", turnId: "turn_1" }))
      .toMatchObject({ allowed: false, status: 403 })

    expect((await policy.authorize({ ...input, operation: "message_read" })).allowed).toBe(true)
    expect(await policy.authorizeStream!({ ...input, operation: "session_event_stream" }))
      .toMatchObject({ allowed: true, lease: "stream_lease" })

    expect(actions).toEqual(["write", "write", "write", "turn_acquire", "read", "read"])
  })

  test("a send grantee is the same runtime asking the same questions and being admitted", async () => {
    const actions: string[] = []
    const policy = remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/api/runtime-authority/session-authorize",
      fetch: async (_url, init) => {
        actions.push(String(rec(fetchBodyJson(init?.body))?.action))
        return Response.json({
          allowed: true,
          turnId: "turn_1",
          leaseId: "lease_1",
          fencingToken: 1,
          acquiredAt: 1,
          expiresAt: Date.now() + 60_000,
        })
      },
    })

    expect((await policy.authorize({ ...input, operation: "prompt" })).allowed).toBe(true)
    expect((await policy.authorize({ ...input, operation: "permission_response" })).allowed).toBe(true)
    expect((await policy.authorize({ ...input, operation: "question_response" })).allowed).toBe(true)
    expect(await policy.acquireTurn!({ ...input, operation: "prompt", turnId: "turn_1" }))
      .toMatchObject({ allowed: true, turnId: "turn_1", leaseId: "lease_1" })

    expect(actions).toEqual(["write", "write", "write", "turn_acquire"])
  })
})
