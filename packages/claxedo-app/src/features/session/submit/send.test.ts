import { afterEach, describe, expect, test } from "bun:test"
import { rollbackPromptDispatch, sendPromptRequest, waitForPendingWorktree } from "./send"
import { clearPendingPromptsForTest, hasPendingPrompt, registerPendingPrompt } from "./pending"
import {
  clearAllPromptSessionStatusTimeoutsForTest,
  dispatchSessionStatusEvent,
  promptSessionStatusStage,
} from "../store/session-status-dispatcher"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { PromptDispatchInput, PromptDispatchPayload } from "./types"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"

// Rubric T2: per-phase test for send.ts. Covers `sendPromptRequest` and
// `rollbackPromptDispatch`. `waitForPendingWorktree` is excluded — it
// reaches into the module-scoped `WorktreeState` global, which the
// submit characterization suite already exercises in `submit.test.ts`;
// repeating that here would duplicate the existing harness.

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
    prompt: async () => ({ data: undefined } as never),
    promptAsync: async () => undefined,
  },
}

const erroringClient: PromptDispatchInput["client"] = {
  session: {
    prompt: async () => ({ data: undefined } as never),
    promptAsync: async () => {
      throw new Error("network blip")
    },
  },
}

afterEach(() => {
  clearPendingPromptsForTest()
  clearAllPromptSessionStatusTimeoutsForTest()
  queryClient.clear()
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
})

describe("sendPromptRequest", () => {
  test("optimistic busy → waitForWorktree → dispatchPrompt, no idle write in live mode", async () => {
    let clearBootCalls = 0
    let clearCloudStartupCalls = 0
    let waitCalls = 0
    await sendPromptRequest({
      sessionID: "ses_1",
      client: liveClient,
      demo: false,
      payload,
      waitForWorktree: async () => {
        waitCalls++
        return true
      },
      onDemoReply: () => undefined,
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

  test("demo mode writes optimistic busy, then server idle, and clears boot", async () => {
    let clearBootCalls = 0
    await sendPromptRequest({
      sessionID: "ses_1",
      client: liveClient,
      demo: true,
      payload,
      waitForWorktree: async () => true,
      onDemoReply: () => undefined,
      clearBoot: () => {
        clearBootCalls++
      },
      clearCloudStartup: () => undefined,
    })
    expect(statusFor("ses_1")).toEqual({ type: "idle" })
    expect(promptSessionStatusStage("ses_1")).toBeUndefined()
    expect(clearBootCalls).toBe(1)
  })

  test("waitForWorktree=false short-circuits before dispatching", async () => {
    let dispatched = 0
    const observedClient: PromptDispatchInput["client"] = {
      session: {
        prompt: async () => ({ data: undefined } as never),
        promptAsync: async () => {
          dispatched++
          return undefined
        },
      },
    }
    await sendPromptRequest({
      sessionID: "ses_1",
      client: observedClient,
      demo: false,
      payload,
      waitForWorktree: async () => false,
      onDemoReply: () => undefined,
      clearBoot: () => undefined,
      clearCloudStartup: () => undefined,
    })
    expect(dispatched).toBe(0)
    expect(statusFor("ses_1")?.type).toBe("busy")
  })

  test("prepares live events before dispatching prompt_async and reconciles after dispatch", async () => {
    const order: string[] = []
    const observedClient: PromptDispatchInput["client"] = {
      session: {
        prompt: async () => ({ data: undefined } as never),
        promptAsync: async () => {
          order.push("prompt")
          return undefined
        },
      },
    }

    await sendPromptRequest({
      sessionID: "ses_1",
      client: observedClient,
      demo: false,
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
      onDemoReply: () => undefined,
      clearBoot: () => undefined,
      clearCloudStartup: () => undefined,
    })

    expect(order).toEqual(["worktree", "events", "prompt", "reconcile"])
  })

  test("does not let live-event readiness block prompt_async dispatch", async () => {
    let dispatched = 0
    const observedClient: PromptDispatchInput["client"] = {
      session: {
        prompt: async () => ({ data: undefined } as never),
        promptAsync: async () => {
          dispatched++
          return undefined
        },
      },
    }

    await sendPromptRequest({
      sessionID: "ses_1",
      client: observedClient,
      demo: false,
      payload,
      waitForWorktree: async () => true,
      prepareLiveEvents: async () => new Promise(() => {}),
      onDemoReply: () => undefined,
      clearBoot: () => undefined,
      clearCloudStartup: () => undefined,
    })

    expect(dispatched).toBe(1)
    expect(statusFor("ses_1")?.type).toBe("busy")
  })

  test("post-dispatch reconciliation errors do not roll back accepted prompts", async () => {
    let clearCloudStartupCalls = 0
    await expect(sendPromptRequest({
      sessionID: "ses_1",
      client: liveClient,
      demo: false,
      payload,
      waitForWorktree: async () => true,
      reconcileAfterDispatch: async () => {
        throw new Error("status poll failed")
      },
      onDemoReply: () => undefined,
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
        demo: false,
        payload,
        waitForWorktree: async () => true,
        onDemoReply: () => undefined,
        clearBoot: () => undefined,
        clearCloudStartup: () => undefined,
      })
    } catch (err) {
      caught = err
    }
    expect((caught as Error).message).toBe("network blip")
  })
})

// Rubric T6: per-phase abort / cancel coverage. `sendPromptRequest`
// exposes one explicit cancellation hook today — the `waitForWorktree`
// callback. If it returns `false` the dispatcher short-circuits before
// the prompt is sent, which is how the existing user-driven abort path
// works (the same callback is wired into the pending prompt controller
// in `waitForPendingWorktree`). The other two abort positions
// (mid-await of `dispatchPrompt`, post-dispatch) would require an
// AbortSignal to be threaded into the dispatch payload — that is a
// future extension (rubric A2/T6 follow-up), so the tests are
// explicitly skipped with the reason.
describe("sendPromptRequest abort coverage", () => {
  test("pre-await abort: waitForWorktree=false leaves optimistic busy AND skips the dispatch", async () => {
    let dispatched = 0
    const observingClient: PromptDispatchInput["client"] = {
      session: {
        prompt: async () => ({ data: undefined } as never),
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
      demo: false,
      payload,
      // Abort surfaces through this callback returning false — the
      // The pending prompt AbortController in waitForPendingWorktree wires
      // a user cancel through the exact same return path.
      waitForWorktree: async () => false,
      onDemoReply: () => undefined,
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

  test.skip("mid-await abort: signal aborted while dispatchPrompt is in flight — needs A2/T6 follow-up to thread AbortSignal through PromptDispatchPayload", () => {})

  test.skip("post-await abort: signal aborted after dispatch resolves — needs A2/T6 follow-up to thread AbortSignal through PromptDispatchPayload", () => {})
})

describe("rollbackPromptDispatch", () => {
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
