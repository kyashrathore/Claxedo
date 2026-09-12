import { describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import { dispatchSessionStatusEvent, dispatchSessionTodoEvent } from "../../store/session-status-dispatcher"
import {
  clearPendingPromptsForTest,
  markPendingPromptSent,
  registerPendingPrompt,
  hasPendingPrompt,
} from "../../store/pending-prompt-registry"
import { createGoalAwareAbort, createPromptAbort, createSubmitAbort, stopSessionInteraction } from "./submit-abort"

describe("goal-aware abort", () => {
  test("routes to the Goal Stop mutation while a Goal is active", async () => {
    let stops = 0
    let aborts = 0
    const abort = createGoalAwareAbort({
      hasActiveGoal: () => true,
      stopGoal: async () => { stops += 1 },
      promptAbort: async () => { aborts += 1 },
      onStopGoalError: () => { throw new Error("must not fire on success") },
    })
    await abort()
    expect(stops).toBe(1)
    expect(aborts).toBe(0)
  })

  test("surfaces a Goal Stop rejection and still interrupts the running turn", async () => {
    const failures: unknown[] = []
    let aborts = 0
    const abort = createGoalAwareAbort({
      hasActiveGoal: () => true,
      stopGoal: () => Promise.reject(new Error("relay unavailable")),
      promptAbort: async () => { aborts += 1 },
      onStopGoalError: (err) => failures.push(err),
    })
    // Call sites void this promise, so it must RESOLVE after reporting.
    await abort()
    expect(failures).toHaveLength(1)
    expect((failures[0] as Error).message).toBe("relay unavailable")
    // Stop must never be a no-op: the Goal is still running, so the local abort
    // has to interrupt the turn.
    expect(aborts).toBe(1)
  })

  test("a stale active-Goal snapshot still aborts the turn when Stop reports not_found", async () => {
    let aborts = 0
    const notFound = Object.assign(new Error("No Goal for this session"), {
      name: "SessionGoalMutationError",
      status: "not_found",
    })
    const abort = createGoalAwareAbort({
      hasActiveGoal: () => true,
      stopGoal: () => Promise.reject(notFound),
      promptAbort: async () => { aborts += 1 },
      onStopGoalError: () => {},
    })
    await abort()
    expect(aborts).toBe(1)
  })

  test("falls back to the prompt abort when no Goal is active", async () => {
    let aborts = 0
    const abort = createGoalAwareAbort({
      hasActiveGoal: () => false,
      stopGoal: async () => { throw new Error("must not stop a Goal") },
      promptAbort: async () => { aborts += 1 },
      onStopGoalError: () => {},
    })
    await abort()
    expect(aborts).toBe(1)
  })
})

test("interaction Stop pauses only its owning active Goal", async () => {
  const calls: string[] = []
  const handlers = { stopGoal: async () => { calls.push("goal") }, abort: async () => { calls.push("abort") } }
  await stopSessionInteraction({ sessionId: "parent", goal: { sessionId: "parent", status: "active" }, ...handlers })
  await stopSessionInteraction({ sessionId: "child", goal: { sessionId: "parent", status: "active" }, ...handlers })
  expect(calls).toEqual(["goal", "abort"])
})

test("interaction Stop surfaces Goal failure after interrupting its turn", async () => {
  let aborted = false
  await expect(stopSessionInteraction({ sessionId: "owner", goal: { sessionId: "owner", status: "active" },
    stopGoal: async () => { throw new Error("Goal unavailable") }, abort: async () => { aborted = true },
  })).rejects.toThrow("Goal unavailable")
  expect(aborted).toBe(true)
})

describe("prompt Stop results", () => {
  test.each(["transport", "failed", "recovering"])("reports %s failure without clearing authoritative state", async (failure) => {
    const toasts: Array<{ description: string }> = []
    let reads = 0
    const abort = createSubmitAbort({
      sessionID: () => "stop-failure",
      defaultDirectory: "/repo",
      clientForDirectory: () => ({
        session: {
          abort: async () => {
            if (failure === "transport") throw new Error("Stop request failed")
            return { data: { ok: false as const, status: failure, message: "Stop request failed" } }
          },
          status: async () => { reads++; return { data: {} } },
        },
        permission: { list: async () => { reads++; return { data: [] } } },
        question: { list: async () => { reads++; return { data: [] } } },
      }),
      stopFailedTitle: () => "Request failed",
      stopGoalFailedTitle: () => "Goal Stop failed",
      errorMessage: (error) => (error as Error).message,
      showToast: (toast) => { toasts.push(toast) },
    })
    await expect(abort()).resolves.toBeUndefined()
    expect(toasts).toEqual([{ title: "Request failed", description: "Stop request failed", variant: "error" }])
    expect(reads).toBe(0)
  })

  test("acknowledged Stop refreshes the server snapshot", async () => {
    const calls: string[] = []
    await createPromptAbort({
      sessionID: () => "stop-success",
      defaultDirectory: "/repo",
      clientForDirectory: () => ({
        session: {
          abort: async () => { calls.push("abort"); return { data: { ok: true as const, status: "already_idle" as const } } },
          status: async () => { calls.push("status"); return { data: {} } },
        },
        permission: { list: async () => { calls.push("permissions"); return { data: [] } } },
        question: { list: async () => { calls.push("questions"); return { data: [] } } },
      }),
    })()
    expect(calls).toEqual(["abort", "status", "permissions", "questions"])
  })
})

describe("which turn Stop names", () => {
  const abortWith = (sessionID: string, seen: Array<string | undefined>, turnId?: string) => createPromptAbort({
    sessionID: () => sessionID,
    defaultDirectory: "/repo",
    ...(turnId ? { turnId: () => turnId } : {}),
    clientForDirectory: () => ({
      session: {
        abort: async (input: { turnId?: string }) => {
          seen.push(input.turnId)
          return { data: { ok: true as const, status: "cancelled" as const } }
        },
        status: async () => ({ data: {} }),
      },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
    }),
  })

  test("names the turn this composer started", async () => {
    const seen: Array<string | undefined> = []
    await abortWith("ses_scoped", seen, "msg_first")()
    expect(seen).toEqual(["msg_first"])
  })

  test("names no turn when this composer started none", async () => {
    const seen: Array<string | undefined> = []
    await abortWith("ses_unscoped", seen)()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeUndefined()
  })
})

describe("prompt Stop feedback", () => {
  const sessionSnapshot = (sessionID: string) => ({
    status: queryClient.getQueryData(shellDataKeys.sessionId(sessionID, "status")),
    todos: queryClient.getQueryData(shellDataKeys.sessionId(sessionID, "todo")),
  })

  const runningSession = (sessionID: string) => {
    dispatchSessionStatusEvent({ event: { type: "session.status", source: "server", sessionID, status: { type: "busy" } } })
    dispatchSessionTodoEvent({
      event: { type: "session.todo", source: "server", sessionID, todos: [{ content: "run the build", status: "in_progress", priority: "high" }] },
    })
  }

  test("reports the turn stopped before the abort answers", async () => {
    const sessionID = "ses_stop_optimistic"
    runningSession(sessionID)
    let answerAbort = () => {}
    const abort = createPromptAbort({
      sessionID: () => sessionID,
      defaultDirectory: "/repo",
      clientForDirectory: () => ({
        session: {
          abort: () => new Promise((resolve) => {
            answerAbort = () => resolve({ data: { ok: true as const, status: "already_idle" as const } })
          }),
          status: async () => ({ data: { [sessionID]: { type: "idle" as const } } }),
        },
        permission: { list: async () => ({ data: [] }) },
        question: { list: async () => ({ data: [] }) },
      }),
    })
    const stopped = abort()
    expect(sessionSnapshot(sessionID)).toEqual({ status: { type: "idle" }, todos: [] })
    answerAbort()
    await stopped
  })

  test("a failed request refresh leaves the acknowledged Stop successful", async () => {
    const sessionID = "ses_stop_refresh_failure"
    runningSession(sessionID)
    const abort = createPromptAbort({
      sessionID: () => sessionID,
      defaultDirectory: "/repo",
      clientForDirectory: () => ({
        session: {
          abort: async () => ({ data: { ok: true as const, status: "already_idle" as const } }),
          status: async () => ({ data: { [sessionID]: { type: "idle" as const } } }),
        },
        permission: { list: () => Promise.reject(new Error("permission list unavailable")) },
        question: { list: async () => ({ data: [] }) },
      }),
    })
    await expect(abort()).resolves.toBeUndefined()
    expect(sessionSnapshot(sessionID)).toEqual({ status: { type: "idle" }, todos: [] })
  })

  test("a rejected abort reports the Stop as failed", async () => {
    const abort = createPromptAbort({
      sessionID: () => "ses_stop_rejected",
      defaultDirectory: "/repo",
      clientForDirectory: () => ({
        session: {
          abort: () => Promise.reject(new Error("Stop request failed")),
          status: async () => ({ data: {} }),
        },
        permission: { list: async () => ({ data: [] }) },
        question: { list: async () => ({ data: [] }) },
      }),
    })
    await expect(abort()).rejects.toThrow("Stop request failed")
  })

  test("cancels a prompt still queued locally and asks the runtime for one already sent", async () => {
    clearPendingPromptsForTest()
    const calls: string[] = []
    const promptAbort = (sessionID: string) => createPromptAbort({
      sessionID: () => sessionID,
      defaultDirectory: "/repo",
      clientForDirectory: () => ({
        session: {
          abort: async () => { calls.push("runtime-abort"); return { data: { ok: true as const, status: "already_idle" as const } } },
          status: async () => ({ data: {} }),
        },
        permission: { list: async () => ({ data: [] }) },
        question: { list: async () => ({ data: [] }) },
      }),
    })

    const controller = new AbortController()
    registerPendingPrompt("ses_queued", { abort: controller, cleanup: () => calls.push("cleanup") })
    await promptAbort("ses_queued")()
    expect(calls).toEqual(["cleanup"])
    expect(controller.signal.aborted).toBe(true)
    expect(hasPendingPrompt("ses_queued")).toBe(false)

    registerPendingPrompt("ses_sent", { abort: new AbortController(), cleanup: () => calls.push("cleanup") })
    markPendingPromptSent("ses_sent")
    await promptAbort("ses_sent")()
    expect(calls).toEqual(["cleanup", "runtime-abort"])
    expect(hasPendingPrompt("ses_sent")).toBe(false)
  })
})
