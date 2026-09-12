import { afterEach, describe, expect, test, vi } from "vitest"
import { isPromptAdmissionConflict, rollbackPromptDispatch, sendPromptRequest, waitForPendingWorktree } from "./send"
import {
  clearPendingPromptsForTest,
  hasPendingPrompt,
  registerPendingPrompt,
  takePendingPrompt,
} from "../store/pending-prompt-registry"
import {
  SESSION_STATUS_TIMEOUTS,
  clearAllPromptSessionStatusTimeoutsForTest,
  dispatchSessionStatusEvent,
  promptSessionStatusMeta,
  promptSessionStatusStage,
} from "../store/session-status-dispatcher"
import { setPromptSessionStatus } from "./pending"
import type { AgentRuntimeStatus as SessionStatus } from "@claxedo/agent-runtime-contract"
import type { PromptDispatchInput, PromptDispatchPayload } from "./types"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"

const payload: PromptDispatchPayload = {
  sessionID: "ses_1",
  directory: "/repo/main",
  agent: "build",
  model: { providerID: "anthropic", modelID: "sonnet" },
  messageID: "msg_1",
  parts: [],
}

const liveClient: PromptDispatchInput["client"] = {
  session: {
    promptAsync: async () => undefined,
  },
}

const erroringClient: PromptDispatchInput["client"] = {
  session: {
    promptAsync: async () => {
      throw new Error("network blip")
    },
  },
}

afterEach(() => {
  clearPendingPromptsForTest()
  clearAllPromptSessionStatusTimeoutsForTest()
  queryClient.clear()
  vi.useRealTimers()
})

describe("waitForPendingWorktree", () => {
  test("skips local worktree waiting for synthetic workspace runtimes", async () => {
    expect(await waitForPendingWorktree({
      sessionID: "session-1",
      sessionDirectory: "workspace:ws_1",
      timeoutMessage: "timeout",
      onPending: () => {
        throw new Error("should not wait")
      },
      onAbortCleanup: () => {
        throw new Error("should not register abort cleanup")
      },
    })).toBe(true)
  })

  test("rejects a worktree that failed before prompt dispatch began", async () => {
    const { Worktree } = await import("@/platform/sync/worktree")
    Worktree.failed("/repo/failed-worktree", "checkout failed")

    await expect(waitForPendingWorktree({
      sessionID: "session-failed",
      sessionDirectory: "/repo/failed-worktree",
      timeoutMessage: "timeout",
      onPending: () => {
        throw new Error("failed worktree must not enter pending")
      },
      onAbortCleanup: () => undefined,
    })).rejects.toThrow("checkout failed")
  })
})

describe("sendPromptRequest", () => {
  test("optimistic busy → waitForWorktree → dispatchPrompt, no idle write in live mode", async () => {
    let clearBootCalls = 0
    let clearCloudStartupCalls = 0
    let waitCalls = 0
    await sendPromptRequest({
      sessionID: "ses_1",
      client: liveClient,
      payload,
      waitForWorktree: async () => {
        waitCalls++
        return true
      },
      clearBoot: () => {
        clearBootCalls++
      },
      clearCloudStartup: () => {
        clearCloudStartupCalls++
      },
    })
    expect(waitCalls).toBe(1)
    expect(clearCloudStartupCalls).toBe(1)
    // Boot is local composer UI state; live session events only own working/idle.
    expect(clearBootCalls).toBe(1)
    expect(statusFor("ses_1")?.type).toBe("busy")
  })



  test("a status read that lands mid-dispatch cannot drop the optimistic busy", async () => {
    let answerPrompt!: () => void
    let promptStarted!: () => void
    const started = new Promise<void>((resolve) => { promptStarted = resolve })
    const onTheWire = new Promise<void>((resolve) => { answerPrompt = resolve })
    const pending = sendPromptRequest({
      sessionID: "ses_1",
      payload,
      client: { session: { promptAsync: async () => { promptStarted(); await onTheWire } } },
      waitForWorktree: async () => true,
      clearBoot: () => undefined,
      clearCloudStartup: () => undefined,
    })

    await started
    dispatchSessionStatusEvent({
      event: { type: "session.idle", source: "server", sessionID: "ses_1" },
    })
    expect(statusFor("ses_1")).toEqual({ type: "busy" })

    answerPrompt()
    await pending
    expect(hasPendingPrompt("ses_1")).toBe(false)

    dispatchSessionStatusEvent({
      event: { type: "session.idle", source: "server", sessionID: "ses_1" },
    })
    expect(statusFor("ses_1")).toEqual({ type: "idle" })
  })

  test("a failed dispatch stops shielding the session from a server idle", async () => {
    await expect(sendPromptRequest({
      sessionID: "ses_1",
      payload,
      client: erroringClient,
      waitForWorktree: async () => true,
      clearBoot: () => undefined,
      clearCloudStartup: () => undefined,
    })).rejects.toThrow("network blip")
    expect(hasPendingPrompt("ses_1")).toBe(false)
  })

  test("prepares live events before dispatching prompt_async and reconciles after dispatch", async () => {
    const order: string[] = []
    const observedClient: PromptDispatchInput["client"] = {
      session: {
        promptAsync: async () => {
          order.push("prompt")
          return undefined
        },
      },
    }

    await sendPromptRequest({
      sessionID: "ses_1",
      client: observedClient,
      payload,
      waitForWorktree: async () => {
        order.push("worktree")
        return true
      },
      prepareLiveEvents: async () => {
        order.push("events")
      },
      reconcileAfterDispatch: async () => {
        order.push("reconcile")
      },
      clearBoot: () => undefined,
      clearCloudStartup: () => undefined,
    })

    expect(order).toEqual(["worktree", "events", "prompt", "reconcile"])
  })

  test("does not let live-event readiness block prompt_async dispatch", async () => {
    vi.useFakeTimers()
    let dispatched = 0
    const observedClient: PromptDispatchInput["client"] = {
      session: {
        promptAsync: async () => {
          dispatched++
          return undefined
        },
      },
    }

    const pending = sendPromptRequest({
      sessionID: "ses_1",
      client: observedClient,
      payload,
      waitForWorktree: async () => true,
      prepareLiveEvents: async () => new Promise(() => {}),
      clearBoot: () => undefined,
      clearCloudStartup: () => undefined,
    })

    await vi.advanceTimersByTimeAsync(1499)
    expect(dispatched).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(dispatched).toBe(1)
    expect(statusFor("ses_1")?.type).toBe("busy")
  })

  test("post-dispatch reconciliation errors do not roll back accepted prompts", async () => {
    let clearCloudStartupCalls = 0
    await expect(sendPromptRequest({
      sessionID: "ses_1",
      client: liveClient,
      payload,
      waitForWorktree: async () => true,
      reconcileAfterDispatch: async () => {
        throw new Error("status poll failed")
      },
      clearBoot: () => undefined,
      clearCloudStartup: () => {
        clearCloudStartupCalls++
      },
    })).resolves.toBeUndefined()

    expect(clearCloudStartupCalls).toBe(1)
    expect(statusFor("ses_1")?.type).toBe("busy")
  })

  test("dispatch error bubbles to caller (so the caller can run rollbackPromptDispatch)", async () => {
    let caught: unknown
    try {
      await sendPromptRequest({
        sessionID: "ses_1",
        client: erroringClient,
        payload,
        waitForWorktree: async () => true,
        clearBoot: () => undefined,
        clearCloudStartup: () => undefined,
      })
    } catch (err) {
      caught = err
    }
    expect((caught as Error).message).toBe("network blip")
  })
})

describe("how the runtime took a prompt sent into a busy session", () => {
  const deliveringClient = (delivery: string): PromptDispatchInput["client"] => ({
    session: { promptAsync: async () => ({ data: { delivery } }) },
  })
  const send = (
    client: PromptDispatchInput["client"],
    body: Partial<PromptDispatchPayload>,
    seen: Array<[string, string]>,
  ) =>
    sendPromptRequest({
      sessionID: "ses_1",
      client,
      payload: { ...payload, ...body },
      onDelivery: (delivery, turnId) => seen.push([delivery, turnId]),
      waitForWorktree: async () => true,
      clearBoot: () => {},
      clearCloudStartup: () => {},
    })

  test("a steered prompt is reported as steered, with the turn id it carried", async () => {
    const seen: Array<[string, string]> = []
    await send(deliveringClient("steer"), { messageID: "msg_steer", delivery: "steer" }, seen)

    expect(seen).toEqual([["steer", "msg_steer"]])
  })

  test("a queued prompt is reported as queued", async () => {
    const seen: Array<[string, string]> = []
    await send(deliveringClient("queue"), { messageID: "msg_queued", delivery: "steer" }, seen)

    expect(seen).toEqual([["queue", "msg_queued"]])
  })

  test("a prompt the transport answers nothing for counts as having started its own turn", async () => {
    const seen: Array<[string, string]> = []
    await send(liveClient, { messageID: "msg_own" }, seen)

    expect(seen).toEqual([["start", "msg_own"]])
  })
})

describe("sendPromptRequest abort coverage", () => {
  test("pre-await abort: waitForWorktree=false leaves optimistic busy AND skips the dispatch", async () => {
    let dispatched = 0
    const observingClient: PromptDispatchInput["client"] = {
      session: {
        promptAsync: async () => {
          dispatched++
          return undefined
        },
      },
    }
    let cleared = 0
    await sendPromptRequest({
      sessionID: "ses_1",
      client: observingClient,
      payload,
      // Abort surfaces through this callback returning false — the
      // The pending prompt AbortController in waitForPendingWorktree wires
      // a user cancel through the exact same return path.
      waitForWorktree: async () => false,
      clearBoot: () => undefined,
      clearCloudStartup: () => {
        cleared++
      },
    })
    expect(dispatched).toBe(0)
    // The pre-await abort leaves optimistic busy in place — the caller
    // (handleSubmit) owns the rollback (see rollbackPromptDispatch).
    expect(statusFor("ses_1")?.type).toBe("busy")
    // clearCloudStartup runs ONLY on the successful path; aborting
    // before dispatch must not pretend the cloud startup completed.
    expect(cleared).toBe(0)
  })

  test("aborting while live event readiness is pending prevents dispatch and success cleanup", async () => {
    let signalReady!: () => void
    let releaseReady!: () => void
    const entered = new Promise<void>((resolve) => { signalReady = resolve })
    const ready = new Promise<void>((resolve) => { releaseReady = resolve })
    const effects: string[] = []
    const pending = sendPromptRequest({
      sessionID: "ses_1", payload,
      client: { session: {
        promptAsync: async () => { effects.push("dispatch") },
      } },
      waitForWorktree: async () => true,
      prepareLiveEvents: () => { signalReady(); return ready },
      onAbortCleanup: () => { effects.push("abort-cleanup") },
      clearBoot: () => { effects.push("boot-success") },
      clearCloudStartup: () => { effects.push("startup-success") },
    })
    await entered
    const abortable = takePendingPrompt("ses_1")
    expect(abortable).toBeDefined()
    abortable!.abort.abort()
    abortable!.cleanup()
    releaseReady()
    await pending
    expect(effects).toEqual(["abort-cleanup"])
    expect(hasPendingPrompt("ses_1")).toBe(false)
  })

  test("Stop taken while the prompt is on the wire is not undone by the dispatch settling", async () => {
    vi.useFakeTimers()
    let answerPrompt!: () => void
    let promptStarted!: () => void
    const started = new Promise<void>((resolve) => { promptStarted = resolve })
    const onTheWire = new Promise<void>((resolve) => { answerPrompt = resolve })
    const pending = sendPromptRequest({
      sessionID: "ses_1",
      payload,
      client: { session: { promptAsync: async () => { promptStarted(); await onTheWire } } },
      waitForWorktree: async () => true,
      clearBoot: () => undefined,
      clearCloudStartup: () => undefined,
    })

    await started
    // Exactly what createPromptAbort does once the prompt is on the wire: the
    // entry carries no handle to abort, so it claims the entry and writes the
    // idle itself before asking the runtime to cancel.
    expect(takePendingPrompt("ses_1")).toBeUndefined()
    setPromptSessionStatus({ sessionID: "ses_1", status: { type: "idle" }, source: "optimistic" })

    answerPrompt()
    await pending

    // No optimistic period was re-opened, so no escalation ladder can climb out
    // of one: past the pending threshold there is still nothing to escalate.
    await vi.advanceTimersByTimeAsync(SESSION_STATUS_TIMEOUTS.pending)
    expect(promptSessionStatusStage("ses_1")).toBeUndefined()
    expect(promptSessionStatusMeta("ses_1")).toBeUndefined()
    expect(statusFor("ses_1")).toEqual({ type: "idle" })
  })
})

describe("rollbackPromptDispatch", () => {
  test("collision rollback preserves busy status and restores only the rejected optimistic prompt", () => {
    dispatchSessionStatusEvent({
      event: {
        type: "session.status",
        source: "server",
        sessionID: "ses_1",
        status: { type: "busy" },
      },
    })
    const calls: string[] = []
    rollbackPromptDispatch({
      err: { status: 409, code: "session_turn_in_progress", message: "busy" },
      sessionID: "ses_1",
      clearBoot: () => calls.push("clear-boot"),
      reportCloudStartupError: () => calls.push("cloud-error"),
      showSendFailed: () => calls.push("show-error"),
      removeSubmittedPrompt: () => calls.push("remove-loser"),
      restoreSubmittedComments: () => calls.push("restore-comments"),
      restoreInput: () => calls.push("restore-input"),
    })

    expect(statusFor("ses_1")).toEqual({ type: "busy" })
    expect(calls).toEqual(["clear-boot", "show-error", "remove-loser", "restore-comments", "restore-input"])
  })

  test("disambiguates admission collision from other 409 errors by structured code", () => {
    expect(isPromptAdmissionConflict({ status: 409, code: "session_turn_in_progress" })).toBe(true)
    expect(isPromptAdmissionConflict({ status: 409, code: "unsupported_operation" })).toBe(false)
    expect(isPromptAdmissionConflict(new Error(JSON.stringify({
      error: { code: "session_turn_in_progress", message: "busy" },
    })))).toBe(true)
  })

  test("clears optimistic busy, runs every restore callback exactly once, and removes pending entry", () => {
    dispatchSessionStatusEvent({
      event: {
        type: "session.status",
        source: "optimistic",
        sessionID: "ses_1",
        status: { type: "busy" },
        now: 1,
        deadline: 2,
      },
    })
    registerPendingPrompt("ses_1", {
      abort: new AbortController(),
      cleanup: () => undefined,
    })
    const counts = {
      clearBoot: 0,
      reportCloudStartupError: 0,
      showSendFailed: 0,
      removeSubmittedPrompt: 0,
      restoreSubmittedComments: 0,
      restoreInput: 0,
    }
    rollbackPromptDispatch({
      err: new Error("send failed"),
      sessionID: "ses_1",
      clearBoot: () => {
        counts.clearBoot++
      },
      reportCloudStartupError: () => {
        counts.reportCloudStartupError++
      },
      showSendFailed: () => {
        counts.showSendFailed++
      },
      removeSubmittedPrompt: () => {
        counts.removeSubmittedPrompt++
      },
      restoreSubmittedComments: () => {
        counts.restoreSubmittedComments++
      },
      restoreInput: () => {
        counts.restoreInput++
      },
    })
    expect(statusFor("ses_1")).toEqual({ type: "idle" })
    expect(promptSessionStatusStage("ses_1")).toBeUndefined()
    expect(hasPendingPrompt("ses_1")).toBe(false)
    for (const [name, count] of Object.entries(counts)) {
      expect({ [name]: count }).toEqual({ [name]: 1 })
    }
  })

  test("rollback is safe to call when there was no pending entry", () => {
    expect(() =>
      rollbackPromptDispatch({
        err: new Error("send failed"),
        sessionID: "never-registered",
        clearBoot: () => undefined,
        reportCloudStartupError: () => undefined,
        showSendFailed: () => undefined,
        removeSubmittedPrompt: () => undefined,
        restoreSubmittedComments: () => undefined,
        restoreInput: () => undefined,
      }),
    ).not.toThrow()
  })

  test("rollback forwards the original error to both error callbacks", () => {
    const err = new Error("specific failure")
    let cloudErr: unknown
    let sendErr: unknown
    rollbackPromptDispatch({
      err,
      sessionID: "ses_1",
      clearBoot: () => undefined,
      reportCloudStartupError: (e) => {
        cloudErr = e
      },
      showSendFailed: (e) => {
        sendErr = e
      },
      removeSubmittedPrompt: () => undefined,
      restoreSubmittedComments: () => undefined,
      restoreInput: () => undefined,
    })
    expect(cloudErr).toBe(err)
    expect(sendErr).toBe(err)
  })
})

function statusFor(sessionID: string) {
  return queryClient.getQueryData<SessionStatus>(shellDataKeys.sessionId(sessionID, "status"))
}
