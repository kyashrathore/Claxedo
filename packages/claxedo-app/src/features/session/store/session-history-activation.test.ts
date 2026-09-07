import { describe, expect, test } from "bun:test"
import {
  classifySessionHistoryReadFailure,
  isSessionAccessDeniedError,
  isSessionNotFoundError,
} from "./session-history-activation"
import { runtimeRequestError } from "@/platform/runtime/agent/agent-runtime-request-error"

describe("session history read failure", () => {
  test("identifies missing session transport errors", () => {
    expect(isSessionNotFoundError(new Error("Request failed: 404"))).toBe(true)
    expect(isSessionNotFoundError({ error: { code: "session_not_found", message: "Session not found" } })).toBe(true)
    expect(isSessionNotFoundError(new Error("Request failed: 500"))).toBe(false)
  })

  // The exact body `authority/adapters/sqlite/private-session-authority.ts`
  // returns for a session the principal may not read, decoded the way
  // `readRuntimeJson` decodes it, so the predicate is pinned to the producer
  // rather than to a hand-written message.
  const deniedSessionReadError = () =>
    runtimeRequestError(
      new Response(
        JSON.stringify({
          error: { code: "workspace_authorization_denied", message: "Private session authority denied access" },
        }),
        { status: 403 },
      ),
    )

  test("a session read the authority refuses is a denial, not a session that is merely absent", async () => {
    const denied = await deniedSessionReadError()

    expect(isSessionAccessDeniedError(denied)).toBe(true)
    expect(isSessionNotFoundError(denied)).toBe(false)
    expect(isSessionAccessDeniedError(new Error("Private session authority denied access"))).toBe(false)
  })

  test("a denied history read settles on session-unavailable instead of escaping the activation path", async () => {
    const denied = await deniedSessionReadError()

    expect(classifySessionHistoryReadFailure({ error: denied })).toEqual({ kind: "denied" })
    // An older page the authority refuses is the same denial. Recording it as a
    // retryable cursor would leave the pane offering history it may not read.
    expect(classifySessionHistoryReadFailure({ error: denied, before: "cur_older" })).toEqual({ kind: "denied" })
  })

  test("only a fault with no handled state is rethrown", async () => {
    expect(classifySessionHistoryReadFailure({ error: new Error("Request failed: 404") })).toEqual({ kind: "missing" })
    expect(classifySessionHistoryReadFailure({ error: new Error("Request failed: 500") })).toEqual({ kind: "unhandled" })
    expect(classifySessionHistoryReadFailure({ error: new Error("Request failed: 500"), before: "cur_older" }))
      .toEqual({ kind: "page", failedCursor: "cur_older" })
    expect(classifySessionHistoryReadFailure({
      error: await runtimeRequestError(new Response("nope", { status: 500 })),
    })).toEqual({ kind: "unhandled" })
  })
})
