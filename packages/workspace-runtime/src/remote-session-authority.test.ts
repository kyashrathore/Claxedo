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
  test("forwards only the opaque proof, session id, and read/write action", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const policy = remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/api/runtime-authority/session-authorize",
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        return Response.json({ allowed: true })
      },
    })

    expect((await policy.authorize({ ...input, operation: "message_read" })).allowed).toBe(true)
    expect((await policy.authorize({ ...input, operation: "prompt" })).allowed).toBe(true)
    expect((await policy.authorize({ ...input, operation: "session_v2_proxy", method: "POST" })).allowed).toBe(true)
    expect(policy.registerSession).toBeDefined()
    expect((await policy.registerSession!({ ...input, operation: "session_create" })).allowed).toBe(true)
    expect(requests.map((request) => ({
      authorization: new Headers(request.init?.headers).get("authorization"),
      body: JSON.parse(String(request.init?.body)),
    }))).toEqual([
      { authorization: "Bearer signed-rht", body: { sessionId: "ses_private", action: "read" } },
      { authorization: "Bearer signed-rht", body: { sessionId: "ses_private", action: "write" } },
      { authorization: "Bearer signed-rht", body: { sessionId: "ses_private", action: "write" } },
      { authorization: "Bearer signed-rht", body: { sessionId: "ses_private", action: "register" } },
    ])
  })

  test("allows opaque Session V2 collection reads for policy filtering", async () => {
    const policy = remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/authorize",
      fetch: async () => Response.json({ allowed: true }),
    })
    expect((await policy.authorize({
      ...input,
      sessionId: undefined,
      operation: "session_v2_proxy",
      method: "GET",
      path: "/api/session",
    })).allowed).toBe(true)
    expect((await policy.authorize({
      ...input,
      sessionId: undefined,
      operation: "session_v2_proxy",
      method: "POST",
      path: "/api/session",
    })).allowed).toBe(true)
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
