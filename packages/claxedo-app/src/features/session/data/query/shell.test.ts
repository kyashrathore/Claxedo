import { describe, expect, test } from "bun:test"
import type { Command } from "@opencode-ai/sdk/v2/client"
import { commandListQuery, normalizeCommandList } from "./shell"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"

function command(name: string, description = ""): Command {
  return {
    name,
    template: "",
    description,
    hints: [],
  }
}

describe("shell query helpers", () => {
  test("commandListQuery normalizes command payloads", async () => {
    expect(
      normalizeCommandList([command("zzz", "last"), command("aaa", "first"), command("", "skip")]).map(
        (item) => item.name,
      ),
    ).toEqual(["aaa", "zzz"])

    const query = commandListQuery({
      baseUrl: "http://example.test",
      directory: "/tmp/ws",
      client: {
        command: {
          list: async () => ({
            data: [command("b", "second"), command("a", "first")],
          }),
        },
      },
    })

    expect(query.queryKey).toEqual(["shell", "http://example.test", "commands", "/tmp/ws"])
    expect((await query.queryFn()).map((item) => item.name)).toEqual(["a", "b"])
  })

  test("commandListQuery resolves the workspace through the canonical routing record — no clock of its own", async () => {
    queryClient.clear()
    let resolves = 0
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      const url = new URL(req.url)
      if (url.pathname === "/api/workspace/resolve") {
        resolves += 1
        return new Response(JSON.stringify({ workspaceId: "ws_1", directory: "/tmp/ws", kind: "cloud" }), { status: 200 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    }) as typeof fetch
    const query = commandListQuery({
      baseUrl: "http://example.test",
      directory: "/tmp/ws",
      request,
      client: { command: { list: async () => ({ data: [] }) } },
    })

    await query.queryFn()
    expect(resolves).toBe(1)

    // Routing identity does not expire: age the one shared entry past the
    // window this call site used to impose and read again.
    const key = queryKeys.runtime.workspace({ baseUrl: "http://example.test", directory: "/tmp/ws" })
    const state = queryClient.getQueryCache().find({ queryKey: key })!.state as { dataUpdatedAt: number }
    state.dataUpdatedAt = Date.now() - 5 * 60 * 1000

    await query.queryFn()
    expect(resolves).toBe(1)
  })

  test("commandListQuery routes loopback cloud workspaces through the local workspace proxy when request is supplied", async () => {
    const calls: string[] = []
    const query = commandListQuery({
      baseUrl: "http://127.0.0.1:3001",
      directory: "/tmp/ws",
      request: (async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
        const url = new URL(req.url)
        if (url.toString() === "http://127.0.0.1:3001/workspaces/ws_1/command") {
          expect(req.headers.get("authorization")).toBeNull()
          expect(req.headers.get("x-opencode-directory")).toBe("workspace:ws_1")
          return new Response(JSON.stringify([{ name: "deploy" }]), { status: 200 })
        }
        throw new Error(`unexpected request: ${req.method} ${req.url}`)
      }) as typeof fetch,
      workspace: {
        workspaceId: "ws_1",
        directory: "/tmp/ws",
        kind: "cloud",
      },
      client: {
        command: {
          list: async () => {
            throw new Error("expected Workspace Relay")
          },
        },
      },
    })

    expect(await query.queryFn()).toEqual([{ name: "deploy" }])
    expect(calls).toEqual(["GET http://127.0.0.1:3001/workspaces/ws_1/command"])
  })

  test("commandListQuery routes signed cloud workspaces through the relay when request is supplied", async () => {
    const calls: string[] = []
    const query = commandListQuery({
      baseUrl: "https://control.test",
      directory: "/tmp/ws",
      request: (async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(req.url)
        const url = new URL(req.url)
        if (url.pathname === "/api/workspace/ws_cloud/connection") {
          return new Response(
            JSON.stringify({
              access: "cloud",
              backing: "cloud-vm",
              workspaceId: "ws_cloud",
              role: "owner",
              relayUrl: "https://relay.test",
              runtimeAccessToken: "rat_1",
              tokenExpiresAt: Date.now() + 120_000,
            }),
            { status: 200 },
          )
        }
        if (url.toString() === "https://relay.test/workspaces/ws_cloud/command") {
          return new Response(JSON.stringify([{ name: "deploy" }]), { status: 200 })
        }
        throw new Error(`unexpected request: ${req.method} ${req.url}`)
      }) as typeof fetch,
      workspace: {
        workspaceId: "ws_cloud",
        directory: "/tmp/ws",
        kind: "cloud",
      },
      client: {
        command: {
          list: async () => {
            throw new Error("expected Workspace Relay")
          },
        },
      },
    })

    expect(await query.queryFn()).toEqual([{ name: "deploy" }])
    expect(calls.some((call) => call.includes("/api/claxedo/agent-config/commands"))).toBe(false)
  })

  test("commandListQuery uses Claxedo command config API for local workspaces", async () => {
    const calls: string[] = []
    const query = commandListQuery({
      baseUrl: "http://claxedo.test/",
      directory: "/tmp/ws",
      request: (async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(req.url)
        if (req.url === "http://claxedo.test/api/claxedo/agent-config/commands") {
          return new Response(JSON.stringify([{ name: "lint" }]), { status: 200 })
        }
        throw new Error(`unexpected request: ${req.method} ${req.url}`)
      }) as typeof fetch,
      workspace: {
        workspaceId: "ws_local",
        directory: "/tmp/ws",
        kind: "local",
      },
      client: {
        command: {
          list: async () => {
            throw new Error("expected Claxedo agent-config API")
          },
        },
      },
    })

    expect(await query.queryFn()).toEqual([{ name: "lint" }])
    expect(calls).toEqual(["http://claxedo.test/api/claxedo/agent-config/commands"])
  })

  test("commandListQuery keeps signed loopback command config requests unsigned", async () => {
    const calls: string[] = []
    const previous = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
      return new Response(JSON.stringify([{ name: "build" }]), { status: 200 })
    }) as typeof fetch
    try {
      const query = commandListQuery({
        baseUrl: "http://127.0.0.1:3001/",
        directory: "/tmp/ws",
        request: (async () => {
          throw new Error("expected unsigned loopback fetch")
        }) as typeof fetch,
        workspace: {
          workspaceId: "ws_local",
          directory: "/tmp/ws",
          kind: "local",
        },
        client: {
          command: {
            list: async () => {
              throw new Error("expected Claxedo agent-config API")
            },
          },
        },
      })

      expect(await query.queryFn()).toEqual([{ name: "build" }])
      expect(calls).toEqual(["GET http://127.0.0.1:3001/api/claxedo/agent-config/commands"])
    } finally {
      globalThis.fetch = previous
    }
  })
})
