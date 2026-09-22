import { afterEach, describe, expect, spyOn, test } from "bun:test"
import type { RecoveryOperation, RecoveryOperationState, RecoveryOutcome, RecoveryRequest, RecoveryTurnTarget } from "@claxedo/agent-runtime-contract"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import * as analytics from "@/platform/telemetry/analytics"
import { dispatchSessionStatusEvent, dispatchSessionTodoEvent } from "../../store/session-status-dispatcher"
import {
  clearPendingPromptsForTest,
  markPendingPromptSent,
  registerPendingPrompt,
  hasPendingPrompt,
} from "../../store/pending-prompt-registry"
import { createGoalAwareAbort, createPromptAbort, createSubmitAbort, stopRunningTurn, stopSessionInteraction } from "./submit-abort"
import { clearSessionRecoveryCommand, sessionRecoveryCommand } from "../../store/session-status-dispatcher"

function target(sessionId: string, turnId = "msg_running"): RecoveryTurnTarget {
  return { scope: "turn", workspaceId: "ws_1", sessionId, turnId, ownerGeneration: "lease_1" }
}

type Facts = RecoveryOperation["facts"]

function facts(execution: "running" | "terminal" | "unknown", cleanup: "owned" | "verified_clear" | "unknown", persistence: "committed" | "pending" | "unavailable"): Facts {
  return {
    execution: { value: execution, source: "codex", observedAt: 1_000, generation: "lease_1" },
    cleanup: { value: cleanup, source: "codex", observedAt: 1_000, generation: "lease_1" },
    persistence: { value: persistence, source: "store", observedAt: 1_000, generation: "lease_1" },
  }
}

/** What a harness that cannot prove cleanup reports for a turn it did stop. */
const STOPPED_CLEANUP_UNVERIFIED = facts("terminal", "unknown", "committed")
const STOPPED_AND_PROVEN = facts("terminal", "verified_clear", "committed")
const STILL_RUNNING = facts("unknown", "unknown", "pending")
const SAVE_FAILED = facts("terminal", "unknown", "pending")

function operation(
  request: RecoveryRequest,
  state: RecoveryOperationState,
  value: Facts = STOPPED_AND_PROVEN,
  error?: string,
): RecoveryOperation {
  return {
    operationId: "op_1",
    requestId: request.requestId,
    target: request.target,
    action: request.action,
    scopeRevision: request.scopeRevision,
    attempt: request.attempt,
    state,
    phase: "graceful_cancel",
    phaseDeadlineAt: 2_000,
    facts: value,
    ...(error
      ? {
          initiatingError: {
            code: "cancellation_timeout" as const,
            origin: "codex",
            target: request.target,
            stage: "graceful_cancel" as const,
            executionMayContinue: true,
            message: error,
            at: 1_000,
          },
        }
      : {}),
    cleanupErrors: [],
    nextActions: [],
    receipt: "durable",
    createdAt: 1_000,
    updatedAt: 1_000,
  }
}

type ClientDouble = {
  calls: string[]
  requests: RecoveryRequest[]
  client: ReturnType<Parameters<typeof createPromptAbort>[0]["clientForDirectory"]>
}

/**
 * Every double drives the real Stop path: inspect for the turn identity,
 * submit against it, then reconcile. `running` decides whether the owner has a
 * turn to name at all.
 */
function clientDouble(input: {
  sessionID: string
  running?: RecoveryTurnTarget | undefined
  answer?: (request: RecoveryRequest) => Promise<RecoveryOutcome> | RecoveryOutcome
  inspect?: () => Promise<{ data: { target?: RecoveryTurnTarget } }>
  statusAfter?: Record<string, { type: "idle" | "busy" }>
  failRequests?: boolean
}): ClientDouble {
  const calls: string[] = []
  const requests: RecoveryRequest[] = []
  const running = "running" in input ? input.running : target(input.sessionID)
  return {
    calls,
    requests,
    client: {
      session: {
        recovery: {
          inspect: input.inspect ?? (async () => {
            calls.push("inspect")
            return { data: running ? { target: running } : {} }
          }),
          submit: async ({ request }: { request: RecoveryRequest }) => {
            calls.push("submit")
            requests.push(request)
            return { data: await (input.answer?.(request) ?? { kind: "operation", operation: operation(request, "succeeded") }) }
          },
        },
        status: async () => { calls.push("status"); return { data: input.statusAfter ?? {} } },
        get: async () => { calls.push("get"); return { data: {} } },
      },
      permission: {
        list: async () => {
          calls.push("permissions")
          if (input.failRequests) throw new Error("permission list unavailable")
          return { data: [] }
        },
      },
      question: { list: async () => { calls.push("questions"); return { data: [] } } },
    } as never,
  }
}

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
  const reported = () => {
    const spy = spyOn(analytics, "captureException").mockImplementation(() => {})
    afterEach(() => spy.mockRestore())
    return spy
  }

  const failures: Array<[string, (request: RecoveryRequest) => Promise<RecoveryOutcome> | RecoveryOutcome, string, string]> = [
    ["a rejected request", () => Promise.reject(new Error("Stop request failed")), "unreachable", "Stop request failed"],
    [
      "an operation whose execution never went terminal",
      (request) => ({ kind: "operation", operation: operation(request, "needs_action", STILL_RUNNING, "Stop request failed") }),
      "still_running",
      "Stop request failed",
    ],
    [
      "an operation whose interrupted state was never saved",
      (request) => ({ kind: "operation", operation: operation(request, "needs_action", SAVE_FAILED, "Stop request failed") }),
      "not_saved",
      "Stop request failed",
    ],
    ["a refusal", () => ({ kind: "refused", refusal: { kind: "generation_conflict", message: "the turn was replaced" } }), "refused_generation_conflict", "the turn was replaced"],
    ["an unavailable owner", () => ({ kind: "refused", refusal: { kind: "unavailable", message: "the runtime is closing" } }), "refused_unavailable", "the runtime is closing"],
  ]

  test.each(failures)("sends %s to error reporting, shows nothing, and refreshes nothing", async (_name, answer, kind, message) => {
    const report = reported()
    const toasts: unknown[] = []
    const double = clientDouble({ sessionID: "stop-failure", answer })
    const abort = createSubmitAbort({
      sessionID: () => "stop-failure",
      defaultDirectory: "/repo",
      clientForDirectory: () => double.client,
      stopGoalFailedTitle: () => "Goal Stop failed",
      errorMessage: (error) => (error as Error).message,
      showToast: (toast) => { toasts.push(toast) },
    })

    await expect(abort()).resolves.toBeUndefined()

    expect(toasts).toEqual([])
    expect(report).toHaveBeenCalledTimes(1)
    const [error, properties] = report.mock.calls[0]
    expect((error as Error).message).toBe(`Stop did not stop the turn: ${kind}`)
    expect(properties).toMatchObject({ surface: "session", session_id: "stop-failure", stop_failure: kind, owner_message: message })
    expect(double.calls.filter((call) => call !== "inspect" && call !== "submit")).toEqual([])
  })

  // The headline of this wave: no adapter can yet prove `verified_clear`, so a
  // working Stop closes as `needs_action`. Reading that as a failure would put
  // a red toast on every Stop and skip the reconcile the interrupted turn needs.
  test("a turn that ended and was saved is stopped even when cleanup is unverified", async () => {
    const report = reported()
    const toasts: unknown[] = []
    const double = clientDouble({
      sessionID: "stop-unverified",
      answer: (request) => ({ kind: "operation", operation: operation(request, "needs_action", STOPPED_CLEANUP_UNVERIFIED) }),
    })
    const abort = createSubmitAbort({
      sessionID: () => "stop-unverified",
      defaultDirectory: "/repo",
      clientForDirectory: () => double.client,
      stopGoalFailedTitle: () => "Goal Stop failed",
      errorMessage: (error) => (error as Error).message,
      showToast: (toast) => { toasts.push(toast) },
    })

    await abort()

    expect(toasts).toEqual([])
    expect(report).not.toHaveBeenCalled()
    expect(double.calls).toEqual(["inspect", "submit", "get", "status", "permissions", "questions"])
  })

  test("an operation that reached its postcondition refreshes the server snapshot", async () => {
    const double = clientDouble({ sessionID: "stop-success" })
    await createPromptAbort({
      sessionID: () => "stop-success",
      defaultDirectory: "/repo",
      clientForDirectory: () => double.client,
    })()
    expect(double.calls).toEqual(["inspect", "submit", "get", "status", "permissions", "questions"])
  })

  test("a session running no turn refreshes without submitting anything", async () => {
    const double = clientDouble({ sessionID: "stop-idle", running: undefined })
    await createPromptAbort({
      sessionID: () => "stop-idle",
      defaultDirectory: "/repo",
      clientForDirectory: () => double.client,
    })()
    expect(double.calls).toEqual(["inspect", "get", "status", "permissions", "questions"])
  })
})

describe("which turn Stop names", () => {
  test("sends back the exact identity the owner reported for the running turn", async () => {
    const running = target("ses_scoped", "msg_first")
    const double = clientDouble({ sessionID: "ses_scoped", running })
    await createPromptAbort({
      sessionID: () => "ses_scoped",
      defaultDirectory: "/repo",
      turnId: () => "msg_first",
      clientForDirectory: () => double.client,
    })()

    expect(double.requests).toHaveLength(1)
    expect(double.requests[0]).toMatchObject({ action: "cancel_turn", target: running, scopeRevision: "lease_1", attempt: 1 })
  })

  test("a composer that started no turn cancels whichever turn the owner reports", async () => {
    const double = clientDouble({ sessionID: "ses_unscoped", running: target("ses_unscoped", "msg_someone_else") })
    await createPromptAbort({
      sessionID: () => "ses_unscoped",
      defaultDirectory: "/repo",
      clientForDirectory: () => double.client,
    })()
    expect(double.requests[0]?.target).toEqual(target("ses_unscoped", "msg_someone_else"))
  })

  test("a Stop for a turn that has already been replaced cancels nothing", async () => {
    const double = clientDouble({ sessionID: "ses_replaced", running: target("ses_replaced", "msg_second") })
    await createPromptAbort({
      sessionID: () => "ses_replaced",
      defaultDirectory: "/repo",
      turnId: () => "msg_first",
      clientForDirectory: () => double.client,
    })()
    expect(double.requests).toEqual([])
    expect(double.calls).toEqual(["inspect", "get", "status", "permissions", "questions"])
  })

  test("two Stops in flight for one turn join a single request id, and a later Stop mints a new one", async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let holding = true
    const double = clientDouble({
      sessionID: "ses_join",
      answer: async (request) => {
        if (holding) await held
        return { kind: "operation", operation: operation(request, "succeeded") }
      },
    })
    const abort = createPromptAbort({
      sessionID: () => "ses_join",
      defaultDirectory: "/repo",
      clientForDirectory: () => double.client,
    })

    const first = abort()
    // The second click has to find the first submit already in flight, which
    // is what makes it join rather than open a second operation.
    while (double.requests.length < 1) await Promise.resolve()
    const second = abort()
    while (double.requests.length < 2) await Promise.resolve()
    release()
    await Promise.all([first, second])

    expect(double.requests[0].requestId).toBe(double.requests[1].requestId)

    holding = false
    await abort()
    expect(double.requests[2].requestId).not.toBe(double.requests[0].requestId)
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

  test("leaves the last authoritative state alone until the owner answers", async () => {
    const sessionID = "ses_stop_no_optimism"
    runningSession(sessionID)
    let answer = () => {}
    const double = clientDouble({
      sessionID,
      answer: (request) => new Promise((resolve) => {
        answer = () => resolve({ kind: "operation", operation: operation(request, "succeeded") })
      }),
      statusAfter: { [sessionID]: { type: "idle" } },
    })
    const stopped = createPromptAbort({
      sessionID: () => sessionID,
      defaultDirectory: "/repo",
      clientForDirectory: () => double.client,
    })()

    while (double.requests.length < 1) await Promise.resolve()
    // Nothing the owner has not said: the turn is still busy and its todos are
    // still its own until the cancellation reports otherwise.
    expect(sessionSnapshot(sessionID)).toEqual({
      status: { type: "busy" },
      todos: [{ content: "run the build", status: "in_progress", priority: "high" }],
    })

    answer()
    await stopped
    expect(sessionSnapshot(sessionID).status).toEqual({ type: "idle" })
  })

  test("a stopped turn whose request refresh fails is still a stopped turn", async () => {
    const sessionID = "ses_stop_refresh_failure"
    runningSession(sessionID)
    const double = clientDouble({ sessionID, statusAfter: { [sessionID]: { type: "idle" } }, failRequests: true })

    await expect(createPromptAbort({
      sessionID: () => sessionID,
      defaultDirectory: "/repo",
      clientForDirectory: () => double.client,
    })()).resolves.toBeUndefined()

    expect(sessionSnapshot(sessionID).status).toEqual({ type: "idle" })
  })

  test("a rejected inspection reports the Stop as failed and never writes idle", async () => {
    const sessionID = "ses_stop_rejected"
    runningSession(sessionID)
    const double = clientDouble({
      sessionID,
      inspect: () => Promise.reject(new Error("Stop request failed")),
    })

    await expect(createPromptAbort({
      sessionID: () => sessionID,
      defaultDirectory: "/repo",
      clientForDirectory: () => double.client,
    })()).rejects.toThrow("Stop request failed")
    expect(sessionSnapshot(sessionID).status).toEqual({ type: "busy" })
  })

  test("cancels a prompt still queued locally and asks the runtime for one already sent", async () => {
    clearPendingPromptsForTest()
    const cleanups: string[] = []
    const doubles = new Map<string, ClientDouble>()
    const promptAbort = (sessionID: string) => {
      const double = clientDouble({ sessionID })
      doubles.set(sessionID, double)
      return createPromptAbort({
        sessionID: () => sessionID,
        defaultDirectory: "/repo",
        clientForDirectory: () => double.client,
      })
    }

    const controller = new AbortController()
    registerPendingPrompt("ses_queued", { abort: controller, cleanup: () => cleanups.push("cleanup") })
    await promptAbort("ses_queued")()
    expect(cleanups).toEqual(["cleanup"])
    expect(controller.signal.aborted).toBe(true)
    expect(hasPendingPrompt("ses_queued")).toBe(false)
    expect(doubles.get("ses_queued")!.calls).toEqual([])

    registerPendingPrompt("ses_sent", { abort: new AbortController(), cleanup: () => cleanups.push("cleanup") })
    markPendingPromptSent("ses_sent")
    await promptAbort("ses_sent")()
    expect(cleanups).toEqual(["cleanup"])
    expect(doubles.get("ses_sent")!.requests).toHaveLength(1)
    expect(hasPendingPrompt("ses_sent")).toBe(false)
  })
})

describe("an explicit retry", () => {
  test("opens a new attempt linked to the one it follows instead of reading it back", async () => {
    const double = clientDouble({ sessionID: "retry" })

    const first = await stopRunningTurn({ client: double.client, sessionID: "retry" })
    const retried = await stopRunningTurn({
      client: double.client,
      sessionID: "retry",
      retryOf: { operationId: "op_1", attempt: 1 },
    })

    expect(first.cancelled && retried.cancelled).toBe(true)
    const [initial, again] = double.requests
    expect(again.requestId).not.toBe(initial.requestId)
    expect(again.attempt).toBe(2)
    expect(again.linkedOperationId).toBe("op_1")
    expect(initial.linkedOperationId).toBeUndefined()
  })
})

describe("the recovery command a Stop leaves behind", () => {
  test("records the owner's answer against the request that is displayed", async () => {
    clearSessionRecoveryCommand("command-answered")
    const double = clientDouble({
      sessionID: "command-answered",
      answer: (request) => ({ kind: "operation", operation: operation(request, "needs_action", STOPPED_CLEANUP_UNVERIFIED) }),
    })

    await stopRunningTurn({ client: double.client, sessionID: "command-answered" })

    const command = sessionRecoveryCommand("command-answered")
    expect(command?.action).toBe("cancel_turn")
    expect(command?.attempt).toBe(1)
    expect(command?.requestId).toBe(double.requests[0].requestId)
    expect(command?.outcome).toEqual({ kind: "operation", operation: operation(double.requests[0], "needs_action", STOPPED_CLEANUP_UNVERIFIED) })
    expect(command?.unreachable).toBeUndefined()
  })

  test("a Stop that never reached an owner is recorded as unreached, with no facts invented", async () => {
    clearSessionRecoveryCommand("command-unreached")
    const double = clientDouble({
      sessionID: "command-unreached",
      answer: () => Promise.reject(new Error("the machine did not answer")),
    })

    await expect(stopRunningTurn({ client: double.client, sessionID: "command-unreached" })).rejects.toThrow(
      "the machine did not answer",
    )

    const command = sessionRecoveryCommand("command-unreached")
    expect(command?.unreachable).toBe("the machine did not answer")
    expect(command?.outcome).toBeUndefined()
  })
})

test("an owner that refuses inspection is the Stop's outcome, and is reported", async () => {
  const report = spyOn(analytics, "captureException").mockImplementation(() => {})
  clearSessionRecoveryCommand("inspect-refused")
  const refusal = { kind: "refused" as const, refusal: { kind: "unavailable" as const, message: "no owner on this machine" } }
  const double = clientDouble({
    sessionID: "inspect-refused",
    inspect: async () => ({ data: refusal }),
  })

  const result = await stopRunningTurn({ client: double.client, sessionID: "inspect-refused" })

  const kinds = report.mock.calls.map(([, properties]) => properties.stop_failure)
  report.mockRestore()

  expect(result).toEqual({ cancelled: true, outcome: refusal })
  expect(kinds).toEqual(["refused_unavailable"])
  expect(double.requests).toEqual([])
})

/** Yields until the predicate holds, so a submission in flight can be observed. */
async function until(ready: () => boolean) {
  for (let tick = 0; tick < 100; tick += 1) {
    if (ready()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("condition never held")
}

describe("which cancellations join and which mint a new one", () => {
  test("a plain Stop after a Retry opens its own request rather than joining the retry's", async () => {
    clearSessionRecoveryCommand("join-intent")
    const held: Array<(outcome: RecoveryOutcome) => void> = []
    const double = clientDouble({
      sessionID: "join-intent",
      answer: () => new Promise<RecoveryOutcome>((resolve) => { held.push(resolve) }),
    })

    const retry = stopRunningTurn({
      client: double.client,
      sessionID: "join-intent",
      retryOf: { operationId: "op_1", attempt: 1 },
    })
    await until(() => double.requests.length === 1)
    const plain = stopRunningTurn({ client: double.client, sessionID: "join-intent" })
    await until(() => double.requests.length === 2)

    const [retried, stop] = double.requests
    expect(retried.attempt).toBe(2)
    expect(retried.linkedOperationId).toBe("op_1")
    // A different intent under the retry's id would be refused as a conflict.
    expect(stop.requestId).not.toBe(retried.requestId)
    expect(stop.attempt).toBe(1)
    expect(stop.linkedOperationId).toBeUndefined()

    // The in-flight retry stays on screen: attempt 1 must not replace attempt 2.
    expect(sessionRecoveryCommand("join-intent")?.attempt).toBe(2)
    expect(sessionRecoveryCommand("join-intent")?.requestId).toBe(retried.requestId)

    for (const resolve of held) resolve({ kind: "operation", operation: operation(retried, "needs_action", STOPPED_AND_PROVEN) })
    await Promise.all([retry, plain])
  })

  test("two identical Stops in flight share one request id", async () => {
    clearSessionRecoveryCommand("join-same")
    const held: Array<(outcome: RecoveryOutcome) => void> = []
    const double = clientDouble({
      sessionID: "join-same",
      answer: () => new Promise<RecoveryOutcome>((resolve) => { held.push(resolve) }),
    })

    const first = stopRunningTurn({ client: double.client, sessionID: "join-same" })
    await until(() => double.requests.length === 1)
    const second = stopRunningTurn({ client: double.client, sessionID: "join-same" })
    await until(() => double.requests.length === 2)

    expect(double.requests[1].requestId).toBe(double.requests[0].requestId)

    for (const resolve of held) resolve({ kind: "operation", operation: operation(double.requests[0], "needs_action", STOPPED_AND_PROVEN) })
    await Promise.all([first, second])
  })
})
