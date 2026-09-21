import { WorkspaceRuntimeClientError, WorkspaceRuntimeClientPayloadError } from "@claxedo/workspace-runtime/client"
import { describe, expect, test } from "bun:test"
import { createServerClient } from "./server-client"

describe("createServerClient", () => {
  test("adds server basic authentication after caller headers", async () => {
    let call: Request | undefined
    const client = createServerClient({
      server: {
        url: "https://server.example",
        username: "alice",
        password: "secret",
      },
      headers: { Authorization: "Bearer ignored", "X-Request": "present" },
      request: async (input, init) => {
        call = new Request(input, init)
        return Response.json({})
      },
    })

    await client.path.get()

    expect(call?.headers.get("authorization")).toBe(`Basic ${btoa("alice:secret")}`)
    expect(call?.headers.get("x-request")).toBe("present")
  })

  test("does not invent a username for password-only credentials", async () => {
    let call: Request | undefined
    const client = createServerClient({
      server: { url: "https://server.example", password: "secret" },
      request: async (input, init) => {
        call = new Request(input, init)
        return Response.json({})
      },
    })

    await client.path.get()

    expect(call?.headers.get("authorization")).toBe(`Basic ${btoa(":secret")}`)
  })

  test("answers server routes and runtime routes from the one server URL with the one scope", async () => {
    const calls: string[] = []
    const client = createServerClient({
      server: { url: "https://server.example/" },
      directory: "/repo",
      request: async (input, init) => {
        calls.push(new Request(input, init).url)
        return Response.json([])
      },
    })

    await client.project.list()
    await client.session.list()

    expect(calls).toEqual([
      "https://server.example/project?directory=%2Frepo",
      "https://server.example/session?directory=%2Frepo",
    ])
  })
})

describe("Claxedo server client", () => {
  test("preserves scoped file and find query parameters", async () => {
    const calls: Request[] = []
    const client = createServerClient({
      server: { url: "https://server.example" },
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
      "https://server.example/api/wr/file?directory=%2Frepo%2Fmain&path=src",
      "https://server.example/api/wr/find/file?directory=%2Frepo%2Fother&query=client&dirs=false&type=file&limit=25",
    ])
  })

  test("merges default and per-request headers and sends JSON bodies", async () => {
    const calls: Request[] = []
    const client = createServerClient({
      server: { url: "https://server.example/base/" },
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
    await client.project.ensure()

    expect(calls.map((request) => [request.method, request.url])).toEqual([
      ["GET", "https://server.example/base/global/health"],
      ["PATCH", "https://server.example/base/project/proj_1"],
      ["POST", "https://server.example/base/project/current"],
    ])
    expect(calls[0]?.headers.get("authorization")).toBe("Basic token")
    expect(calls[0]?.headers.get("x-default")).toBe("default")
    expect(calls[0]?.headers.get("x-request")).toBe("get")
    expect(calls[1]?.headers.get("x-default")).toBe("overridden")
    expect(calls[1]?.headers.get("content-type")).toBe("application/json")
    await expect(calls[1]?.json()).resolves.toEqual({ name: "renamed" })
  })

  test("throws typed response and payload errors", async () => {
    const failed = createServerClient({
      server: { url: "https://server.example" },
      request: async () => Response.json({ error: { code: "denied", message: "Not allowed" } }, { status: 403 }),
    })
    const invalid = createServerClient({
      server: { url: "https://server.example" },
      request: async () => new Response("not json", { headers: { "Content-Type": "application/json" } }),
    })

    await expect(failed.global.health()).rejects.toMatchObject({
      name: "WorkspaceRuntimeClientError",
      operation: "global.health",
      status: 403,
      code: "denied",
      message: "Not allowed",
    } satisfies Partial<WorkspaceRuntimeClientError>)
    await expect(invalid.global.health()).rejects.toBeInstanceOf(WorkspaceRuntimeClientPayloadError)
  })

  test("forwards AbortSignal and preserves native AbortError cancellation", async () => {
    const controller = new AbortController()
    const aborted = new DOMException("cancelled", "AbortError")
    const client = createServerClient({
      server: { url: "https://server.example" },
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
