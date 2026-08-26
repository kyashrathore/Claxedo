import { beforeEach, describe, expect, test } from "bun:test"
import { createWorkspaceResolveRegistry, shareableResolve } from "./workspace-resolve-read"

const URL_A = "http://127.0.0.1:3101/api/claxedo/workspace/resolve?directory=%2Frepo"
const URL_B = "http://127.0.0.1:3101/api/claxedo/workspace/resolve?directory=%2Fother"

function recordingRequest(responses: Array<() => Response>) {
  const urls: string[] = []
  let call = 0
  const request = Object.assign(async (input: URL | RequestInfo) => {
    urls.push(input.toString())
    const make = responses[Math.min(call, responses.length - 1)]!
    call += 1
    return make()
  }, { preconnect: fetch.preconnect })
  return { urls, request }
}

const ok = (body: unknown) => () => Response.json(body)

// A fresh registry per test is the point of owning the state on an instance:
// no cross-test leakage and no global reset hook to remember.
let read: ReturnType<typeof createWorkspaceResolveRegistry>["read"]
beforeEach(() => {
  read = createWorkspaceResolveRegistry().read
})

describe("workspace resolve single-flight reader", () => {
  test("callers that overlap share one request and both get the value", async () => {
    const { urls, request } = recordingRequest([ok({ workspaceId: "ws_1" })])
    const [left, right] = await Promise.all([read({ url: URL_A, request }), read({ url: URL_A, request })])
    expect(urls).toHaveLength(1)
    expect(left.valueOrThrow()).toEqual({ workspaceId: "ws_1" })
    expect(right.valueOrThrow()).toEqual({ workspaceId: "ws_1" })
  })

  test("three overlapping callers — the boot shape — collapse to one request", async () => {
    const { urls, request } = recordingRequest([ok({ workspaceId: "ws_1" })])
    await Promise.all([read({ url: URL_A, request }), read({ url: URL_A, request }), read({ url: URL_A, request })])
    expect(urls).toHaveLength(1)
  })

  test("different directories are never merged", async () => {
    const { urls, request } = recordingRequest([ok({ workspaceId: "ws_1" }), ok({ workspaceId: "ws_2" })])
    await Promise.all([read({ url: URL_A, request }), read({ url: URL_B, request })])
    expect(urls).toHaveLength(2)
  })

  test("a read after the shared request settles re-reads and sees the new value", async () => {
    const { urls, request } = recordingRequest([ok({ workspaceId: "ws_before" }), ok({ workspaceId: "ws_after" })])
    const first = await read({ url: URL_A, request })
    const second = await read({ url: URL_A, request })
    expect(first.valueOrThrow()).toEqual({ workspaceId: "ws_before" })
    expect(second.valueOrThrow()).toEqual({ workspaceId: "ws_after" })
    expect(urls).toHaveLength(2)
  })

  test("a create=true resolve is a write and is never shared", async () => {
    const { urls, request } = recordingRequest([ok({ workspaceId: "ws_1" })])
    await Promise.all([read({ url: URL_A, request, create: true }), read({ url: URL_A, request, create: true })])
    expect(shareableResolve({ create: true })).toBe(false)
    expect(urls).toHaveLength(2)
  })

  // THE DEFECT THIS READER PREVIOUSLY INTRODUCED. Routing through a shared
  // reader silently replaced `readJson`'s throw-on-bad-status with an undefined
  // snapshot, which callers then read `.kind` off one line later. A non-ok
  // response must raise, not resolve.
  test("a non-ok response throws, exactly as a direct readJson would", async () => {
    const { request } = recordingRequest([() => new Response("workspace exploded", { status: 500 })])
    const outcome = await read({ url: URL_A, request })
    expect(outcome.ok).toBe(false)
    expect(outcome.status).toBe(500)
    expect(() => outcome.valueOrThrow()).toThrow("workspace exploded")
  })

  test("a 404 is reported by status so callers can map it to null without throwing first", async () => {
    const { request } = recordingRequest([() => new Response(null, { status: 404 })])
    const outcome = await read({ url: URL_A, request })
    expect(outcome.status).toBe(404)
    expect(() => outcome.valueOrThrow()).toThrow()
  })

  test("an unparseable body throws the runtime-unavailable error, as readJson does", async () => {
    const { request } = recordingRequest([() => new Response("<html>nope", { status: 200 })])
    const outcome = await read({ url: URL_A, request })
    expect(outcome.ok).toBe(true)
    expect(() => outcome.valueOrThrow()).toThrow("Workspace runtime is unavailable.")
  })

  // A shared failure must reach EVERY joiner as a failure, not just the issuer.
  test("a failure is replayed to every joiner", async () => {
    const { urls, request } = recordingRequest([() => new Response("boom", { status: 503 })])
    const [left, right] = await Promise.all([read({ url: URL_A, request }), read({ url: URL_A, request })])
    expect(urls).toHaveLength(1)
    expect(() => left.valueOrThrow()).toThrow("boom")
    expect(() => right.valueOrThrow()).toThrow("boom")
  })
})
