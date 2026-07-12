import { afterEach, describe, expect, mock, test } from "bun:test"
import {
  appendWorkspaceRuntimeLog,
  prepareUserHostedRuntime,
  prepareWorkspaceRuntime,
  resetWorkspaceRuntimeEnsureCache,
  resolveWorkspaceRuntime,
  workspaceRuntimeEnsureQueryKey,
  workspaceRuntimeBlocksBootstrap,
  type WorkspaceProvisionEvent,
} from "./workspace-runtime-store"
import { queryClient } from "@/platform/query/query-client"

// happy-dom's preloaded window must survive this suite: deleting it without
// restoring poisons whichever test file shares the process afterwards
// (e.g. agent-runtime-client.test.ts hits "window is not defined").
const preloadedWindow = (globalThis as typeof globalThis & { window?: unknown }).window

afterEach(() => {
  queryClient.clear()
  resetWorkspaceRuntimeEnsureCache()
  delete (globalThis as typeof globalThis & { __claxedoFastSessionSwitch?: unknown }).__claxedoFastSessionSwitch
  ;(globalThis as typeof globalThis & { window?: unknown }).window = preloadedWindow
})

function requestUrl(input: Parameters<typeof fetch>[0]) {
  if (input instanceof Request) return input.url
  return input.toString()
}

function connectionBody(workspaceId: string) {
  return {
    access: "cloud",
    backing: "cloud-vm",
    runtimeKind: "cloud",
    workspaceId,
    role: "owner",
    relayUrl: "http://relay.test",
    runtimeAccessToken: "rat-test-token",
    tokenExpiresAt: Date.now() + 3_600_000,
  }
}

describe("workspace runtime helpers", () => {
  test("workspaceRuntimeBlocksBootstrap only while cloud runtime is still pending", () => {
    expect(workspaceRuntimeBlocksBootstrap()).toBe(false)
    expect(workspaceRuntimeBlocksBootstrap({ workspaceId: "ws", kind: "local" })).toBe(false)
    expect(workspaceRuntimeBlocksBootstrap({ workspaceId: "ws", kind: "cloud", status: "ready" })).toBe(false)
    expect(workspaceRuntimeBlocksBootstrap({ workspaceId: "ws", kind: "cloud", status: "failed" })).toBe(false)
    expect(workspaceRuntimeBlocksBootstrap({ workspaceId: "ws", kind: "cloud", status: "starting_runtime" })).toBe(true)
    expect(workspaceRuntimeBlocksBootstrap({ workspaceId: "ws", kind: "cloud", status: "stopped" })).toBe(true)
  })

  test("appendWorkspaceRuntimeLog avoids duplicate rows", () => {
    const first = appendWorkspaceRuntimeLog([], "stopped", "Waking workspace runtime...", 12, 1)
    expect(first).toEqual([{ step: "stopped", message: "Waking workspace runtime...", ts: 1, totalMs: 12 }])
    expect(appendWorkspaceRuntimeLog(first, "stopped", "Waking workspace runtime...", 12, 2)).toBe(first)
  })

  test("resolveWorkspaceRuntime uses the shared query cache", async () => {
    const request: typeof fetch = mock(async () => new Response(JSON.stringify({
      workspaceId: "ws_1",
      kind: "cloud",
      status: "ready",
    }), { status: 200 }))

    const first = await resolveWorkspaceRuntime({
      baseUrl: "http://runtime.test",
      request,
      directory: "/tmp/ws",
    })
    const second = await resolveWorkspaceRuntime({
      baseUrl: "http://runtime.test",
      request,
      directory: "/tmp/ws",
    })

    expect(first).toMatchObject({ workspaceId: "ws_1", status: "ready" })
    expect(second).toMatchObject({ workspaceId: "ws_1", status: "ready" })
    expect(request).toHaveBeenCalledTimes(1)
  })

  test("resolveWorkspaceRuntime skips uncached directory resolve during fast session switch quiet", async () => {
    ;(globalThis as typeof globalThis & {
      window?: {
        __claxedoFastSessionSwitch?: { sessionId: string; until: number; networkQuietUntil?: number }
      }
    }).window = {
      __claxedoFastSessionSwitch: {
        sessionId: "ses_next",
        until: Date.now() + 250,
        networkQuietUntil: Date.now() + 2_000,
      },
    }
    const request: typeof fetch = mock(async () => new Response(JSON.stringify({
      workspaceId: "ws_1",
      kind: "local",
      status: "ready",
    }), { status: 200 }))

    const result = await resolveWorkspaceRuntime({
      baseUrl: "http://runtime.test",
      request,
      directory: "/tmp/ws",
    })

    expect(result).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  test("resolveWorkspaceRuntime normalizes legacy workspace directory selectors", async () => {
    const calls: string[] = []
    const request: typeof fetch = mock(async (input) => {
      calls.push(requestUrl(input))
      return new Response(JSON.stringify({
        workspaceId: "ws_1",
        kind: "cloud",
        status: "ready",
      }), { status: 200 })
    })

    await resolveWorkspaceRuntime({
      baseUrl: "http://runtime.test",
      request,
      directory: "workspace:ws_1",
    })
    await resolveWorkspaceRuntime({
      baseUrl: "http://runtime.test",
      request,
      directory: "ws_2",
    })

    expect(calls).toEqual([
      "http://runtime.test/api/workspace/resolve?workspaceId=ws_1",
      "http://runtime.test/api/workspace/resolve?workspaceId=ws_2",
    ])
  })

  test("prepareWorkspaceRuntime reuses resolve and streams startup progress", async () => {
    const request: typeof fetch = mock(async (input, init) => {
      const url = requestUrl(input)
      if (url === "http://runtime.test/api/workspace/resolve?directory=%2Ftmp%2Fcloud") {
        return new Response(JSON.stringify({
          workspaceId: "ws_cloud",
          kind: "cloud",
          status: "stopped",
        }), { status: 200 })
      }
      if (url === "http://runtime.test/api/workspace/resolve?workspaceId=ws_cloud") {
        return new Response(JSON.stringify({
          workspaceId: "ws_cloud",
          kind: "cloud",
          status: "ready",
        }), { status: 200 })
      }
      if (url === "http://runtime.test/api/workspace/ws_cloud/connection") {
        return new Response(JSON.stringify(connectionBody("ws_cloud")), { status: 200 })
      }
      throw new Error(`unexpected request: ${url} ${init?.method ?? "GET"}`)
    })
    const logs: string[] = []
    const provision: WorkspaceProvisionEvent = {
      type: "provision",
      workspaceId: "ws_cloud",
      step: "starting_runtime",
      message: "booting runtime",
      totalMs: 42,
      ts: 9,
    }

    const result = await prepareWorkspaceRuntime({
      directory: "/tmp/cloud",
      baseUrl: "http://runtime.test",
      request,
      events: {
        on: (_type: "provision", handler: (event: WorkspaceProvisionEvent) => void) => {
          handler(provision)
          return () => undefined
        },
        connected: () => true,
      },
      onLog: (log) => {
        logs.push(`${log.step}:${log.message ?? ""}`)
      },
    })

    expect(result).toMatchObject({ ok: true, startup: true })
    expect(logs).toEqual([
      "stopped:Waking workspace runtime...",
      "starting_runtime:booting runtime",
      "ready:",
    ])
  })

  test("prepareWorkspaceRuntime coalesces duplicate workspace ensure calls", async () => {
    let ensureCalls = 0
    const request: typeof fetch = mock(async (input, init) => {
      const url = requestUrl(input)
      if (url === "http://runtime.test/api/workspace/resolve?directory=%2Ftmp%2Fcloud") {
        return new Response(JSON.stringify({
          workspaceId: "ws_cloud",
          kind: "cloud",
          status: "stopped",
        }), { status: 200 })
      }
      if (url === "http://runtime.test/api/workspace/resolve?workspaceId=ws_cloud") {
        return new Response(JSON.stringify({
          workspaceId: "ws_cloud",
          kind: "cloud",
          status: "ready",
        }), { status: 200 })
      }
      if (url === "http://runtime.test/api/workspace/ws_cloud/connection") {
        ensureCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        return new Response(JSON.stringify(connectionBody("ws_cloud")), { status: 200 })
      }
      throw new Error(`unexpected request: ${url} ${init?.method ?? "GET"}`)
    })

    const [first, second] = await Promise.all([
      prepareWorkspaceRuntime({
        directory: "/tmp/cloud",
        baseUrl: "http://runtime.test",
        request,
      }),
      prepareWorkspaceRuntime({
        directory: "/tmp/cloud",
        baseUrl: "http://runtime.test",
        request,
      }),
    ])

    expect(first).toMatchObject({ ok: true, startup: true })
    expect(second).toMatchObject({ ok: true, startup: true })
    expect(ensureCalls).toBe(1)
    expect(queryClient.getQueryData<unknown>(workspaceRuntimeEnsureQueryKey({
      baseUrl: "http://runtime.test",
      workspaceId: "ws_cloud",
    }))).toMatchObject({
      workspaceId: "ws_cloud",
      status: "ready",
    })
  })

  test("prepareWorkspaceRuntime reuses fresh workspace ensure query data", async () => {
    let ensureCalls = 0
    const request: typeof fetch = mock(async (input, init) => {
      const url = requestUrl(input)
      if (url === "http://runtime.test/api/workspace/resolve?directory=%2Ftmp%2Fcloud") {
        return new Response(JSON.stringify({
          workspaceId: "ws_cloud",
          kind: "cloud",
          status: "stopped",
        }), { status: 200 })
      }
      if (url === "http://runtime.test/api/workspace/resolve?workspaceId=ws_cloud") {
        return new Response(JSON.stringify({
          workspaceId: "ws_cloud",
          kind: "cloud",
          status: "ready",
        }), { status: 200 })
      }
      if (url === "http://runtime.test/api/workspace/ws_cloud/connection") {
        ensureCalls += 1
        return new Response(JSON.stringify(connectionBody("ws_cloud")), { status: 200 })
      }
      throw new Error(`unexpected request: ${url} ${init?.method ?? "GET"}`)
    })

    await prepareWorkspaceRuntime({
      directory: "/tmp/cloud",
      baseUrl: "http://runtime.test",
      request,
    })
    await prepareWorkspaceRuntime({
      directory: "/tmp/cloud",
      baseUrl: "http://runtime.test",
      request,
    })

    expect(ensureCalls).toBe(1)

    resetWorkspaceRuntimeEnsureCache()

    await prepareWorkspaceRuntime({
      directory: "/tmp/cloud",
      baseUrl: "http://runtime.test",
      request,
    })

    expect(ensureCalls).toBe(2)
  })
})

function userHostedConnectionBody(workspaceId: string) {
  return {
    access: "user-hosted",
    backing: "local-worktree",
    runtimeKind: "user-hosted",
    workspaceId,
    role: "owner",
    relayUrl: "https://relay.uh.test",
    runtimeAccessToken: "rat-uh-token",
    tokenExpiresAt: Date.now() + 3_600_000,
  }
}

describe("prepareUserHostedRuntime", () => {
  test("mints the relay connection, probes health through the relay, and reports ready", async () => {
    const seen: string[] = []
    const healthHeaders: string[] = []
    const request: typeof fetch = mock(async (input, init) => {
      const url = requestUrl(input)
      seen.push(url)
      if (url === "https://control.test/api/workspace/ws_uh_ready/connection") {
        return new Response(JSON.stringify(userHostedConnectionBody("ws_uh_ready")), { status: 200 })
      }
      if (url === "https://relay.uh.test/workspaces/ws_uh_ready/api/wr/health") {
        healthHeaders.push(new Headers(init?.headers).get("x-fetch-bypass-throttle") ?? "")
        return new Response(JSON.stringify({ status: "ready" }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const logs: string[] = []
    const result = await prepareUserHostedRuntime({
      workspaceId: "ws_uh_ready",
      baseUrl: "https://control.test",
      request,
      onLog: (log) => logs.push(log.step),
    })
    expect(result).toMatchObject({ ok: true, status: "ready" })
    // The health probe went through the relay (NOT a central /workspaces URL).
    expect(seen).toContain("https://relay.uh.test/workspaces/ws_uh_ready/api/wr/health")
    expect(healthHeaders).toEqual(["1"])
    expect(seen.some((u) => u === "https://control.test/workspaces/ws_uh_ready/api/wr/health")).toBe(false)
    // The connecting sequence is the user-hosted set, NOT cloud sandbox steps.
    expect(logs).toEqual(["connecting_workspace", "establishing_relay", "checking_health", "ready"])
    expect(logs).not.toContain("acquiring_sandbox")
  })

  test("reports offline after retrying when the relay stays 503 user_hosted_app_offline", async () => {
    let probes = 0
    const request: typeof fetch = mock(async (input) => {
      const url = requestUrl(input)
      if (url === "https://control.test/api/workspace/ws_uh_offline/connection") {
        return new Response(JSON.stringify(userHostedConnectionBody("ws_uh_offline")), { status: 200 })
      }
      if (url === "https://relay.uh.test/workspaces/ws_uh_offline/api/wr/health") {
        probes += 1
        return new Response(JSON.stringify({ error: { code: "user_hosted_app_offline" } }), { status: 503 })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const logs: string[] = []
    const result = await prepareUserHostedRuntime({
      workspaceId: "ws_uh_offline",
      baseUrl: "https://control.test",
      request,
      maxHealthAttempts: 3,
      delay: async () => {},
      onLog: (log) => logs.push(log.step),
    })
    expect(result.ok).toBe(false)
    expect(result.offline).toBe(true)
    expect(result.message).toContain("Workspace host is offline")
    expect(result.message).toContain("claxedo up")
    expect(logs.at(-1)).toBe("error")
    // Persistent offline is retried across the presence-registration window.
    expect(probes).toBe(3)
  })

  test("recovers to ready when a transient 409 clears on a later health probe", async () => {
    let probes = 0
    const request: typeof fetch = mock(async (input) => {
      const url = requestUrl(input)
      if (url === "https://control.test/api/workspace/ws_uh_flaky/connection") {
        return new Response(JSON.stringify(userHostedConnectionBody("ws_uh_flaky")), { status: 200 })
      }
      if (url === "https://relay.uh.test/workspaces/ws_uh_flaky/api/wr/health") {
        probes += 1
        // First two probes hit the DO presence-registration gap (409), then ready.
        if (probes < 3) {
          return new Response(JSON.stringify({ error: { code: "relay_resolver_workspace_target_unavailable" } }), { status: 409 })
        }
        return new Response(JSON.stringify({ status: "ready" }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const result = await prepareUserHostedRuntime({
      workspaceId: "ws_uh_flaky",
      baseUrl: "https://control.test",
      request,
      maxHealthAttempts: 5,
      delay: async () => {},
    })
    expect(result).toMatchObject({ ok: true, status: "ready" })
    expect(probes).toBe(3)
  })

  test("signals offline on the first presence miss while continuing retries", async () => {
    let probes = 0
    const request: typeof fetch = mock(async (input) => {
      const url = requestUrl(input)
      if (url === "https://control.test/api/workspace/ws_uh_fast_offline/connection") {
        return new Response(JSON.stringify(userHostedConnectionBody("ws_uh_fast_offline")), { status: 200 })
      }
      if (url === "https://relay.uh.test/workspaces/ws_uh_fast_offline/api/wr/health") {
        probes += 1
        if (probes === 1) {
          return new Response(JSON.stringify({ error: { code: "relay_resolver_workspace_target_unavailable" } }), { status: 409 })
        }
        return new Response(JSON.stringify({ status: "ready" }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const offlineSignals: string[] = []
    const result = await prepareUserHostedRuntime({
      workspaceId: "ws_uh_fast_offline",
      baseUrl: "https://control.test",
      request,
      maxHealthAttempts: 3,
      delay: async () => {},
      onOffline: (next) => offlineSignals.push(next.message),
    })

    expect(offlineSignals).toHaveLength(1)
    expect(offlineSignals[0]).toContain("Workspace host is offline")
    expect(result).toMatchObject({ ok: true, status: "ready" })
    expect(probes).toBe(2)
  })

  test("times out a hung health probe and retries, then recovers to ready", async () => {
    let probes = 0
    const request: typeof fetch = mock(async (input, init) => {
      const url = requestUrl(input)
      if (url === "https://control.test/api/workspace/ws_uh_hang/connection") {
        return new Response(JSON.stringify(userHostedConnectionBody("ws_uh_hang")), { status: 200 })
      }
      if (url === "https://relay.uh.test/workspaces/ws_uh_hang/api/wr/health") {
        probes += 1
        // First probe hangs until its AbortController fires, then ready.
        if (probes < 2) {
          return await new Promise<Response>((_resolve, reject) => {
            const signal = (init as RequestInit | undefined)?.signal
            signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
          })
        }
        return new Response(JSON.stringify({ status: "ready" }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const result = await prepareUserHostedRuntime({
      workspaceId: "ws_uh_hang",
      baseUrl: "https://control.test",
      request,
      maxHealthAttempts: 4,
      healthTimeoutMs: 30,
      delay: async () => {},
    })
    expect(result).toMatchObject({ ok: true, status: "ready" })
    expect(probes).toBe(2)
  })

  test("fails fast (no retry) on a non-transient runtime error", async () => {
    let probes = 0
    const request: typeof fetch = mock(async (input) => {
      const url = requestUrl(input)
      if (url === "https://control.test/api/workspace/ws_uh_err/connection") {
        return new Response(JSON.stringify(userHostedConnectionBody("ws_uh_err")), { status: 200 })
      }
      if (url === "https://relay.uh.test/workspaces/ws_uh_err/api/wr/health") {
        probes += 1
        return new Response("boom", { status: 500 })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const result = await prepareUserHostedRuntime({
      workspaceId: "ws_uh_err",
      baseUrl: "https://control.test",
      request,
      maxHealthAttempts: 5,
      delay: async () => {},
    })
    expect(result.ok).toBe(false)
    expect(result.offline).not.toBe(true)
    // A 500 is not a presence gap — surface it immediately without burning retries.
    expect(probes).toBe(1)
  })

  test("reports offline when the connection mint itself fails", async () => {
    const request: typeof fetch = mock(async (input) => {
      const url = requestUrl(input)
      if (url === "https://control.test/api/workspace/ws_uh_mintfail/connection") {
        return new Response("forbidden", { status: 403 })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const result = await prepareUserHostedRuntime({
      workspaceId: "ws_uh_mintfail",
      baseUrl: "https://control.test",
      request,
      maxHealthAttempts: 1,
      delay: async () => {},
    })
    // A failed mint surfaces a non-ok result (relay seam maps it to a Response,
    // which is non-2xx → error). The caller can render the connect-failure UI.
    expect(result.ok).toBe(false)
  })
})
