import { describe, expect, test } from "bun:test"
import {
  createClaxedoServerClient,
  ServerClientPayloadError,
  ServerClientResponseError,
} from "./server-client-contract"

describe("Claxedo server client", () => {
  test("preserves scoped file and find query parameters", async () => {
    const calls: Request[] = []
    const client = createClaxedoServerClient({
      baseUrl: "https://server.example",
      directory: "/repo/main",
      request: async (input, init) => {
        calls.push(new Request(input, init))
        return Response.json([])
      },
    })

    await client.file.list({ path: "src" })
    await client.find.files({
      directory: "/repo/other",
      query: "client",
      dirs: "false",
      type: "file",
      limit: 25,
    })

    expect(calls.map((call) => call.url)).toEqual([
      "https://server.example/file?directory=%2Frepo%2Fmain&path=src",
      "https://server.example/find/file?directory=%2Frepo%2Fother&query=client&dirs=false&type=file&limit=25",
    ])
  })

  test("merges default and per-request headers and sends JSON bodies", async () => {
    const calls: Request[] = []
    const client = createClaxedoServerClient({
      baseUrl: "https://server.example/base/",
      headers: { Authorization: "Basic token", "X-Default": "default" },
      request: async (input, init) => {
        const request = new Request(input, init)
        calls.push(request)
        if (request.method === "GET") return Response.json({ healthy: true })
        return Response.json({ id: "proj_1", name: "renamed" })
      },
    })

    await expect(client.global.health({ headers: { "X-Request": "get" } }).then((result) => result.data)).resolves.toEqual({
      healthy: true,
    })
    await expect(client.project.update({ projectID: "proj_1", name: "renamed" }, {
      headers: { "X-Default": "overridden" },
    }).then((result) => result.data)).resolves.toEqual({ id: "proj_1", name: "renamed" })

    expect(calls.map((request) => [request.method, request.url])).toEqual([
      ["GET", "https://server.example/base/global/health"],
      ["PATCH", "https://server.example/base/project/proj_1"],
    ])
    expect(calls[0]?.headers.get("authorization")).toBe("Basic token")
    expect(calls[0]?.headers.get("x-default")).toBe("default")
    expect(calls[0]?.headers.get("x-request")).toBe("get")
    expect(calls[1]?.headers.get("x-default")).toBe("overridden")
    expect(calls[1]?.headers.get("content-type")).toBe("application/json")
    await expect(calls[1]?.json()).resolves.toEqual({ name: "renamed" })
  })

  test("throws typed response and payload errors", async () => {
    const failed = createClaxedoServerClient({
      baseUrl: "https://server.example",
      request: async () => Response.json({ error: { code: "denied", message: "Not allowed" } }, { status: 403 }),
    })
    const invalid = createClaxedoServerClient({
      baseUrl: "https://server.example",
      request: async () => new Response("not json", { headers: { "Content-Type": "application/json" } }),
    })

    await expect(failed.global.health()).rejects.toMatchObject({
      name: "ServerClientResponseError",
      operation: "global.health",
      status: 403,
      code: "denied",
      message: "Not allowed",
    } satisfies Partial<ServerClientResponseError>)
    await expect(invalid.global.health()).rejects.toBeInstanceOf(ServerClientPayloadError)
  })

  test("forwards AbortSignal and preserves native AbortError cancellation", async () => {
    const controller = new AbortController()
    const aborted = new DOMException("cancelled", "AbortError")
    const client = createClaxedoServerClient({
      baseUrl: "https://server.example",
      request: async (_input, init) => {
        expect(init?.signal).toBe(controller.signal)
        throw aborted
      },
    })

    const result = client.global.health({ signal: controller.signal }).catch((error) => error)
    controller.abort(aborted)
    expect(await result).toBe(aborted)
  })
})
