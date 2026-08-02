import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"

const calls: Array<{ url: string; method?: string }> = []
const realApiModule = { ...(await import(`${import.meta.dir}/../../../platform/api/api.ts?session-transport-restore`)) }

afterAll(() => {
  mock.module("@/platform/api/api", () => realApiModule)
})

mock.module("@/platform/api/api", () => ({
  authFetch: async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    calls.push({
      url: request.url,
      method: request.method,
    })
    if (request.url.includes("/api/workspace/resolve")) {
      return new Response(JSON.stringify({
        workspaceId: "ws_1",
        directory: "/repo",
        kind: "cloud",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (request.url.includes("/api/workspace/ws_1/connection")) {
      return new Response(JSON.stringify({
        access: "cloud",
        backing: "cloud-vm",
        workspaceId: "ws_1",
        relayUrl: "https://relay.test",
        runtimeAccessToken: "rat_1",
        role: "editor",
        tokenExpiresAt: Date.now() + 120_000,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (request.url.includes("https://relay.test/workspaces/ws_1/session/ses_123/message")) {
      return new Response(JSON.stringify([{ info: { id: "msg_workspace", role: "user" } }]), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-next-cursor": "cursor_workspace",
        },
      })
    }
    if (request.url.includes("/capabilities")) {
      return new Response(JSON.stringify({
        transport: "codex-acp",
        abort: true,
        reconnect: false,
        replay: true,
        permissions: true,
        questions: false,
        todos: true,
        commands: false,
        fork: true,
        revert: false,
        unrevert: false,
        configOptions: true,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (request.url.includes("/api/control/sessions/")) {
      return new Response(JSON.stringify({
        messages: [{ info: { id: "msg_control", role: "assistant" } }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    return new Response(JSON.stringify([{ info: { id: "msg_1", role: "user" } }]), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "x-next-cursor": "cursor_1",
      },
    })
  },
  getClaxedoServerUrl: () => "http://test.local",
  getDefaultBaseUrl: () => "http://test.local",
  // Ensure all api.ts named exports are stubbed so other tests that
  // transitively import this module don't crash with
  // "Export named 'api' not found" — bun:test mock.module shims leak
  // across files in the same suite run.
  api: {} as Record<string, unknown>,
  isDemoMode: () => false,
  isDemoPath: () => false,
  isEmbedMode: () => false,
  fixDir: (input: string | undefined) => input,
  configureApiRuntime: () => undefined,
  resetApiRuntime: () => undefined,
  normalizeUrl: (u: string | undefined) => u?.trim().replace(/\/+$/, "") || undefined,
}))

const {
  DEFAULT_OPENCODE_TRANSPORT_CAPABILITIES,
  fetchSessionCapabilitiesByTransport,
  fetchSessionByTransport,
  fetchSessionMessagesByTransport,
  fetchSessionTodoByTransport,
  usesClaxedoSessionTransport,
} = await import("./session-transport")

beforeEach(() => {
  calls.length = 0
})

describe("session transport split", () => {
  test("treats ses-prefixed ids as upstream sessions", () => {
    expect(usesClaxedoSessionTransport("ses_123")).toBe(false)
    expect(usesClaxedoSessionTransport("ses_local")).toBe(false)
    expect(usesClaxedoSessionTransport("ses_123", "ws_1")).toBe(true)
  })

  test("routes non-ses ids through claxedo-server", () => {
    expect(usesClaxedoSessionTransport("0251fd86-2f35-4efe-a802-b2fd6d473992")).toBe(true)
    expect(usesClaxedoSessionTransport("3aca2eef-6d50-4366-9600-a7ebb9852a58")).toBe(true)
  })

  test("uses scoped runtime transport for filesystem-backed ses-prefixed message reads", async () => {
    const client = {
      get: mock(async () => ({ data: { id: "ses_123" } })),
      messages: mock(async () => ({ data: [], response: new Response(null) })),
      todo: mock(async () => ({ data: [] })),
    }

    const result = await fetchSessionMessagesByTransport({
      client,
      directory: "/repo",
      sessionID: "ses_123",
      limit: 8,
    })

    expect(client.messages).toHaveBeenCalledTimes(0)
    expect(result.data?.[0]?.info?.id).toBe("msg_1")
    expect(calls).toEqual([{
      url: "http://test.local/session/ses_123/message?directory=%2Frepo&limit=8",
      method: "GET",
    }])
  })

  test("uses workspace transport for ses-prefixed synthetic workspace reads", async () => {
    const client = {
      get: mock(async () => ({ data: { id: "ses_123" } })),
      messages: mock(async () => ({ data: [], response: new Response(null) })),
      todo: mock(async () => ({ data: [] })),
    }

    const result = await fetchSessionMessagesByTransport({
      client,
      directory: "ws_1",
      sessionID: "ses_123",
      limit: 8,
    })

    expect(client.messages).toHaveBeenCalledTimes(0)
    expect(result.data?.[0]?.info?.id).toBe("msg_workspace")
    expect(calls.map((item) => item.url)).toEqual([
      "http://test.local/api/workspace/ws_1/connection",
      "https://relay.test/workspaces/ws_1/session/ses_123/message?limit=8",
    ])
  })

  test("uses claxedo-server for uuid message reads", async () => {
    const client = {
      get: mock(async () => ({ data: { id: "ses_123" } })),
      messages: mock(async () => ({ data: [], response: new Response(null) })),
      todo: mock(async () => ({ data: [] })),
    }

    const result = await fetchSessionMessagesByTransport({

      directory: "/repo",
      sessionID: "0251fd86-2f35-4efe-a802-b2fd6d473992",
      limit: 8,
      before: "cursor_0",
    })

    expect(client.messages).toHaveBeenCalledTimes(0)
    expect(calls).toEqual([
      {
        url: "http://test.local/session/0251fd86-2f35-4efe-a802-b2fd6d473992/message?directory=%2Frepo&limit=8&before=cursor_0",
        method: "GET",
      },
    ])
    expect(result.data?.[0]?.info?.id).toBe("msg_1")
    expect(result.response.headers.get("x-next-cursor")).toBe("cursor_1")
  })

  test("uses claxedo-server for uuid session and todo reads", async () => {
    const client = {
      get: mock(async () => ({ data: { id: "ses_123" } })),
      messages: mock(async () => ({ data: [], response: new Response(null) })),
      todo: mock(async () => ({ data: [] })),
    }

    await fetchSessionByTransport({
      client,
      directory: "/repo",
      sessionID: "3aca2eef-6d50-4366-9600-a7ebb9852a58",
    })
    await fetchSessionTodoByTransport({
      client,
      directory: "/repo",
      sessionID: "3aca2eef-6d50-4366-9600-a7ebb9852a58",
    })

    expect(client.get).toHaveBeenCalledTimes(0)
    expect(client.todo).toHaveBeenCalledTimes(0)
    expect(calls.map((item) => item.url)).toEqual([
      "http://test.local/session/3aca2eef-6d50-4366-9600-a7ebb9852a58?directory=%2Frepo",
      "http://test.local/session/3aca2eef-6d50-4366-9600-a7ebb9852a58/todo?directory=%2Frepo",
    ])
  })

  test("reads capabilities from claxedo-server for scoped sessions", async () => {
    const client = {
      get: mock(async () => ({ data: { id: "ses_123" } })),
      messages: mock(async () => ({ data: [], response: new Response(null) })),
      todo: mock(async () => ({ data: [] })),
    }

    const legacy = await fetchSessionCapabilitiesByTransport({
      client,
      directory: "/repo",
      sessionID: "ses_123",
    })
    const scoped = await fetchSessionCapabilitiesByTransport({
      client,
      directory: "/repo",
      sessionID: "0251fd86-2f35-4efe-a802-b2fd6d473992",
    })

    expect(legacy).toMatchObject({
      transport: "codex-acp",
      commands: false,
      questions: false,
      configOptions: true,
    })
    expect(scoped).toMatchObject({
      transport: "codex-acp",
      commands: false,
      questions: false,
      configOptions: true,
    })
    expect(calls).toEqual([{
      url: "http://test.local/session/ses_123/capabilities?directory=%2Frepo",
      method: "GET",
    }, {
      url: "http://test.local/session/0251fd86-2f35-4efe-a802-b2fd6d473992/capabilities?directory=%2Frepo",
      method: "GET",
    }])
  })

  test("signed scoped message reads use Control Plane instead of /session", async () => {
    const client = {
      get: mock(async () => ({ data: { id: "ses_123" } })),
      messages: mock(async () => ({ data: [], response: new Response(null) })),
      todo: mock(async () => ({ data: [] })),
    }

    const result = await fetchSessionMessagesByTransport({
      client,
      directory: "/repo",
      sessionID: "0251fd86-2f35-4efe-a802-b2fd6d473992",
      limit: 8,
      signedControlPlane: true,
    })
    const capabilities = await fetchSessionCapabilitiesByTransport({
      client,
      directory: "/repo",
      sessionID: "0251fd86-2f35-4efe-a802-b2fd6d473992",
      signedControlPlane: true,
    })

    expect(client.messages).toHaveBeenCalledTimes(0)
    expect(result.maxEventOrdinal).toBe(0)
    expect(result.data?.[0]?.info?.id).toBe("msg_control")
    expect(capabilities).toMatchObject({ transport: "codex-acp", replay: true, abort: true, fork: true, revert: false })
    expect(calls.map((item) => item.url)).toContain("http://test.local/api/workspace/resolve?directory=%2Frepo")
    expect(calls.map((item) => item.url)).toContain(
      "http://test.local/api/control/sessions/0251fd86-2f35-4efe-a802-b2fd6d473992/messages?workspaceId=ws_1&limit=8",
    )
    expect(calls.at(-1)?.url).toBe(
      "https://relay.test/workspaces/ws_1/session/0251fd86-2f35-4efe-a802-b2fd6d473992/capabilities",
    )
    expect(calls.some((item) =>
      item.url.startsWith("http://test.local/session/0251fd86-2f35-4efe-a802-b2fd6d473992")
    )).toBe(false)
  })

  test("signed scoped message reads use the known workspace id without resolving", async () => {
    const client = {
      get: mock(async () => ({ data: { id: "ses_123" } })),
      messages: mock(async () => ({ data: [], response: new Response(null) })),
      todo: mock(async () => ({ data: [] })),
    }

    const result = await fetchSessionMessagesByTransport({
      client,
      directory: "/repo",
      workspaceId: "ws_known",
      sessionID: "0251fd86-2f35-4efe-a802-b2fd6d473992",
      limit: 8,
      signedControlPlane: true,
    })

    expect(client.messages).toHaveBeenCalledTimes(0)
    expect(result.data?.[0]?.info?.id).toBe("msg_control")
    expect(calls.map((item) => item.url)).toEqual([
      "http://test.local/api/control/sessions/0251fd86-2f35-4efe-a802-b2fd6d473992/messages?workspaceId=ws_known&limit=8",
    ])
  })

  test("local signed workspace message reads use the workspace runtime proxy", async () => {
    const client = {
      get: mock(async () => ({ data: { id: "ses_123" } })),
      messages: mock(async () => ({ data: [], response: new Response(null) })),
      todo: mock(async () => ({ data: [] })),
    }

    const result = await fetchSessionMessagesByTransport({
      client,
      claxedoServerUrl: "http://127.0.0.1:3001",
      directory: "/workspace",
      workspaceId: "ws_known",
      sessionID: "ses_123",
      limit: 8,
      signedControlPlane: true,
    })

    expect(client.messages).toHaveBeenCalledTimes(0)
    expect(result.data?.[0]?.info?.id).toBe("msg_1")
    expect(calls.map((item) => item.url)).toEqual([
      "http://127.0.0.1:3001/workspaces/ws_known/session/ses_123/message?limit=8",
    ])
  })

  test("local workspace-scoped message reads prefer replay projection when populated", async () => {
    const client = {
      get: mock(async () => ({ data: { id: "ses_123" } })),
      messages: mock(async () => ({ data: [], response: new Response(null) })),
      todo: mock(async () => ({ data: [] })),
    }

    const result = await fetchSessionMessagesByTransport({
      client,
      directory: "/repo",
      workspaceId: "ws_known",
      sessionID: "ses_123",
      limit: 8,
    })

    expect(client.messages).toHaveBeenCalledTimes(0)
    expect(result.data?.[0]?.info?.id).toBe("msg_control")
    expect(calls.map((item) => item.url)).toEqual([
      "http://test.local/api/control/sessions/ses_123/messages?workspaceId=ws_known&limit=8",
    ])
  })
})
