import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "../../../shared/query/query-client"
import { createTransport, submitTransportForPlacement } from "./transport"

afterEach(() => {
  queryClient.clear()
})

describe("createTransport", () => {
  test("keeps signed web placements on the control plane", async () => {
    const calls: string[] = []
    const transport = createTransport({
      placement: { hosting: "central", transport: "signed-web", workspaceId: "ws_authz" },
      serverUrl: "https://control.test/",
      request: (async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
        return Response.json({ ok: true })
      }) as typeof fetch,
    })

    await expect(transport.json("/session/ses_1?workspaceId=ws_authz", {
      headers: { Authorization: "Bearer signed-browser-token" },
    })).resolves.toEqual({ ok: true })
    expect(calls).toEqual([
      "GET https://control.test/session/ses_1?workspaceId=ws_authz Bearer signed-browser-token",
    ])
  })

  test("keeps loopback placements unsigned on the local runtime", async () => {
    const calls: string[] = []
    const transport = createTransport({
      placement: { hosting: "workspace", transport: "loopback" },
      serverUrl: "http://127.0.0.1:3001",
      directory: "/repo/main",
      request: (async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
        return Response.json({ ok: true })
      }) as typeof fetch,
    })

    await expect(transport.json("/mcp?directory=%2Frepo%2Fmain", {
      headers: { Authorization: "Bearer signed-browser-token" },
    })).resolves.toEqual({ ok: true })
    expect(calls).toEqual(["GET http://127.0.0.1:3001/mcp?directory=%2Frepo%2Fmain"])
  })

  test("keeps loopback workspace placements on the local workspace proxy", async () => {
    const calls: string[] = []
    const transport = createTransport({
      placement: { hosting: "workspace", transport: "loopback", workspaceId: "ws_local_proxy" },
      serverUrl: "http://127.0.0.1:3001",
      request: (async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""} ${req.headers.get("x-opencode-directory") ?? ""}`.trim())
        return Response.json({ ok: true })
      }) as typeof fetch,
    })

    await expect(transport.json("/provider?workspaceId=ws_local_proxy", {
      headers: { Authorization: "Bearer signed-browser-token" },
    })).resolves.toEqual({ ok: true })
    expect(calls).toEqual([
      "GET http://127.0.0.1:3001/workspaces/ws_local_proxy/provider  workspace:ws_local_proxy",
    ])
  })

  test("routes workspace relay placements through the workspace connection", async () => {
    const calls: string[] = []
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""} ${req.headers.get("x-opencode-directory") ?? ""}`.trim())
      const url = new URL(req.url)
      if (url.pathname === "/api/workspace/ws_relay/connection") {
        return Response.json({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_relay",
          role: "owner",
          relayUrl: "https://relay.test",
          runtimeAccessToken: "rat_relay",
          tokenExpiresAt: Date.now() + 120_000,
        })
      }
      if (url.toString() === "https://relay.test/workspaces/ws_relay/vcs") {
        return Response.json({ ok: true })
      }
      throw new Error(`unexpected request: ${req.method} ${req.url}`)
    }) as typeof fetch
    const transport = createTransport({
      placement: { hosting: "workspace", transport: "workspace-relay", workspaceId: "ws_relay" },
      serverUrl: "https://control.test",
      request,
      relayRequest: request,
    })

    await expect(transport.json("/vcs?directory=workspace%3Aws_relay", {
      headers: { Authorization: "Bearer signed-browser-token" },
    })).resolves.toEqual({ ok: true })
    expect(calls).toEqual([
      "GET https://control.test/api/workspace/ws_relay/connection Bearer signed-browser-token",
      "GET https://relay.test/workspaces/ws_relay/vcs Bearer rat_relay workspace:ws_relay",
    ])
  })

  test("adapts SDK-style fetch inputs to runtime paths", async () => {
    const calls: string[] = []
    const transport = createTransport({
      placement: { hosting: "workspace", transport: "loopback", workspaceId: "ws_sdk" },
      serverUrl: "http://127.0.0.1:3001",
      request: (async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(`${req.method} ${req.url} ${await req.clone().text()} ${req.headers.get("authorization") ?? ""} ${req.headers.get("x-opencode-directory") ?? ""}`.trim())
        return Response.json({ ok: true })
      }) as typeof fetch,
    })

    await expect(transport.sdkFetch(new Request("http://opencode.local/session/ses_1/prompt_async?workspaceId=ws_sdk", {
      method: "POST",
      headers: { Authorization: "Bearer signed-browser-token" },
      body: "hello",
    })).then((response) => response.json())).resolves.toEqual({ ok: true })
    expect(calls).toEqual([
      "POST http://127.0.0.1:3001/workspaces/ws_sdk/session/ses_1/prompt_async hello  workspace:ws_sdk",
    ])
  })

  test("uses direct runtime URLs exposed by the workspace connection", async () => {
    const calls: string[] = []
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
      const url = new URL(req.url)
      if (url.pathname === "/api/workspace/ws_direct/connection") {
        return Response.json({
          access: "user-hosted",
          backing: "local-worktree",
          workspaceId: "ws_direct",
          role: "owner",
          relayUrl: "https://relay.direct.test",
          directRuntimeUrl: "https://runtime.direct.test",
          runtimeAccessToken: "rat_direct",
          tokenExpiresAt: Date.now() + 120_000,
        })
      }
      if (url.toString() === "https://runtime.direct.test/api/wr/process") {
        return Response.json({ ok: true })
      }
      throw new Error(`unexpected request: ${req.method} ${req.url}`)
    }) as typeof fetch
    const transport = createTransport({
      placement: { hosting: "workspace", transport: "direct-runtime", workspaceId: "ws_direct" },
      serverUrl: "https://control.test",
      request,
      relayRequest: request,
    })

    await expect(transport.json("/api/wr/process?workspaceId=ws_direct", {
      headers: { Authorization: "Bearer signed-browser-token" },
    })).resolves.toEqual({ ok: true })
    expect(calls).toEqual([
      "GET https://control.test/api/workspace/ws_direct/connection Bearer signed-browser-token",
      "GET https://runtime.direct.test/api/wr/process",
    ])
  })
})

describe("submitTransportForPlacement", () => {
  test("classifies submit transport flags without RuntimeGateway predicate wrappers", () => {
    expect(submitTransportForPlacement({
      serverUrl: "http://localhost:3001",
      directory: "/repo/main",
    })).toEqual({
      loopbackWorkspaceBridge: true,
      controlPlaneSession: false,
      workspaceRuntimeSession: false,
    })
    expect(submitTransportForPlacement({
      serverUrl: "http://localhost:3001",
      directory: "ws_1",
    })).toEqual({
      loopbackWorkspaceBridge: false,
      controlPlaneSession: true,
      workspaceRuntimeSession: true,
    })
    expect(submitTransportForPlacement({
      serverUrl: "https://control.example.com",
      directory: "/repo/main",
      signedControlPlane: true,
    })).toEqual({
      loopbackWorkspaceBridge: false,
      controlPlaneSession: true,
      workspaceRuntimeSession: true,
    })
    expect(submitTransportForPlacement({
      serverUrl: "https://control.example.com",
      directory: "/repo/main",
      workspaceId: "ws_cloud",
    })).toEqual({
      loopbackWorkspaceBridge: false,
      controlPlaneSession: true,
      workspaceRuntimeSession: true,
    })
  })
})
