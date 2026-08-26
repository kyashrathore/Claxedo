import { EventEmitter } from "node:events"
import { afterEach, describe, expect, test, vi } from "vitest"

import {
  configureOpenCodeEmbedPath,
  configureOpenCodeEngine,
  configureOpenCodeWorkerPath,
  __setOpenCodeWorkerForkForTests,
  drainOpenCodeEngine,
  opencodeRequest,
  OPENCODE_INTERNAL_BASE,
} from "./engine"

class FakeChild extends EventEmitter {
  killed = false
  kill() {
    this.killed = true
    return true
  }
}

const originalFetch = globalThis.fetch
const forkWorker = vi.fn()

afterEach(async () => {
  await drainOpenCodeEngine()
  configureOpenCodeWorkerPath(undefined)
  __setOpenCodeWorkerForkForTests(undefined)
  configureOpenCodeEmbedPath(undefined)
  configureOpenCodeEngine({ embedded: true })
  globalThis.fetch = originalFetch
  forkWorker.mockReset()
})

describe("embedded engine worker transport", () => {
  test("uses an unguessable per-boot authorization capability", async () => {
    const child = new FakeChild()
    forkWorker.mockImplementation((_path, _args, options) => {
      const token = options?.env?.CLAXEDO_ENGINE_AUTH_TOKEN
      expect(typeof token).toBe("string")
      expect(String(token).length).toBeGreaterThanOrEqual(32)
      queueMicrotask(() => child.emit("message", { type: "claxedo-engine-ready", port: 43123 }))
      return child as never
    })
    let authorization: string | null = null
    globalThis.fetch = vi.fn(async (input: Request | string | URL) => {
      const request = input instanceof Request ? input : new Request(input)
      authorization = request.headers.get("authorization")
      return Response.json({ ok: true })
    }) as unknown as typeof fetch

    configureOpenCodeEmbedPath("/tmp/opencode-node-embed.js")
    configureOpenCodeWorkerPath("/tmp/claxedo-engine-worker.js")
    __setOpenCodeWorkerForkForTests(forkWorker as never)
    const response = await opencodeRequest(new Request(`${OPENCODE_INTERNAL_BASE}/session`))

    expect(response.status).toBe(200)
    expect(authorization).toMatch(/^Bearer [A-Za-z0-9_-]{32,}$/)
  })

  test("never replays a request after an ambiguous transport failure", async () => {
    const child = new FakeChild()
    forkWorker.mockImplementation(() => {
      queueMicrotask(() => child.emit("message", { type: "claxedo-engine-ready", port: 43124 }))
      return child as never
    })
    const failure = new TypeError("socket closed after request write")
    const fetchMock = vi.fn(async () => {
      throw failure
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    configureOpenCodeEmbedPath("/tmp/opencode-node-embed.js")
    configureOpenCodeWorkerPath("/tmp/claxedo-engine-worker.js")
    __setOpenCodeWorkerForkForTests(forkWorker as never)

    await expect(
      opencodeRequest(new Request(`${OPENCODE_INTERNAL_BASE}/session`, { method: "POST", body: "send once" })),
    ).rejects.toBe(failure)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(forkWorker).toHaveBeenCalledTimes(1)
  })

  test("propagates caller cancellation to the worker fetch", async () => {
    const child = new FakeChild()
    forkWorker.mockImplementation(() => {
      queueMicrotask(() => child.emit("message", { type: "claxedo-engine-ready", port: 43125 }))
      return child as never
    })
    let outgoingSignal: AbortSignal | undefined
    const fetchMock = vi.fn(async (input: Request | string | URL) => {
      const request = input instanceof Request ? input : new Request(input)
      outgoingSignal = request.signal
      return new Promise<Response>((_resolve, reject) => {
        if (request.signal.aborted) {
          reject(request.signal.reason)
          return
        }
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    configureOpenCodeEmbedPath("/tmp/opencode-node-embed.js")
    configureOpenCodeWorkerPath("/tmp/claxedo-engine-worker.js")
    __setOpenCodeWorkerForkForTests(forkWorker as never)

    const controller = new AbortController()
    const pending = opencodeRequest(
      new Request(`${OPENCODE_INTERNAL_BASE}/session`, { signal: controller.signal }),
    )
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    controller.abort(new DOMException("request cancelled", "AbortError"))

    await rejected
    expect(outgoingSignal?.aborted).toBe(true)
    expect(forkWorker).toHaveBeenCalledTimes(1)
  })
})
