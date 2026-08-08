import { afterEach, describe, expect, mock, test } from "bun:test"
import { resolveWorkspaceRuntime, workspaceRuntimeBlocksBootstrap } from "./workspace-runtime-record"
import { queryClient } from "@/platform/query/query-client"

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
})
