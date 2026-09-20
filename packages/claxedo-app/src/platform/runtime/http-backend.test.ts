import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { AgentPresentationSession as Session } from "@claxedo/agent-runtime-contract"
import type { ClaxedoCommand as Command, ClaxedoProject as Project } from "@/platform/api/claxedo-api-types"
import {
  createHttpSessionBackend,
  createHttpWorkspaceRuntimeBackend,
} from "@/platform/runtime/http-backend"
import { createHttpShellBackend } from "@/platform/query/control-plane"
import { queryClient } from "@/platform/query/query-client"
import { requestUrl } from "@/lib/url"

afterEach(() => queryClient.clear())

beforeEach(() => queryClient.clear())

function project(id: string, worktree: string): Project {
  return {
    id,
    worktree,
    time: { created: 0, updated: 0 },
    sandboxes: [],
  }
}

function command(name: string): Command {
  return {
    name,
    template: "",
    hints: [],
  }
}

function session(id: string): Session {
  return {
    id,
    slug: id,
    projectID: "",
    directory: "/tmp/ws",
    title: id,
    version: "",
    time: { created: 0, updated: 0 },
  }
}

// The runtime and session backends reach for the ambient `fetch` on their relay
// hop, so a relay-routed assertion has to run with the double installed
// globally — and restore the real one even when the assertion throws.
async function withGlobalFetch<T>(request: typeof fetch, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch
  globalThis.fetch = request
  try {
    return await run()
  } finally {
    globalThis.fetch = previous
  }
}

describe("http backend ports", () => {
  test("shell backend delegates to sdk-style clients", async () => {
    const backend = createHttpShellBackend({
      client: {
        project: {
          list: async () => ({ data: [project("p1", "/tmp/p1")] }),
        },
        command: {
          list: async () => ({ data: [command("build")] }),
        },
      },
    })

    expect(await backend.listProjects()).toMatchObject([{ id: "p1" }])
    expect(await backend.listCommands({ directory: "/tmp/p1" })).toMatchObject([{ name: "build" }])
  })

  test("runtime backend resolves and ensures through http", async () => {
    let resolves = 0
    let connections = 0
    const request: typeof fetch = async (input) => {
      const url = requestUrl(input)
      if (url.includes("/api/workspace/resolve")) {
        resolves += 1
        return new Response(JSON.stringify({
          workspaceId: "ws_1",
          directory: "/tmp/ws",
          kind: "cloud",
          status: resolves > 1 ? "ready" : "stopped",
        }), { status: 200 })
      }
      if (url.includes("/api/workspace/ws_1/connection")) {
        connections += 1
        return new Response(JSON.stringify({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_1",
          relayUrl: "https://relay.test",
          runtimeAccessToken: "rat_1",
          role: "editor",
          tokenExpiresAt: Date.now() + 120_000,
        }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    }

    const backend = createHttpWorkspaceRuntimeBackend({
      baseUrl: "http://runtime.test",
      request,
    })

    expect(await backend.ensureWorkspace({ directory: "/tmp/ws" })).toMatchObject({
      workspaceId: "ws_1",
      status: "ready",
    })
    expect(connections).toBe(1)
  })

  test("runtime backend sends cloud runtime status reads through Workspace Relay", async () => {
    const calls: string[] = []
    const request: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init)
      calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
      const url = new URL(req.url)
      if (url.pathname === "/api/workspace/resolve") {
        return new Response(JSON.stringify({
          workspaceId: "ws_backend_relay",
          directory: "/tmp/ws",
          kind: "cloud",
        }), { status: 200 })
      }
      if (url.pathname === "/api/workspace/ws_backend_relay/connection") {
        return new Response(JSON.stringify({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_backend_relay",
          relayUrl: "https://relay.test",
          runtimeAccessToken: "rat_1",
          role: "editor",
          tokenExpiresAt: Date.now() + 120_000,
        }), { status: 200 })
      }
      if (url.toString() === "https://relay.test/workspaces/ws_backend_relay/vcs") {
        expect(req.headers.get("authorization")).toBe("Bearer rat_1")
        return new Response(JSON.stringify({ branch: "feature/relay" }), { status: 200 })
      }
      if (url.toString() === "https://relay.test/workspaces/ws_backend_relay/mcp") {
        expect(req.headers.get("authorization")).toBe("Bearer rat_1")
        return new Response(JSON.stringify({ local: { status: "connected" } }), { status: 200 })
      }
      throw new Error(`unexpected request: ${req.method} ${req.url}`)
    }

    const client = {
      vcs: { get: mock(async () => ({ data: undefined })) },
      mcp: { status: mock(async () => ({ data: {} })) },
    }
    const backend = createHttpWorkspaceRuntimeBackend({
      baseUrl: "http://claxedo.test",
      request,
      client,
    })

    await withGlobalFetch(request, async () => {
      expect(await backend.getVcs({ directory: "/tmp/ws" })).toMatchObject({ branch: "feature/relay" })
      expect(await backend.getMcpStatus({ directory: "/tmp/ws" })).toMatchObject({ local: { status: "connected" } })
    })
    expect(client.vcs.get).toHaveBeenCalledTimes(0)
    expect(client.mcp.status).toHaveBeenCalledTimes(0)
    expect(calls.some((call) =>
      call.includes("http://claxedo.test/vcs") ||
      call.includes("http://claxedo.test/mcp")
    )).toBe(false)
  })

  test("runtime backend sends synthetic signed workspace status reads through Workspace Relay", async () => {
    const calls: string[] = []
    const request: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init)
      calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
      const url = new URL(req.url)
      if (url.pathname === "/api/workspace/ws_machine/connection") {
        return new Response(JSON.stringify({
          access: "user-hosted",
          backing: "local-worktree",
          workspaceId: "ws_machine",
          relayUrl: "https://relay.test",
          runtimeAccessToken: "rat_machine",
          role: "editor",
          tokenExpiresAt: Date.now() + 120_000,
        }), { status: 200 })
      }
      if (url.toString() === "https://relay.test/workspaces/ws_machine/mcp") {
        expect(req.headers.get("authorization")).toBe("Bearer rat_machine")
        return new Response(JSON.stringify({ local: { status: "connected" } }), { status: 200 })
      }
      throw new Error(`unexpected request: ${req.method} ${req.url}`)
    }

    const backend = createHttpWorkspaceRuntimeBackend({
      baseUrl: "http://claxedo.test",
      request,
      client: {
        mcp: { status: mock(async () => ({ data: {} })) },
      },
    })

    await withGlobalFetch(request, async () => {
      expect(await backend.getMcpStatus({ directory: "workspace:ws_machine" })).toMatchObject({
        local: { status: "connected" },
      })
    })
    expect(calls).toEqual([
      "GET http://claxedo.test/api/workspace/ws_machine/connection",
      "GET https://relay.test/workspaces/ws_machine/mcp Bearer rat_machine",
    ])
  })

  test("signed runtime status reads fail closed instead of using legacy runtime fallback", async () => {
    const client = {
      mcp: { status: mock(async () => ({ data: {} })) },
    }
    const backend = createHttpWorkspaceRuntimeBackend({
      baseUrl: "http://claxedo.test",
      signedControlPlane: true,
      request: async () =>
        new Response(JSON.stringify({ workspaceId: "ws_local", kind: "local" }), { status: 200 }),
      client,
    })

    await expect(backend.getMcpStatus({ directory: "/tmp/ws" })).rejects.toThrow("signed workspace MCP relay connection unavailable")
    expect(client.mcp.status).toHaveBeenCalledTimes(0)
  })

  test("session backend routes opaque and scoped sessions through AgentRuntime", async () => {
    const calls: string[] = []
    const request: typeof fetch = async (input) => {
      const url = requestUrl(input)
      calls.push(url)
      if (url.includes("/capabilities")) {
        return new Response(JSON.stringify({
          transport: "runtime",
          abort: true,
          reconnect: false,
          replay: true,
          permissions: true,
          questions: true,
          todos: true,
          commands: true,
          fork: true,
          revert: true,
          unrevert: true,
          configOptions: false,
        }), { status: 200 })
      }
      if (url.includes("/message")) {
        return new Response(JSON.stringify([{ info: { id: "msg_1" } }]), {
          status: 200,
          headers: { "x-next-cursor": "cursor_1", "x-max-event-ordinal": "1" },
        })
      }
      if (url.includes("/session/ses_1")) return new Response(JSON.stringify(session("ses_1")), { status: 200 })
      return new Response(JSON.stringify([{ info: { id: "msg_1" } }]), {
        status: 200,
        headers: { "x-next-cursor": "cursor_1", "x-max-event-ordinal": "1" },
      })
    }

    const backend = createHttpSessionBackend({
      request,
      claxedoServerUrl: "http://127.0.0.1:3001",
    })

    expect(backend.usesScopedTransport("ses_1")).toBe(false)
    expect(backend.usesScopedTransport("ses_1", "workspace:ws_1")).toBe(true)
    expect(backend.usesScopedTransport("uuid-1")).toBe(true)

    await backend.getSession({ directory: "/legacy-project", sessionID: "ses_1" })
    const opaqueCapabilities = await backend.getCapabilities({ directory: "/legacy-project", sessionID: "ses_1" })
    await backend.listMessages({ directory: "/repo", sessionID: "uuid-1", limit: 8, before: "cursor_0" })
    await backend.getCapabilities({ directory: "/repo", sessionID: "uuid-1" })

    expect(opaqueCapabilities).toMatchObject({ transport: "runtime", commands: true })
    expect(calls).toEqual([
      "http://127.0.0.1:3001/session/ses_1?directory=%2Flegacy-project",
      "http://127.0.0.1:3001/session/ses_1/capabilities?directory=%2Flegacy-project",
      "http://127.0.0.1:3001/session/uuid-1/message?directory=%2Frepo&limit=8&before=cursor_0",
      "http://127.0.0.1:3001/session/uuid-1/capabilities?directory=%2Frepo",
    ])
  })

  test("session backend sends synthetic workspace ses sessions through Workspace Relay", async () => {
    const calls: string[] = []
    const request: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init)
      calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
      const url = new URL(req.url)
      if (url.pathname === "/api/workspace/ws_cloud/connection") {
        return new Response(JSON.stringify({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_cloud",
          relayUrl: "https://relay.test",
          runtimeAccessToken: "rat_cloud",
          role: "editor",
          tokenExpiresAt: Date.now() + 120_000,
        }), { status: 200 })
      }
      if (url.toString() === "https://relay.test/workspaces/ws_cloud/session/ses_cloud/message?limit=8") {
        expect(req.headers.get("authorization")).toBe("Bearer rat_cloud")
        return new Response(JSON.stringify([{ info: { id: "msg_1" } }]), {
          status: 200,
          headers: { "x-max-event-ordinal": "1" },
        })
      }
      throw new Error(`unexpected request: ${req.method} ${req.url}`)
    }

    const backend = createHttpSessionBackend({
      request,
      claxedoServerUrl: "http://claxedo.test",
    })

    const messages = await withGlobalFetch(request, () => backend.listMessages({
      directory: "workspace:ws_cloud",
      sessionID: "ses_cloud",
      limit: 8,
    }))

    expect(messages.data?.map((row) => row.info.id)).toEqual(["msg_1"])
    expect(calls).toEqual([
      "GET http://claxedo.test/api/workspace/ws_cloud/connection",
      "GET https://relay.test/workspaces/ws_cloud/session/ses_cloud/message?limit=8 Bearer rat_cloud",
    ])
  })

  test("session backend uses explicit SessionRef workspace backing before directory shape", async () => {
    const calls: string[] = []
    const request: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init)
      calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
      const url = new URL(req.url)
      if (url.pathname === "/api/workspace/ws_explicit/connection") {
        return new Response(JSON.stringify({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_explicit",
          relayUrl: "https://relay.test",
          runtimeAccessToken: "rat_explicit",
          role: "editor",
          tokenExpiresAt: Date.now() + 120_000,
        }), { status: 200 })
      }
      if (url.toString() === "https://relay.test/workspaces/ws_explicit/session/ses_explicit/message?limit=8") {
        expect(req.headers.get("authorization")).toBe("Bearer rat_explicit")
        return new Response(JSON.stringify([{ info: { id: "msg_1" } }]), {
          status: 200,
          headers: { "x-max-event-ordinal": "1" },
        })
      }
      throw new Error(`unexpected request: ${req.method} ${req.url}`)
    }

    const backend = createHttpSessionBackend({
      request,
      claxedoServerUrl: "http://claxedo.test",
    })

    const messages = await withGlobalFetch(request, () => backend.listMessages({
      directory: "/repo/not-a-workspace-ref",
      sessionID: "ses_explicit",
      sessionRef: {
        sessionId: "ses_explicit",
        host: "workspace",
        workspaceId: "ws_explicit",
        toolSandbox: {
          kind: "workspace",
          workspaceId: "ws_explicit",
          hosting: "provisioner",
        },
      },
      limit: 8,
    }))

    expect(messages.data?.map((row) => row.info.id)).toEqual(["msg_1"])
    expect(calls).toEqual([
      "GET http://claxedo.test/api/workspace/ws_explicit/connection",
      "GET https://relay.test/workspaces/ws_explicit/session/ses_explicit/message?limit=8 Bearer rat_explicit",
    ])
  })

  test("signed session backend uses Control Plane inventory and messages with relay-owned runtime resources", async () => {
    const calls: string[] = []
    const request: typeof fetch = async (input) => {
      const url = requestUrl(input)
      calls.push(url)
      if (url.includes("/api/workspace/resolve")) {
        return new Response(JSON.stringify({ workspaceId: "ws_cloud", directory: "/repo", kind: "cloud" }), { status: 200 })
      }
      if (url.includes("/api/workspace/ws_cloud/connection")) {
        return new Response(JSON.stringify({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_cloud",
          relayUrl: "https://relay.test",
          runtimeAccessToken: "rat_cloud",
          role: "editor",
          tokenExpiresAt: Date.now() + 120_000,
        }), { status: 200 })
      }
      if (url.includes("https://relay.test/workspaces/ws_cloud/session/uuid-1/capabilities")) {
        return new Response(JSON.stringify({
          transport: "codex-acp",
          replay: true,
          abort: true,
          fork: true,
          revert: false,
          todos: false,
        }), { status: 200 })
      }
      if (url.includes("https://relay.test/workspaces/ws_cloud/session/uuid-1/todo")) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes("/api/control/sessions/uuid-1/messages")) {
        return new Response(JSON.stringify({
          maxEventOrdinal: 9,
          messages: [{ info: { id: "msg_1" } }],
        }), { status: 200 })
      }
      if (url.includes("/api/control/sessions")) {
        return new Response(JSON.stringify({ sessions: [{ id: "uuid-1", title: "Cloud session" }] }), { status: 200 })
      }
      throw new Error(`unexpected URL: ${url}`)
    }

    const backend = createHttpSessionBackend({
      request,
      claxedoServerUrl: "http://claxedo.test",
      signedControlPlane: true,
    })

    const session = await backend.getSession({ directory: "/repo", sessionID: "uuid-1" })
    const messages = await backend.listMessages({ directory: "/repo", sessionID: "uuid-1", limit: 8, before: "cursor_0" })
    const capabilities = await backend.getCapabilities({ directory: "/repo", sessionID: "uuid-1" })
    const todos = await backend.listTodos({ directory: "/repo", sessionID: "uuid-1" })

    expect(session.data).toMatchObject({ id: "uuid-1", title: "Cloud session" })
    expect(messages.maxEventOrdinal).toBe(9)
    expect(capabilities).toMatchObject({
      transport: "codex-acp",
      replay: true,
      abort: true,
      fork: true,
      revert: false,
      todos: false,
    })
    expect(todos.data).toEqual([])
    expect(calls).toContain("http://claxedo.test/api/control/sessions?workspaceId=ws_cloud")
    expect(calls).toContain("http://claxedo.test/api/control/sessions/uuid-1/messages?workspaceId=ws_cloud&limit=8&before=cursor_0")
    expect(calls).toContain("https://relay.test/workspaces/ws_cloud/session/uuid-1/capabilities")
    expect(calls).toContain("https://relay.test/workspaces/ws_cloud/session/uuid-1/todo")
    expect(calls.some((url) => url.includes("http://claxedo.test/session/uuid-1"))).toBe(false)
  })

  test("signed session backend fails closed when workspace resolve omits workspaceId", async () => {
    const calls: string[] = []
    const backend = createHttpSessionBackend({
      request: async (input) => {
        const url = requestUrl(input)
        calls.push(url)
        if (url.includes("/api/workspace/resolve")) {
          return new Response(JSON.stringify({ directory: "/repo", kind: "cloud" }), { status: 200 })
        }
        throw new Error(`unexpected URL: ${url}`)
      },
      claxedoServerUrl: "http://claxedo.test",
      signedControlPlane: true,
    })

    await expect(backend.listMessages({ directory: "/repo", sessionID: "uuid-1" }))
      .rejects.toThrow("Signed session transport requires a workspace id for /repo")
    await expect(backend.getCapabilities({ directory: "/repo", sessionID: "uuid-1" }))
      .rejects.toThrow("Signed session transport requires a workspace id for /repo")
    await expect(backend.getSession({ directory: "/repo", sessionID: "uuid-1" }))
      .rejects.toThrow("Signed session transport requires a workspace id for /repo")
    expect(calls).toEqual([
      "http://claxedo.test/api/workspace/resolve?directory=%2Frepo",
      "http://claxedo.test/api/workspace/resolve?directory=%2Frepo",
      "http://claxedo.test/api/workspace/resolve?directory=%2Frepo",
    ])
  })
})
