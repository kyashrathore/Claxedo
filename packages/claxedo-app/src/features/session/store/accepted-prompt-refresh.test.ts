import { afterEach, describe, expect, test } from "bun:test"
import {
  claimAcceptedPromptRefresh,
  completeAcceptedPromptRefresh,
  readAcceptedPromptStatus,
  releaseAcceptedPromptRefresh,
  requestAcceptedPromptRefresh,
  acceptedPromptRefreshRequest,
  resetAcceptedPromptRefreshForTest,
} from "./accepted-prompt-refresh"

afterEach(() => resetAcceptedPromptRefreshForTest())

describe("accepted prompt reconciliation ownership", () => {
  test("one controller consumes a request exactly once", () => {
    requestAcceptedPromptRefresh({ directory: "/repo", sessionID: "ses_1", messageID: "msg_1" })
    const request = acceptedPromptRefreshRequest()!
    const first = {}
    const second = {}

    expect(claimAcceptedPromptRefresh(request, first)).toBe(true)
    expect(claimAcceptedPromptRefresh(request, second)).toBe(false)
    expect(completeAcceptedPromptRefresh(request, first)).toBe(true)
    expect(acceptedPromptRefreshRequest()).toBeUndefined()
    expect(claimAcceptedPromptRefresh(request, second)).toBe(false)
  })

  test("an aborted pane releases ownership for the next matching activation", () => {
    requestAcceptedPromptRefresh({ directory: "/repo", sessionID: "ses_1", messageID: "msg_1" })
    const request = acceptedPromptRefreshRequest()!
    const hiddenPane = {}
    const activePane = {}

    expect(claimAcceptedPromptRefresh(request, hiddenPane)).toBe(true)
    releaseAcceptedPromptRefresh(request, hiddenPane)
    expect(claimAcceptedPromptRefresh(request, activePane)).toBe(true)
  })

  test("status reconciliation forwards its abort signal to the canonical request", async () => {
    const controller = new AbortController()
    let observed: AbortSignal | undefined
    const result = await readAcceptedPromptStatus({
      sessionID: "ses_1",
      signal: controller.signal,
      client: {
        session: {
          status: async (_parameters, options) => {
            observed = options?.signal
            return { data: { ses_1: { type: "busy" as const } } }
          },
        },
      },
    })

    expect(observed).toBe(controller.signal)
    expect(result).toEqual({ type: "busy" })
  })
})
