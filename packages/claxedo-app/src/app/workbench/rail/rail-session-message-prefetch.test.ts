import { afterEach, describe, expect, mock, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { queryClient } from "@/platform/query/query-client"
import { getSessionPrefetch, getSessionPrefetchPromise } from "@/platform/sync/session-prefetch"
import { createRailSessionMessagePrefetch } from "./rail-session-message-prefetch"
import { markFastSessionSwitch } from "@/platform/runtime/session-switch"

afterEach(() => {
  queryClient.clear()
  delete (globalThis as typeof globalThis & { __claxedoFastSessionSwitch?: unknown }).__claxedoFastSessionSwitch
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function message(id: string): Message {
  return {
    id,
    sessionID: id.replace("msg", "ses"),
    role: "user",
    time: { created: 1 },
    agent: "assistant",
    model: { providerID: "openai", modelID: "gpt-4o" },
  } as Message
}

describe("rail session message prefetch ownership", () => {
  test("explicit pointer intent bypasses suppression left by the previously active session", async () => {
    const client = {
      get: mock(async () => ({ data: undefined })),
      todo: mock(async () => ({ data: [] })),
      messages: mock(async () => ({ data: [{ info: message("msg_b") }], response: new Response(null) })),
    }
    const prefetch = createRailSessionMessagePrefetch({ client, workspaceReachable: () => true })
    markFastSessionSwitch("ses_a", Date.now())

    expect(prefetch.start("opencode", "ses_b", { bypassQuiet: true })).toBe(true)
    await getSessionPrefetchPromise("opencode", "ses_b")

    expect(client.messages).toHaveBeenCalledTimes(1)
    expect(getSessionPrefetch("opencode", "ses_b")?.page?.messages.map((item) => item.id)).toEqual(["msg_b"])
  })

  test("cold B aborts click-owned A before A can normalize or publish", async () => {
    const a = deferred<{ data: Array<{ info: Message }>; response: Response }>()
    let aSignal: AbortSignal | undefined
    let aNormalizations = 0
    const client = {
      get: mock(async () => ({ data: undefined })),
      todo: mock(async () => ({ data: [] })),
      messages: mock(async (input: { sessionID: string }, options?: { signal?: AbortSignal }) => {
        if (input.sessionID === "ses_a") {
          aSignal = options?.signal
          return await a.promise
        }
        return { data: [{ info: message("msg_b") }], response: new Response(null) }
      }),
    }
    const prefetch = createRailSessionMessagePrefetch({ client, workspaceReachable: () => true })

    prefetch.start("opencode", "ses_a", { bypassQuiet: true })
    const aRequest = getSessionPrefetchPromise("opencode", "ses_a")
    prefetch.supersede("opencode", "ses_b")
    prefetch.start("opencode", "ses_b", { bypassQuiet: true })
    const bRequest = getSessionPrefetchPromise("opencode", "ses_b")

    expect(aSignal?.aborted).toBe(true)
    a.resolve({
      data: [{
        get info() {
          aNormalizations++
          return message("msg_a")
        },
      }],
      response: new Response(null),
    })
    await Promise.all([aRequest, bRequest])

    expect(aNormalizations).toBe(0)
    expect(getSessionPrefetch("opencode", "ses_a")).toBeUndefined()
    expect(getSessionPrefetch("opencode", "ses_b")?.page?.messages.map((item) => item.id)).toEqual(["msg_b"])
  })

  test("already-mounted B still aborts A without starting a B read", async () => {
    const a = deferred<{ data: Array<{ info: Message }>; response: Response }>()
    let aSignal: AbortSignal | undefined
    let aNormalizations = 0
    const client = {
      get: mock(async () => ({ data: undefined })),
      todo: mock(async () => ({ data: [] })),
      messages: mock(async (_input: { sessionID: string }, options?: { signal?: AbortSignal }) => {
        aSignal = options?.signal
        return await a.promise
      }),
    }
    const prefetch = createRailSessionMessagePrefetch({ client, workspaceReachable: () => true })

    prefetch.start("opencode", "ses_a", { bypassQuiet: true })
    const aRequest = getSessionPrefetchPromise("opencode", "ses_a")
    prefetch.supersede("opencode", "ses_b")
    expect(aSignal?.aborted).toBe(true)

    a.resolve({
      data: [{
        get info() {
          aNormalizations++
          return message("msg_a")
        },
      }],
      response: new Response(null),
    })
    await aRequest

    expect(client.messages).toHaveBeenCalledTimes(1)
    expect(aNormalizations).toBe(0)
    expect(getSessionPrefetch("opencode", "ses_a")).toBeUndefined()
  })

  test("same-key joins share the request and completed pages survive later activation", async () => {
    const pending = deferred<{ data: Array<{ info: Message }>; response: Response }>()
    let signal: AbortSignal | undefined
    const client = {
      get: mock(async () => ({ data: undefined })),
      todo: mock(async () => ({ data: [] })),
      messages: mock(async (_input: { sessionID: string }, options?: { signal?: AbortSignal }) => {
        signal = options?.signal
        return await pending.promise
      }),
    }
    const prefetch = createRailSessionMessagePrefetch({ client, workspaceReachable: () => true })

    expect(prefetch.start("opencode", "ses_a", { bypassQuiet: true })).toBe(true)
    prefetch.supersede("opencode", "ses_a")
    expect(prefetch.start("opencode", "ses_a", { bypassQuiet: true })).toBe(true)
    expect(signal?.aborted).toBe(false)
    expect(client.messages).toHaveBeenCalledTimes(1)

    const request = getSessionPrefetchPromise("opencode", "ses_a")
    pending.resolve({ data: [{ info: message("msg_a") }], response: new Response(null) })
    await request
    prefetch.supersede("opencode", "ses_b")

    expect(getSessionPrefetch("opencode", "ses_a")?.page?.messages.map((item) => item.id)).toEqual(["msg_a"])
  })
})
