import { afterEach, describe, expect, mock, test } from "bun:test"
import {
  appendWorkspaceRuntimeLog,
  prepareWorkspaceRuntime,
  resolveWorkspaceRuntime,
  workspaceRuntimeBlocksBootstrap,
  workspaceRuntimePhase,
} from "./workspace-runtime-store"
import { queryClient } from "../../shared/query/query-client"

afterEach(() => queryClient.clear())

describe("workspace runtime helpers", () => {
  test("workspaceRuntimePhase maps cloud states", () => {
    expect(workspaceRuntimePhase()).toBe("unknown")
    expect(workspaceRuntimePhase({ workspaceId: "ws", kind: "local" })).toBe("ready")
    expect(workspaceRuntimePhase({ workspaceId: "ws", kind: "cloud", status: "stopped" })).toBe("stopped")
    expect(workspaceRuntimePhase({ workspaceId: "ws", kind: "cloud", status: "ready" })).toBe("ready")
    expect(workspaceRuntimePhase({ workspaceId: "ws", kind: "cloud", status: "failed" })).toBe("failed")
  })

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
    const request = mock(async () => new Response(JSON.stringify({
      workspaceId: "ws_1",
      kind: "cloud",
      status: "ready",
    }), { status: 200 })) as unknown as typeof fetch

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

  test("prepareWorkspaceRuntime reuses resolve and streams startup progress", async () => {
    const request = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === "http://runtime.test/api/workspace/resolve?directory=%2Ftmp%2Fcloud") {
        return new Response(JSON.stringify({
          workspaceId: "ws_cloud",
          kind: "cloud",
          status: "stopped",
        }), { status: 200 })
      }
      if (url === "http://runtime.test/api/workspace/ensure" && init?.method === "POST") {
        return new Response(JSON.stringify({
          workspaceId: "ws_cloud",
          kind: "cloud",
          status: "ready",
        }), { status: 200 })
      }
      throw new Error(`unexpected request: ${url}`)
    }) as unknown as typeof fetch
    const logs: string[] = []

    const result = await prepareWorkspaceRuntime({
      directory: "/tmp/cloud",
      baseUrl: "http://runtime.test",
      request,
      events: {
        on: (_type, handler) => {
          handler({
            type: "provision",
            workspaceId: "ws_cloud",
            step: "starting_runtime",
            message: "booting runtime",
            totalMs: 42,
            ts: 9,
          } as any)
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
})
