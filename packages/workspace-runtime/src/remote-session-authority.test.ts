import { describe, expect, test } from "bun:test"
import { remoteWorkspaceSessionAccessPolicy } from "./remote-session-authority"

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
  test("forwards only proof, session id, action, and exact registration operation", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const policy = remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/api/runtime-authority",
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        return Response.json({ allowed: true })
      },
    })

    expect((await policy.authorize({ ...input, operation: "message_read" })).allowed).toBe(true)
    expect((await policy.authorize({ ...input, operation: "prompt" })).allowed).toBe(true)
    expect((await policy.registerSession({
      ...input,
      operation: "session_create",
      registrationOperationId: "op_create_1",
    })).allowed).toBe(true)
    expect((await policy.markRegistrationAmbiguous?.({
      ...input,
      operation: "session_create",
      registrationOperationId: "op_create_1",
      reason: "registration response timed out",
    }))?.allowed).toBe(true)
    expect(requests.map((request) => ({
      authorization: new Headers(request.init?.headers).get("authorization"),
      body: JSON.parse(String(request.init?.body)),
    }))).toEqual([
      { authorization: "Bearer signed-rht", body: { sessionId: "ses_private", action: "read" } },
      { authorization: "Bearer signed-rht", body: { sessionId: "ses_private", action: "write" } },
      {
        authorization: "Bearer signed-rht",
        body: { sessionId: "ses_private", action: "register", operationId: "op_create_1" },
      },
      {
        authorization: "Bearer signed-rht",
        body: {
          sessionId: "ses_private",
          action: "registration_ambiguous",
          operationId: "op_create_1",
          reason: "registration response timed out",
        },
      },
    ])
  })

  test("fails closed before transport when registration has no operation id", async () => {
    let calls = 0
    const policy = remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/api/runtime-authority",
      fetch: async () => {
        calls += 1
        return Response.json({ allowed: true })
      },
    })

    const decision = await policy.registerSession({
      ...input,
      operation: "session_create",
      registrationOperationId: "" as never,
    })
    expect(decision).toMatchObject({
      allowed: false,
      status: 503,
      code: "session_registration_operation_required",
    })
    expect(calls).toBe(0)
  })

  test("preserves 401, 403, and retryable 503 responses", async () => {
    for (const status of [401, 403, 503] as const) {
      const policy = remoteWorkspaceSessionAccessPolicy({
        url: "https://control.test/authorize",
        fetch: async () => Response.json({ error: { code: `authority_${status}`, message: `status ${status}` } }, { status }),
      })
      await expect(policy.authorize({ ...input, operation: "message_read" })).resolves.toEqual({
        allowed: false,
        status,
        code: `authority_${status}`,
        message: `status ${status}`,
      })
    }
  })

  test("mints and renews a bounded stream lease through the same authority", async () => {
    const bodies: unknown[] = []
    const policy = remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/authorize",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json({ allowed: true, lease: `lease_${bodies.length}`, expiresAt: 123 + bodies.length })
      },
    })

    await expect(policy.authorizeStream?.({ ...input, operation: "session_event_stream" })).resolves.toEqual({
      allowed: true,
      lease: "lease_1",
      expiresAt: 124,
    })
    await expect(policy.authorizeStream?.({ ...input, operation: "session_event_stream" }, "lease_1")).resolves.toEqual({
      allowed: true,
      lease: "lease_2",
      expiresAt: 125,
    })
    expect(bodies).toEqual([
      { sessionId: "ses_private", action: "read", stream: true },
      { sessionId: "ses_private", action: "read", stream: true, lease: "lease_1" },
    ])
  })

  test("fails closed on missing endpoint, network failure, deadline, or malformed lease", async () => {
    await expect(remoteWorkspaceSessionAccessPolicy().authorize({ ...input, operation: "message_read" }))
      .resolves.toMatchObject({ allowed: false, status: 503 })
    await expect(remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/authorize",
      fetch: async () => { throw new Error("offline") },
    }).authorize({ ...input, operation: "message_read" })).resolves.toMatchObject({ allowed: false, status: 503 })
    await expect(remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/authorize",
      timeoutMs: 5,
      fetch: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      }),
    }).authorize({ ...input, operation: "message_read" })).resolves.toMatchObject({ allowed: false, status: 503 })
    await expect(remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/authorize",
      fetch: async () => Response.json({ allowed: true }),
    }).authorizeStream?.({ ...input, operation: "session_event_stream" })).resolves.toMatchObject({
      allowed: false,
      code: "session_authority_invalid_response",
    })
  })
})
