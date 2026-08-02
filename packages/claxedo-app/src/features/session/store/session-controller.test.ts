import { afterEach, describe, expect, test } from "bun:test"
import type { Message, Part, PermissionRequest, QuestionRequest, Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
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
  firstFoldSessionHydrateDelay,
  firstFoldSessionPrefetch,
  isSessionNotFoundError,
  removeDirectorySessionCacheRow,
  resolveStoredMessages,
  resolveStoredParts,
  shouldDeferSessionTransportHydrate,
  sessionHistoryKey,
  shouldSkipSessionTransportHydrate,
  shouldStartActiveSessionStatusPolling,
  shouldHydrateSession,
  shouldReuseSessionHistory,
  syncSessionMeta,
  waitForFirstActiveSessionStatusPoll,
} from "./session-controller"
import { backfillFailedCursor, createHistoryMetaState, historyHasMore } from "./history-pagination"
import {
  SESSION_STATUS_TELEMETRY_CONFIG,
  observeSessionStatusEvent,
  observeSessionStatusPoll,
  resetSessionStatusTelemetryForTest,
  sessionStatusPollDisagreements,
} from "./session-status-telemetry"
import { normalizeMessageRows } from "./message-page"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import { directorySessionCacheQueryOptions, setSessionStatusQueryData } from "../data/sync/queries"
import {
  clearConversationChatRegistryForTest,
  hydrateRegisteredConversationSnapshot,
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
    expect(shouldReuseSessionHistory({
      hasSession: true,
      cached: true,
    })).toBe(true)
    expect(shouldReuseSessionHistory({
      hasSession: true,
      cached: true,
      signedControlPlane: true,
    })).toBe(false)
    expect(shouldReuseSessionHistory({
      hasSession: true,
      cached: true,
      force: true,
    })).toBe(false)
    expect(shouldReuseSessionHistory({
      before: "cursor_1",
      hasSession: true,
      cached: true,
    })).toBe(false)
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
    expect(historyHasMore(base, "k")).toBe(true)
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
    expect(historyHasMore(meta(), key)).toBe(true)

    const recorded = backfillFailedCursor({ before: "cur_older", sessionNotFound: false })
    expect(recorded).toBe("cur_older")
    setValue("failedCursor", key, recorded)
    expect(historyHasMore(meta(), key)).toBe(false)
  })

  test("identifies missing session transport errors", () => {
    expect(isSessionNotFoundError(new Error("Request failed: 404"))).toBe(true)
    expect(isSessionNotFoundError({ error: { code: "session_not_found", message: "Session not found" } })).toBe(true)
    expect(isSessionNotFoundError(new Error("Request failed: 500"))).toBe(false)
  })

  test("assistant error messages count as present even without renderable parts", () => {
    hydrateRegisteredConversationSnapshot({
      sessionID: "ses_error",
      messages: [{
        id: "msg_assistant",
        sessionID: "ses_error",
        role: "assistant",
        parentID: "msg_user",
        time: { created: 1, completed: 2 },
        error: { name: "UnknownError", data: { message: "provider failed" } },
      } as Message],
      parts: { msg_assistant: [] },
    })

    expect(conversationHasAssistantMessage("ses_error", "msg_assistant")).toBe(true)
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
      messages: [{ id: "msg_1", role: "user" } as Message],
    }

    expect(firstFoldSessionPrefetch({
      sessionID: "ses_1",
      directory: "/repo/main",
      info,
      now: 1_010,
    })).toBe(info)
    expect(firstFoldSessionPrefetch({
      sessionID: "ses_1",
      directory: "/repo/other",
      info,
      now: 1_010,
    })).toBeUndefined()
    expect(firstFoldSessionPrefetch({
      sessionID: "ses_1",
      directory: "/repo/main",
      info: { ...info, messages: [] },
      now: 1_010,
    })).toBeUndefined()
    expect(firstFoldSessionPrefetch({
      sessionID: "ses_1",
      directory: "/repo/main",
      info,
      now: 1_000 + 15_001,
    })).toBeUndefined()
  })

  test("session switch transport refresh is deferred past the 30ms first-fold budget", () => {
    expect(FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS).toBeGreaterThan(30)
    expect(FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS).toBeGreaterThanOrEqual(900)
    expect(FIRST_FOLD_SESSION_META_HYDRATE_DELAY_MS).toBeGreaterThan(FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS)
  })

  test("fast session switches keep target background hydration outside the interaction window", () => {
    const now = 1_000
    ;(globalThis as typeof globalThis & {
      window?: {
        __claxedoFastSessionSwitch?: { sessionId: string; until: number; networkQuietUntil?: number }
      }
    }).window = {
      __claxedoFastSessionSwitch: {
        sessionId: "ses_next",
        until: now + 250,
        networkQuietUntil: now + FAST_SESSION_SWITCH_NETWORK_QUIET_MS,
      },
    }

    expect(firstFoldSessionHydrateDelay({
      sessionID: "ses_next",
      prefetched: true,
      now,
    })).toBe(FAST_SESSION_SWITCH_NETWORK_QUIET_MS)
    expect(firstFoldSessionHydrateDelay({
      sessionID: "ses_next",
      prefetched: false,
      now,
    })).toBe(0)
    expect(firstFoldSessionHydrateDelay({
      sessionID: "ses_other",
      prefetched: true,
      now,
    })).toBe(FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS)
  })

  test("first visible session hydrate bypasses the fast-switch network quiet gate", () => {
    const now = 1_000
    ;(globalThis as typeof globalThis & {
      window?: {
        __claxedoFastSessionSwitch?: { sessionId: string; until: number; networkQuietUntil?: number }
      }
    }).window = {
      __claxedoFastSessionSwitch: {
        sessionId: "ses_next",
        until: now + 250,
        networkQuietUntil: now + FAST_SESSION_SWITCH_NETWORK_QUIET_MS,
      },
    }

    expect(shouldSkipSessionTransportHydrate({
      sessionID: "ses_next",
      now,
    })).toBe(true)
    expect(shouldSkipSessionTransportHydrate({
      sessionID: "ses_next",
      bypassQuiet: true,
      now,
    })).toBe(false)
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
    expect(acceptedPromptRefreshMatches({ request, sessionID: "ses_created", currentDirectory: "/repo/other" })).toBe(false)
    expect(acceptedPromptRefreshMatches({ request, sessionID: "ses_created", currentDirectory: "/repo/main" })).toBe(true)
  })

  test("active-turn settlement is scoped to the same session history key", () => {
    const previous = activeTurnTransition({
      directory: "/repo/main",
      sessionID: "ses_busy",
      active: true,
    }).next

    expect(activeTurnTransition({
      previous,
      directory: "/repo/main",
      sessionID: "ses_idle",
      active: false,
    }).settled).toBe(false)
    expect(activeTurnTransition({
      previous,
      directory: "/repo/main",
      sessionID: "ses_busy",
      active: false,
    }).settled).toBe(true)
    expect(activeTurnTransition({
      previous,
      directory: "/repo/other",
      sessionID: "ses_busy",
      active: false,
    }).settled).toBe(false)
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

    expect(shouldStartActiveSessionStatusPolling({
      directory: "/repo/main",
      sessionID: "ses_1",
    })).toBe(true)

    observeSessionStatusEvent({
      directory: "/repo/main",
      sessionID: "ses_1",
      status: idle,
      now,
    })
    expect(shouldStartActiveSessionStatusPolling({
      directory: "/repo/main",
      sessionID: "ses_1",
    })).toBe(true)

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
    expect(shouldStartActiveSessionStatusPolling({
      directory: "/repo/main",
      sessionID: "ses_1",
    })).toBe(false)
    expect(shouldStartActiveSessionStatusPolling({
      directory: "/repo/main",
      sessionID: "ses_2",
    })).toBe(true)

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
    const queryEnabled = (input: { directory?: string; sessionID: string }) => shouldStartActiveSessionStatusPolling(input)
    expect(queryEnabled({ directory, sessionID })).toBe(false)

    // 5. A DIFFERENT session (no event evidence yet) still gets polled —
    //    the gate is per-session, not global.
    expect(queryEnabled({ directory, sessionID: "ses_t10_other" })).toBe(true)

    resetSessionStatusTelemetryForTest()
  })

  test("active-session status polling decision exposes the telemetry gate reason", () => {
    resetSessionStatusTelemetryForTest()
    const now = Date.now()

    expect(activeSessionStatusPollingDecision({
      directory: "/repo/main",
      sessionID: "ses_1",
    })).toMatchObject({
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
    expect(activeSessionStatusPollingDecision({
      directory: "/repo/main",
      sessionID: "ses_1",
    })).toMatchObject({
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
    expect(activeSessionStatusPollingDecision({
      directory: "/repo/main",
      sessionID: "ses_1",
    })).toMatchObject({
      shouldStart: false,
      canDisablePolling: true,
      reason: "event-path-clean",
    })

    resetSessionStatusTelemetryForTest()
  })

  test("resolveStoredMessages keeps visible messages when replace fetch is empty", () => {
    expect(
      resolveStoredMessages({
        existing: [{ id: "msg_1" }, { id: "msg_2" }],
        next: [],
      }).map((message) => message.id),
    ).toEqual(["msg_1", "msg_2"])
  })

  test("resolveStoredMessages still replaces when fetch returns rows", () => {
    expect(
      resolveStoredMessages({
        existing: [{ id: "msg_old" }],
        next: [{ id: "msg_new" }],
      }).map((message) => message.id),
    ).toEqual(["msg_new"])
  })

  test("resolveStoredMessages prepends without dropping existing rows", () => {
    expect(
      resolveStoredMessages({
        existing: [{ id: "msg_2" }],
        next: [{ id: "msg_1" }],
        mode: "prepend",
      }).map((message) => message.id),
    ).toEqual(["msg_1", "msg_2"])
  })

  test("fetchTransportSession fetches session before messages", async () => {
    const order: string[] = []
    const result = await fetchTransportSession({
      shouldFetchSession: true,
      fetchSession: async () => {
        order.push("session")
        return { data: { id: "sess_1" } }
      },
      fetchMessages: async () => {
        order.push("messages")
        return { data: [{ info: { id: "msg_1" } }], maxEventOrdinal: 12 }
      },
    })

    expect(order).toEqual(["session", "messages"])
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
        [{ id: "part_2", text: "streamed" }, { id: "part_1", text: "local" }],
        [{ id: "part_2", text: "stale" }, { id: "part_3", text: "snapshot" }],
      ),
    ).toEqual([
      { id: "part_1", text: "local" },
      { id: "part_2", text: "streamed" },
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

    expect(page.messages.map((message) => message.id)).toEqual(["msg_1", "msg_2"])
    expect(page.parts).toEqual([
      { id: "msg_1", parts: [{ id: "part_1", type: "text" }] },
      { id: "msg_2", parts: [{ id: "part_2", type: "text" }] },
    ])
  })
})
