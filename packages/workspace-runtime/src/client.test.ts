import { describe, expect, test } from "bun:test"
import { createWorkspaceRuntimeClient, WorkspaceRuntimeClientError } from "./client"
import { fetchDouble, fetchUrl } from "./test-support/fetch-double"

describe("WorkspaceRuntimeClient file routes", () => {
  test("exposes typed file tree, content, status, and search requests", async () => {
    const requests: { url: URL; init?: RequestInit }[] = []
    const controller = new AbortController()
    const client = createWorkspaceRuntimeClient({
      baseUrl: "http://runtime.local",
      headers: { authorization: "Bearer runtime" },
      fetch: fetchDouble(async (input, init) => {
        const url = new URL(fetchUrl(input))
        requests.push({ url, init })
        if (url.pathname.endsWith("/file/content")) {
          return Response.json({ type: "text", content: "hello" })
        }
        if (url.pathname.endsWith("/file/status")) {
          return Response.json([{ path: "src/index.ts", added: 2, removed: 1, status: "modified" }])
        }
        if (url.pathname.endsWith("/find/file")) return Response.json(["src/index.ts"])
        return Response.json([{
          name: "index.ts",
          path: "src/index.ts",
          absolute: "/workspace/src/index.ts",
          type: "file",
          ignored: false,
        }])
      }),
    })
    const requestOptions = {
      headers: { "x-request-id": "request-1" },
      signal: controller.signal,
    }

    await expect(client.files.tree("src", requestOptions)).resolves.toEqual([{
      name: "index.ts",
      path: "src/index.ts",
      absolute: "/workspace/src/index.ts",
      type: "file",
      ignored: false,
    }])
    await expect(client.files.content("src/index.ts", requestOptions)).resolves.toEqual({
      type: "text",
      content: "hello",
    })
    await expect(client.files.status(requestOptions)).resolves.toEqual([{
      path: "src/index.ts",
      added: 2,
      removed: 1,
      status: "modified",
    }])
    await expect(client.files.search({
      query: "index",
      dirs: "false",
      type: "file",
      limit: 25,
    }, requestOptions)).resolves.toEqual(["src/index.ts"])

    expect(requests.map(({ url }) => `${url.pathname}${url.search}`)).toEqual([
      "/api/wr/file?path=src",
      "/api/wr/file/content?path=src%2Findex.ts",
      "/api/wr/file/status",
      "/api/wr/find/file?query=index&dirs=false&type=file&limit=25",
    ])
    for (const { init } of requests) {
      expect(init?.signal).toBe(controller.signal)
      expect(new Headers(init?.headers)).toEqual(new Headers({
        accept: "application/json",
        authorization: "Bearer runtime",
        "x-request-id": "request-1",
      }))
    }
  })

  test("the scoped file members answer the same routes with the response attached", async () => {
    const seen: string[] = []
    const client = createWorkspaceRuntimeClient({
      baseUrl: "http://runtime.local/",
      directory: "/repo/main",
      fetch: fetchDouble(async (input) => {
        seen.push(fetchUrl(input))
        return Response.json([])
      }),
    })

    const listed = await client.file.list({ path: "src" })
    await client.find.files({ directory: "/repo/other", query: "client", dirs: "false", type: "file", limit: 25 })
    await client.file.all()

    expect(listed.data).toEqual([])
    expect(listed.response.status).toBe(200)
    expect(seen).toEqual([
      "http://runtime.local/api/wr/file?directory=%2Frepo%2Fmain&path=src",
      "http://runtime.local/api/wr/find/file?directory=%2Frepo%2Fother&query=client&dirs=false&type=file&limit=25",
      "http://runtime.local/api/wr/file/all?directory=%2Frepo%2Fmain",
    ])
  })

  test("throws typed response errors without converting cancellations", async () => {
    const failed = createWorkspaceRuntimeClient({
      baseUrl: "http://runtime.local",
      fetch: fetchDouble(async () => new Response("denied", { status: 403 })),
    })

    const responseError = await failed.files.status().catch((error: unknown) => error)
    expect(responseError).toBeInstanceOf(WorkspaceRuntimeClientError)
    expect(responseError).toMatchObject({ operation: "file.status", status: 403, code: "http_403", body: "denied", message: "denied" })

    const controller = new AbortController()
    controller.abort(new DOMException("cancelled", "AbortError"))
    const cancelled = createWorkspaceRuntimeClient({
      baseUrl: "http://runtime.local",
      fetch: fetchDouble(async (_input, init) => {
        init?.signal?.throwIfAborted()
        return Response.json([])
      }),
    })

    const cancellation = await cancelled.files.tree("src", { signal: controller.signal }).catch((error: unknown) => error)
    expect(cancellation).toBe(controller.signal.reason)
    expect(cancellation).not.toBeInstanceOf(WorkspaceRuntimeClientError)
  })
})
