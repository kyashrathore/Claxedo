import { describe, expect, test } from "bun:test"
import { createWorkspaceRuntimeClient } from "./index"
import { WorkspaceRuntimeClientError, WorkspaceRuntimeClientPayloadError, WorkspaceRuntimeClientTransportError } from "./request"

describe("workspace runtime request path", () => {
  test("keeps a base path, scopes by directory and workspace, and merges headers in caller order", async () => {
    const calls: Request[] = []
    const client = createWorkspaceRuntimeClient({
      baseUrl: "https://server.example/base/",
      headers: { Authorization: "Basic token", "X-Default": "default" },
      directory: "/repo/main",
      workspace: "ws-1",
      fetch: async (input, init) => {
        const request = new Request(input, init)
        calls.push(request)
        if (request.method === "GET") return Response.json([])
        return Response.json({ id: "s1" })
      },
    })

    const listed = await client.session.list({ limit: 5 }, { headers: { "X-Request": "get" } })
    const created = await client.session.create({ directory: "/repo/other", title: "t", parentID: undefined }, { headers: { "X-Default": "overridden" } })

    expect(listed.data).toEqual([])
    expect(listed.request.url).toBe("https://server.example/base/session?directory=%2Frepo%2Fmain&workspace=ws-1&limit=5")
    expect(created.data).toMatchObject({ id: "s1" })
    expect(calls.map((request) => [request.method, request.url])).toEqual([
      ["GET", "https://server.example/base/session?directory=%2Frepo%2Fmain&workspace=ws-1&limit=5"],
      ["POST", "https://server.example/base/session?directory=%2Frepo%2Fother&workspace=ws-1"],
    ])
    expect(calls[0]?.headers.get("authorization")).toBe("Basic token")
    expect(calls[0]?.headers.get("x-default")).toBe("default")
    expect(calls[0]?.headers.get("x-request")).toBe("get")
    expect(calls[0]?.headers.get("accept")).toBe("application/json")
    expect(calls[1]?.headers.get("x-default")).toBe("overridden")
    expect(calls[1]?.headers.get("content-type")).toBe("application/json")
    await expect(calls[1]?.json()).resolves.toEqual({ title: "t" })
  })

  test("throws typed response, payload and transport errors", async () => {
    const failed = createWorkspaceRuntimeClient({
      baseUrl: "https://server.example",
      fetch: async () => Response.json({ error: { code: "denied", message: "Not allowed" } }, { status: 403 }),
    })
    const invalid = createWorkspaceRuntimeClient({
      baseUrl: "https://server.example",
      fetch: async () => new Response("not json", { headers: { "Content-Type": "application/json" } }),
    })
    const offline = createWorkspaceRuntimeClient({
      baseUrl: "https://server.example",
      fetch: async () => {
        throw new TypeError("fetch failed")
      },
    })

    await expect(failed.vcs.get()).rejects.toMatchObject({
      name: "WorkspaceRuntimeClientError",
      operation: "vcs.get",
      status: 403,
      code: "denied",
      message: "Not allowed",
    } satisfies Partial<WorkspaceRuntimeClientError>)
    await expect(invalid.vcs.get()).rejects.toBeInstanceOf(WorkspaceRuntimeClientPayloadError)
    await expect(offline.vcs.get()).rejects.toMatchObject({
      name: "WorkspaceRuntimeClientTransportError",
      operation: "vcs.get",
      message: "fetch failed",
    } satisfies Partial<WorkspaceRuntimeClientTransportError>)
  })

  test("reads a 204 route as no body, and refuses one that answered with a body", async () => {
    const responses: Response[] = [new Response(null, { status: 204 }), Response.json({ ok: true })]
    const client = createWorkspaceRuntimeClient({
      baseUrl: "https://server.example",
      fetch: async () => responses.shift() ?? new Response(null, { status: 500 }),
    })

    const admitted = await client.session.promptAsync({ sessionID: "s1", parts: [{ type: "text", text: "go" }] })
    expect(admitted.data).toBeUndefined()
    expect(admitted.response.status).toBe(204)

    await expect(client.session.promptAsync({ sessionID: "s1", parts: [] })).rejects.toMatchObject({
      name: "WorkspaceRuntimeClientPayloadError",
      operation: "session.promptAsync",
      message: "Expected 204 No Content, got 200",
    } satisfies Partial<WorkspaceRuntimeClientPayloadError>)
  })

  test("explicit delivery decodes durable acknowledgements instead of requiring an empty response", async () => {
    const pending = { ok: false, status: "pending", operationId: "operation", message: "Awaiting provider acknowledgement" } as const
    const responses = [Response.json({ delivery: "queue" }), Response.json(pending, { status: 202 }), Response.json({ delivery: "queue", messageID: "queued" }, { status: 202 })]
    const client = createWorkspaceRuntimeClient({ baseUrl: "https://server.example", fetch: async () => responses.shift()! })
    expect((await client.session.promptAsync({ sessionID: "s1", delivery: "queue", parts: [] })).data).toEqual({ delivery: "queue" })
    expect((await client.session.promptAsync({ sessionID: "s1", delivery: "steer", parts: [] })).data).toEqual(pending)
    expect((await client.session.prompt({ sessionID: "s1", delivery: "queue", messageID: "queued", parts: [] })).data).toEqual({ delivery: "queue", messageID: "queued" })
  })

  test("forwards AbortSignal and preserves native AbortError cancellation", async () => {
    const controller = new AbortController()
    const aborted = new DOMException("cancelled", "AbortError")
    const client = createWorkspaceRuntimeClient({
      baseUrl: "https://server.example",
      fetch: async (_input, init) => {
        expect(init?.signal).toBe(controller.signal)
        throw aborted
      },
    })

    const result = client.vcs.get({}, { signal: controller.signal }).catch((error) => error)
    controller.abort(aborted)
    expect(await result).toBe(aborted)
  })
})

test("session startup reads and binary attachments retain canonical workspace scope", async () => {
  const calls: Request[] = []
  const binding = { sessionId: "reserved", workspaceId: "workspace", directory: "/repo", connectionId: "connection", operationId: "operation" }
  const start = { binding, status: "starting" as const, createdAt: 1, updatedAt: 1 }
  const client = createWorkspaceRuntimeClient({
    baseUrl: "https://runtime.example", workspace: "workspace", directory: "/repo",
    fetch: async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      return new URL(request.url).pathname.startsWith("/session-start/") ? Response.json(start) : new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } })
    },
  })
  expect((await client.session.start({ sessionID: binding.sessionId })).data).toEqual(start)
  const image = await client.session.attachment({ sessionID: "reserved", messageID: "message/id", attachmentID: "image/id" })
  expect(image.headers.get("Content-Type")).toBe("image/png")
  expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([137, 80, 78, 71])
  expect(new URL(calls[1].url).pathname).toBe("/session/reserved/message/message%2Fid/attachment/image%2Fid")
  expect(calls.every((request) => new URL(request.url).searchParams.get("workspace") === "workspace")).toBe(true)
})
