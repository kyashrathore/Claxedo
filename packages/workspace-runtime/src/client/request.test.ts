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
