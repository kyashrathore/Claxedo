import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import type { PreparedRuntimeSession } from "./prepared-session"
import {
  harnessChangeRequestKey,
  harnessHydrateRequestKey,
  harnessHydrateSeenKey,
  harnessOptionsSeqKey,
  harnessOptionsTriesKey,
  harnessPreparedSessionKey,
  harnessPreparedSessionSeqKey,
  harnessPreparingSessionKey,
  sessionModelSyncRequestKey,
  sessionModelSyncStateKey,
} from "./store-policy"
import {
  clearHarnessOptionsTries,
  createHarnessHydratorQueryCache,
  createHarnessOptionsQueryCache,
  createHarnessSwitcherQueryCache,
  createPreparedRuntimeSessionQueryCache,
  createSessionModelSyncQueryCache,
} from "./harness-query-cache"

const scope = "draft:/repo:route"

afterEach(() => {
  queryClient.clear()
})

describe("harness query cache", () => {
  test("stores session model sync state and removes only the matching pending write", () => {
    const cache = createSessionModelSyncQueryCache()
    const first = Promise.resolve()
    const second = Promise.resolve()

    cache.setState("server\nses_1", { desired: "opus" })
    cache.setPending("server\nses_1", "opus", first)
    cache.removePending("server\nses_1", "opus", second)

    expect(queryClient.getQueryData(sessionModelSyncStateKey("server\nses_1"))).toEqual({ desired: "opus" })
    expect(queryClient.getQueryData(sessionModelSyncRequestKey("server\nses_1", "opus"))).toBe(first)

    cache.removePending("server\nses_1", "opus", first)
    expect(queryClient.getQueryData(sessionModelSyncRequestKey("server\nses_1", "opus"))).toBeUndefined()
  })

  test("stores prepared runtime-session lifecycle metadata under query keys", () => {
    const cache = createPreparedRuntimeSessionQueryCache()
    const prepared = {
      id: "ses_prepared",
      directory: "/repo",
      harness: "claude-acp",
      model: "sonnet",
    } satisfies PreparedRuntimeSession
    const pending = { seq: 1, promise: Promise.resolve(prepared) }

    cache.setSeq(scope, 1)
    cache.setPrepared(scope, prepared)
    cache.setPreparing(scope, pending)

    expect(queryClient.getQueryData(harnessPreparedSessionSeqKey(scope))).toBe(1)
    expect(queryClient.getQueryData(harnessPreparedSessionKey(scope))).toEqual(prepared)
    expect(queryClient.getQueryData(harnessPreparingSessionKey(scope))).toBe(pending)

    cache.removePrepared(scope)
    cache.removePreparing(scope)
    expect(queryClient.getQueryData(harnessPreparedSessionKey(scope))).toBeUndefined()
    expect(queryClient.getQueryData(harnessPreparingSessionKey(scope))).toBeUndefined()
  })

  test("increments option sequence and clears retry tries through the shared helper", () => {
    const cache = createHarnessOptionsQueryCache()

    expect(cache.nextSeq(scope)).toBe(1)
    expect(cache.nextSeq(scope)).toBe(2)
    cache.setTries(scope, 3)

    expect(queryClient.getQueryData(harnessOptionsSeqKey(scope))).toBe(2)
    expect(queryClient.getQueryData(harnessOptionsTriesKey(scope))).toBe(3)

    clearHarnessOptionsTries(scope)
    expect(queryClient.getQueryData(harnessOptionsTriesKey(scope))).toBeUndefined()
  })

  test("dedupes hydrate pending removal by identity and fetches session config by session id", async () => {
    const cache = createHarnessHydratorQueryCache<{ directory?: string; sessionId?: string }>("https://server-one.test")
    const first = Promise.resolve()
    const second = Promise.resolve()
    let fetches = 0

    cache.setSeen(scope, "session:ses_1")
    cache.setPending(scope, first)
    cache.removePending(scope, second)

    expect(queryClient.getQueryData(harnessHydrateSeenKey(scope))).toBe("session:ses_1")
    expect(queryClient.getQueryData(harnessHydrateRequestKey(scope))).toBe(first)

    cache.removePending(scope, first)
    expect(queryClient.getQueryData(harnessHydrateRequestKey(scope))).toBeUndefined()

    await expect(
      cache.fetchSessionConfig({ directory: "/one", sessionId: "ses_1" }, async () => {
        fetches++
        return { model: "sonnet" }
      }),
    ).resolves.toEqual({ model: "sonnet" })
    await expect(
      cache.fetchSessionConfig({ directory: "/two", sessionId: "ses_1" }, async () => {
        fetches++
        return { model: "opus" }
      }),
    ).resolves.toEqual({ model: "opus" })
    expect(fetches).toBe(2)
  })

  test("isolates the same session placement across server authorities", async () => {
    const first = createHarnessHydratorQueryCache<{ directory?: string; sessionId?: string }>("https://server-one.test")
    const second = createHarnessHydratorQueryCache<{ directory?: string; sessionId?: string }>(
      "https://server-two.test",
    )
    let fetches = 0

    await expect(
      first.fetchSessionConfig({ directory: "/repo", sessionId: "ses_shared" }, async () => {
        fetches++
        return { model: "sonnet" }
      }),
    ).resolves.toEqual({ model: "sonnet" })
    await expect(
      second.fetchSessionConfig({ directory: "/repo", sessionId: "ses_shared" }, async () => {
        fetches++
        return { model: "opus" }
      }),
    ).resolves.toEqual({ model: "opus" })

    expect(fetches).toBe(2)
  })

  test("stores harness switch pending requests and shares option retry cleanup", () => {
    const cache = createHarnessSwitcherQueryCache()
    const pending = Promise.resolve()
    createHarnessOptionsQueryCache().setTries(scope, 2)

    cache.setPending("change-key", pending)
    expect(queryClient.getQueryData(harnessChangeRequestKey("change-key"))).toBe(pending)
    cache.clearOptionsTries(scope)
    expect(queryClient.getQueryData(harnessOptionsTriesKey(scope))).toBeUndefined()

    cache.removePending("change-key", Promise.resolve())
    expect(queryClient.getQueryData(harnessChangeRequestKey("change-key"))).toBe(pending)
    cache.removePending("change-key", pending)
    expect(queryClient.getQueryData(harnessChangeRequestKey("change-key"))).toBeUndefined()
  })
})
