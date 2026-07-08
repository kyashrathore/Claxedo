import { afterEach, describe, expect, test } from "bun:test"
import type { PermissionRequest, QuestionRequest, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { shellDataKeys } from "../../shell/data/keys"
import { queryClient } from "../../shared/query/query-client"
import { FAST_SESSION_SWITCH_INTENT_MS, markFastSessionSwitch, suppressedByFastSessionSwitch } from "./fast-session-switch"
import { shouldAcceptSessionTransportResult, syncSessionMeta } from "./session-controller"

const idle: SessionStatus = { type: "idle" }
const busy: SessionStatus = { type: "busy" }
const originalDateNow = Date.now

afterEach(() => {
  queryClient.clear()
  Object.defineProperty(Date, "now", { value: originalDateNow, configurable: true })
  delete (globalThis as typeof globalThis & { __claxedoFastSessionSwitch?: unknown }).__claxedoFastSessionSwitch
  delete (globalThis as typeof globalThis & { window?: unknown }).window
})

describe("fast session switch race proof", () => {
  test("drops stale transport metadata after a newer session activates and allows reactivation", async () => {
    let now = 1_000
    let visibleSessionID = "ses_a"
    Object.defineProperty(Date, "now", { value: () => now, configurable: true })

    expect(shouldAcceptSessionTransportResult({
      expectedSessionID: "ses_a",
      currentSessionID: visibleSessionID,
    })).toBe(true)

    markFastSessionSwitch("ses_b", now, { networkQuiet: false })
    visibleSessionID = "ses_b"

    expect(suppressedByFastSessionSwitch("ses_a")).toBe(true)
    expect(suppressedByFastSessionSwitch("ses_b")).toBe(false)
    expect(shouldAcceptSessionTransportResult({
      expectedSessionID: "ses_a",
      currentSessionID: visibleSessionID,
    })).toBe(false)

    const staleAccepted = await syncSessionMeta({
      sessionID: "ses_a",
      currentSessionID: () => visibleSessionID,
      sdk: metaSdk("ses_a", busy),
    })

    expect(staleAccepted).toBe(false)
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_a", "status"))).toBeUndefined()
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_a", "requests"))).toBeUndefined()
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_b", "status"))).toBeUndefined()
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_b", "requests"))).toBeUndefined()

    now += FAST_SESSION_SWITCH_INTENT_MS + 1
    visibleSessionID = "ses_a"

    expect(suppressedByFastSessionSwitch("ses_a")).toBe(false)
    expect(shouldAcceptSessionTransportResult({
      expectedSessionID: "ses_a",
      currentSessionID: visibleSessionID,
    })).toBe(true)

    const reactivatedAccepted = await syncSessionMeta({
      sessionID: "ses_a",
      currentSessionID: () => visibleSessionID,
      sdk: metaSdk("ses_a", idle),
    })

    expect(reactivatedAccepted).toBe(true)
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_a", "status"))).toEqual(idle)
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_a", "requests"))).toEqual({
      permissions: [permission("perm_a", "ses_a")],
      questions: [question("question_a", "ses_a")],
    })
  })
})

function metaSdk(sessionID: string, status: SessionStatus) {
  return {
    session: {
      status: async () => ({ data: { [sessionID]: status } }),
    },
    permission: {
      list: async () => ({ data: [permission("perm_a", sessionID)] }),
    },
    question: {
      list: async () => ({ data: [question("question_a", sessionID)] }),
    },
  }
}

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
