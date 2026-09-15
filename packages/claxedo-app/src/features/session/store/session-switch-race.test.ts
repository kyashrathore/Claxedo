import { afterEach, describe, expect, test } from "bun:test"
import type { AgentPermission as PermissionRequest, AgentQuestion as QuestionRequest, AgentRuntimeStatus as SessionStatus } from "@claxedo/agent-runtime-contract"
import { shellDataKeys } from "@/platform/sync/keys"
import { queryClient } from "@/platform/query/query-client"
import { FAST_SESSION_SWITCH_INTENT_MS, markFastSessionSwitch, suppressedByFastSessionSwitch } from "@/platform/runtime/session-switch"
import { syncSessionMeta } from "./session-controller"
import { shouldAcceptSessionTransportResult } from "./session-history-activation"

const idle: SessionStatus = { type: "idle" }
const busy: SessionStatus = { type: "busy" }
const originalDateNow = Date.now

afterEach(() => {
  queryClient.clear()
  Object.defineProperty(Date, "now", { value: originalDateNow, configurable: true })
  delete (globalThis as typeof globalThis & { __claxedoFastSessionSwitch?: unknown }).__claxedoFastSessionSwitch
  // Clear the fast-switch carrier off the happy-dom window WITHOUT deleting the
  // window itself — deleting `window` kills the DOM for every later test file.
  delete (globalThis as typeof globalThis & { window?: { __claxedoFastSessionSwitch?: unknown } }).window
    ?.__claxedoFastSessionSwitch
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

    let releaseStatus!: (value: { data: Record<string, SessionStatus> }) => void
    let signalStarted!: () => void
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    const sdk = metaSdk("ses_a", busy)
    sdk.session.status = async () => {
      signalStarted()
      return await new Promise((resolve) => { releaseStatus = resolve })
    }
    const staleRead = syncSessionMeta({
      sessionID: "ses_a",
      currentSessionID: () => visibleSessionID,
      sdk,
    })
    await started

    markFastSessionSwitch("ses_b", now, { networkQuiet: false })
    visibleSessionID = "ses_b"

    expect(suppressedByFastSessionSwitch("ses_a")).toBe(true)
    expect(suppressedByFastSessionSwitch("ses_b")).toBe(false)
    expect(shouldAcceptSessionTransportResult({
      expectedSessionID: "ses_a",
      currentSessionID: visibleSessionID,
    })).toBe(false)

    releaseStatus({ data: { ses_a: busy } })
    const staleAccepted = await staleRead

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
      reconciledAt: expect.any(Number),
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
