import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import {
  createWorkspaceRelayConnection,
  forgetWorkspaceConnection,
  openWorkspaceConnection,
  refreshWorkspaceConnection,
  runtimeAccessTokenProtocol,
  runtimeAccessTokenJti,
  runtimeAccessTokenRole,
  setWorkspaceConnectionObserver,
  type WorkspaceConnectionInfo,
} from "./workspace-relay-connection"

afterEach(() => {
  queryClient.clear()
  setWorkspaceConnectionObserver(undefined)
})

function token(jti: string, payload: Record<string, unknown> = {}) {
  return [
    btoa(JSON.stringify({ alg: "none" })),
    btoa(JSON.stringify({ jti, ...payload })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""),
    "sig",
  ].join(".")
}

function connection(input: Partial<WorkspaceConnectionInfo> = {}): WorkspaceConnectionInfo {
  return {
    access: "cloud",
    backing: "cloud-vm",
    workspaceId: "ws_1",
    role: "owner",
    relayUrl: "https://relay.example.test",
    runtimeAccessToken: token("jti_1"),
    tokenExpiresAt: Date.now() + 30 * 60_000,
    ...input,
  }
}

function requestUrl(input: string | URL | Request) {
  if (input instanceof Request) return input.url
  if (input instanceof URL) return input.href
  return input
}

describe("workspace relay connection", () => {
  test("opens workspace connection info through the Control Plane", async () => {
    const calls: string[] = []
    const result = await openWorkspaceConnection("ws_1", {
      serverUrl: "http://server.test/",
      request: (async (url) => {
        calls.push(requestUrl(url))
        return Response.json(connection())
      }) as typeof fetch,
    })

    expect(result.workspaceId).toBe("ws_1")
    expect(result.role).toBe("owner")
    expect(calls).toEqual(["http://server.test/api/workspace/ws_1/connection"])
  })

  test("shares concurrent workspace connection opens", async () => {
    const calls: string[] = []
    const request = (async (url) => {
      calls.push(requestUrl(url))
      await new Promise((resolve) => setTimeout(resolve, 10))
      return Response.json(connection({ workspaceId: "ws_cached" }))
    }) as typeof fetch

    const [first, second] = await Promise.all([
      openWorkspaceConnection("ws_cached", {
        serverUrl: "http://server.cached.test",
        request,
      }),
      openWorkspaceConnection("ws_cached", {
        serverUrl: "http://server.cached.test",
        request,
      }),
    ])

    expect(first.workspaceId).toBe("ws_cached")
    expect(second.workspaceId).toBe("ws_cached")
    expect(calls).toEqual(["http://server.cached.test/api/workspace/ws_cached/connection"])
  })

  test("forgets cached workspace connection failures so user retry can re-mint", async () => {
    const calls: string[] = []
    const request = (async (url) => {
      calls.push(requestUrl(url))
      return calls.length === 1
        ? new Response("offline", { status: 409 })
        : Response.json(connection({ workspaceId: "ws_retry" }))
    }) as typeof fetch

    await expect(openWorkspaceConnection("ws_retry", {
      serverUrl: "http://server.retry.test",
      request,
    })).rejects.toThrow("Workspace connection failed: 409")
    await expect(openWorkspaceConnection("ws_retry", {
      serverUrl: "http://server.retry.test",
      request,
    })).rejects.toThrow("Workspace connection failed: 409")
    forgetWorkspaceConnection("ws_retry", { serverUrl: "http://server.retry.test" })

    const retried = await openWorkspaceConnection("ws_retry", {
      serverUrl: "http://server.retry.test",
      request,
    })

    expect(retried.workspaceId).toBe("ws_retry")
    expect(calls).toEqual([
      "http://server.retry.test/api/workspace/ws_retry/connection",
      "http://server.retry.test/api/workspace/ws_retry/connection",
    ])
  })

  test("stores workspace connection opens in Query instead of a private cache map", async () => {
    const source = await Bun.file(new URL("./workspace-relay-connection.ts", import.meta.url)).text()

    expect(source).not.toContain("connectionCache = new Map")
    expect(source).toContain("workspace-connection")
    expect(source).toContain("queryClient.setQueryData(key, pending)")
  })

  test("forwards control-plane authorization headers when opening and refreshing", async () => {
    const requests: Array<{ url: string; auth: string | null }> = []
    const request = (async (url, init) => {
      const req = new Request(requestUrl(url), init)
      requests.push({
        url: req.url,
        auth: req.headers.get("authorization"),
      })
      return Response.json(connection({ runtimeAccessToken: token(`jti_${requests.length}`) }))
    }) as typeof fetch
    const opened = await openWorkspaceConnection("ws_1", {
      serverUrl: "http://server.test",
      request,
      headers: { Authorization: "Bearer signed-browser-token" },
    })
    await refreshWorkspaceConnection(opened, {
      serverUrl: "http://server.test",
      request,
      headers: { Authorization: "Bearer signed-browser-token" },
    })

    expect(requests).toEqual([
      {
        url: "http://server.test/api/workspace/ws_1/connection",
        auth: "Bearer signed-browser-token",
      },
      {
        url: "http://server.test/api/workspace/ws_1/connection/refresh",
        auth: "Bearer signed-browser-token",
      },
    ])
  })

  test("accepts user-hosted access backed by a local worktree", async () => {
    const result = await openWorkspaceConnection("ws_uh", {
      serverUrl: "http://server.test",
      request: (async () => Response.json(connection({
        access: "user-hosted",
        backing: "local-worktree",
        runtimeKind: "user-hosted",
        homeRegion: "eu-west",
        workspaceId: "ws_uh",
      }))) as typeof fetch,
    })
    expect(result.backing).toBe("local-worktree")
    expect(result.access).toBe("user-hosted")
    expect(result.workspaceId).toBe("ws_uh")
    expect(result.runtimeKind).toBe("user-hosted")
    expect(result.homeRegion).toBe("eu-west")
    expect(result.role).toBe("owner")
  })

  test("retries provider-neutral provisioning responses until the runtime is ready", async () => {
    const calls: string[] = []
    const sleeps: number[] = []
    const result = await openWorkspaceConnection("ws_cloud", {
      serverUrl: "http://server.test",
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      request: (async (url) => {
        calls.push(requestUrl(url))
        if (calls.length === 1) {
          return Response.json({
            status: "provisioning",
            workspaceId: "ws_cloud",
            runtimeKind: "cloud",
            homeRegion: "us-east",
            retryAfterMs: 1_500,
          })
        }
        return Response.json(connection({ workspaceId: "ws_cloud" }))
      }) as typeof fetch,
    })

    expect(result.workspaceId).toBe("ws_cloud")
    expect(calls).toEqual([
      "http://server.test/api/workspace/ws_cloud/connection",
      "http://server.test/api/workspace/ws_cloud/connection",
    ])
    expect(sleeps).toEqual([1_500])
  })

  test("clamps server-controlled provisioning retryAfterMs to a sane window", async () => {
    const retryValues: unknown[] = [undefined, 0, -50, "soon", Number.NaN, 999_999_999]
    const sleeps: number[] = []
    let call = 0
    const result = await openWorkspaceConnection("ws_clamped", {
      serverUrl: "http://server.test",
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      request: (async () => {
        if (call < retryValues.length) {
          const retryAfterMs = retryValues[call]
          call += 1
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ status: "provisioning", retryAfterMs }),
          } as Response
        }
        return Response.json(connection({ workspaceId: "ws_clamped" }))
      }) as typeof fetch,
    })

    expect(result.workspaceId).toBe("ws_clamped")
    expect(sleeps).toEqual([2_000, 500, 500, 2_000, 2_000, 30_000])
  })

  test("treats a 429 with a body retry signal as a provisioning-equivalent wait", async () => {
    const calls: string[] = []
    const sleeps: number[] = []
    const result = await openWorkspaceConnection("ws_limited", {
      serverUrl: "http://server.test",
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      request: (async (url) => {
        calls.push(requestUrl(url))
        if (calls.length === 1) {
          return Response.json({
            error: {
              code: "runtime_access_token_rate_limited",
              message: "Workspace connection token limit exceeded",
              retryAfterMs: 1_200,
            },
          }, { status: 429 })
        }
        return Response.json(connection({ workspaceId: "ws_limited" }))
      }) as typeof fetch,
    })

    expect(result.workspaceId).toBe("ws_limited")
    expect(calls).toHaveLength(2)
    expect(sleeps).toEqual([1_200])
  })

  test("treats a 429 with a Retry-After header as a provisioning-equivalent wait", async () => {
    const sleeps: number[] = []
    let call = 0
    const result = await openWorkspaceConnection("ws_limited_header", {
      serverUrl: "http://server.test",
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      request: (async () => {
        call += 1
        if (call === 1) {
          return new Response("slow down", { status: 429, headers: { "Retry-After": "2" } })
        }
        return Response.json(connection({ workspaceId: "ws_limited_header" }))
      }) as typeof fetch,
    })

    expect(result.workspaceId).toBe("ws_limited_header")
    expect(sleeps).toEqual([2_000])
  })

  test("treats a 409 cloud_runtime_unavailable with retryAfterMs as a provisioning-equivalent wait", async () => {
    const sleeps: number[] = []
    let call = 0
    const result = await openWorkspaceConnection("ws_unavailable", {
      serverUrl: "http://server.test",
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      request: (async () => {
        call += 1
        if (call === 1) {
          return Response.json({
            error: {
              code: "cloud_runtime_unavailable",
              message: "Cloud workspace runtime is unavailable",
              retryAfterMs: 1_500,
            },
          }, { status: 409 })
        }
        return Response.json(connection({ workspaceId: "ws_unavailable" }))
      }) as typeof fetch,
    })

    expect(result.workspaceId).toBe("ws_unavailable")
    expect(sleeps).toEqual([1_500])
  })

  test("still fails fast on a 409 without a retry signal", async () => {
    await expect(openWorkspaceConnection("ws_conflict_hard", {
      serverUrl: "http://server.test",
      request: (async () => Response.json({
        error: { code: "workspace_backing_conflict", message: "cloud-backed" },
      }, { status: 409 })) as typeof fetch,
    })).rejects.toThrow("Workspace connection failed: 409")
  })

  test("still fails fast on a 429 without any retry signal", async () => {
    await expect(openWorkspaceConnection("ws_limited_hard", {
      serverUrl: "http://server.test",
      request: (async () => new Response("denied", { status: 429 })) as typeof fetch,
    })).rejects.toThrow("Workspace connection failed: 429")
  })

  test("notifies the workspace connection authority when mints resolve or fail", async () => {
    const events: string[] = []
    setWorkspaceConnectionObserver({
      onConnected: (info) => events.push(`connected:${info.workspaceId}:${info.role}`),
      onFailed: (workspaceId) => events.push(`failed:${workspaceId}`),
    })

    await expect(openWorkspaceConnection("ws_outcome", {
      serverUrl: "http://server.test",
      request: (async () => new Response("offline", { status: 409 })) as typeof fetch,
    })).rejects.toThrow("Workspace connection failed: 409")
    expect(events).toEqual(["failed:ws_outcome"])

    // A later successful mint flips it back to connected so the gated UI reopens.
    queryClient.clear()
    await openWorkspaceConnection("ws_outcome", {
      serverUrl: "http://server.test",
      request: (async () => Response.json(connection({ workspaceId: "ws_outcome", role: "editor" }))) as typeof fetch,
    })
    expect(events).toEqual(["failed:ws_outcome", "connected:ws_outcome:editor"])
  })

  test("negative-caches a terminal failure so swarming panes do not re-mint", async () => {
    let calls = 0
    const request = (async () => new Response("forbidden", { status: 403 })) as typeof fetch
    // The shell mounts one pane per open tab; each opens the same workspace
    // connection. A forbidden/conflict mint must be cached for a cooldown so the
    // swarm reuses the rejection instead of re-firing a doomed request (which is
    // what produced the 403/409/429 flood and triggered the rate limiter).
    await expect(openWorkspaceConnection("ws_forbidden", {
      serverUrl: "http://server.test",
      request: (async (...args) => {
        calls += 1
        return request(...(args as Parameters<typeof fetch>))
      }) as typeof fetch,
    })).rejects.toThrow("Workspace connection failed: 403")

    await expect(openWorkspaceConnection("ws_forbidden", {
      serverUrl: "http://server.test",
      request: (async (...args) => {
        calls += 1
        return request(...(args as Parameters<typeof fetch>))
      }) as typeof fetch,
    })).rejects.toThrow("Workspace connection failed: 403")

    expect(calls).toBe(1)
  })

  test("does not negative-cache startup 401s without explicit control-plane auth headers", async () => {
    let calls = 0
    const request = (async () => {
      calls += 1
      if (calls === 1) return new Response("auth not ready", { status: 401 })
      return Response.json(connection({ workspaceId: "ws_auth_ready" }))
    }) as typeof fetch

    await expect(openWorkspaceConnection("ws_auth_ready", {
      serverUrl: "http://server.test",
      request,
    })).rejects.toThrow("Workspace connection failed: 401")

    const result = await openWorkspaceConnection("ws_auth_ready", {
      serverUrl: "http://server.test",
      request,
    })

    expect(result.workspaceId).toBe("ws_auth_ready")
    expect(calls).toBe(2)
  })

  test("negative-caches explicit unauthorized control-plane opens", async () => {
    let calls = 0
    const request = (async () => {
      calls += 1
      return new Response("unauthorized", { status: 401 })
    }) as typeof fetch

    await expect(openWorkspaceConnection("ws_bad_auth", {
      serverUrl: "http://server.test",
      request,
      headers: { Authorization: "Bearer stale-token" },
    })).rejects.toThrow("Workspace connection failed: 401")
    await expect(openWorkspaceConnection("ws_bad_auth", {
      serverUrl: "http://server.test",
      request,
      headers: { Authorization: "Bearer stale-token" },
    })).rejects.toThrow("Workspace connection failed: 401")

    expect(calls).toBe(1)
  })

  test("429 retries stay within the bounded provisioning attempt budget", async () => {
    const sleeps: number[] = []
    let calls = 0
    await expect(openWorkspaceConnection("ws_limited_forever", {
      serverUrl: "http://server.test",
      provisioningMaxAttempts: 2,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      request: (async () => {
        calls += 1
        return Response.json({
          error: { code: "runtime_access_token_rate_limited", message: "limited", retryAfterMs: 600 },
        }, { status: 429 })
      }) as typeof fetch,
    })).rejects.toThrow("Workspace runtime is still provisioning")

    expect(calls).toBe(2)
    expect(sleeps).toEqual([600, 600])
  })

  test("stops retrying provider-neutral provisioning responses after the configured attempt cap", async () => {
    const calls: string[] = []
    const sleeps: number[] = []

    await expect(openWorkspaceConnection("ws_still_cold", {
      serverUrl: "http://server.test",
      provisioningMaxAttempts: 2,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      request: (async (url) => {
        calls.push(requestUrl(url))
        return Response.json({
          status: "provisioning",
          workspaceId: "ws_still_cold",
          runtimeKind: "cloud",
          homeRegion: "us-east",
          retryAfterMs: 750,
        })
      }) as typeof fetch,
    })).rejects.toThrow("Workspace runtime is still provisioning")

    expect(calls).toEqual([
      "http://server.test/api/workspace/ws_still_cold/connection",
      "http://server.test/api/workspace/ws_still_cold/connection",
    ])
    expect(sleeps).toEqual([750, 750])
  })

  test("rejects connection info without a workspace role", async () => {
    await expect(openWorkspaceConnection("ws_missing_role", {
      serverUrl: "http://server.test",
      request: (async () => Response.json({
        access: "cloud",
        backing: "cloud-vm",
        workspaceId: "ws_missing_role",
        relayUrl: "https://relay.example.test",
        runtimeAccessToken: token("jti_1"),
        tokenExpiresAt: Date.now() + 30 * 60_000,
      })) as typeof fetch,
    })).rejects.toThrow("Invalid workspace connection role")
  })

  test("refresh sends the previous JWT id when available", async () => {
    const bodies: string[] = []
    const result = await refreshWorkspaceConnection(connection(), {
      serverUrl: "http://server.test",
      request: (async (_url, init) => {
        bodies.push(typeof init?.body === "string" ? init.body : "")
        return Response.json(connection({ runtimeAccessToken: token("jti_2") }))
      }) as typeof fetch,
    })

    expect(runtimeAccessTokenJti(result.runtimeAccessToken)).toBe("jti_2")
    expect(bodies).toEqual([JSON.stringify({ previousJti: "jti_1" })])
  })

  test("refresh retries provider-neutral provisioning responses until ready", async () => {
    const bodies: string[] = []
    const sleeps: number[] = []
    const result = await refreshWorkspaceConnection(connection({ workspaceId: "ws_refreshing" }), {
      serverUrl: "http://server.test",
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      request: (async (_url, init) => {
        bodies.push(typeof init?.body === "string" ? init.body : "")
        if (bodies.length === 1) {
          return Response.json({
            status: "provisioning",
            workspaceId: "ws_refreshing",
            runtimeKind: "cloud",
            homeRegion: "us-east",
            retryAfterMs: 750,
          })
        }
        return Response.json(connection({ workspaceId: "ws_refreshing", runtimeAccessToken: token("jti_ready") }))
      }) as typeof fetch,
    })

    expect(result.workspaceId).toBe("ws_refreshing")
    expect(runtimeAccessTokenJti(result.runtimeAccessToken)).toBe("jti_ready")
    expect(bodies).toEqual([
      JSON.stringify({ previousJti: "jti_1" }),
      JSON.stringify({ previousJti: "jti_1" }),
    ])
    expect(sleeps).toEqual([750])
  })

  test("decodes runtime access token role beside jti", () => {
    expect(runtimeAccessTokenJti(token("jti_role", { role: "editor" }))).toBe("jti_role")
    expect(runtimeAccessTokenRole(token("jti_role", { role: "editor" }))).toBe("editor")
    expect(runtimeAccessTokenRole(token("jti_invalid", { role: "guest" }))).toBeUndefined()
    expect(runtimeAccessTokenRole("not-a-jwt")).toBeUndefined()
  })

  test("refreshes before expiry and retries once after a relay 401", async () => {
    const requests: Array<{ url: string; auth: string | null; redirect?: RequestRedirect }> = []
    const observerEvents: string[] = []
    setWorkspaceConnectionObserver({
      onConnected: (info) => observerEvents.push(`${info.workspaceId}:${info.role}:${runtimeAccessTokenJti(info.runtimeAccessToken)}`),
      onFailed: (workspaceId) => observerEvents.push(`failed:${workspaceId}`),
    })
    const request = (async (url, init) => {
      const req = new Request(requestUrl(url), init)
      requests.push({ url: req.url, auth: req.headers.get("Authorization"), redirect: init?.redirect })
      if (req.url.includes("/connection/refresh")) {
        return Response.json(connection({
          role: requests.length === 1 ? "viewer" : "editor",
          runtimeAccessToken: token(requests.length === 1 ? "new" : "newer"),
          tokenExpiresAt: 10_000,
        }))
      }
      return new Response("ok", { status: requests.length === 2 ? 401 : 200 })
    }) as typeof fetch
    const transport = createWorkspaceRelayConnection(connection({
      runtimeAccessToken: token("old"),
      tokenExpiresAt: 1_000,
    }), {
      serverUrl: "http://server.test",
      now: () => 1_000,
      request,
      relayRequest: request,
    })

    const res = await transport.fetch("/api/wr/health")

    expect(res.status).toBe(200)
    expect(requests.map((item) => item.url)).toEqual([
      "http://server.test/api/workspace/ws_1/connection/refresh",
      "https://relay.example.test/workspaces/ws_1/api/wr/health",
      "http://server.test/api/workspace/ws_1/connection/refresh",
      "https://relay.example.test/workspaces/ws_1/api/wr/health",
    ])
    expect(requests[1].auth).toBe(`Bearer ${token("new")}`)
    expect(requests[3].auth).toBe(`Bearer ${token("newer")}`)
    expect(requests[1].redirect).toBe("manual")
    expect(requests[3].redirect).toBe("manual")
    expect(observerEvents).toEqual(["ws_1:viewer:new", "ws_1:editor:newer"])
  })

  test("opens relay WebSockets with a fresh Runtime Access Token subprotocol", async () => {
    const sockets: Array<{ url: string; protocols: string[] }> = []
    class FakeWebSocket extends EventTarget implements WebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSING = 2
      readonly CLOSED = 3
      binaryType: BinaryType = "blob"
      readonly bufferedAmount = 0
      readonly extensions = ""
      readonly protocol = ""
      readonly readyState = 1
      readonly url: string
      onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null
      onerror: ((this: WebSocket, ev: Event) => unknown) | null = null
      onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null
      onopen: ((this: WebSocket, ev: Event) => unknown) | null = null

      constructor(url: string | URL, protocols?: string | string[]) {
        super()
        this.url = requestUrl(url)
        sockets.push({ url: this.url, protocols: Array.isArray(protocols) ? protocols : protocols ? [protocols] : [] })
      }

      close() {}

      send() {}
    }
    const transport = createWorkspaceRelayConnection(connection({
      runtimeAccessToken: token("old"),
      tokenExpiresAt: 1_000,
    }), {
      serverUrl: "http://server.test",
      now: () => 1_000,
      webSocket: FakeWebSocket,
      request: (async (url) => {
        expect(requestUrl(url)).toBe("http://server.test/api/workspace/ws_1/connection/refresh")
        return Response.json(connection({
          runtimeAccessToken: token("new"),
          tokenExpiresAt: 10_000,
        }))
      }) as typeof fetch,
    })

    await transport.webSocket("/api/wr/pty/pty_1/connect", ["pty.v1"])

    expect(sockets).toEqual([{
      url: "wss://relay.example.test/workspaces/ws_1/api/wr/pty/pty_1/connect",
      protocols: [runtimeAccessTokenProtocol(token("new")), "pty.v1"],
    }])
  })
})
