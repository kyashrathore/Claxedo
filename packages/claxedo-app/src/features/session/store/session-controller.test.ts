import { flush } from "solid-js"
import { afterEach, describe, expect, test } from "bun:test"
import type {
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
} from "@opencode-ai/sdk/v2/client"
import {
  ACTIVE_SESSION_STATUS_POLL_DELAY_MS,
  ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS,
  acceptedPromptRefreshMatches,
  activeSessionStatusPollingDecision,
  activeTurnTransition,
  conversationHasAssistantMessage,
  fetchTransportSession,
  FAST_SESSION_SWITCH_NETWORK_QUIET_MS,
  FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS,
  FIRST_FOLD_SESSION_META_HYDRATE_DELAY_MS,
  firstFoldSessionPrefetch,
  isSessionNotFoundError,
  removeDirectorySessionCacheRow,
  resolveStoredMessages,
  resolveStoredParts,
  sessionHistoryKey,
  shouldStartActiveSessionStatusPolling,
  shouldHydrateSession,
  shouldReuseSessionHistory,
  syncSessionMeta,
  waitForFirstActiveSessionStatusPoll,
} from "./session-controller"
import {
  createActivationSessionReadEpoch,
  firstFoldSessionHydrateDelay,
  shouldAcceptSessionTransportResult,
  shouldDeferSessionTransportHydrate,
  shouldSkipSessionTransportHydrate,
} from "./session-history-activation"
import {
  createLatestTurnCompletion,
  FIRST_FOLD_PREFETCH_JOIN_TIMEOUT_MS,
  joinFirstFoldSessionPrefetch,
  LATEST_TURN_COMPLETION_EARLIEST_MS,
  LATEST_TURN_COMPLETION_IDLE_TIMEOUT_MS,
  runFirstFoldFallback,
  scheduleDeferredFirstFoldPrefetch,
  schedulePostPaintLatestTurnCompletion,
  shouldScheduleFirstFoldHistory,
} from "./first-fold-prefetch"
import { SESSION_PREFETCH_TTL } from "@/platform/sync/session-prefetch"
import { readAcceptedPromptStatus } from "./accepted-prompt-refresh"
import { shouldFetchSessionAlongsideHistory } from "./session-transport"
import { backfillFailedCursor, createHistoryMetaState, historyHasMore } from "./history-pagination"
import {
  SESSION_STATUS_TELEMETRY_CONFIG,
  observeSessionStatusEvent,
  observeSessionStatusPoll,
  resetSessionStatusTelemetryForTest,
  sessionStatusPollDisagreements,
} from "./session-status-telemetry"
import { normalizeMessageRows } from "./message-page"
import { hydrateFirstFoldSessionPrefetch } from "./first-fold-hydration"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import { directorySessionCacheQueryOptions, setSessionStatusQueryData } from "../data/sync/queries"
import {
  clearConversationChatRegistryForTest,
  hydrateRegisteredConversationSnapshot,
  registeredConversationSnapshot,
} from "../conversation/conversation-registry"

const idle: SessionStatus = { type: "idle" }
const busy: SessionStatus = { type: "busy" }
const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window

afterEach(() => {
  queryClient.clear()
  clearConversationChatRegistryForTest()
  delete (globalThis as typeof globalThis & { __claxedoFastSessionSwitch?: unknown }).__claxedoFastSessionSwitch
  if (originalWindow === undefined) delete (globalThis as typeof globalThis & { window?: unknown }).window
  else (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow
})

function permission(id: string, sessionID: string): PermissionRequest {
  return {
    id,
    sessionID,
    permission: "edit",
    patterns: [],
    metadata: {},
    always: [],
  }
}

function question(id: string, sessionID: string): QuestionRequest {
  return {
    id,
    sessionID,
    questions: [],
  }
}

describe("session controller helpers", () => {
  test("activation session reads become inactive and abort on pane deactivation", () => {
    const epoch = createActivationSessionReadEpoch()

    expect(epoch.active()).toBe(true)
    expect(epoch.signal.aborted).toBe(false)
    epoch.abort()
    expect(epoch.active()).toBe(false)
    expect(epoch.signal.aborted).toBe(true)
    epoch.abort()
    expect(epoch.signal.aborted).toBe(true)
  })

  test("late transport results require the same directory, session, and activation epoch", () => {
    const exact = {
      expectedSessionID: "ses_shared",
      currentSessionID: "ses_shared",
      expectedDirectory: "/repo/a",
      currentDirectory: "/repo/a",
      expectedActivationEpoch: 4,
      currentActivationEpoch: 4,
    }
    expect(shouldAcceptSessionTransportResult(exact)).toBe(true)
    expect(shouldAcceptSessionTransportResult({ ...exact, currentDirectory: "/repo/b" })).toBe(false)
    expect(shouldAcceptSessionTransportResult({ ...exact, currentActivationEpoch: 5 })).toBe(false)
    expect(shouldAcceptSessionTransportResult({ ...exact, currentSessionID: "ses_other" })).toBe(false)
  })
  test("reads accepted-prompt status from the canonical live-status map", async () => {
    expect(
      await readAcceptedPromptStatus({
        sessionID: "ses_busy",
        client: { session: { status: async () => ({ data: { ses_busy: busy } }) } },
      }),
    ).toEqual(busy)
    expect(
      await readAcceptedPromptStatus({
        sessionID: "ses_idle",
        client: { session: { status: async () => ({ data: {} }) } },
      }),
    ).toEqual(idle)
  })

  test("does not turn a failed accepted-prompt status read into idle", async () => {
    expect(
      await readAcceptedPromptStatus({
        sessionID: "ses_failed",
        client: { session: { status: async () => Promise.reject(new Error("unavailable")) } },
      }),
    ).toBeUndefined()
    expect(
      await readAcceptedPromptStatus({
        sessionID: "ses_failed",
        client: { session: { status: async () => ({}) } },
      }),
    ).toBeUndefined()
  })

  test("keeps migrated metadata, todo, and capabilities request state query-owned", async () => {
    const source = await Bun.file(new URL("./session-controller.ts", import.meta.url)).text()
    const banned = [
      "runInflight",
      "sessionInflight",
      "metaInflight",
      "metaFresh",
      "todoInflight",
      "capabilitiesInflight",
      "capabilitiesCache",
    ]

    banned.forEach((pattern) => {
      expect(source).not.toContain(pattern)
    })
  })

  test("shouldHydrateSession skips invalid routes and hydrates real sessions", () => {
    expect(shouldHydrateSession({ sessionID: undefined, healthy: true })).toBe(false)
    expect(shouldHydrateSession({ sessionID: "new", healthy: true })).toBe(false)
    expect(shouldHydrateSession({ sessionID: "ses_1", healthy: false })).toBe(false)
    expect(shouldHydrateSession({ sessionID: "ses_1", directory: "/repo/main", healthy: false })).toBe(true)
    expect(shouldHydrateSession({ sessionID: "ses_1", healthy: true, active: false })).toBe(false)
    expect(shouldHydrateSession({ sessionID: "ses_1", healthy: true, active: true })).toBe(true)
    expect(shouldHydrateSession({ sessionID: "cp_1", directory: "workspace:ws_1", healthy: false })).toBe(true)
  })

  test("signed session history never reuses warm snapshots without a transport read", () => {
    expect(
      shouldReuseSessionHistory({
        hasSession: true,
        cached: true,
      }),
    ).toBe(true)
    expect(
      shouldReuseSessionHistory({
        hasSession: true,
        cached: true,
        signedControlPlane: true,
      }),
    ).toBe(false)
    expect(
      shouldReuseSessionHistory({
        hasSession: true,
        cached: true,
        force: true,
      }),
    ).toBe(false)
    expect(
      shouldReuseSessionHistory({
        before: "cursor_1",
        hasSession: true,
        cached: true,
      }),
    ).toBe(false)
  })

  test("session history readiness is scoped by directory as well as session id", () => {
    expect(sessionHistoryKey({ sessionID: "ses_1", directory: "" })).not.toBe(
      sessionHistoryKey({ sessionID: "ses_1", directory: "/repo/main" }),
    )
    expect(sessionHistoryKey({ sessionID: "ses_1", directory: "/repo/main" })).not.toBe(
      sessionHistoryKey({ sessionID: "ses_1", directory: "/repo/other" }),
    )
  })

  test("failed older-history cursors are dampened instead of refetched in a loop", () => {
    // Behavior (dampening derivation now lives in history-pagination.ts and is
    // unit-tested there): a session with a next cursor offers "more" history;
    // once that same cursor's backfill fails and is recorded in failedCursor,
    // it is no longer offered, so the controller cannot refetch it in a loop.
    const base = { limit: {}, cursor: { k: "cur" }, failedCursor: {}, complete: {}, loading: {} }
    flush()
    expect(historyHasMore(base, "k")).toBe(true)
    flush()
    expect(historyHasMore({ ...base, failedCursor: { k: "cur" } }, "k")).toBe(false)
  })

  test("the controller records the attempted older-page cursor when its backfill fails", () => {
    // WRITE side of the dampening loop-break. `syncSessionHistory`'s failure
    // handler delegates the "which cursor to record as failed" decision to
    // backfillFailedCursor (the real export it imports); an older-page backfill
    // carries a `before` cursor, and a plain (non-not-found) rejection records
    // exactly that cursor so historyHasMore() stops offering it.
    expect(backfillFailedCursor({ before: "cur_older", sessionNotFound: false })).toBe("cur_older")
  })

  test("a not-found backfill failure records no failed cursor (the session is being removed instead)", () => {
    expect(backfillFailedCursor({ before: "cur_older", sessionNotFound: true })).toBeUndefined()
  })

  test("a foreground load (no before cursor) records no failed cursor and surfaces the error", () => {
    expect(backfillFailedCursor({ before: undefined, sessionNotFound: false })).toBeUndefined()
  })

  test("recording the failed cursor through the real history state dampens historyHasMore for that key", () => {
    // End-to-end of the write→read contract using the real state setter the
    // controller uses: seed a next cursor, then record that same cursor as
    // failed (as the controller does on a failed backfill) and confirm the key
    // no longer offers more history — the refetch loop is broken.
    const { meta, setValue } = createHistoryMetaState()
    const key = "/repo/main\nses_1"
    setValue("cursor", key, "cur_older")
    flush()
    expect(historyHasMore(meta(), key)).toBe(true)

    const recorded = backfillFailedCursor({ before: "cur_older", sessionNotFound: false })
    expect(recorded).toBe("cur_older")
    setValue("failedCursor", key, recorded)
    flush()
    expect(historyHasMore(meta(), key)).toBe(false)
  })

  test("identifies missing session transport errors", () => {
    expect(isSessionNotFoundError(new Error("Request failed: 404"))).toBe(true)
    expect(isSessionNotFoundError({ error: { code: "session_not_found", message: "Session not found" } })).toBe(true)
    expect(isSessionNotFoundError(new Error("Request failed: 500"))).toBe(false)
  })

  test("assistant error messages count as present even without renderable parts", () => {
    hydrateRegisteredConversationSnapshot({
      directory: "/repo/main",
      sessionID: "ses_error",
      messages: [
        {
          id: "msg_assistant",
          sessionID: "ses_error",
          role: "assistant",
          parentID: "msg_user",
          time: { created: 1, completed: 2 },
          error: { name: "UnknownError", data: { message: "provider failed" } },
        } as Message,
      ],
      parts: { msg_assistant: [] },
    })

    expect(conversationHasAssistantMessage("/repo/main", "ses_error", "msg_assistant")).toBe(true)
  })

  test("removes missing sessions from the directory cache", () => {
    const directory = "/repo/main"
    const root = { id: "ses_root" } as Session
    const child = { id: "ses_child", parentID: "ses_root" } as Session
    queryClient.setQueryData(directorySessionCacheQueryOptions({ directory }).queryKey, {
      at: 1,
      limit: 5,
      total: 1,
      session: [root, child],
    })

    removeDirectorySessionCacheRow(directory, "ses_child")
    expect(queryClient.getQueryData(directorySessionCacheQueryOptions({ directory }).queryKey)).toMatchObject({
      total: 1,
      session: [root],
    })

    removeDirectorySessionCacheRow(directory, "ses_root")
    expect(queryClient.getQueryData(directorySessionCacheQueryOptions({ directory }).queryKey)).toMatchObject({
      total: 0,
      session: [],
    })
  })

  test("first-fold session switching accepts only fresh same-directory message prefetch", () => {
    const info = {
      directory: "/repo/main",
      limit: 1,
      complete: true,
      at: 1_000,
      page: { messages: [{ id: "msg_1", role: "user" } as Message], parts: [] },
    }

    expect(
      firstFoldSessionPrefetch({
        sessionID: "ses_1",
        directory: "/repo/main",
        info,
        now: 1_010,
      }),
    ).toBe(info)
    expect(
      firstFoldSessionPrefetch({
        sessionID: "ses_1",
        directory: "/repo/other",
        info,
        now: 1_010,
      }),
    ).toBeUndefined()
    expect(
      firstFoldSessionPrefetch({
        sessionID: "ses_1",
        directory: "/repo/main",
        info: { ...info, page: { messages: [], parts: [] } },
        now: 1_010,
      }),
    ).toBeUndefined()
    expect(
      firstFoldSessionPrefetch({
        sessionID: "ses_1",
        directory: "/repo/main",
        info,
        now: 1_000 + SESSION_PREFETCH_TTL + 1,
      }),
    ).toBeUndefined()
  })

  test("first-fold seeding applies selected parts even when the message ids already exist", () => {
    const sameMessage = {
      id: "msg_same",
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
      agent: "assistant",
      model: { providerID: "openai", modelID: "gpt-4o" },
    } as Message
    hydrateRegisteredConversationSnapshot({
      directory: "/repo/main",
      sessionID: "ses_1",
      messages: [sameMessage],
      parts: { msg_same: [] },
    })
    hydrateFirstFoldSessionPrefetch({
      directory: "/repo/main",
      sessionID: "ses_1",
      prefetch: {
        directory: "/repo/main",
        limit: 1,
        complete: true,
        at: Date.now(),
        page: {
          messages: [sameMessage],
          parts: [
            {
              id: "msg_same",
              part: [
                {
                  id: "part_surface",
                  messageID: "msg_same",
                  sessionID: "ses_1",
                  type: "text",
                  text: "surface",
                } as Part,
              ],
            },
          ],
        },
      },
    })
    expect(registeredConversationSnapshot("/repo/main", "ses_1").parts.msg_same?.map((item) => item.id)).toEqual([
      "part_surface",
    ])
  })

  test("session switch transport refresh is deferred past the 30ms first-fold budget", () => {
    expect(FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS).toBeGreaterThan(30)
    expect(FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS).toBeGreaterThanOrEqual(900)
    expect(FIRST_FOLD_SESSION_META_HYDRATE_DELAY_MS).toBeGreaterThan(FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS)
  })

  test("deferred latest-turn completion is message-only", () => {
    expect(
      shouldFetchSessionAlongsideHistory({
        view: "latest-turn",
        hasSession: true,
        force: true,
        title: "Session title",
      }),
    ).toBe(false)
    expect(
      shouldFetchSessionAlongsideHistory({
        view: "latest-turn",
        hasSession: false,
        force: true,
      }),
    ).toBe(false)
    expect(
      shouldFetchSessionAlongsideHistory({
        view: "latest-surface",
        hasSession: false,
      }),
    ).toBe(false)
  })

  test("joined cold-session prefetch seeds its canonical page without a duplicate transport fetch", async () => {
    let fallbacks = 0
    let ceilings = 0
    await expect(
      joinFirstFoldSessionPrefetch({
        request: Promise.resolve(),
        active: () => true,
        seed: () => true,
        onSeed: () => {
          ceilings += 1
        },
        onEmpty: () => {},
        fallback: () => {
          fallbacks += 1
        },
      }),
    ).resolves.toBe("seeded")
    expect(fallbacks).toBe(0)
    expect(ceilings).toBe(1)
  })

  test("failed or empty cold-session prefetch falls back immediately while stale activations do nothing", async () => {
    let fallbacks = 0
    await expect(
      joinFirstFoldSessionPrefetch({
        request: Promise.reject(new Error("prefetch failed")),
        active: () => true,
        seed: () => false,
        onEmpty: () => {},
        fallback: () => {
          fallbacks += 1
        },
      }),
    ).resolves.toBe("fallback")
    expect(fallbacks).toBe(1)

    await expect(
      joinFirstFoldSessionPrefetch({
        request: Promise.resolve(),
        active: () => false,
        seed: () => false,
        onEmpty: () => {},
        fallback: () => {
          fallbacks += 1
        },
      }),
    ).resolves.toBe("inactive")
    expect(fallbacks).toBe(1)
  })

  test("a slow cold-session prefetch stays single-flight past the interaction deadline", async () => {
    expect(FIRST_FOLD_PREFETCH_JOIN_TIMEOUT_MS).toBeLessThan(50)
    let resolveRequest!: () => void
    const request = new Promise<void>((resolve) => {
      resolveRequest = resolve
    })
    let seeds = 0
    let timeouts = 0
    let fallbacks = 0
    await expect(
      joinFirstFoldSessionPrefetch({
        request,
        timeoutMs: 5,
        active: () => true,
        seed: () => {
          seeds += 1
          return true
        },
        onTimeout: () => {
          timeouts += 1
        },
        onEmpty: () => {},
        fallback: () => {
          fallbacks += 1
        },
      }),
    ).resolves.toBe("timeout-pending")

    expect({ seeds, timeouts, fallbacks }).toEqual({ seeds: 0, timeouts: 1, fallbacks: 0 })

    resolveRequest()
    await Promise.resolve()
    await Promise.resolve()
    expect({ seeds, timeouts, fallbacks }).toEqual({ seeds: 1, timeouts: 1, fallbacks: 0 })
  })

  test("a slow successful-empty prefetch transitions without repeating the surface", async () => {
    let resolveRequest!: () => void
    const request = new Promise<void>((resolve) => {
      resolveRequest = resolve
    })
    let fallbacks = 0
    let empty = 0
    await expect(
      joinFirstFoldSessionPrefetch({
        request,
        timeoutMs: 5,
        active: () => true,
        seed: () => false,
        onEmpty: () => {
          empty++
        },
        fallback: () => {
          fallbacks++
        },
      }),
    ).resolves.toBe("timeout-pending")
    expect({ fallbacks, empty }).toEqual({ fallbacks: 0, empty: 0 })

    resolveRequest()
    await Promise.resolve()
    await Promise.resolve()
    expect({ fallbacks, empty }).toEqual({ fallbacks: 0, empty: 1 })
  })

  test("prefetch fallback failures are consumed both before and after the join timeout", async () => {
    const errors: string[] = []
    const fallback = async () => {
      throw new Error("fallback failed")
    }
    const base = {
      active: () => true,
      seed: () => false,
      onEmpty: () => {},
      fallback,
      onError: (error: unknown) => errors.push((error as Error).message),
    }
    await expect(
      joinFirstFoldSessionPrefetch({
        ...base,
        request: Promise.reject(new Error("surface failed")),
      }),
    ).resolves.toBe("fallback")

    let rejectRequest!: (error: unknown) => void
    const request = new Promise<void>((_resolve, reject) => {
      rejectRequest = reject
    })
    await expect(joinFirstFoldSessionPrefetch({ ...base, request, timeoutMs: 5 })).resolves.toBe("timeout-pending")
    rejectRequest(new Error("late surface failed"))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(errors).toEqual(["fallback failed", "fallback failed"])
  })

  test("a rejected fallback always unblocks deferred completion", async () => {
    let unblocked = 0
    let scheduled = 0
    await expect(
      runFirstFoldFallback({
        sync: async () => {
          throw new Error("surface unavailable")
        },
        scheduleCompletion: () => {
          scheduled++
        },
        unblockCompletion: () => {
          unblocked++
        },
      }),
    ).rejects.toThrow("surface unavailable")
    expect({ unblocked, scheduled }).toEqual({ unblocked: 1, scheduled: 0 })
  })

  test("latest-turn completion consumes synchronous and asynchronous failures", async () => {
    const errors: string[] = []
    const scheduled: Array<() => void> = []
    const schedule = (input: Parameters<typeof schedulePostPaintLatestTurnCompletion>[0]) => {
      scheduled.push(input.complete)
      return () => {}
    }
    const sync = createLatestTurnCompletion({
      activationAt: 0,
      active: () => true,
      complete: () => {
        throw new Error("sync completion")
      },
      onError: (error) => errors.push((error as Error).message),
      schedule,
    })
    const async = createLatestTurnCompletion({
      activationAt: 0,
      active: () => true,
      complete: async () => {
        throw new Error("async completion")
      },
      onError: (error) => errors.push((error as Error).message),
      schedule,
    })
    sync.schedule()
    async.schedule()
    scheduled.forEach((run) => run())
    await Promise.resolve()
    await Promise.resolve()
    expect(errors).toEqual(["sync completion", "async completion"])
  })

  test("the delayed hydrate does not duplicate completed or joined first-fold prefetch", () => {
    expect(shouldScheduleFirstFoldHistory({ prefetched: true })).toBe(false)
    expect(shouldScheduleFirstFoldHistory({ prefetched: false, request: Promise.resolve() })).toBe(false)
    expect(shouldScheduleFirstFoldHistory({ prefetched: false })).toBe(true)
  })

  test("latest-turn completion is scheduled once and remains cancellable", () => {
    let schedules = 0
    let cancels = 0
    const completion = createLatestTurnCompletion({
      activationAt: 0,
      active: () => true,
      complete: () => {},
      schedule: () => {
        schedules++
        return () => cancels++
      },
    })
    completion.schedule()
    completion.schedule()
    completion.cancel()
    expect({ schedules, cancels }).toEqual({ schedules: 1, cancels: 1 })
  })

  test("latest-turn completion cannot overlap an unresolved latest-surface request", () => {
    let schedules = 0
    let cancels = 0
    const completion = createLatestTurnCompletion({
      activationAt: 0,
      active: () => true,
      complete: () => {},
      schedule: () => {
        schedules++
        return () => cancels++
      },
    })

    completion.block()
    completion.schedule()
    expect(schedules).toBe(0)

    completion.unblock()
    completion.unblock()
    expect(schedules).toBe(1)

    completion.cancel()
    expect(cancels).toBe(1)
  })

  test("cancelling a blocked completion prevents late prefetch settlement from starting it", () => {
    let schedules = 0
    const completion = createLatestTurnCompletion({
      activationAt: 0,
      active: () => true,
      complete: () => {},
      schedule: () => {
        schedules++
        return () => {}
      },
    })

    completion.block()
    completion.schedule()
    completion.cancel()
    completion.unblock()
    expect(schedules).toBe(0)
  })

  test("latest-turn waits past the interaction budget, then a frame and idle, and superseded A never reads", () => {
    expect(LATEST_TURN_COMPLETION_EARLIEST_MS).toBeGreaterThan(50)
    expect(LATEST_TURN_COMPLETION_EARLIEST_MS + LATEST_TURN_COMPLETION_IDLE_TIMEOUT_MS).toBeLessThan(10_000)
    let now = 1_000
    let nextToken = 0
    const timers = new Map<number, { at: number; callback: () => void }>()
    const frames = new Map<number, () => void>()
    const idles = new Map<number, () => void>()
    const requests: string[] = []
    let sessionDetailRequests = 0
    const schedule = (callback: () => void, delay: number) => {
      const token = ++nextToken
      timers.set(token, { at: now + delay, callback })
      return token
    }
    const runTimers = () => {
      for (const [token, timer] of [...timers]) {
        if (timer.at > now) continue
        timers.delete(token)
        timer.callback()
      }
    }
    const runQueue = (queue: Map<number, () => void>) => {
      for (const [token, callback] of [...queue]) {
        queue.delete(token)
        callback()
      }
    }
    const policy: typeof schedulePostPaintLatestTurnCompletion = (input) =>
      schedulePostPaintLatestTurnCompletion({
        ...input,
        now: () => now,
        schedule,
        cancel: (token) => timers.delete(token as number),
        scheduleFrame: (callback) => {
          const token = ++nextToken
          frames.set(token, callback)
          return token
        },
        cancelFrame: (token) => frames.delete(token as number),
        scheduleIdle: (callback) => {
          const token = ++nextToken
          idles.set(token, callback)
          return token
        },
        cancelIdle: (token) => idles.delete(token as number),
      })

    const activationA = createLatestTurnCompletion({
      activationAt: now,
      active: () => true,
      complete: () => {
        if (shouldFetchSessionAlongsideHistory({ view: "latest-turn", hasSession: false, force: true }))
          sessionDetailRequests++
        requests.push("A")
      },
      schedule: policy,
    })
    activationA.schedule()

    // The immediately-started surface is also transcript-only; its metadata
    // owner remains scheduleDirectorySessionHydration.
    if (shouldFetchSessionAlongsideHistory({ view: "latest-surface", hasSession: false })) sessionDetailRequests++

    now += 50
    runTimers()
    runQueue(frames)
    runQueue(idles)
    expect({ requests, sessionDetailRequests }).toEqual({ requests: [], sessionDetailRequests: 0 })

    // B supersedes A before A reaches its earliest completion time.
    activationA.cancel()
    const activationBAt = now
    const activationB = createLatestTurnCompletion({
      activationAt: activationBAt,
      active: () => true,
      complete: () => {
        if (shouldFetchSessionAlongsideHistory({ view: "latest-turn", hasSession: false, force: true }))
          sessionDetailRequests++
        requests.push("B")
      },
      schedule: policy,
    })
    activationB.schedule()

    now = activationBAt + LATEST_TURN_COMPLETION_EARLIEST_MS - 1
    runTimers()
    expect(requests).toEqual([])
    now += 1
    runTimers()
    expect(requests).toEqual([])
    runQueue(frames)
    expect(requests).toEqual([])
    runQueue(idles)
    expect({ requests, sessionDetailRequests }).toEqual({ requests: ["B"], sessionDetailRequests: 0 })
  })

  test("deferred prefetched history waits for idle and cancels when the activation becomes inactive", () => {
    let timer: (() => void) | undefined
    let idle: (() => void) | undefined
    let active = true
    let hydrates = 0
    const cancel = scheduleDeferredFirstFoldPrefetch({
      delay: 900,
      active: () => active,
      hydrate: () => hydrates++,
      schedule: (callback) => {
        timer = callback
        return 1 as ReturnType<typeof setTimeout>
      },
      cancel: () => {},
      scheduleIdle: (callback) => {
        idle = callback
        return 2
      },
      cancelIdle: () => {},
    })

    expect(hydrates).toBe(0)
    timer?.()
    expect(hydrates).toBe(0)
    active = false
    idle?.()
    expect(hydrates).toBe(0)
    cancel()
  })

  test("fast session switches keep target background hydration outside the interaction window", () => {
    const now = 1_000
    ;(
      globalThis as typeof globalThis & {
        window?: {
          __claxedoFastSessionSwitch?: { sessionId: string; until: number; networkQuietUntil?: number }
        }
      }
    ).window = {
      __claxedoFastSessionSwitch: {
        sessionId: "ses_next",
        until: now + 250,
        networkQuietUntil: now + FAST_SESSION_SWITCH_NETWORK_QUIET_MS,
      },
    }

    expect(
      firstFoldSessionHydrateDelay({
        sessionID: "ses_next",
        prefetched: true,
        now,
      }),
    ).toBe(FAST_SESSION_SWITCH_NETWORK_QUIET_MS)
    expect(
      firstFoldSessionHydrateDelay({
        sessionID: "ses_next",
        prefetched: false,
        now,
      }),
    ).toBe(0)
    expect(
      firstFoldSessionHydrateDelay({
        sessionID: "ses_other",
        prefetched: true,
        now,
      }),
    ).toBe(FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS)
  })

  test("first visible session hydrate bypasses the fast-switch network quiet gate", () => {
    const now = 1_000
    ;(
      globalThis as typeof globalThis & {
        window?: {
          __claxedoFastSessionSwitch?: { sessionId: string; until: number; networkQuietUntil?: number }
        }
      }
    ).window = {
      __claxedoFastSessionSwitch: {
        sessionId: "ses_next",
        until: now + 250,
        networkQuietUntil: now + FAST_SESSION_SWITCH_NETWORK_QUIET_MS,
      },
    }

    expect(
      shouldSkipSessionTransportHydrate({
        sessionID: "ses_next",
        now,
      }),
    ).toBe(true)
    expect(
      shouldSkipSessionTransportHydrate({
        sessionID: "ses_next",
        bypassQuiet: true,
        now,
      }),
    ).toBe(false)
  })

  test("forced accepted-prompt refreshes bypass the in-flight hydrate gate", () => {
    expect(shouldDeferSessionTransportHydrate({ loading: true })).toBe(true)
    expect(shouldDeferSessionTransportHydrate({ loading: true, force: false })).toBe(true)
    expect(shouldDeferSessionTransportHydrate({ loading: true, force: true })).toBe(false)
    expect(shouldDeferSessionTransportHydrate({ loading: false, force: true })).toBe(false)
  })

  test("accepted-prompt refresh waits for the created session route identity", () => {
    const request = { sessionID: "ses_created", directory: "/repo/main" }

    expect(acceptedPromptRefreshMatches({ request, sessionID: "new", currentDirectory: "/repo/main" })).toBe(false)
    expect(acceptedPromptRefreshMatches({ request, sessionID: "ses_created", currentDirectory: "/repo/other" })).toBe(
      false,
    )
    expect(acceptedPromptRefreshMatches({ request, sessionID: "ses_created", currentDirectory: "/repo/main" })).toBe(
      true,
    )
  })

  test("active-turn settlement is scoped to the same session history key", () => {
    const previous = activeTurnTransition({
      directory: "/repo/main",
      sessionID: "ses_busy",
      active: true,
    }).next

    expect(
      activeTurnTransition({
        previous,
        directory: "/repo/main",
        sessionID: "ses_idle",
        active: false,
      }).settled,
    ).toBe(false)
    expect(
      activeTurnTransition({
        previous,
        directory: "/repo/main",
        sessionID: "ses_busy",
        active: false,
      }).settled,
    ).toBe(true)
    expect(
      activeTurnTransition({
        previous,
        directory: "/repo/other",
        sessionID: "ses_busy",
        active: false,
      }).settled,
    ).toBe(false)
  })

  test("syncSessionMeta preserves local busy and filters lists to one session", async () => {
    setSessionStatusQueryData({ queryClient, sessionId: "ses_1", status: busy })

    const ok = await syncSessionMeta({
      sessionID: "ses_1",
      currentSessionID: () => "ses_1",
      sdk: {
        session: {
          status: async () => ({ data: { ses_1: idle, ses_2: busy } }),
        },
        permission: {
          list: async () => ({ data: [permission("p2", "ses_2"), permission("p1", "ses_1")] }),
        },
        question: {
          list: async () => ({ data: [question("q2", "ses_2"), question("q1", "ses_1")] }),
        },
      },
    })

    expect(ok).toBe(true)
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_1", "status"))).toEqual({ type: "busy" })
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_1", "requests"))).toEqual({
      permissions: [permission("p1", "ses_1")],
      questions: [question("q1", "ses_1")],
    })
  })

  test("syncSessionMeta ignores late results after session switch", async () => {
    const ok = await syncSessionMeta({
      sessionID: "ses_1",
      currentSessionID: () => "ses_2",
      sdk: {
        session: {
          status: async () => ({ data: { ses_1: busy } }),
        },
        permission: {
          list: async () => ({ data: [permission("p1", "ses_1")] }),
        },
        question: {
          list: async () => ({ data: [question("q1", "ses_1")] }),
        },
      },
    })

    expect(ok).toBe(false)
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_1", "status"))).toBeUndefined()
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_1", "requests"))).toBeUndefined()
  })

  test("syncSessionMeta does not dispatch a late result from an abort-ignoring transport", async () => {
    const activation = new AbortController()
    let resolveStatus!: (value: { data: Record<string, SessionStatus> }) => void
    const pendingStatus = new Promise<{ data: Record<string, SessionStatus> }>((resolve) => {
      resolveStatus = resolve
    })
    const result = syncSessionMeta({
      sessionID: "ses_1",
      currentSessionID: () => "ses_1",
      signal: activation.signal,
      sdk: {
        session: { status: async () => await pendingStatus },
        permission: { list: async () => ({ data: [] }) },
        question: { list: async () => ({ data: [] }) },
      },
    })

    await Promise.resolve()
    activation.abort()
    resolveStatus({ data: { ses_1: busy } })

    await expect(result).resolves.toBe(false)
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_1", "status"))).toBeUndefined()
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_1", "requests"))).toBeUndefined()
  })

  test("syncSessionMeta tolerates unavailable permission metadata", async () => {
    const ok = await syncSessionMeta({
      sessionID: "ses_1",
      currentSessionID: () => "ses_1",
      sdk: {
        session: {
          status: async () => ({ data: { ses_1: idle } }),
        },
        permission: {
          list: async () => {
            throw new Error("workspaceId or directory is required")
          },
        },
        question: {
          list: async () => ({ data: [] }),
        },
      },
    })

    expect(ok).toBe(true)
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_1", "status"))).toEqual({ type: "idle" })
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_1", "requests"))).toEqual({
      permissions: [],
      questions: [],
    })
  })

  test("syncSessionMeta shares directory metadata fetches across sessions", async () => {
    const calls = { status: 0, permission: 0, question: 0 }
    const sdk = {
      session: {
        status: async () => {
          calls.status += 1
          return { data: { ses_1: idle, ses_2: idle } }
        },
      },
      permission: {
        list: async () => {
          calls.permission += 1
          return { data: [permission("p1", "ses_1"), permission("p2", "ses_2")] }
        },
      },
      question: {
        list: async () => {
          calls.question += 1
          return { data: [question("q1", "ses_1"), question("q2", "ses_2")] }
        },
      },
    }

    const [first, second] = await Promise.all([
      syncSessionMeta({
        directory: "/repo/shared",
        sessionID: "ses_1",
        currentSessionID: () => "ses_1",
        sdk,
      }),
      syncSessionMeta({
        directory: "/repo/shared",
        sessionID: "ses_2",
        currentSessionID: () => "ses_2",
        sdk,
      }),
    ])

    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(calls).toEqual({ status: 1, permission: 1, question: 1 })
    expect(queryClient.getQueryData(["shell", "directory", "/repo/shared", "session-meta", "requests"])).toEqual({
      status: { ses_1: idle, ses_2: idle },
      permissions: [permission("p1", "ses_1"), permission("p2", "ses_2")],
      questions: [question("q1", "ses_1"), question("q2", "ses_2")],
    })
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_1", "requests"))).toEqual({
      permissions: [permission("p1", "ses_1")],
      questions: [question("q1", "ses_1")],
    })
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_2", "requests"))).toEqual({
      permissions: [permission("p2", "ses_2")],
      questions: [question("q2", "ses_2")],
    })
  })

  test("syncSessionMeta keeps a shared directory request alive when one consumer aborts", async () => {
    const firstActivation = new AbortController()
    const secondActivation = new AbortController()
    let resolveStatus!: (value: { data: Record<string, SessionStatus> }) => void
    let sharedSignal: AbortSignal | undefined
    const calls = { status: 0, permission: 0, question: 0 }
    const pendingStatus = new Promise<{ data: Record<string, SessionStatus> }>((resolve) => {
      resolveStatus = resolve
    })
    const sdk = {
      session: {
        status: async (_input?: undefined, options?: { signal?: AbortSignal }) => {
          calls.status += 1
          sharedSignal = options?.signal
          return await pendingStatus
        },
      },
      permission: {
        list: async () => {
          calls.permission += 1
          return { data: [] }
        },
      },
      question: {
        list: async () => {
          calls.question += 1
          return { data: [] }
        },
      },
    }

    const first = syncSessionMeta({
      directory: "/repo/shared-abort",
      sessionID: "ses_1",
      currentSessionID: () => "ses_1",
      signal: firstActivation.signal,
      sdk,
    })
    const second = syncSessionMeta({
      directory: "/repo/shared-abort",
      sessionID: "ses_2",
      currentSessionID: () => "ses_2",
      signal: secondActivation.signal,
      sdk,
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual({ status: 1, permission: 1, question: 1 })
    firstActivation.abort()
    await expect(first).resolves.toBe(false)
    expect(sharedSignal?.aborted).toBe(false)

    resolveStatus({ data: { ses_1: idle, ses_2: idle } })
    await expect(second).resolves.toBe(true)
    expect(queryClient.getQueryData(["shell", "directory", "/repo/shared-abort", "session-meta", "requests"])).toEqual({
      status: { ses_1: idle, ses_2: idle },
      permissions: [],
      questions: [],
    })
  })

  test("syncSessionMeta can refresh status without refetching request lists", async () => {
    queryClient.setQueryData(shellDataKeys.sessionId("ses_1", "requests"), {
      permissions: [permission("p1", "ses_1")],
      questions: [question("q1", "ses_1")],
    })

    const ok = await syncSessionMeta({
      sessionID: "ses_1",
      currentSessionID: () => "ses_1",
      includeRequests: false,
      sdk: {
        session: {
          status: async () => ({ data: { ses_1: idle } }),
        },
        permission: {
          list: async () => {
            throw new Error("permission should not be fetched")
          },
        },
        question: {
          list: async () => {
            throw new Error("question should not be fetched")
          },
        },
      },
    })

    expect(ok).toBe(true)
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_1", "status"))).toEqual({ type: "idle" })
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_1", "requests"))).toEqual({
      permissions: [permission("p1", "ses_1")],
      questions: [question("q1", "ses_1")],
    })
  })

  test("syncSessionMeta status-only refresh clears busy when no request is pending", async () => {
    setSessionStatusQueryData({ queryClient, sessionId: "ses_1", status: busy })

    const ok = await syncSessionMeta({
      sessionID: "ses_1",
      currentSessionID: () => "ses_1",
      includeRequests: false,
      sdk: {
        session: {
          status: async () => ({ data: { ses_1: idle } }),
        },
        permission: {
          list: async () => {
            throw new Error("permission should not be fetched")
          },
        },
        question: {
          list: async () => {
            throw new Error("question should not be fetched")
          },
        },
      },
    })

    expect(ok).toBe(true)
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_1", "status"))).toEqual({ type: "idle" })
  })

  test("syncSessionMeta can merge status through shell query state without a Solid store writer", async () => {
    setSessionStatusQueryData({ queryClient, sessionId: "ses_1", status: busy })
    queryClient.setQueryData(shellDataKeys.sessionId("ses_1", "requests"), {
      permissions: [permission("p1", "ses_1")],
      questions: [],
    })

    const ok = await syncSessionMeta({
      sessionID: "ses_1",
      currentSessionID: () => "ses_1",
      includeRequests: false,
      sdk: {
        session: {
          status: async () => ({ data: { ses_1: idle } }),
        },
        permission: {
          list: async () => {
            throw new Error("permission should not be fetched")
          },
        },
        question: {
          list: async () => {
            throw new Error("question should not be fetched")
          },
        },
      },
    })

    expect(ok).toBe(true)
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_1", "status"))).toEqual(busy)
  })

  test("syncSessionMeta records poll disagreement against last event status", async () => {
    resetSessionStatusTelemetryForTest()
    observeSessionStatusEvent({
      directory: "/repo/main",
      sessionID: "ses_1",
      status: busy,
      now: 1_000,
    })

    const ok = await syncSessionMeta({
      directory: "/repo/main",
      sessionID: "ses_1",
      currentSessionID: () => "ses_1",
      includeRequests: false,
      instrumentPoll: true,
      sdk: {
        session: {
          status: async () => ({ data: { ses_1: idle } }),
        },
        permission: {
          list: async () => {
            throw new Error("permission should not be fetched")
          },
        },
        question: {
          list: async () => {
            throw new Error("question should not be fetched")
          },
        },
      },
    })

    expect(ok).toBe(true)
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_1", "status"))).toEqual(idle)
    const disagreements = sessionStatusPollDisagreements()
    expect(disagreements).toHaveLength(1)
    expect(disagreements[0]?.directory).toBe("/repo/main")
    expect(disagreements[0]?.sessionID).toBe("ses_1")
    expect(disagreements[0]?.eventStatus).toEqual(busy)
    expect(disagreements[0]?.polledStatus).toEqual(idle)
    expect(disagreements[0]?.count).toBe(1)
    expect(typeof disagreements[0]?.firstSeenAt).toBe("number")
    expect(typeof disagreements[0]?.lastSeenAt).toBe("number")
    resetSessionStatusTelemetryForTest()
  })

  test("active-session status polling waits one minute before the first query-owned poll", async () => {
    const startedKeys = new Set<string>()
    const waits: number[] = []
    const wait = (delay: number) => {
      waits.push(delay)
      return Promise.resolve()
    }

    await waitForFirstActiveSessionStatusPoll({
      key: "/repo/main\u0000ses_1",
      startedKeys,
      wait,
    })

    await waitForFirstActiveSessionStatusPoll({
      key: "/repo/main\u0000ses_1",
      startedKeys,
      wait,
    })

    await waitForFirstActiveSessionStatusPoll({
      key: "/repo/main\u0000ses_2",
      startedKeys,
      wait,
    })

    expect(waits).toEqual([ACTIVE_SESSION_STATUS_POLL_DELAY_MS, ACTIVE_SESSION_STATUS_POLL_DELAY_MS])
    expect(ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS).toBe(5_000)
  })

  test("active-session status polling starts only until the event path is proven for that session", () => {
    resetSessionStatusTelemetryForTest()
    const now = Date.now()

    expect(
      shouldStartActiveSessionStatusPolling({
        directory: "/repo/main",
        sessionID: "ses_1",
      }),
    ).toBe(true)

    observeSessionStatusEvent({
      directory: "/repo/main",
      sessionID: "ses_1",
      status: idle,
      now,
    })
    expect(
      shouldStartActiveSessionStatusPolling({
        directory: "/repo/main",
        sessionID: "ses_1",
      }),
    ).toBe(true)

    // Rubric C3: the gate now requires matchesRequired matching polls inside
    // the sliding window, not a single match.
    for (let i = 0; i < SESSION_STATUS_TELEMETRY_CONFIG.matchesRequired; i++) {
      observeSessionStatusPoll({
        directory: "/repo/main",
        sessionID: "ses_1",
        status: idle,
        now: now + 1 + i,
      })
    }
    expect(
      shouldStartActiveSessionStatusPolling({
        directory: "/repo/main",
        sessionID: "ses_1",
      }),
    ).toBe(false)
    expect(
      shouldStartActiveSessionStatusPolling({
        directory: "/repo/main",
        sessionID: "ses_2",
      }),
    ).toBe(true)

    resetSessionStatusTelemetryForTest()
  })

  test("rubric T10: integration — once the gate opens, the controller decision flips and a sane caller never invokes the poller", () => {
    resetSessionStatusTelemetryForTest()
    const now = Date.now()
    const sessionID = "ses_t10"
    const directory = "/repo/main"

    // Drive a session from "no evidence" → "matching evidence sustained".
    // 1. No data yet — the decision says start.
    expect(shouldStartActiveSessionStatusPolling({ directory, sessionID })).toBe(true)

    // 2. Event arrives. Still missing matching poll evidence.
    observeSessionStatusEvent({ directory, sessionID, status: idle, now })
    expect(shouldStartActiveSessionStatusPolling({ directory, sessionID })).toBe(true)

    // 3. Matching polls accumulate inside the sliding window. After
    //    matchesRequired the gate opens for THIS session.
    for (let i = 0; i < SESSION_STATUS_TELEMETRY_CONFIG.matchesRequired; i++) {
      observeSessionStatusPoll({ directory, sessionID, status: idle, now: now + 1 + i })
    }

    // 4. A controller that respects the decision disables the active-status
    //    polling query for this session.
    const queryEnabled = (input: { directory?: string; sessionID: string }) =>
      shouldStartActiveSessionStatusPolling(input)
    expect(queryEnabled({ directory, sessionID })).toBe(false)

    // 5. A DIFFERENT session (no event evidence yet) still gets polled —
    //    the gate is per-session, not global.
    expect(queryEnabled({ directory, sessionID: "ses_t10_other" })).toBe(true)

    resetSessionStatusTelemetryForTest()
  })

  test("active-session status polling decision exposes the telemetry gate reason", () => {
    resetSessionStatusTelemetryForTest()
    const now = Date.now()

    expect(
      activeSessionStatusPollingDecision({
        directory: "/repo/main",
        sessionID: "ses_1",
      }),
    ).toMatchObject({
      shouldStart: true,
      canDisablePolling: false,
      reason: "missing-event-evidence",
    })

    observeSessionStatusEvent({
      directory: "/repo/main",
      sessionID: "ses_1",
      status: idle,
      now,
    })
    expect(
      activeSessionStatusPollingDecision({
        directory: "/repo/main",
        sessionID: "ses_1",
      }),
    ).toMatchObject({
      shouldStart: true,
      canDisablePolling: false,
      reason: "missing-matching-poll-evidence",
    })

    for (let i = 0; i < SESSION_STATUS_TELEMETRY_CONFIG.matchesRequired; i++) {
      observeSessionStatusPoll({
        directory: "/repo/main",
        sessionID: "ses_1",
        status: idle,
        now: now + 1 + i,
      })
    }
    expect(
      activeSessionStatusPollingDecision({
        directory: "/repo/main",
        sessionID: "ses_1",
      }),
    ).toMatchObject({
      shouldStart: false,
      canDisablePolling: true,
      reason: "event-path-clean",
    })

    resetSessionStatusTelemetryForTest()
  })

  test("resolveStoredMessages honors empty canonical membership", () => {
    expect(
      resolveStoredMessages({
        existing: [{ id: "msg_1" }, { id: "msg_2" }],
        next: [],
        completeness: "canonical",
      }).map((message) => message.id),
    ).toEqual([])
  })

  test("resolveStoredMessages still replaces when fetch returns rows", () => {
    expect(
      resolveStoredMessages({
        existing: [{ id: "msg_old" }],
        next: [{ id: "msg_new" }],
        completeness: "canonical",
      }).map((message) => message.id),
    ).toEqual(["msg_new"])
  })

  test("resolveStoredMessages prepends without dropping existing rows", () => {
    expect(
      resolveStoredMessages({
        existing: [{ id: "msg_2" }],
        next: [{ id: "msg_1" }],
        completeness: "canonical",
        mode: "prepend",
      }).map((message) => message.id),
    ).toEqual(["msg_1", "msg_2"])
  })

  test("fetchTransportSession starts messages without waiting for the session", async () => {
    // The messages request must not sit behind the session round-trip: it
    // consumes nothing from it, and serializing them put a whole extra
    // round-trip on the critical path of every cold switch. Proven by holding
    // the session promise open and asserting messages still runs.
    const order: string[] = []
    let releaseSession: (value: { data: { id: string } }) => void = () => {}
    const sessionGate = new Promise<{ data: { id: string } }>((resolve) => {
      releaseSession = resolve
    })
    const messagesStarted = Promise.withResolvers<void>()

    const pending = fetchTransportSession({
      shouldFetchSession: true,
      fetchSession: () => {
        order.push("session")
        return sessionGate
      },
      fetchMessages: async () => {
        order.push("messages")
        messagesStarted.resolve()
        return { data: [{ info: { id: "msg_1" } }], maxEventOrdinal: 12 }
      },
    })

    // Messages ran while the session request was still unresolved.
    await messagesStarted.promise
    expect(order).toEqual(["session", "messages"])

    releaseSession({ data: { id: "sess_1" } })
    const result = await pending
    expect(result.session?.data.id).toBe("sess_1")
    expect(result.messages.maxEventOrdinal).toBe(12)
  })

  test("fetchTransportSession skips session fetch for cached or paged loads", async () => {
    const order: string[] = []
    const result = await fetchTransportSession({
      shouldFetchSession: false,
      fetchSession: async () => {
        order.push("session")
        return { data: { id: "sess_1" } }
      },
      fetchMessages: async () => {
        order.push("messages")
        return { data: [] }
      },
    })

    expect(order).toEqual(["messages"])
    expect(result.session).toBeUndefined()
  })

  test("resolveStoredParts keeps existing part ids when snapshots are stale", () => {
    type TestPart = Pick<Part, "id"> & { text: string }
    expect(
      resolveStoredParts<TestPart>(
        [
          { id: "part_2", text: "streamed" },
          { id: "part_1", text: "local" },
        ],
        [
          { id: "part_2", text: "stale" },
          { id: "part_3", text: "snapshot" },
        ],
      ),
    ).toEqual([
      { id: "part_2", text: "streamed" },
      { id: "part_1", text: "local" },
      { id: "part_3", text: "snapshot" },
    ])
  })

  test("normalizeMessageRows filters control parts before controller and sync storage", () => {
    const page = normalizeMessageRows([
      {
        info: { id: "msg_2", role: "assistant" } as Message,
        parts: [
          { id: "patch_1", type: "patch" } as Part,
          { id: "part_2", type: "text" } as Part,
          { id: "", type: "text" } as Part,
        ],
      },
      {
        info: { id: "msg_1", role: "assistant" } as Message,
        parts: [{ id: "part_1", type: "text" } as Part],
      },
      { parts: [{ id: "part_orphan", type: "text" } as Part] },
    ])

    expect(page.messages.map((message) => message.id)).toEqual(["msg_2", "msg_1"])
    expect(page.parts).toEqual([
      { id: "msg_2", parts: [{ id: "part_2", type: "text" }] },
      { id: "msg_1", parts: [{ id: "part_1", type: "text" }] },
    ])
  })
})
