import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const ensureWorkspaceRuntime = vi.fn()
const holdRuntime = vi.fn()
const markRuntimeUse = vi.fn()
const releaseRuntime = vi.fn()
const getSandbox = vi.fn()
const resolveWorkspace = vi.fn()
const opencodeHeaders = vi.fn((headers?: HeadersInit) => new Headers(headers))
const resolveRunnerHostForRequest = vi.fn()

vi.mock("./workspace-supervisor", () => ({
  ensureWorkspaceRuntime,
  holdRuntime,
  markRuntimeUse,
  releaseRuntime,
  getSandbox,
}))

vi.mock("./workspace-store", () => ({
  resolveWorkspace,
}))

vi.mock("./opencode-auth", () => ({
  opencodeHeaders,
}))

vi.mock("./runner-resolution", () => ({
  resolveRunnerHostForRequest,
}))

import { workspaceRuntimeProxy } from "./proxy"

function context(url: string) {
  const raw = new Request(url)
  return {
    req: {
      url,
      method: raw.method,
      raw,
      query(name: string) {
        return new URL(url).searchParams.get(name) ?? undefined
      },
      header(name: string) {
        return raw.headers.get(name) ?? undefined
      },
    },
    json(body: unknown, status: number) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
    },
  } as any
}

describe("workspaceRuntimeProxy startup wait", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveRunnerHostForRequest.mockResolvedValue("workspace")
    resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      kind: "cloud",
      directory: "/tmp/demo",
      remote_directory: "/workspace",
    })
    getSandbox.mockReturnValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  test("does not fail early while the runtime is still starting", async () => {
    let ready!: (value: { url: string }) => void
    ensureWorkspaceRuntime.mockReturnValue(new Promise((resolve) => {
      ready = resolve
    }))
    globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch

    const resPromise = workspaceRuntimeProxy(
      context("http://localhost/file/status?directory=%2Ftmp%2Fdemo"),
      vi.fn(async () => undefined),
    ) as Promise<Response>

    let settled = false
    void resPromise.finally(() => {
      settled = true
    })

    vi.advanceTimersByTime(5_000)
    await Promise.resolve()
    expect(settled).toBe(false)

    ready({ url: "http://runtime.test" })

    const res = await resPromise
    expect(res.status).toBe(200)
    expect(markRuntimeUse).toHaveBeenCalledWith("ws_1")
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })
})
