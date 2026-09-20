import { afterEach, describe, expect, test } from "bun:test"
import type { ClaxedoCommand as Command } from "@/platform/api/claxedo-api-types"
import { commandListQuery, normalizeCommandList } from "./shell"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"

afterEach(() => queryClient.clear())

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
    expect(normalizeCommandList([
      command("zzz", "last"),
      command("aaa", "first"),
      command("", "skip"),
    ]).map((item) => item.name)).toEqual(["aaa", "zzz"])

    const client = {
      command: {
        list: async () => ({
          data: [
            command("b", "second"),
            command("a", "first"),
          ],
        }),
      },
    }
    const query = commandListQuery({
      baseUrl: "http://example.test",
      directory: "/tmp/ws",
      harnessType: "opencode",
      client,
    })

    expect(query.queryKey).toEqual(["shell", "http://example.test", "commands", "/tmp/ws", "opencode", ""])
    expect((await query.queryFn()).map((item) => item.name)).toEqual(["a", "b"])
  })

  // A command set belongs to (the machine serving the workspace, the worktree,
  // the harness) — the same family `directory.agents` is in.
  test("commandListQuery keys on the harness and the resolved workspace", () => {
    const client = { command: { list: async () => ({ data: [] }) } }
    const base = { baseUrl: "http://example.test", directory: "/tmp/ws", client }
    const opencode = commandListQuery({ ...base, harnessType: "opencode" }).queryKey

    expect(opencode).not.toEqual(commandListQuery({ ...base, harnessType: "acp:codex" }).queryKey)
    expect(opencode).not.toEqual(commandListQuery({ ...base }).queryKey)
    expect(commandListQuery({
      ...base,
      harnessType: "opencode",
      workspace: { kind: "provisioner", workspaceId: "ws_1" } as Parameters<typeof commandListQuery>[0]["workspace"],
    }).queryKey).toEqual(["shell", "http://example.test", "commands", "/tmp/ws", "opencode", "provisioner:ws_1"])
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

    // Routing identity does not expire: age the one shared entry well past
    // staleness and read again.
    const key = queryKeys.runtime.workspace({ baseUrl: "http://example.test", directory: "/tmp/ws" })
    queryClient.setQueryData(key, queryClient.getQueryData(key), { updatedAt: Date.now() - 5 * 60 * 1000 })

    await query.queryFn()
    expect(resolves).toBe(1)
  })

  test("commandListQuery routes loopback provisioner-placed workspaces through this machine's workspace proxy when request is supplied", async () => {
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
          expect(req.headers.get("x-claxedo-directory")).toBeNull()
          return new Response(JSON.stringify([{ name: "deploy" }]), { status: 200 })
        }
        throw new Error(`unexpected request: ${req.method} ${req.url}`)
      }) as typeof fetch,
      workspace: {
        workspaceId: "ws_1",
        directory: "/tmp/ws",
        kind: "provisioner",
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

  test("commandListQuery routes signed provisioner-placed workspaces through the relay when request is supplied", async () => {
    const calls: string[] = []
    const query = commandListQuery({
      baseUrl: "https://control.test",
      directory: "/tmp/ws",
      request: (async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(req.url)
        const url = new URL(req.url)
        if (url.pathname === "/api/workspace/ws_cloud/connection") {
          return new Response(JSON.stringify({
            access: "cloud",
            backing: "cloud-vm",
            workspaceId: "ws_cloud",
            role: "owner",
            relayUrl: "https://relay.test",
            runtimeAccessToken: "rat_1",
            tokenExpiresAt: Date.now() + 120_000,
          }), { status: 200 })
        }
        if (url.toString() === "https://relay.test/workspaces/ws_cloud/command") {
          return new Response(JSON.stringify([{ name: "deploy" }]), { status: 200 })
        }
        throw new Error(`unexpected request: ${req.method} ${req.url}`)
      }) as typeof fetch,
      workspace: {
        workspaceId: "ws_cloud",
        directory: "/tmp/ws",
        kind: "provisioner",
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

  test("commandListQuery uses Claxedo command config API for workspaces this machine serves", async () => {
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
        kind: "self",
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
          kind: "self",
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
