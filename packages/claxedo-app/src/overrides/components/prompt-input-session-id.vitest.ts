import { describe, expect, test } from "vitest"
import { resolveSessionId } from "./prompt-input/resolve-session-id"

/**
 * REGRESSION: prompt-input resolvedSessionId resolution
 *
 * Bug: `resolvedSessionId` fell back to `useParams().id` from the router,
 * which is empty/undefined in split/group mode. This caused `createPromptSubmit`
 * to receive `undefined` as the session ID, treating every submit as a new
 * session (`isNewSession = true`) and creating duplicates.
 *
 * Fix: Added `useSessionParams()?.sessionId()` as fallback before `params.id`.
 * Resolution chain: `props.sessionID ?? sessionParams?.sessionId() ?? params.id`
 *
 * These tests verify the REAL resolveSessionId utility used by PromptInput.
 */

describe("resolveSessionId", () => {
  test("props.sessionID takes first priority", () => {
    expect(resolveSessionId("ses_prop", "ses_params", "ses_route")).toBe("ses_prop")
  })

  test("sessionParams takes second priority when prop is undefined", () => {
    expect(resolveSessionId(undefined, "ses_params", "ses_route")).toBe("ses_params")
  })

  test("route params used as last resort", () => {
    expect(resolveSessionId(undefined, undefined, "ses_route")).toBe("ses_route")
  })

  test("returns undefined when nothing is available", () => {
    expect(resolveSessionId(undefined, undefined, undefined)).toBeUndefined()
  })

  test("REGRESSION: split mode — sessionParams provides ID when route params are empty", () => {
    const result = resolveSessionId(undefined, "ses_real_session", undefined)
    expect(result).toBe("ses_real_session")
    expect(result).toBeTruthy()
  })

  test("REGRESSION: isNewSession must be false for existing session in split mode", () => {
    const sessionID = resolveSessionId(undefined, "ses_existing", undefined)
    const isNewSession = !sessionID || sessionID === "new"
    expect(isNewSession).toBe(false)
  })

  test("isNewSession is true only for genuinely new sessions", () => {
    const undefinedSession = resolveSessionId(undefined, undefined, undefined)
    const newSession = resolveSessionId(undefined, "new", undefined)

    expect(!undefinedSession || undefinedSession === "new").toBe(true)
    expect(!newSession || newSession === "new").toBe(true)
  })
})
