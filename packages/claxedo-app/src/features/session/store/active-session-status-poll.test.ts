import { describe, expect, test } from "bun:test"
import { QueryClient, QueryObserver } from "@tanstack/solid-query"
import {
  activeSessionStatusPollQueryOptions,
  activeSessionStatusPollRequestKey,
  activeSessionStatusPollScope,
  waitForFirstActiveSessionStatusPoll,
} from "./active-session-status-poll"

const scope = { directory: "/repo/main", sessionID: "ses_poll" }

describe("active session status poll lifecycle", () => {
  test("an aborted first delay is retried after reactivation", async () => {
    const startedKeys = new Set<string>()
    const activation = new AbortController()
    let waits = 0
    const wait = async (_delay: number, signal?: AbortSignal) => {
      waits++
      activation.abort()
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError")
    }

    await expect(waitForFirstActiveSessionStatusPoll({
      key: activeSessionStatusPollScope(scope),
      startedKeys,
      wait,
      signal: activation.signal,
    })).rejects.toBeDefined()
    expect(startedKeys.size).toBe(0)

    await waitForFirstActiveSessionStatusPoll({
      key: activeSessionStatusPollScope(scope),
      startedKeys,
      wait: async () => { waits++ },
    })
    expect(waits).toBe(2)
    expect(startedKeys.has(activeSessionStatusPollScope(scope))).toBe(true)
  })

  test("uses an ephemeral runtime key and leaves no query after its observer unmounts", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const options = activeSessionStatusPollQueryOptions({
      ...scope,
      enabled: false,
      startedKeys: new Set<string>(),
      refresh: async () => true,
    })
    const observer = new QueryObserver(client, options)
    const unsubscribe = observer.subscribe(() => undefined)

    expect(options.queryKey).toEqual(["runtime", "session-status-poll", "/repo/main", "ses_poll"])
    expect(client.getQueryCache().find({ queryKey: activeSessionStatusPollRequestKey(scope), exact: true })).toBeDefined()

    unsubscribe()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(client.getQueryCache().find({ queryKey: activeSessionStatusPollRequestKey(scope), exact: true })).toBeUndefined()
  })

  test("aborts an in-flight refresh when the owning observer unmounts", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let started = false
    let aborted = false
    const startedKeys = new Set([activeSessionStatusPollScope(scope)])
    const observer = new QueryObserver(client, activeSessionStatusPollQueryOptions({
      ...scope,
      enabled: true,
      startedKeys,
      refresh: async (signal) => {
        started = true
        return await new Promise<boolean>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true
            resolve(false)
          }, { once: true })
        })
      },
    }))
    const unsubscribe = observer.subscribe(() => undefined)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toBe(true)
    unsubscribe()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(aborted).toBe(true)
    expect(client.getQueryCache().find({ queryKey: activeSessionStatusPollRequestKey(scope), exact: true })).toBeUndefined()
  })
})
