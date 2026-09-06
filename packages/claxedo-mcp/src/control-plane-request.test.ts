/**
 * Control-plane request tests.
 *
 * This boundary used to live at module scope in `server.ts`, which connects a
 * stdio transport when imported, so none of it could be tested — fourteen call
 * sites went through an untested function that also chose their return type.
 */
import { describe, expect, test } from "vitest"

import { createControlPlaneClient } from "./control-plane-request"
import { McpHttpError } from "./http-error"

type Recorded = { url: string; headers: Record<string, string>; method?: string }

/** `fetch` accepts three input shapes; only one of them stringifies usefully. */
const requestUrl = (input: RequestInfo | URL) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url

function recordingFetch(response: () => Response) {
  const calls: Recorded[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: requestUrl(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      method: init?.method,
    })
    return response()
  }
  return { calls, fetchImpl }
}

const ok = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "application/json" } })

const config = {
  origin: "http://127.0.0.1:2593",
  defaultDirectory: "/work/project",
}

describe("workspace scope", () => {
  test("carries the directory as a query parameter and a header", async () => {
    const { calls, fetchImpl } = recordingFetch(() => ok("{}"))
    const client = createControlPlaneClient({ ...config, fetch: fetchImpl })

    await client.json("/api/wr/process", { method: "GET" })

    expect(calls[0].url).toBe("http://127.0.0.1:2593/api/wr/process?directory=%2Fwork%2Fproject")
    expect(calls[0].headers["x-claxedo-directory"]).toBe("/work/project")
    expect(calls[0].headers["x-workspace-id"]).toBeUndefined()
  })

  test("appends to a path that already has a query string", async () => {
    const { calls, fetchImpl } = recordingFetch(() => ok("{}"))
    const client = createControlPlaneClient({ ...config, fetch: fetchImpl })

    await client.json("/api/wr/process/logs?lines=10")

    expect(calls[0].url).toContain("?lines=10&directory=")
  })

  test("reads the workspace id out of a workspace: directory", async () => {
    const { calls, fetchImpl } = recordingFetch(() => ok("{}"))
    const client = createControlPlaneClient({ ...config, fetch: fetchImpl })

    await client.json("/api/wr/process", undefined, "workspace:ws_42")

    expect(calls[0].headers["x-workspace-id"]).toBe("ws_42")
    expect(calls[0].url).toContain("workspaceId=ws_42")
  })

  test("falls back to the configured workspace id for a plain directory", async () => {
    const { calls, fetchImpl } = recordingFetch(() => ok("{}"))
    const client = createControlPlaneClient({ ...config, defaultWorkspaceId: "ws_default", fetch: fetchImpl })

    await client.json("/api/wr/process", undefined, "/some/other/dir")

    expect(calls[0].headers["x-claxedo-directory"]).toBe("/some/other/dir")
    expect(calls[0].headers["x-workspace-id"]).toBe("ws_default")
  })
})

describe("owner scope", () => {
  test("addresses the user, with no directory query or header", async () => {
    const { calls, fetchImpl } = recordingFetch(() => ok("{}"))
    const client = createControlPlaneClient({
      ...config,
      defaultWorkspaceId: "ws_default",
      scope: "owner",
      fetch: fetchImpl,
    })

    await client.json("/api/control/workspaces", undefined, "workspace:ws_42")

    expect(calls[0].url).toBe("http://127.0.0.1:2593/api/control/workspaces")
    expect(calls[0].headers["x-claxedo-directory"]).toBeUndefined()
    expect(calls[0].headers["x-workspace-id"]).toBeUndefined()
  })
})

describe("headers", () => {
  test("sends the bearer token when one is configured", async () => {
    const { calls, fetchImpl } = recordingFetch(() => ok("{}"))
    const client = createControlPlaneClient({ ...config, token: "tok_1", fetch: fetchImpl })

    await client.json("/api/wr/process")

    expect(calls[0].headers.authorization).toBe("Bearer tok_1")
  })

  test.each([
    ["object", { Authorization: "Bearer caller" } satisfies HeadersInit],
    ["entry pairs", [["Authorization", "Bearer caller"]] satisfies HeadersInit],
    ["Headers", new Headers({ Authorization: "Bearer caller" }) satisfies HeadersInit],
  ])("lets a caller override the token when it passes headers as %s", async (_label, headers) => {
    // `HeadersInit` also covers `string[][]`, which spreads into an object as
    // numeric indices — the reason this path normalizes instead of spreading.
    const { calls, fetchImpl } = recordingFetch(() => ok("{}"))
    const client = createControlPlaneClient({ ...config, token: "tok_1", fetch: fetchImpl })

    await client.json("/api/wr/process", { headers })

    expect(calls[0].headers.authorization).toBe("Bearer caller")
    expect(calls[0].headers["0"]).toBeUndefined()
  })
})

describe("reading the response", () => {
  test("parses a JSON body", async () => {
    const client = createControlPlaneClient({ ...config, fetch: recordingFetch(() => ok('{"id":"s_1"}')).fetchImpl })

    expect(await client.json("/session")).toEqual({ id: "s_1" })
  })

  test("reads an empty body as null", async () => {
    const client = createControlPlaneClient({ ...config, fetch: recordingFetch(() => ok("   ")).fetchImpl })

    expect(await client.json("/api/wr/process/p/stop", { method: "POST" })).toBeNull()
  })

  test("returns text verbatim, untrimmed", async () => {
    const client = createControlPlaneClient({
      ...config,
      fetch: recordingFetch(() => ok("line one\nline two\n")).fetchImpl,
    })

    expect(await client.text("/api/wr/process/logs")).toBe("line one\nline two\n")
  })

  test("raises the control plane's own error message", async () => {
    const client = createControlPlaneClient({
      ...config,
      fetch: recordingFetch(() => ok('{"error":{"code":"not_found","message":"no such process"}}', 404)).fetchImpl,
    })

    await expect(client.json("/api/wr/process/nope")).rejects.toMatchObject({
      name: "McpHttpError",
      status: 404,
      code: "not_found",
      message: "no such process",
    })
  })

  test("falls back to the status when the error body is not JSON", async () => {
    const client = createControlPlaneClient({
      ...config,
      fetch: recordingFetch(() => ok("<html>bad gateway</html>", 502)).fetchImpl,
    })

    const error = await client.json("/api/wr/process").catch((err: unknown) => err)
    expect(error).toBeInstanceOf(McpHttpError)
    expect(error).toMatchObject({ status: 502, message: "HTTP 502" })
  })

  test("raises on a failed text request too", async () => {
    const client = createControlPlaneClient({
      ...config,
      fetch: recordingFetch(() => ok("nope", 500)).fetchImpl,
    })

    await expect(client.text("/api/wr/process/logs")).rejects.toMatchObject({ status: 500 })
  })
})
