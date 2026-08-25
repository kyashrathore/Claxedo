import { afterEach, describe, expect, mock, test } from "bun:test"
import {
  resolveWorkspaceRuntime,
  cachedWorkspaceRuntimeRecord,
  workspaceResolveQuery,
  workspaceRuntimeBlocksBootstrap,
  workspaceRuntimeRoutingRecord,
} from "./workspace-runtime-record"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"

// happy-dom's preloaded window must survive this suite: deleting it without
// restoring poisons whichever test file shares the process afterwards
// (e.g. agent-runtime-client.test.ts hits "window is not defined").
const preloadedWindow = (globalThis as typeof globalThis & { window?: unknown }).window

afterEach(() => {
  queryClient.clear()
  delete (globalThis as typeof globalThis & { __claxedoFastSessionSwitch?: unknown }).__claxedoFastSessionSwitch
  ;(globalThis as typeof globalThis & { window?: unknown }).window = preloadedWindow
})

function requestUrl(input: Parameters<typeof fetch>[0]) {
  if (input instanceof Request) return input.url
  return input.toString()
}

describe("workspace runtime record", () => {
  test("workspaceRuntimeBlocksBootstrap only while cloud runtime is still pending", () => {
    expect(workspaceRuntimeBlocksBootstrap()).toBe(false)
    expect(workspaceRuntimeBlocksBootstrap({ workspaceId: "ws", kind: "local" })).toBe(false)
    expect(workspaceRuntimeBlocksBootstrap({ workspaceId: "ws", kind: "cloud", status: "ready" })).toBe(false)
    expect(workspaceRuntimeBlocksBootstrap({ workspaceId: "ws", kind: "cloud", status: "failed" })).toBe(false)
    expect(workspaceRuntimeBlocksBootstrap({ workspaceId: "ws", kind: "cloud", status: "starting_runtime" })).toBe(true)
    expect(workspaceRuntimeBlocksBootstrap({ workspaceId: "ws", kind: "cloud", status: "stopped" })).toBe(true)
  })

  test("builds a directory-scoped resolve query", async () => {
    const request: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init)
      expect(req.url).toBe("http://runtime.test/api/workspace/resolve?directory=%2Ftmp%2Fws")
      return new Response(JSON.stringify({
        workspaceId: "ws_1",
        directory: "/tmp/ws",
        kind: "cloud",
        status: "stopped",
      }), { status: 200 })
    }

    const query = workspaceResolveQuery({
      baseUrl: "http://runtime.test/",
      request,
      directory: "/tmp/ws",
    })

    expect(query.queryKey).toEqual(["runtime", "http://runtime.test", "workspace", "", "/tmp/ws", "read"])
    expect(await query.queryFn()).toMatchObject({
      workspaceId: "ws_1",
      kind: "cloud",
      status: "stopped",
    })
  })

  test("the resolve query returns null on missing workspaces", async () => {
    const query = workspaceResolveQuery({
      baseUrl: "http://runtime.test",
      request: async () => new Response("missing", { status: 404 }),
      workspaceId: "ws_missing",
    })

    expect(await query.queryFn()).toBeNull()
  })

  test("the resolve query throws rather than caching a fake null for a transient failure", async () => {
    const query = workspaceResolveQuery({
      baseUrl: "http://runtime.test",
      request: async () => new Response("upstream exploded", { status: 503 }),
      directory: "/tmp/ws",
    })

    expect(query.queryFn()).rejects.toThrow("upstream exploded")
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

  test("a routing read never refetches on elapsed time; a liveness read does", async () => {
    const request: typeof fetch = mock(async () => new Response(JSON.stringify({
      workspaceId: "ws_1",
      kind: "cloud",
      status: "ready",
    }), { status: 200 }))
    const scope = { baseUrl: "http://runtime.test", request, directory: "/tmp/ws" }

    await workspaceRuntimeRoutingRecord(scope)
    expect(request).toHaveBeenCalledTimes(1)

    // Age the entry past every freshness window the record has.
    const key = queryKeys.runtime.workspace({ baseUrl: scope.baseUrl, directory: scope.directory })
    const state = queryClient.getQueryCache().find({ queryKey: key })!.state as { dataUpdatedAt: number }
    state.dataUpdatedAt = Date.now() - 60_000

    // Routing identity cannot have changed, so there is nothing to ask for.
    await workspaceRuntimeRoutingRecord(scope)
    expect(request).toHaveBeenCalledTimes(1)

    // Liveness can have changed, so the same entry is revalidated.
    await resolveWorkspaceRuntime(scope)
    expect(request).toHaveBeenCalledTimes(2)
  })

  test("a routing read still refetches once the record is invalidated", async () => {
    const request: typeof fetch = mock(async () => new Response(JSON.stringify({
      workspaceId: "ws_1",
      kind: "cloud",
      status: "ready",
    }), { status: 200 }))
    const scope = { baseUrl: "http://runtime.test", request, directory: "/tmp/ws" }

    await workspaceRuntimeRoutingRecord(scope)
    await workspaceRuntimeRoutingRecord(scope)
    expect(request).toHaveBeenCalledTimes(1)

    // Creating or re-homing a workspace invalidates this key (`ensureProject`).
    // An invalidated entry is stale whatever its staleTime says -- otherwise
    // "never expires" would mean "never correct again".
    await queryClient.invalidateQueries({
      queryKey: queryKeys.runtime.workspace({ baseUrl: scope.baseUrl, directory: scope.directory }),
    })
    await workspaceRuntimeRoutingRecord(scope)
    expect(request).toHaveBeenCalledTimes(2)
  })

  test("cachedWorkspaceRuntimeRecord answers from the shared entry and never requests", async () => {
    const request: typeof fetch = mock(async () => new Response(JSON.stringify({
      workspaceId: "ws_1",
      kind: "cloud",
      status: "ready",
    }), { status: 200 }))
    const scope = { baseUrl: "http://runtime.test", request, directory: "/tmp/ws" }

    // Nothing cached yet: a warm-up caller learns that without a round trip.
    expect(cachedWorkspaceRuntimeRecord(scope)).toBeUndefined()
    expect(request).not.toHaveBeenCalled()

    await workspaceRuntimeRoutingRecord(scope)
    expect(request).toHaveBeenCalledTimes(1)

    // Same entry the routing read populated -- one record, one cache key.
    expect(cachedWorkspaceRuntimeRecord(scope)).toMatchObject({ workspaceId: "ws_1" })
    expect(request).toHaveBeenCalledTimes(1)
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
})
