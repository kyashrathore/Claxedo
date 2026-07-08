import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "../shared/query/query-client"
import {
  isUserHostedWorkspaceDirectory,
  isWorkspaceIdRef,
} from "../shell/identity/legacy-resolver"
import {
  createWorkspaceRuntimeRequest,
  isLoopbackHttpUrl,
} from "./workspace-runtime-request"

afterEach(() => {
  queryClient.clear()
})

describe("workspace runtime request", () => {
  test("recognizes loopback and signed workspace references precisely", () => {
    expect(isLoopbackHttpUrl("http://[::1]:3001")).toBe(true)
    expect(isLoopbackHttpUrl("https://example.test")).toBe(false)
    expect(isWorkspaceIdRef("ws_1")).toBe(true)
    expect(isWorkspaceIdRef("workspace:ws_1")).toBe(false)
    expect(isUserHostedWorkspaceDirectory("/repo/.claxedo/user-hosted/workspaces/ws_1")).toBe(true)
    expect(isUserHostedWorkspaceDirectory("C:\\repo\\.claxedo\\user-hosted\\workspaces\\ws_1")).toBe(true)
    expect(isUserHostedWorkspaceDirectory("/repo/.claxedo/not-user-hosted/workspaces/ws_1")).toBe(false)
  })

  test("routes user-hosted workspace runtime requests through Workspace Relay", async () => {
    const calls: string[] = []
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
      const url = new URL(req.url)
      if (url.pathname === "/api/workspace/ws_user_hosted/connection") {
        return Response.json({
          access: "user-hosted",
          backing: "local-worktree",
          workspaceId: "ws_user_hosted",
          role: "owner",
          relayUrl: "https://relay.test",
          runtimeAccessToken: "rat_user_hosted",
          tokenExpiresAt: Date.now() + 120_000,
        })
      }
      if (url.toString() === "https://relay.test/workspaces/ws_user_hosted/mcp") {
        expect(req.headers.get("authorization")).toBe("Bearer rat_user_hosted")
        return Response.json({ local: { status: "connected" } })
      }
      throw new Error(`unexpected request: ${req.method} ${req.url}`)
    }) as typeof fetch
    const runtime = createWorkspaceRuntimeRequest({
      serverUrl: "http://server.test",
      directory: "workspace:ws_user_hosted",
      request,
      relayRequest: request,
      resolveWorkspaceRuntime: async () => ({
        kind: "user-hosted",
        workspaceId: "ws_user_hosted",
      }),
    })

    await expect(runtime.fetch("/mcp?directory=workspace%3Aws_user_hosted").then((res) => res.json())).resolves.toEqual({
      local: { status: "connected" },
    })
    expect(calls.some((call) => call.includes("http://server.test/mcp"))).toBe(false)
  })

  test("strips synthetic directory selectors from relay runtime requests", async () => {
    const calls: string[] = []
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push(`${req.method} ${req.url}`)
      const url = new URL(req.url)
      if (url.pathname === "/api/workspace/ws_strip/connection") {
        return Response.json({
          access: "user-hosted",
          backing: "local-worktree",
          workspaceId: "ws_strip",
          role: "owner",
          relayUrl: "https://relay.strip.test",
          runtimeAccessToken: "rat_strip",
          tokenExpiresAt: Date.now() + 120_000,
        })
      }
      expect(url.toString()).toBe("https://relay.strip.test/workspaces/ws_strip/file?path=%2Fhello.txt")
      return Response.json({ ok: true })
    }) as typeof fetch
    const runtime = createWorkspaceRuntimeRequest({
      serverUrl: "http://server.strip.test",
      directory: "workspace:ws_strip",
      request,
      relayRequest: request,
      resolveWorkspaceRuntime: async () => ({
        kind: "user-hosted",
        workspaceId: "ws_strip",
      }),
    })

    await expect(runtime.fetch("/file?directory=workspace%3Aws_strip&path=%2Fhello.txt").then((res) => res.json()))
      .resolves.toEqual({ ok: true })
    expect(calls.some((call) => call.includes("directory=workspace"))).toBe(false)
  })

  test("strips synthetic workspace id selectors from relay runtime requests", async () => {
    const calls: string[] = []
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push(`${req.method} ${req.url}`)
      const url = new URL(req.url)
      if (url.pathname === "/api/workspace/ws_strip_id/connection") {
        return Response.json({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_strip_id",
          role: "owner",
          relayUrl: "https://relay.strip-id.test",
          runtimeAccessToken: "rat_strip_id",
          tokenExpiresAt: Date.now() + 120_000,
        })
      }
      expect(url.toString()).toBe("https://relay.strip-id.test/workspaces/ws_strip_id/api/wr/process")
      return Response.json({ ok: true })
    }) as typeof fetch
    const runtime = createWorkspaceRuntimeRequest({
      serverUrl: "http://server.strip-id.test",
      directory: "/tmp/alias",
      workspaceId: "ws_strip_id",
      request,
    })

    await expect(runtime.fetch("/api/wr/process?directory=%2Ftmp%2Falias&workspaceId=ws_strip_id").then((res) => res.json()))
      .resolves.toEqual({ ok: true })
    expect(calls.some((call) => call.includes("workspaceId=ws_strip_id"))).toBe(false)
  })

  test("routes loopback unsigned cloud workspace ids through the local workspace proxy", async () => {
    const calls: string[] = []
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""} ${req.headers.get("x-opencode-directory") ?? ""}`.trim())
      const url = new URL(req.url)
      if (url.pathname === "/workspaces/ws_direct/api/wr/health") {
        expect(req.headers.get("authorization")).toBeNull()
        return Response.json({ ok: true })
      }
      throw new Error(`unexpected request: ${req.method} ${req.url}`)
    }) as typeof fetch
    const runtime = createWorkspaceRuntimeRequest({
      serverUrl: "http://127.0.0.1:3001",
      directory: "ws_direct",
      request,
      relayRequest: request,
    })

    await expect(runtime.fetch("/api/wr/health?directory=ws_direct").then((res) => res.json())).resolves.toEqual({
      ok: true,
    })
    expect(calls).toEqual([
      "GET http://127.0.0.1:3001/workspaces/ws_direct/api/wr/health  workspace:ws_direct",
    ])
  })

  test("routes signed loopback cloud workspace ids through Workspace Relay", async () => {
    const calls: string[] = []
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""} ${req.headers.get("x-opencode-directory") ?? ""}`.trim())
      const url = new URL(req.url)
      if (url.pathname === "/api/workspace/ws_signed_loopback/connection") {
        expect(req.headers.get("authorization")).toBe("Bearer signed-browser-token")
        return Response.json({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_signed_loopback",
          role: "owner",
          relayUrl: "https://relay.loopback.test",
          runtimeAccessToken: "rat_signed_loopback",
          tokenExpiresAt: Date.now() + 120_000,
        })
      }
      if (url.toString() === "https://relay.loopback.test/workspaces/ws_signed_loopback/session/ses_1/prompt_async") {
        expect(req.headers.get("authorization")).toBe("Bearer rat_signed_loopback")
        expect(req.headers.get("x-opencode-directory")).toBe("workspace:ws_signed_loopback")
        return Response.json({ ok: true })
      }
      throw new Error(`unexpected request: ${req.method} ${req.url}`)
    }) as typeof fetch
    const runtime = createWorkspaceRuntimeRequest({
      serverUrl: "http://127.0.0.1:3001",
      directory: "ws_signed_loopback",
      request,
      relayRequest: request,
      preferRelayOnLoopback: true,
    })

    await expect(runtime.fetch("/session/ses_1/prompt_async?directory=ws_signed_loopback", {
      method: "POST",
      headers: { Authorization: "Bearer signed-browser-token" },
      body: "{}",
    }).then((res) => res.json())).resolves.toEqual({ ok: true })
    expect(calls).toEqual([
      "GET http://127.0.0.1:3001/api/workspace/ws_signed_loopback/connection Bearer signed-browser-token",
      "POST https://relay.loopback.test/workspaces/ws_signed_loopback/session/ses_1/prompt_async Bearer rat_signed_loopback workspace:ws_signed_loopback",
    ])
  })

  test("shares Workspace Relay connection tokens across runtime request wrappers", async () => {
    const calls: string[] = []
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push(`${req.method} ${req.url}`)
      const url = new URL(req.url)
      if (url.pathname === "/api/workspace/ws_shared/connection") {
        return Response.json({
          access: "user-hosted",
          backing: "local-worktree",
          workspaceId: "ws_shared",
          role: "owner",
          relayUrl: "https://relay.shared.test",
          runtimeAccessToken: "rat_shared",
          tokenExpiresAt: Date.now() + 120_000,
        })
      }
      if (url.origin === "https://relay.shared.test") {
        expect(req.headers.get("authorization")).toBe("Bearer rat_shared")
        return Response.json({ ok: true })
      }
      throw new Error(`unexpected request: ${req.method} ${req.url}`)
    }) as typeof fetch
    const first = createWorkspaceRuntimeRequest({
      serverUrl: "http://server.shared.test",
      directory: "workspace:ws_shared",
      request,
      relayRequest: request,
      resolveWorkspaceRuntime: async () => ({
        kind: "user-hosted",
        workspaceId: "ws_shared",
      }),
    })
    const second = createWorkspaceRuntimeRequest({
      serverUrl: "http://server.shared.test/",
      directory: "workspace:ws_shared",
      request,
      relayRequest: request,
      resolveWorkspaceRuntime: async () => ({
        kind: "user-hosted",
        workspaceId: "ws_shared",
      }),
    })

    await expect(Promise.all([
      first.fetch("/file?directory=workspace%3Aws_shared&path=%2F"),
      second.fetch("/vcs?directory=workspace%3Aws_shared"),
    ]).then((responses) => Promise.all(responses.map((res) => res.json()))))
      .resolves.toEqual([{ ok: true }, { ok: true }])
    expect(calls.filter((call) => call === "GET http://server.shared.test/api/workspace/ws_shared/connection"))
      .toHaveLength(1)
  })

  test("keeps runtime relay transport promises in Query instead of a private WeakMap cache", async () => {
    const source = await Bun.file(new URL("./workspace-runtime-request.ts", import.meta.url)).text()

    expect(source).not.toContain("relayConnections = new WeakMap")
    expect(source).not.toContain("function connectionCache")
    expect(source).toContain("workspace-runtime-relay")
    expect(source).toContain("queryClient.setQueryData(key, pending)")
  })

  test("keeps relay transport caches isolated by injected relay request", async () => {
    const calls: string[] = []
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push(`control ${req.url}`)
      const url = new URL(req.url)
      if (url.pathname !== "/api/workspace/ws_isolated/connection") throw new Error(`unexpected request: ${req.url}`)
      return Response.json({
        access: "cloud",
        backing: "cloud-vm",
        workspaceId: "ws_isolated",
        role: "owner",
        relayUrl: "https://relay.isolated.test",
        runtimeAccessToken: "rat_isolated",
        tokenExpiresAt: Date.now() + 120_000,
      })
    }) as typeof fetch
    const relayA = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push(`relayA ${req.url}`)
      return Response.json({ relay: "a" })
    }) as typeof fetch
    const relayB = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push(`relayB ${req.url}`)
      return Response.json({ relay: "b" })
    }) as typeof fetch

    const first = createWorkspaceRuntimeRequest({
      serverUrl: "http://server.isolated.test",
      directory: "workspace:ws_isolated",
      request,
      relayRequest: relayA,
      resolveWorkspaceRuntime: async () => ({ kind: "cloud", workspaceId: "ws_isolated" }),
    })
    const second = createWorkspaceRuntimeRequest({
      serverUrl: "http://server.isolated.test",
      directory: "workspace:ws_isolated",
      request,
      relayRequest: relayB,
      resolveWorkspaceRuntime: async () => ({ kind: "cloud", workspaceId: "ws_isolated" }),
    })

    await expect(first.fetch("/alpha?directory=workspace%3Aws_isolated").then((res) => res.json()))
      .resolves.toEqual({ relay: "a" })
    await expect(second.fetch("/beta?directory=workspace%3Aws_isolated").then((res) => res.json()))
      .resolves.toEqual({ relay: "b" })
    expect(calls).toEqual([
      "control http://server.isolated.test/api/workspace/ws_isolated/connection",
      "relayA https://relay.isolated.test/workspaces/ws_isolated/alpha",
      "relayB https://relay.isolated.test/workspaces/ws_isolated/beta",
    ])
  })

  test("uses injected request for Relay runtime calls by default", async () => {
    const calls: string[] = []
    const previous = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push(`relay ${req.url} ${req.headers.get("authorization") ?? ""}`)
      return Response.json({ ok: true })
    }) as typeof fetch
    try {
      const runtime = createWorkspaceRuntimeRequest({
        serverUrl: "http://server.raw.test",
        directory: "workspace:ws_raw",
        request: (async (input: string | URL | Request, init?: RequestInit) => {
          const req = input instanceof Request ? input : new Request(String(input), init)
          calls.push(`${req.url.includes("/api/workspace/") ? "control" : "relay"} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
          const url = new URL(req.url)
          if (url.pathname === "/workspaces/ws_raw/command") return Response.json({ ok: true })
          if (url.pathname !== "/api/workspace/ws_raw/connection") throw new Error(`unexpected request: ${req.url}`)
          return Response.json({
            access: "cloud",
            backing: "cloud-vm",
            workspaceId: "ws_raw",
            role: "owner",
            relayUrl: "https://relay.raw.test",
            runtimeAccessToken: "rat_raw",
            tokenExpiresAt: Date.now() + 120_000,
          })
        }) as typeof fetch,
        resolveWorkspaceRuntime: async () => ({
          kind: "cloud",
          workspaceId: "ws_raw",
        }),
      })

      await expect(runtime.fetch("/command?directory=workspace%3Aws_raw").then((res) => res.json()))
        .resolves.toEqual({ ok: true })
      expect(calls).toEqual([
        "control http://server.raw.test/api/workspace/ws_raw/connection",
        "relay https://relay.raw.test/workspaces/ws_raw/command Bearer rat_raw",
      ])
    } finally {
      globalThis.fetch = previous
    }
  })

  test("keeps local workspace runtime requests on the direct server path", async () => {
    const calls: string[] = []
    const runtime = createWorkspaceRuntimeRequest({
      serverUrl: "http://server.test",
      directory: "/tmp/local",
      request: (async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(`${req.method} ${req.url}`)
        return Response.json({ ok: true })
      }) as typeof fetch,
      resolveWorkspaceRuntime: async () => ({
        kind: "local",
        workspaceId: "ws_local",
      }),
    })

    await expect(runtime.fetch("/mcp?directory=%2Ftmp%2Flocal").then((res) => res.json())).resolves.toEqual({ ok: true })
    expect(calls).toEqual(["GET http://server.test/mcp?directory=%2Ftmp%2Flocal"])
  })

  test("prefers central SessionRef placement over workspace id fallback", async () => {
    const calls: string[] = []
    const runtime = createWorkspaceRuntimeRequest({
      serverUrl: "https://control.test",
      workspaceId: "ws_authz_only",
      sessionRef: {
        sessionId: "central-session",
        host: "central",
        workspaceId: "ws_authz_only",
        toolSandbox: { kind: "virtual" },
      },
      request: (async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(req.url)
        if (req.url.includes("/api/workspace/")) throw new Error(`unexpected workspace relay: ${req.url}`)
        return Response.json({ ok: true })
      }) as typeof fetch,
    })

    await expect(runtime.fetch("/mcp?workspaceId=ws_authz_only").then((res) => res.json()))
      .resolves.toEqual({ ok: true })
    expect(calls).toEqual(["https://control.test/mcp?workspaceId=ws_authz_only"])
  })

  test("uses SessionRef tool sandbox without inspecting directory shape", async () => {
    const calls: string[] = []
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push(req.url)
      const url = new URL(req.url)
      if (url.pathname === "/api/workspace/ws_real/connection") {
        return Response.json({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_real",
          role: "owner",
          relayUrl: "https://relay.session-ref.test",
          runtimeAccessToken: "rat_session_ref",
          tokenExpiresAt: Date.now() + 120_000,
        })
      }
      if (url.toString() === "https://relay.session-ref.test/workspaces/ws_real/vcs") {
        return Response.json({ ok: true })
      }
      throw new Error(`unexpected request: ${req.url}`)
    }) as typeof fetch
    const runtime = createWorkspaceRuntimeRequest({
      serverUrl: "https://control.test",
      directory: "not-a-workspace-id",
      sessionRef: {
        sessionId: "workspace-session",
        host: "workspace",
        toolSandbox: { kind: "workspace", workspaceId: "ws_real", hosting: "cloud" },
      },
      request,
      relayRequest: request,
    })

    await expect(runtime.fetch("/vcs?directory=not-a-workspace-id").then((res) => res.json()))
      .resolves.toEqual({ ok: true })
    expect(calls).toEqual([
      "https://control.test/api/workspace/ws_real/connection",
      "https://relay.session-ref.test/workspaces/ws_real/vcs",
    ])
  })

  test("keeps signed loopback local runtime requests unsigned", async () => {
    const calls: string[] = []
    const runtime = createWorkspaceRuntimeRequest({
      serverUrl: "http://127.0.0.1:3001",
      directory: "/tmp/local",
      request: (async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
        return Response.json({ ok: true })
      }) as typeof fetch,
      resolveWorkspaceRuntime: async () => ({
        kind: "local",
        workspaceId: "ws_local",
      }),
    })

    await expect(runtime.fetch("/agent?directory=%2Ftmp%2Flocal", {
      headers: { Authorization: "Bearer signed-browser-token" },
    }).then((res) => res.json())).resolves.toEqual({ ok: true })
    expect(calls).toEqual(["GET http://127.0.0.1:3001/agent?directory=%2Ftmp%2Flocal"])
  })

  test("routes loopback workspace-id runtime requests through the local workspace proxy", async () => {
    const calls: string[] = []
    const runtime = createWorkspaceRuntimeRequest({
      serverUrl: "http://127.0.0.1:3001",
      directory: "ws_1",
      request: (async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""} ${req.headers.get("x-opencode-directory") ?? ""}`.trim())
        if (new URL(req.url).pathname !== "/workspaces/ws_1/provider") throw new Error(`unexpected request: ${req.url}`)
        return Response.json({ ok: true })
      }) as typeof fetch,
      resolveWorkspaceRuntime: async () => ({
        kind: "cloud",
        workspaceId: "ws_1",
      }),
    })

    await expect(runtime.fetch("/provider?directory=ws_1", {
      headers: {
        Authorization: "Bearer signed-browser-token",
        "x-opencode-directory": "ws_1",
      },
    }).then((res) => res.json())).resolves.toEqual({ ok: true })
    expect(calls).toEqual([
      "GET http://127.0.0.1:3001/workspaces/ws_1/provider  workspace:ws_1",
    ])
  })

  test("keeps loopback resolved local runtime requests on the local bridge", async () => {
    const calls: string[] = []
    const runtime = createWorkspaceRuntimeRequest({
      serverUrl: "http://127.0.0.1:3001",
      directory: "workspace:ws_1",
      request: (async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
        return Response.json({ ok: true })
      }) as typeof fetch,
      resolveWorkspaceRuntime: async () => ({
        kind: "local",
        workspaceId: "ws_1",
      }),
    })

    await expect(runtime.fetch("/provider?directory=workspace%3Aws_1", {
      headers: { Authorization: "Bearer signed-browser-token" },
    }).then((res) => res.json())).resolves.toEqual({ ok: true })
    expect(calls).toEqual([
      "GET http://127.0.0.1:3001/provider?directory=workspace%3Aws_1",
    ])
  })

  test("returns an error response when the relay connection is unauthorized", async () => {
    const runtime = createWorkspaceRuntimeRequest({
      serverUrl: "https://control.test",
      directory: "workspace:ws_denied",
      request: (async () => new Response("Unauthorized", { status: 401 })) as typeof fetch,
      relayRequest: (async () => {
        throw new Error("relay should not be called")
      }) as typeof fetch,
      resolveWorkspaceRuntime: async () => ({
        kind: "cloud",
        workspaceId: "ws_denied",
      }),
    })

    const res = await runtime.fetch("/provider?directory=workspace%3Aws_denied")

    expect(res.status).toBe(401)
    expect(await res.text()).toBe("Workspace connection failed: 401")
  })

  test("keeps loopback local runtime requests on the local bridge", async () => {
    const calls: string[] = []
    const runtime = createWorkspaceRuntimeRequest({
      serverUrl: "http://127.0.0.1:3001",
      directory: "/tmp/local",
      request: (async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
        return Response.json({ ok: true })
      }) as typeof fetch,
      resolveWorkspaceRuntime: async () => ({
        kind: "local",
        workspaceId: "ws_local",
      }),
    })

    await expect(runtime.fetch("/provider?directory=%2Ftmp%2Flocal", {
      headers: { Authorization: "Bearer signed-browser-token" },
    }).then((res) => res.json())).resolves.toEqual({ ok: true })
    expect(calls).toEqual([
      "GET http://127.0.0.1:3001/provider?directory=%2Ftmp%2Flocal",
    ])
  })
})
