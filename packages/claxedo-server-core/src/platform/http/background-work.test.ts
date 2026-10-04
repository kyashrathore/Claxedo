import type { Context } from "hono"
import { describe, expect, test, vi } from "vitest"
import { guardedWaitUntil, keepAlivePastResponse } from "./background-work"

function nodeContext(): Context {
  return {
    get executionCtx(): never {
      throw new Error("This context has no ExecutionContext")
    },
  } as unknown as Context
}

function workerContext(waitUntil: (work: Promise<unknown>) => void): Context {
  return { executionCtx: { waitUntil, passThroughOnException() {} } } as unknown as Context
}

describe("background work past the response", () => {
  test("on Node there is no scheduler, and detached work still runs", async () => {
    const c = nodeContext()
    expect(guardedWaitUntil(c)).toBeUndefined()
    let ran = false
    keepAlivePastResponse(c, Promise.resolve().then(() => { ran = true }))
    await Promise.resolve()
    expect(ran).toBe(true)
  })

  test("on Workers the work is handed to executionCtx.waitUntil", async () => {
    const waitUntil = vi.fn()
    const c = workerContext(waitUntil)
    const work = Promise.resolve("done")
    keepAlivePastResponse(c, work)
    expect(waitUntil).toHaveBeenCalledTimes(1)
    expect(waitUntil).toHaveBeenCalledWith(work)
    guardedWaitUntil(c)?.(work)
    expect(waitUntil).toHaveBeenCalledTimes(2)
  })

  test("a context whose executionCtx lacks waitUntil counts as Node", () => {
    const c = { executionCtx: {} } as unknown as Context
    expect(guardedWaitUntil(c)).toBeUndefined()
  })
})
