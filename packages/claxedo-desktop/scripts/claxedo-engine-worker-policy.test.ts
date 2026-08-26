import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import {
  bindEngineWorkerRequestAbort,
  isAuthorizedEngineWorkerRequest,
  sessionStatusHasActiveWork,
} from "./claxedo-engine-worker-policy"

describe("engine worker policy", () => {
  test("accepts only the exact per-boot bearer capability", () => {
    expect(isAuthorizedEngineWorkerRequest("Bearer secret", "secret")).toBe(true)
    expect(isAuthorizedEngineWorkerRequest("Bearer other", "secret")).toBe(false)
    expect(isAuthorizedEngineWorkerRequest(undefined, "secret")).toBe(false)
    expect(isAuthorizedEngineWorkerRequest(["Bearer secret"], "secret")).toBe(false)
  })

  test("keeps the worker alive for active or malformed status payloads", () => {
    expect(sessionStatusHasActiveWork({})).toBe(false)
    expect(sessionStatusHasActiveWork({ ses_1: { type: "idle" } })).toBe(false)
    expect(sessionStatusHasActiveWork({ ses_1: { type: "busy" } })).toBe(true)
    expect(sessionStatusHasActiveWork({ ses_1: { type: "retry" } })).toBe(true)
    expect(sessionStatusHasActiveWork(null)).toBe(true)
  })

  test("aborts the internal handler when the caller disconnects", async () => {
    let requestStarted!: () => void
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve
    })
    let handlerAborted!: () => void
    const aborted = new Promise<void>((resolve) => {
      handlerAborted = resolve
    })
    const server = createServer(async (incoming, outgoing) => {
      const binding = bindEngineWorkerRequestAbort(incoming, outgoing)
      binding.signal.addEventListener("abort", handlerAborted, { once: true })
      requestStarted()
      await aborted
      binding.dispose()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server failed to bind")
    const controller = new AbortController()
    const request = fetch(`http://127.0.0.1:${address.port}/session`, { signal: controller.signal }).catch(() => undefined)
    try {
      await started
      controller.abort()
      await Promise.race([
        aborted,
        new Promise((_, reject) => setTimeout(() => reject(new Error("handler did not observe abort")), 2_000)),
      ])
    } finally {
      controller.abort()
      await request
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
