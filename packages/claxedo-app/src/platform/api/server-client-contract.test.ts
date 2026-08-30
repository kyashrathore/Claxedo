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

  test("uses explicit global configuration routes and merges request headers", async () => {
    const calls: Request[] = []
    const client = createClaxedoServerClient({
      baseUrl: "https://server.example/base/",
      headers: { Authorization: "Basic token", "X-Default": "default" },
      request: async (input, init) => {
        const request = new Request(input, init)
        calls.push(request)
        if (request.method === "GET") return Response.json({ provider: { openai: {} } })
        return Response.json({ provider: { anthropic: {} } })
      },
    })

    await expect(client.global.config.get({ headers: { "X-Request": "get" } }).then((result) => result.data)).resolves.toEqual({
      provider: { openai: {} },
    })
    await expect(client.global.config.update({ config: { provider: { anthropic: {} } } }, {
      headers: { "X-Default": "overridden" },
    }).then((result) => result.data)).resolves.toEqual({ provider: { anthropic: {} } })

    expect(calls.map((request) => [request.method, request.url])).toEqual([
      ["GET", "https://server.example/base/global/config"],
      ["PATCH", "https://server.example/base/global/config"],
    ])
    expect(calls[0]?.headers.get("authorization")).toBe("Basic token")
    expect(calls[0]?.headers.get("x-default")).toBe("default")
    expect(calls[0]?.headers.get("x-request")).toBe("get")
    expect(calls[1]?.headers.get("x-default")).toBe("overridden")
    expect(calls[1]?.headers.get("content-type")).toBe("application/json")
    await expect(calls[1]?.json()).resolves.toEqual({ provider: { anthropic: {} } })
  })

  test("disposes the server through the explicit global route", async () => {
    let call: Request | undefined
    const client = createClaxedoServerClient({
      baseUrl: "https://server.example",
      request: async (input, init) => {
        call = new Request(input, init)
        return Response.json(true)
      },
    })

    await expect(client.global.dispose().then((result) => result.data)).resolves.toBe(true)
    expect(call?.method).toBe("POST")
    expect(call?.url).toBe("https://server.example/global/dispose")
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

    await expect(failed.global.config.get()).rejects.toMatchObject({
      name: "ServerClientResponseError",
      operation: "global.config.get",
      status: 403,
      code: "denied",
      message: "Not allowed",
    } satisfies Partial<ServerClientResponseError>)
    await expect(invalid.global.config.get()).rejects.toBeInstanceOf(ServerClientPayloadError)
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

    const result = client.global.config.get({ signal: controller.signal }).catch((error) => error)
    controller.abort(aborted)
    expect(await result).toBe(aborted)
  })
})
