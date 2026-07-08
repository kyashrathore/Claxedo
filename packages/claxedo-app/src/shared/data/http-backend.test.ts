import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { Command, Project, ProviderListResponse, Session } from "@opencode-ai/sdk/v2/client"
import {
  createHttpSessionBackend,
  createHttpShellBackend,
  createHttpWorkspaceRuntimeBackend,
} from "./http-backend"
import { queryClient } from "../query/query-client"

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

function requestUrl(input: RequestInfo | URL, init?: RequestInit) {
  return input instanceof Request ? input.url : new Request(input, init).url
}

describe("http backend ports", () => {
  test("shell backend delegates to sdk-style clients", async () => {
    const providerList = {
      all: [{ id: "openai", name: "OpenAI", source: "api", env: [], options: {}, models: {} }],
      connected: [],
      default: {},
    } satisfies ProviderListResponse
    const backend = createHttpShellBackend({
      client: {
        project: {
          list: async () => ({ data: [project("p1", "/tmp/p1")] }),
        },
        provider: {
          list: async () => ({ data: providerList }),
        },
        command: {
          list: async () => ({ data: [command("build")] }),
        },
      },
    })

    expect(await backend.listProjects()).toMatchObject([{ id: "p1" }])
    expect(await backend.listProviders()).toMatchObject({ all: [{ id: "openai" }] })
    expect(await backend.listCommands({ directory: "/tmp/p1" })).toMatchObject([{ name: "build" }])
  })

  test("runtime backend resolves and ensures through http", async () => {
    let resolves = 0
    let connections = 0
    const request: typeof fetch = async (input, init) => {
      const url = requestUrl(input, init)
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
      if (url.toString() === "https://relay.test/workspaces/ws_backend_relay/lsp") {
        expect(req.headers.get("authorization")).toBe("Bearer rat_1")
        return new Response(JSON.stringify([{ id: "ts", status: "connected" }]), { status: 200 })
      }
      throw new Error(`unexpected request: ${req.method} ${req.url}`)
    }

    const client = {
      vcs: { get: mock(async () => ({ data: undefined })) },
      mcp: { status: mock(async () => ({ data: {} })) },
      lsp: { status: mock(async () => ({ data: [] })) },
    }
    const backend = createHttpWorkspaceRuntimeBackend({
      baseUrl: "http://claxedo.test",
      request,

    })

    const previous = globalThis.fetch
    globalThis.fetch = request
    try {
      expect(await backend.getVcs({ directory: "/tmp/ws" })).toMatchObject({ branch: "feature/relay" })
      expect(await backend.getMcpStatus({ directory: "/tmp/ws" })).toMatchObject({ local: { status: "connected" } })
      expect(await backend.getLspStatus({ directory: "/tmp/ws" })).toMatchObject([{ id: "ts", status: "connected" }])
    } finally {
      globalThis.fetch = previous
    }
    expect(client.vcs.get).toHaveBeenCalledTimes(0)
    expect(client.mcp.status).toHaveBeenCalledTimes(0)
    expect(client.lsp.status).toHaveBeenCalledTimes(0)
    expect(calls.some((call) =>
      call.includes("http://claxedo.test/vcs") ||
      call.includes("http://claxedo.test/mcp") ||
      call.includes("http://claxedo.test/lsp")
    )).toBe(false)
  })

  test("runtime backend sends synthetic signed workspace status reads through Workspace Relay", async () => {
    const calls: string[] = []
    const request: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init)
      calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
      const url = new URL(req.url)
      if (url.pathname === "/api/workspace/ws_user_hosted/connection") {
        return new Response(JSON.stringify({
          access: "user-hosted",
          backing: "local-worktree",
          workspaceId: "ws_user_hosted",
          relayUrl: "https://relay.test",
          runtimeAccessToken: "rat_user_hosted",
          role: "editor",
          tokenExpiresAt: Date.now() + 120_000,
        }), { status: 200 })
      }
      if (url.toString() === "https://relay.test/workspaces/ws_user_hosted/mcp") {
        expect(req.headers.get("authorization")).toBe("Bearer rat_user_hosted")
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

    const previous = globalThis.fetch
    globalThis.fetch = request
    try {
      expect(await backend.getMcpStatus({ directory: "workspace:ws_user_hosted" })).toMatchObject({
        local: { status: "connected" },
      })
    } finally {
      globalThis.fetch = previous
    }
    expect(calls).toEqual([
      "GET http://claxedo.test/api/workspace/ws_user_hosted/connection",
      "GET https://relay.test/workspaces/ws_user_hosted/mcp Bearer rat_user_hosted",
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

  test("session backend splits upstream and claxedo transport", async () => {
    const calls: string[] = []
    const request: typeof fetch = async (input, init) => {
      calls.push(requestUrl(input, init))
      return new Response(JSON.stringify([{ info: { id: "msg_1" } }]), {
        status: 200,
        headers: { "x-next-cursor": "cursor_1" },
      })
    }

    const client = {
      get: mock(async () => ({ data: session("ses_1") })),
      messages: mock(async () => ({ data: [], response: new Response(null) })),
      todo: mock(async () => ({ data: [] })),
    }

    const backend = createHttpSessionBackend({
      client,
      request,
      claxedoServerUrl: "http://claxedo.test",
    })

    expect(backend.usesScopedTransport("ses_1")).toBe(false)
    expect(backend.usesScopedTransport("ses_1", "workspace:ws_1")).toBe(true)
    expect(backend.usesScopedTransport("uuid-1")).toBe(true)

    await backend.getSession({ directory: "legacy-project", sessionID: "ses_1" })
    const legacyCapabilities = await backend.getCapabilities({ directory: "legacy-project", sessionID: "ses_1" })
    await backend.listMessages({ directory: "/repo", sessionID: "uuid-1", limit: 8, before: "cursor_0" })
    await backend.getCapabilities({ directory: "/repo", sessionID: "uuid-1" })

    expect(client.get).toHaveBeenCalledTimes(1)
    expect(legacyCapabilities).toMatchObject({ transport: "opencode", commands: true })
    expect(calls).toEqual([
      "http://claxedo.test/session/uuid-1/message?directory=%2Frepo&limit=8&before=cursor_0",
      "http://claxedo.test/session/uuid-1/capabilities?directory=%2Frepo",
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
        return new Response(JSON.stringify([{ info: { id: "msg_1" } }]), { status: 200 })
      }
      throw new Error(`unexpected request: ${req.method} ${req.url}`)
    }

    const client = {
      get: mock(async () => ({ data: session("ses_cloud") })),
      messages: mock(async () => ({ data: [], response: new Response(null) })),
      todo: mock(async () => ({ data: [] })),
    }
    const backend = createHttpSessionBackend({
      client,
      request,
      claxedoServerUrl: "http://claxedo.test",
    })

    const previous = globalThis.fetch
    globalThis.fetch = request
    let messages: Awaited<ReturnType<typeof backend.listMessages>> | undefined
    try {
      messages = await backend.listMessages({
        directory: "workspace:ws_cloud",
        sessionID: "ses_cloud",
        limit: 8,
      })
    } finally {
      globalThis.fetch = previous
    }

    expect(messages?.data?.map((row) => row.info.id)).toEqual(["msg_1"])
    expect(client.messages).toHaveBeenCalledTimes(0)
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
        return new Response(JSON.stringify([{ info: { id: "msg_1" } }]), { status: 200 })
      }
      throw new Error(`unexpected request: ${req.method} ${req.url}`)
    }

    const client = {
      get: mock(async () => ({ data: session("ses_explicit") })),
      messages: mock(async () => ({ data: [], response: new Response(null) })),
      todo: mock(async () => ({ data: [] })),
    }
    const backend = createHttpSessionBackend({
      client,
      request,
      claxedoServerUrl: "http://claxedo.test",
    })

    const previous = globalThis.fetch
    globalThis.fetch = request
    let messages: Awaited<ReturnType<typeof backend.listMessages>> | undefined
    try {
      messages = await backend.listMessages({
        directory: "/repo/not-a-workspace-ref",
        sessionID: "ses_explicit",
        sessionRef: {
          sessionId: "ses_explicit",
          host: "workspace",
          workspaceId: "ws_explicit",
          toolSandbox: {
            kind: "workspace",
            workspaceId: "ws_explicit",
            hosting: "cloud",
          },
        },
        limit: 8,
      })
    } finally {
      globalThis.fetch = previous
    }

    expect(messages?.data?.map((row) => row.info.id)).toEqual(["msg_1"])
    expect(client.messages).toHaveBeenCalledTimes(0)
    expect(calls).toEqual([
      "GET http://claxedo.test/api/workspace/ws_explicit/connection",
      "GET https://relay.test/workspaces/ws_explicit/session/ses_explicit/message?limit=8 Bearer rat_explicit",
    ])
  })

  test("signed session backend uses Control Plane messages instead of local session compatibility routes", async () => {
    const calls: string[] = []
    const request: typeof fetch = async (input, init) => {
      const url = requestUrl(input, init)
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
      if (url.includes("/api/control/sessions/uuid-1/capabilities")) {
        return new Response(JSON.stringify({
          transport: "codex-acp",
          replay: true,
          abort: true,
          reconnect: false,
          permissions: true,
          questions: true,
          todos: false,
          commands: true,
          fork: true,
          revert: false,
          unrevert: false,
          configOptions: true,
        }), { status: 200 })
      }
      if (url.includes("/api/control/sessions")) {
        return new Response(JSON.stringify({ sessions: [{ session_id: "uuid-1", title: "Cloud session" }] }), { status: 200 })
      }
      throw new Error(`unexpected URL: ${url}`)
    }

    const client = {
      get: mock(async () => ({ data: undefined })),
      messages: mock(async () => ({ data: [], response: new Response(null) })),
      todo: mock(async () => ({ data: [] })),
    }
    const backend = createHttpSessionBackend({
      client,
      request,
      claxedoServerUrl: "http://claxedo.test",
      signedControlPlane: true,
    })

    const session = await backend.getSession({ directory: "/repo", sessionID: "uuid-1" })
    const messages = await backend.listMessages({ directory: "/repo", sessionID: "uuid-1", limit: 8, before: "cursor_0" })
    const capabilities = await backend.getCapabilities({ directory: "/repo", sessionID: "uuid-1" })
    const todos = await backend.listTodos({ directory: "/repo", sessionID: "uuid-1" })

    expect(client.get).toHaveBeenCalledTimes(0)
    expect(client.messages).toHaveBeenCalledTimes(0)
    expect(client.todo).toHaveBeenCalledTimes(0)
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
    expect(calls).toContain("http://claxedo.test/api/control/sessions/uuid-1/capabilities?workspaceId=ws_cloud")
    expect(calls).toContain("https://relay.test/workspaces/ws_cloud/session/uuid-1/todo")
    expect(calls.some((url) => url.includes("http://claxedo.test/session/uuid-1"))).toBe(false)
  })

  test("signed session backend fails closed when workspace resolve omits workspaceId", async () => {
    const calls: string[] = []
    const backend = createHttpSessionBackend({
      client: {
        get: mock(async () => ({ data: undefined })),
        messages: mock(async () => ({ data: [], response: new Response(null) })),
        todo: mock(async () => ({ data: [] })),
      },
      request: async (input, init) => {
        const url = requestUrl(input, init)
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
