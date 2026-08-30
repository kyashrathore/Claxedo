import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import type { AgentPresentationMessage as Message } from "@claxedo/agent-runtime-contract"
import { queryClient } from "@/platform/query/query-client"
import { getSessionPrefetch, getSessionPrefetchPromise } from "@/platform/sync/session-prefetch"
import { markFastSessionSwitch } from "@/platform/runtime/session-switch"

let requestHandler: typeof fetch = async () => {
  throw new Error("request handler is not configured")
}
const realApiModule = { ...(await import(`${import.meta.dir}/../../../platform/api/api.ts?rail-prefetch-restore`)) }

afterAll(() => {
  mock.module("@/platform/api/api", () => realApiModule)
})

mock.module("@/platform/api/api", () => ({
  ...realApiModule,
  authFetch: (input: string | URL | Request, init?: RequestInit) => requestHandler(input, init),
  apiBearerToken: async () => null,
}))

const { createRailSessionMessagePrefetch } = await import("./rail-session-message-prefetch")

afterEach(() => {
  queryClient.clear()
  delete (globalThis as typeof globalThis & { __claxedoFastSessionSwitch?: unknown }).__claxedoFastSessionSwitch
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

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

function history(messages: Array<{ info: Message }>) {
  return new Response(JSON.stringify(messages), {
    status: 200,
    headers: { "Content-Type": "application/json", "x-max-event-ordinal": "1" },
  })
}

describe("rail session message prefetch ownership", () => {
  test("explicit pointer intent bypasses suppression left by the previously active session", async () => {
    requestHandler = async () => history([{ info: message("msg_b") }])
    const prefetch = createRailSessionMessagePrefetch({ workspaceReachable: () => true })
    markFastSessionSwitch("ses_a", Date.now())

    expect(prefetch.start("opencode", "ses_b", { bypassQuiet: true })).toBe(true)
    await getSessionPrefetchPromise("opencode", "ses_b")

    expect(getSessionPrefetch("opencode", "ses_b")?.page?.messages.map((item) => item.id)).toEqual(["msg_b"])
  })

  test("cold B aborts click-owned A before A can normalize or publish", async () => {
    const a = deferred<Response>()
    let aSignal: AbortSignal | undefined
    let aNormalizations = 0
    requestHandler = async (input, init) => {
      if (String(input).includes("/session/ses_a/")) {
        aSignal = init?.signal ?? undefined
        return await a.promise
      }
      return history([{ info: message("msg_b") }])
    }
    const prefetch = createRailSessionMessagePrefetch({ workspaceReachable: () => true })

    prefetch.start("opencode", "ses_a", { bypassQuiet: true })
    const aRequest = getSessionPrefetchPromise("opencode", "ses_a")
    await flush()
    prefetch.supersede("opencode", "ses_b")
    prefetch.start("opencode", "ses_b", { bypassQuiet: true })
    const bRequest = getSessionPrefetchPromise("opencode", "ses_b")

    expect(aSignal?.aborted).toBe(true)
    const late = new Response(null, { headers: { "x-max-event-ordinal": "1" } })
    Object.defineProperty(late, "json", { value: async () => [{
        get info() {
          aNormalizations++
          return message("msg_a")
        },
      }] })
    a.resolve(late)
    await Promise.all([aRequest, bRequest])

    expect(aNormalizations).toBe(0)
    expect(getSessionPrefetch("opencode", "ses_a")).toBeUndefined()
    expect(getSessionPrefetch("opencode", "ses_b")?.page?.messages.map((item) => item.id)).toEqual(["msg_b"])
  })

  test("already-mounted B still aborts A without starting a B read", async () => {
    const a = deferred<Response>()
    let aSignal: AbortSignal | undefined
    let aNormalizations = 0
    let requests = 0
    requestHandler = async (_input, init) => {
      requests++
      aSignal = init?.signal ?? undefined
      return await a.promise
    }
    const prefetch = createRailSessionMessagePrefetch({ workspaceReachable: () => true })

    prefetch.start("opencode", "ses_a", { bypassQuiet: true })
    const aRequest = getSessionPrefetchPromise("opencode", "ses_a")
    await flush()
    prefetch.supersede("opencode", "ses_b")
    expect(aSignal?.aborted).toBe(true)

    const late = new Response(null, { headers: { "x-max-event-ordinal": "1" } })
    Object.defineProperty(late, "json", { value: async () => [{
        get info() {
          aNormalizations++
          return message("msg_a")
        },
      }] })
    a.resolve(late)
    await aRequest

    expect(requests).toBe(1)
    expect(aNormalizations).toBe(0)
    expect(getSessionPrefetch("opencode", "ses_a")).toBeUndefined()
  })

  test("same-key joins share the request and completed pages survive later activation", async () => {
    const pending = deferred<Response>()
    let signal: AbortSignal | undefined
    let requests = 0
    requestHandler = async (_input, init) => {
      requests++
      signal = init?.signal ?? undefined
      return await pending.promise
    }
    const prefetch = createRailSessionMessagePrefetch({ workspaceReachable: () => true })

    expect(prefetch.start("opencode", "ses_a", { bypassQuiet: true })).toBe(true)
    await flush()
    prefetch.supersede("opencode", "ses_a")
    expect(prefetch.start("opencode", "ses_a", { bypassQuiet: true })).toBe(true)
    expect(signal?.aborted).toBe(false)
    expect(requests).toBe(1)

    const request = getSessionPrefetchPromise("opencode", "ses_a")
    pending.resolve(history([{ info: message("msg_a") }]))
    await request
    prefetch.supersede("opencode", "ses_b")

    expect(getSessionPrefetch("opencode", "ses_a")?.page?.messages.map((item) => item.id)).toEqual(["msg_a"])
  })
})
