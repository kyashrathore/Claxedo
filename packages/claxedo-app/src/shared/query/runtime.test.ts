import { afterEach, describe, expect, mock, test } from "bun:test"
import { queryClient } from "./query-client"
import { workspaceLspQuery, workspaceMcpQuery, workspaceResolveQuery, workspaceVcsQuery } from "./runtime"

afterEach(() => queryClient.clear())

describe("workspace resolve query", () => {
  test("builds a directory-scoped resolve query", async () => {
    const request = mock(async (input: string | URL | Request) => {
      expect(String(input)).toBe("http://runtime.test/api/workspace/resolve?directory=%2Ftmp%2Fws")
      return new Response(JSON.stringify({
        workspaceId: "ws_1",
        directory: "/tmp/ws",
        kind: "cloud",
        status: "stopped",
      }), { status: 200 })
    }) as unknown as typeof fetch

    const query = workspaceResolveQuery({
      baseUrl: "http://runtime.test/",
      request,
      directory: "/tmp/ws",
    })

    expect(query.queryKey).toEqual(["runtime", "http://runtime.test", "workspace", "", "/tmp/ws", "read"])
    expect(await query.queryFn()).toMatchObject({
      workspaceId: "ws_1",
      kind: "cloud",
      status: "stopped",
    })
  })

  test("returns null on missing workspaces", async () => {
    const query = workspaceResolveQuery({
      baseUrl: "http://runtime.test",
      request: mock(async () => new Response("missing", { status: 404 })) as unknown as typeof fetch,
      workspaceId: "ws_missing",
    })

    expect(await query.queryFn()).toBeNull()
  })

  test("workspaceVcsQuery is directory-scoped", async () => {
    const query = workspaceVcsQuery({
      baseUrl: "http://runtime.test",
      directory: "/tmp/ws",
      client: {
        vcs: {
          get: async () => ({ data: { branch: "feature", default_branch: "dev" } as any }),
        },
      },
    })

    expect(query.queryKey).toEqual(["runtime", "http://runtime.test", "vcs", "/tmp/ws"])
    expect(await query.queryFn()).toMatchObject({ branch: "feature", default_branch: "dev" })
  })

  test("workspaceMcpQuery is directory-scoped", async () => {
    const query = workspaceMcpQuery({
      baseUrl: "http://runtime.test",
      directory: "/tmp/ws",
      client: {
        mcp: {
          status: async () => ({ data: { foo: { status: "connected" } as any } }),
        },
      },
    })

    expect(query.queryKey).toEqual(["runtime", "http://runtime.test", "mcp", "/tmp/ws"])
    expect(await query.queryFn()).toMatchObject({ foo: { status: "connected" } })
  })

  test("workspaceLspQuery is directory-scoped", async () => {
    const query = workspaceLspQuery({
      baseUrl: "http://runtime.test",
      directory: "/tmp/ws",
      client: {
        lsp: {
          status: async () => ({ data: [{ id: "ts", status: "connected" } as any] }),
        },
      },
    })

    expect(query.queryKey).toEqual(["runtime", "http://runtime.test", "lsp", "/tmp/ws"])
    expect(await query.queryFn()).toMatchObject([{ id: "ts", status: "connected" }])
  })
})
