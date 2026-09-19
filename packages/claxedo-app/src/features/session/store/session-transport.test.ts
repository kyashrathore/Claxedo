import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createMockApi } from "@/architecture/test-support/mock-api"

const calls: Array<{ url: string; method?: string }> = []

// `mock.module` replaces `@/platform/api/api` PROCESS-WIDE and permanently, so
// a hand-listed factory silently deletes every export it forgets — that is what
// leaves later files reading `undefined` for exports they never mocked. This
// file used to spread a cache-busting real import and then blank `api` to an
// empty object, which is the same hazard wearing a cast. `createMockApi` owns
// the module's whole surface once: the pure mirrors are inherited so they
// cannot drift, and `api` is a real client routed through the `authFetch`
// override below rather than a stub that throws on first use.
const apiFixture = createMockApi({
  baseUrl: "http://test.local",
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
        kind: "provisioner",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (request.url.includes("/api/workspace/ws_1/connection") || request.url.includes("/api/workspace/ws_known/connection")) {
      const workspaceId = request.url.includes("ws_known") ? "ws_known" : "ws_1"
      return new Response(JSON.stringify({
        access: "cloud",
        backing: "cloud-vm",
        workspaceId,
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
          "x-max-event-ordinal": "4",
        },
      })
    }
    if (request.url.includes("/session/fa751c3c-50ff-46dd-b600-eb8b9caf7443?")) {
      return new Response(JSON.stringify({
        id: "fa751c3c-50ff-46dd-b600-eb8b9caf7443",
        parentID: "parent-session-1",
        title: "Subagent",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
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
        maxEventOrdinal: 0,
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
        "x-max-event-ordinal": "4",
      },
    })
  },
  getClaxedoServerUrl: () => "http://test.local",
  getDefaultBaseUrl: () => "http://test.local",
  apiBearerToken: async () => null,
  // Ensure all api.ts named exports are stubbed so other tests that
  // transitively import this module don't crash with
  // "Export named 'api' not found" — bun:test mock.module shims leak
  // across files in the same suite run.
  api: {} as Record<string, unknown>,
  isEmbedMode: () => false,
  fixDir: (input: string | undefined) => input,
})

// Captured before the mock is installed, and re-registered afterwards, because
// the replacement outlives this file otherwise.
const realApiModule = { ...(await import(`${import.meta.dir}/../../../platform/api/api.ts?session-transport-restore`)) }

afterAll(async () => {
  await mock.module("@/platform/api/api", () => realApiModule)
})

await mock.module("@/platform/api/api", () => apiFixture.module)

const {
  createSessionInfoHydrationGetter,
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
  test("hydrates native child metadata through its canonical session ref", async () => {
    const client = {
      get: mock(async () => ({ data: { id: "wrong-upstream-session" } })),
      messages: mock(async () => ({ data: [], response: new Response(null) })),
      todo: mock(async () => ({ data: [] })),
    }
    const getSession = createSessionInfoHydrationGetter({
      client,
      claxedoServerUrl: "http://127.0.0.1:3001",
      sessionRef: {
        sessionId: "fa751c3c-50ff-46dd-b600-eb8b9caf7443",
        host: "workspace",
        harness: { id: "pi", access: "native" },
        toolSandbox: { kind: "local", cwd: "/repo" },
      },
    })

    const session = await getSession({
      directory: "/repo",
      claxedoServerUrl: "http://127.0.0.1:3001",
      sessionID: "fa751c3c-50ff-46dd-b600-eb8b9caf7443",
    })

    expect(session).toMatchObject({
      id: "fa751c3c-50ff-46dd-b600-eb8b9caf7443",
      parentID: "parent-session-1",
    })
    expect(calls).toEqual([{
      url: "http://127.0.0.1:3001/session/fa751c3c-50ff-46dd-b600-eb8b9caf7443?directory=%2Frepo",
      method: "GET",
    }])
  })

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
    const result = await fetchSessionMessagesByTransport({
      directory: "/repo",
      sessionID: "ses_123",
      limit: 8,
    })

    expect(result.data?.[0]?.info?.id).toBe("msg_1")
    expect(calls).toEqual([{
      url: "http://test.local/session/ses_123/message?directory=%2Frepo&limit=8",
      method: "GET",
    }])
  })

  test("passes the semantic latest-turn view through the session transport", async () => {
    await fetchSessionMessagesByTransport({
      directory: "/repo",
      sessionID: "ses_123",
      view: "latest-turn",
    })

    expect(calls).toEqual([{
      url: "http://test.local/session/ses_123/message?directory=%2Frepo&view=latest-turn",
      method: "GET",
    }])
  })

  test("uses workspace transport for ses-prefixed synthetic workspace reads", async () => {
    const result = await fetchSessionMessagesByTransport({
      directory: "ws_1",
      sessionID: "ses_123",
      limit: 8,
    })

    expect(result.data?.[0]?.info?.id).toBe("msg_workspace")
    expect(calls.map((item) => item.url)).toEqual([
      "http://test.local/api/workspace/ws_1/connection",
      "https://relay.test/workspaces/ws_1/session/ses_123/message?limit=8",
    ])
  })

  test("uses claxedo-server for uuid message reads", async () => {
    const result = await fetchSessionMessagesByTransport({

      directory: "/repo",
      sessionID: "0251fd86-2f35-4efe-a802-b2fd6d473992",
      limit: 8,
      before: "cursor_0",
    })

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
    await fetchSessionByTransport({
      directory: "/repo",
      claxedoServerUrl: "http://127.0.0.1:3001",
      sessionID: "3aca2eef-6d50-4366-9600-a7ebb9852a58",
    })
    await fetchSessionTodoByTransport({
      directory: "/repo",
      claxedoServerUrl: "http://127.0.0.1:3001",
      sessionID: "3aca2eef-6d50-4366-9600-a7ebb9852a58",
    })

    expect(calls.map((item) => item.url)).toEqual([
      "http://127.0.0.1:3001/session/3aca2eef-6d50-4366-9600-a7ebb9852a58?directory=%2Frepo",
      "http://127.0.0.1:3001/session/3aca2eef-6d50-4366-9600-a7ebb9852a58/todo?directory=%2Frepo",
    ])
  })

  test("reads capabilities from claxedo-server for scoped sessions", async () => {
    const opaque = await fetchSessionCapabilitiesByTransport({
      directory: "/repo",
      claxedoServerUrl: "http://127.0.0.1:3001",
      sessionID: "ses_123",
    })
    const scoped = await fetchSessionCapabilitiesByTransport({
      directory: "/repo",
      claxedoServerUrl: "http://127.0.0.1:3001",
      sessionID: "0251fd86-2f35-4efe-a802-b2fd6d473992",
    })

    expect(opaque).toMatchObject({
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
      url: "http://127.0.0.1:3001/session/ses_123/capabilities?directory=%2Frepo",
      method: "GET",
    }, {
      url: "http://127.0.0.1:3001/session/0251fd86-2f35-4efe-a802-b2fd6d473992/capabilities?directory=%2Frepo",
      method: "GET",
    }])
  })

  test("signed scoped message reads use Control Plane instead of /session", async () => {
    const result = await fetchSessionMessagesByTransport({
      directory: "/repo",
      sessionID: "0251fd86-2f35-4efe-a802-b2fd6d473992",
      limit: 8,
      signedControlPlane: true,
    })
    const capabilities = await fetchSessionCapabilitiesByTransport({
      directory: "/repo",
      sessionID: "0251fd86-2f35-4efe-a802-b2fd6d473992",
      signedControlPlane: true,
    })

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
    const result = await fetchSessionMessagesByTransport({
      directory: "/repo",
      workspaceId: "ws_known",
      sessionID: "0251fd86-2f35-4efe-a802-b2fd6d473992",
      limit: 8,
      signedControlPlane: true,
    })

    expect(result.data?.[0]?.info?.id).toBe("msg_control")
    expect(calls.map((item) => item.url)).toEqual([
      "http://test.local/api/control/sessions/0251fd86-2f35-4efe-a802-b2fd6d473992/messages?workspaceId=ws_known&limit=8",
    ])
  })

  test("local signed workspace message reads use the workspace runtime proxy", async () => {
    const result = await fetchSessionMessagesByTransport({
      claxedoServerUrl: "http://127.0.0.1:3001",
      directory: "/workspace",
      workspaceId: "ws_known",
      sessionID: "ses_123",
      limit: 8,
      signedControlPlane: true,
    })

    expect(result.data?.[0]?.info?.id).toBe("msg_1")
    expect(calls.map((item) => item.url)).toEqual([
      "http://127.0.0.1:3001/workspaces/ws_known/session/ses_123/message?limit=8",
    ])
  })

  test("workspace-scoped message reads use the canonical workspace runtime", async () => {
    const result = await fetchSessionMessagesByTransport({
      directory: "/repo",
      workspaceId: "ws_known",
      sessionID: "ses_123",
      limit: 8,
    })

    expect(result.data?.[0]?.info?.id).toBe("msg_1")
    expect(calls.map((item) => item.url)).toEqual([
      "http://test.local/api/workspace/ws_known/connection",
      "https://relay.test/workspaces/ws_known/session/ses_123/message?limit=8",
    ])
  })

})
