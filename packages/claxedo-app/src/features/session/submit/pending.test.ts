import { afterEach, describe, expect, test } from "bun:test"
import {
  clearPendingPrompt,
  clearPendingPromptsForTest,
  hasPendingPrompt,
  pendingPromptCount,
  registerPendingPrompt,
  setPromptSessionStatus,
  takePendingPrompt,
} from "./pending"
import {
  clearAllPromptSessionStatusTimeoutsForTest,
  dispatchSessionStatusTimeoutStage,
  promptSessionStatusMeta,
  promptSessionStatusStage,
} from "../store/session-status-dispatcher"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"

// Rubric T2: per-phase test for pending.ts. Two surfaces:
// 1. pending prompt registry — a private module-scoped Map for imperative abort
//    controllers. Tests pin the public lifecycle contract without exporting the
//    mutable Map itself.
// 2. `setPromptSessionStatus` — the routing facade around the session
//    status dispatcher; defaults to `optimistic` source, accepts an explicit
//    `server` override, and writes through shell query status.

afterEach(() => {
  clearPendingPromptsForTest()
  clearAllPromptSessionStatusTimeoutsForTest()
  queryClient.clear()
})

describe("pending prompt registry", () => {
  test("starts empty", () => {
    expect(pendingPromptCount()).toBe(0)
  })

  test("register/take round-trip preserves identity and removes entry", () => {
    const controller = new AbortController()
    let cleaned = 0
    registerPendingPrompt("ses_1", {
      abort: controller,
      cleanup: () => {
        cleaned++
      },
    })
    expect(hasPendingPrompt("ses_1")).toBe(true)
    const found = takePendingPrompt("ses_1")
    expect(found?.abort).toBe(controller)
    found?.cleanup()
    expect(cleaned).toBe(1)
    expect(pendingPromptCount()).toBe(0)
  })

  test("multiple sessions are independent", () => {
    registerPendingPrompt("ses_a", { abort: new AbortController(), cleanup: () => undefined })
    registerPendingPrompt("ses_b", { abort: new AbortController(), cleanup: () => undefined })
    expect(pendingPromptCount()).toBe(2)
    clearPendingPrompt("ses_a")
    expect(hasPendingPrompt("ses_a")).toBe(false)
    expect(hasPendingPrompt("ses_b")).toBe(true)
  })
})

describe("setPromptSessionStatus", () => {
  test("optimistic busy writes status + timeout meta", () => {
    setPromptSessionStatus({
      sessionID: "ses_1",
      status: { type: "busy" },
    })
    expect(statusFor("ses_1")).toEqual({ type: "busy" })
    expect(promptSessionStatusMeta("ses_1")?.source).toBe("optimistic")
    expect(typeof promptSessionStatusMeta("ses_1")?.started).toBe("number")
  })

  test("optimistic idle clears timeout meta", () => {
    setPromptSessionStatus({
      sessionID: "ses_1",
      status: { type: "busy" },
    })
    setPromptSessionStatus({
      sessionID: "ses_1",
      status: { type: "idle" },
    })
    expect(statusFor("ses_1")).toEqual({ type: "idle" })
    expect(promptSessionStatusMeta("ses_1")).toBeUndefined()
  })

  test("explicit server source clears optimistic meta", () => {
    setPromptSessionStatus({
      sessionID: "ses_1",
      status: { type: "busy" },
    })
    setPromptSessionStatus({
      sessionID: "ses_1",
      status: { type: "busy" },
      source: "server",
    })
    expect(statusFor("ses_1")).toEqual({ type: "busy" })
    expect(promptSessionStatusMeta("ses_1")).toBeUndefined()
  })

  test("dispatcher exposes timeout stage and clears it when the server wins", () => {
    setPromptSessionStatus({
      sessionID: "ses_1",
      status: { type: "busy" },
    })
    dispatchSessionStatusTimeoutStage({
      event: { type: "session.status.timeout", sessionID: "ses_1", stage: "pending" },
    })

    expect(promptSessionStatusStage("ses_1")).toBe("pending")

    setPromptSessionStatus({
      sessionID: "ses_1",
      status: { type: "idle" },
      source: "server",
    })

    expect(promptSessionStatusStage("ses_1")).toBeUndefined()
  })
})

function statusFor(sessionID: string) {
  return queryClient.getQueryData<SessionStatus>(shellDataKeys.sessionId(sessionID, "status"))
}
