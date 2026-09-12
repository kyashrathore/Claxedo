import { afterEach, describe, expect, test } from "bun:test"
import { setPromptSessionStatus } from "./pending"
import {
  clearAllPromptSessionStatusTimeoutsForTest,
  dispatchSessionStatusTimeoutStage,
  promptSessionStatusMeta,
  promptSessionStatusStage,
} from "../store/session-status-dispatcher"
import type { AgentRuntimeStatus as SessionStatus } from "@claxedo/agent-runtime-contract"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"

afterEach(() => {
  clearAllPromptSessionStatusTimeoutsForTest()
  queryClient.clear()
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
