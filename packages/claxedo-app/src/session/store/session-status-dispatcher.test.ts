import { afterEach, describe, expect, test } from "bun:test"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { queryClient } from "../../shared/query/query-client"
import { shellDataKeys } from "../../shell/data/keys"
import { setSessionStatusQueryData } from "../../shell/data/queries"
import {
  SESSION_STATUS_TIMEOUTS,
  applySessionStatusSseEvent,
  clearAllPromptSessionStatusTimeoutsForTest,
  dispatchSessionRequestsEvent,
  dispatchSessionStatusEvent,
  dispatchSessionStatusTimeoutStage,
  dispatchSessionTodoEvent,
  promptSessionStatusMeta,
  promptSessionStatusStage,
  subscribePromptSessionStatusMeta,
} from "./session-status-dispatcher"
import {
  SESSION_STATUS_TELEMETRY_CONFIG,
  observeSessionStatusPoll,
  resetSessionStatusTelemetryForTest,
  sessionStatusPollingRemovalGate,
} from "./session-status-telemetry"

afterEach(() => {
  clearAllPromptSessionStatusTimeoutsForTest()
  queryClient.clear()
  resetSessionStatusTelemetryForTest()
})

describe("session-status dispatcher", () => {
  test("accepts optimistic events and server reconciliation through shell query state", () => {
    const now = 10_000

    dispatchSessionStatusEvent({
      event: {
        type: "session.status",
        source: "optimistic",
        sessionID: "ses_dispatch",
        status: { type: "busy" },
        deadline: now + 30_000,
        now,
      },
    })
    expect(statusFor("ses_dispatch")).toEqual({ type: "busy" })
    expect(promptSessionStatusMeta("ses_dispatch")).toEqual({
      source: "optimistic",
      started: now,
      deadline: now + 30_000,
    })
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_dispatch", "status-meta"))).toEqual({
      source: "optimistic",
      started: now,
      deadline: now + 30_000,
    })

    dispatchSessionStatusEvent({
      event: { type: "session.idle", source: "server", sessionID: "ses_dispatch" },
    })

    expect(statusFor("ses_dispatch")).toEqual({ type: "idle" })
    expect(promptSessionStatusMeta("ses_dispatch")).toBeUndefined()
  })

  test("re-submitting an optimistic busy preserves the original started and deadline", () => {
    dispatchSessionStatusEvent({
      event: {
        type: "session.status",
        source: "optimistic",
        sessionID: "ses",
        status: { type: "busy" },
        deadline: 31_000,
        now: 1_000,
      },
    })

    dispatchSessionStatusEvent({
      event: {
        type: "session.status",
        source: "optimistic",
        sessionID: "ses",
        status: { type: "busy" },
        now: 6_000,
      },
    })

    expect(statusFor("ses")).toEqual({ type: "busy" })
    expect(promptSessionStatusMeta("ses")).toEqual({
      source: "optimistic",
      started: 1_000,
      deadline: 31_000,
    })
  })

  test("absent server status records idle and clears optimistic metadata", () => {
    dispatchSessionStatusEvent({
      event: {
        type: "session.status",
        source: "optimistic",
        sessionID: "ses_clear",
        status: { type: "busy" },
        now: 1,
      },
    })

    dispatchSessionStatusEvent({
      event: { type: "session.status", source: "server", sessionID: "ses_clear" },
    })

    expect(statusFor("ses_clear")).toEqual({ type: "idle" })
    expect(promptSessionStatusMeta("ses_clear")).toBeUndefined()
  })

  test("session.status SSE event reconciles status without polling", () => {
    applySessionStatusSseEvent({
      event: { type: "session.status", properties: { sessionID: "ses_stream", status: { type: "idle" } } },
      directory: "/tmp/ws",
    })

    expect(statusFor("ses_stream")).toEqual({ type: "idle" })
    expect(sessionStatusPollingRemovalGate({
      directory: "/tmp/ws",
      sessionID: "ses_stream",
    })).toEqual({
      canDisablePolling: false,
      reason: "missing-matching-poll-evidence",
      eventStatusCount: 1,
      matchingPollCount: 0,
      disagreements: [],
    })

    const now = Date.now()
    for (let i = 0; i < SESSION_STATUS_TELEMETRY_CONFIG.matchesRequired; i++) {
      observeSessionStatusPoll({
        directory: "/tmp/ws",
        sessionID: "ses_stream",
        status: { type: "idle" },
        now: now + i,
      })
    }
    const open = sessionStatusPollingRemovalGate({
      directory: "/tmp/ws",
      sessionID: "ses_stream",
      now: now + SESSION_STATUS_TELEMETRY_CONFIG.matchesRequired,
    })
    expect(open.canDisablePolling).toBe(true)
    expect(open.reason).toBe("event-path-clean")
  })

  test("session.error releases optimistic busy status", () => {
    dispatchSessionStatusEvent({
      event: {
        type: "session.status",
        source: "optimistic",
        sessionID: "ses_error",
        status: { type: "busy" },
      },
    })

    applySessionStatusSseEvent({
      event: { type: "session.error", properties: { sessionID: "ses_error" } },
      directory: "/tmp/ws",
    })

    expect(statusFor("ses_error")).toEqual({ type: "idle" })
    expect(promptSessionStatusMeta("ses_error")).toBeUndefined()
  })

  test("session.idle releases optimistic busy status", () => {
    dispatchSessionStatusEvent({
      event: {
        type: "session.status",
        source: "optimistic",
        sessionID: "ses_idle",
        status: { type: "busy" },
      },
    })

    applySessionStatusSseEvent({
      event: { type: "session.idle", properties: { sessionID: "ses_idle" } },
      directory: "/tmp/ws",
    })

    expect(statusFor("ses_idle")).toEqual({ type: "idle" })
    expect(promptSessionStatusMeta("ses_idle")).toBeUndefined()
  })

  test("timeout queues refresh before showing pending status", () => {
    dispatchSessionStatusEvent({
      event: {
        type: "session.status",
        source: "optimistic",
        sessionID: "ses_watch",
        status: { type: "busy" },
        now: 1_000,
        deadline: 1_000 + SESSION_STATUS_TIMEOUTS.failure,
      },
    })

    expect(dispatchSessionStatusTimeoutStage({
      event: { type: "session.status.timeout", sessionID: "ses_watch", stage: "redispatch" },
    })).toBe(true)
    expect(statusFor("ses_watch")).toEqual({ type: "busy" })
    expect(promptSessionStatusStage("ses_watch")).toBe("redispatch")
  })

  test("timeout surfaces delayed optimistic status", () => {
    dispatchSessionStatusEvent({
      event: {
        type: "session.status",
        source: "optimistic",
        sessionID: "ses_watch",
        status: { type: "busy" },
        now: 1_000,
        deadline: 1_000 + SESSION_STATUS_TIMEOUTS.failure,
      },
    })

    dispatchSessionStatusTimeoutStage({
      event: { type: "session.status.timeout", sessionID: "ses_watch", stage: "pending" },
    })

    expect(statusFor("ses_watch")).toEqual({
      type: "retry",
      attempt: 1,
      message: "Still waiting for the server to acknowledge this run.",
      next: 0,
    })
    expect(promptSessionStatusStage("ses_watch")).toBe("pending")
  })

  test("server status clears timeout metadata after delayed optimistic status", () => {
    dispatchSessionStatusEvent({
      event: {
        type: "session.status",
        source: "optimistic",
        sessionID: "ses_watch",
        status: { type: "busy" },
      },
    })
    dispatchSessionStatusTimeoutStage({
      event: { type: "session.status.timeout", sessionID: "ses_watch", stage: "pending" },
    })

    dispatchSessionStatusEvent({
      event: { type: "session.status", source: "server", sessionID: "ses_watch", status: { type: "busy" } },
    })

    expect(statusFor("ses_watch")).toEqual({ type: "busy" })
    expect(promptSessionStatusMeta("ses_watch")).toBeUndefined()
  })

  test("late timeout stage does not revive status after server metadata clear", () => {
    dispatchSessionStatusEvent({
      event: {
        type: "session.status",
        source: "optimistic",
        sessionID: "ses_watch",
        status: { type: "busy" },
      },
    })
    dispatchSessionStatusEvent({
      event: { type: "session.status", source: "server", sessionID: "ses_watch", status: { type: "busy" } },
    })

    dispatchSessionStatusTimeoutStage({
      event: { type: "session.status.timeout", sessionID: "ses_watch", stage: "pending" },
    })

    expect(statusFor("ses_watch")).toEqual({ type: "busy" })
    expect(promptSessionStatusMeta("ses_watch")).toBeUndefined()
  })

  test("optimistic flap busy to idle to busy starts a fresh optimistic window", () => {
    const sessionID = "ses_flap"

    dispatchSessionStatusEvent({
      event: { type: "session.status", source: "optimistic", sessionID, status: { type: "busy" }, now: 10_000 },
    })
    expect(promptSessionStatusMeta(sessionID)?.started).toBe(10_000)

    dispatchSessionStatusEvent({
      event: { type: "session.idle", source: "optimistic", sessionID, now: 15_000 },
    })
    expect(promptSessionStatusMeta(sessionID)).toBeUndefined()

    dispatchSessionStatusEvent({
      event: { type: "session.status", source: "optimistic", sessionID, status: { type: "busy" }, now: 18_000 },
    })
    expect(promptSessionStatusMeta(sessionID)?.started).toBe(18_000)
  })

  test("server event wins over a concurrent optimistic write until a later optimistic event arrives", () => {
    const sessionID = "ses_race"

    dispatchSessionStatusEvent({
      event: { type: "session.status", source: "optimistic", sessionID, status: { type: "busy" }, now: 1 },
    })
    dispatchSessionStatusEvent({
      event: { type: "session.idle", source: "server", sessionID, now: 2 },
    })
    expect(statusFor(sessionID)).toEqual({ type: "idle" })
    expect(promptSessionStatusMeta(sessionID)).toBeUndefined()

    dispatchSessionStatusEvent({
      event: { type: "session.status", source: "optimistic", sessionID, status: { type: "busy" }, now: 3 },
    })
    expect(statusFor(sessionID)).toEqual({ type: "busy" })
    expect(promptSessionStatusMeta(sessionID)?.source).toBe("optimistic")
  })

  test("timeout stage walks forward and ignores repeated or lower stages", () => {
    const sessionID = "ses_timeout"
    dispatchSessionStatusEvent({
      event: {
        type: "session.status",
        source: "optimistic",
        sessionID,
        status: { type: "busy" },
        now: 100_000,
        deadline: 100_000 + SESSION_STATUS_TIMEOUTS.failure,
      },
    })

    expect(dispatchSessionStatusTimeoutStage({
      event: { type: "session.status.timeout", sessionID, stage: "redispatch" },
    })).toBe(true)
    expect(promptSessionStatusStage(sessionID)).toBe("redispatch")

    expect(dispatchSessionStatusTimeoutStage({
      event: { type: "session.status.timeout", sessionID, stage: "redispatch" },
    })).toBe(false)
    expect(promptSessionStatusStage(sessionID)).toBe("redispatch")

    dispatchSessionStatusTimeoutStage({
      event: { type: "session.status.timeout", sessionID, stage: "pending" },
    })
    expect(promptSessionStatusStage(sessionID)).toBe("pending")

    dispatchSessionStatusTimeoutStage({
      event: { type: "session.status.timeout", sessionID, stage: "long" },
    })
    expect(promptSessionStatusStage(sessionID)).toBe("long")

    dispatchSessionStatusTimeoutStage({
      event: { type: "session.status.timeout", sessionID, stage: "failed" },
    })
    expect(promptSessionStatusStage(sessionID)).toBe("failed")
  })

  test("timeout stage clears meta once status reaches idle", () => {
    const sessionID = "ses_idle_clear"
    dispatchSessionStatusEvent({
      event: {
        type: "session.status",
        source: "optimistic",
        sessionID,
        status: { type: "busy" },
      },
    })
    setSessionStatusQueryData({ queryClient, sessionId: sessionID, status: { type: "idle" } })

    dispatchSessionStatusTimeoutStage({
      event: { type: "session.status.timeout", sessionID, stage: "pending" },
    })

    expect(promptSessionStatusMeta(sessionID)).toBeUndefined()
  })

  test("concurrent dispatch for two different sessions does not cross-contaminate meta", () => {
    dispatchSessionStatusEvent({
      event: { type: "session.status", source: "optimistic", sessionID: "ses_a", status: { type: "busy" }, now: 1 },
    })
    dispatchSessionStatusEvent({
      event: { type: "session.status", source: "optimistic", sessionID: "ses_b", status: { type: "busy" }, now: 2 },
    })
    expect(promptSessionStatusMeta("ses_a")?.started).toBe(1)
    expect(promptSessionStatusMeta("ses_b")?.started).toBe(2)

    dispatchSessionStatusEvent({
      event: { type: "session.idle", source: "server", sessionID: "ses_a", now: 3 },
    })
    expect(statusFor("ses_a")).toEqual({ type: "idle" })
    expect(promptSessionStatusMeta("ses_a")).toBeUndefined()
    expect(statusFor("ses_b")).toEqual({ type: "busy" })
    expect(promptSessionStatusMeta("ses_b")?.started).toBe(2)
  })

  test("server status arriving before any optimistic write is recorded without conjuring meta", () => {
    dispatchSessionStatusEvent({
      event: { type: "session.status", source: "server", sessionID: "ses_cold", status: { type: "busy" } },
    })
    expect(statusFor("ses_cold")).toEqual({ type: "busy" })
    expect(promptSessionStatusMeta("ses_cold")).toBeUndefined()
  })

  test("request events write through the dispatcher and support updater functions", () => {
    dispatchSessionRequestsEvent({
      event: {
        type: "session.requests",
        source: "optimistic",
        sessionID: "ses_requests",
        requests: {
          permissions: [{ id: "perm_1", sessionID: "ses_requests" } as never],
          questions: [],
        },
      },
    })

    dispatchSessionRequestsEvent({
      event: {
        type: "session.requests",
        source: "server",
        sessionID: "ses_requests",
        requests: (previous) => ({
          permissions: previous?.permissions ?? [],
          questions: [{ id: "question_1", sessionID: "ses_requests" } as never],
        }),
      },
    })

    expect(requestsFor("ses_requests")).toEqual({
      permissions: [{ id: "perm_1", sessionID: "ses_requests" }],
      questions: [{ id: "question_1", sessionID: "ses_requests" }],
    })
  })

  test("todo events write through the dispatcher", () => {
    dispatchSessionTodoEvent({
      event: {
        type: "session.todo",
        source: "server",
        sessionID: "ses_todo",
        todos: [{ id: "todo_1", content: "ship", status: "pending" } as never],
      },
    })

    expect(todoFor("ses_todo")).toEqual([{ id: "todo_1", content: "ship", status: "pending" }])
  })

  test("optimistic metadata stays query-owned instead of a private Solid signal mirror", async () => {
    const source = await Bun.file(new URL("./session-status-dispatcher.ts", import.meta.url)).text()

    expect(source).not.toContain("createSignal")
    expect(source).not.toContain("promptSessionStatusMetaBySession")
    expect(source).toContain('shellDataKeys.sessionId(sessionID, "status-meta")')
  })

  test("subscribePromptSessionStatusMeta notifies on stage writes and on the reconcile clear, for its session only", () => {
    const now = 10_000
    let notified = 0
    const unsubscribe = subscribePromptSessionStatusMeta("ses_sub", () => notified++)

    dispatchSessionStatusEvent({
      event: { type: "session.status", source: "optimistic", sessionID: "ses_sub", status: { type: "busy" }, now },
    })
    const afterOptimistic = notified
    expect(afterOptimistic).toBeGreaterThan(0)

    // A different session's meta writes must not notify this subscriber.
    dispatchSessionStatusEvent({
      event: { type: "session.status", source: "optimistic", sessionID: "ses_other", status: { type: "busy" }, now },
    })
    expect(notified).toBe(afterOptimistic)

    // Escalation stage write (the read path consumers re-read on notify).
    dispatchSessionStatusTimeoutStage({
      event: { type: "session.status.timeout", sessionID: "ses_sub", stage: "pending" },
    })
    const afterStage = notified
    expect(afterStage).toBeGreaterThan(afterOptimistic)
    expect(promptSessionStatusStage("ses_sub")).toBe("pending")

    // Server reconciliation clears meta via removeQueries — must also notify.
    dispatchSessionStatusEvent({
      event: { type: "session.idle", source: "server", sessionID: "ses_sub" },
    })
    expect(notified).toBeGreaterThan(afterStage)
    expect(promptSessionStatusStage("ses_sub")).toBeUndefined()

    unsubscribe()
    const afterUnsubscribe = notified
    dispatchSessionStatusEvent({
      event: { type: "session.status", source: "optimistic", sessionID: "ses_sub", status: { type: "busy" }, now },
    })
    expect(notified).toBe(afterUnsubscribe)
  })
})

function statusFor(sessionID: string) {
  return queryClient.getQueryData<SessionStatus>(shellDataKeys.sessionId(sessionID, "status"))
}

function requestsFor(sessionID: string) {
  return queryClient.getQueryData(shellDataKeys.sessionId(sessionID, "requests"))
}

function todoFor(sessionID: string) {
  return queryClient.getQueryData(shellDataKeys.sessionId(sessionID, "todo"))
}
