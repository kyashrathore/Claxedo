import { describe, expect, test } from "vitest"
import {
  SESSION_TURN_AUTHORITY_METHODS,
  SESSION_TURN_GRANT_DEFAULT_TTL_MS,
  SESSION_TURN_GRANT_MAX_TTL_MS,
  SESSION_TURN_GRANT_MIN_TTL_MS,
  SessionTurnConflictError,
  SessionTurnGrantError,
  SessionTurnLeaseLostError,
  childCompletionTurnIdPrefix,
  sessionTurnGrantRefusal,
  sessionTurnGrantTtl,
  type SessionTurnAuthority,
  type SessionTurnGrant,
} from "./session-turn-authority"

describe("provider-neutral session-turn authority contract", () => {
  test("keeps the runtime principal explicit and inventories the whole lease lifecycle", () => {
    expect(SESSION_TURN_AUTHORITY_METHODS).toEqual([
      "acquireSessionTurn",
      "renewSessionTurn",
      "releaseSessionTurn",
      "grantSessionTurn",
      "revokeSessionTurnGrants",
    ] satisfies Array<keyof SessionTurnAuthority>)
  })

  test("bounds a grant lifetime and names the wake turn-id prefix", () => {
    expect(sessionTurnGrantTtl(undefined)).toBe(SESSION_TURN_GRANT_DEFAULT_TTL_MS)
    expect(sessionTurnGrantTtl(SESSION_TURN_GRANT_MIN_TTL_MS)).toBe(SESSION_TURN_GRANT_MIN_TTL_MS)
    expect(sessionTurnGrantTtl(SESSION_TURN_GRANT_MAX_TTL_MS)).toBe(SESSION_TURN_GRANT_MAX_TTL_MS)
    for (const ttl of [SESSION_TURN_GRANT_MIN_TTL_MS - 1, SESSION_TURN_GRANT_MAX_TTL_MS + 1, 1.5, Number.NaN]) {
      expect(() => sessionTurnGrantTtl(ttl)).toThrow(expect.objectContaining({ code: "session_turn_grant_invalid" }))
    }
    expect(childCompletionTurnIdPrefix("ses_child")).toBe("msg_wake_ses_child_")
  })

  test("refuses a grant in a fixed order and admits only a fresh match or the live retry", () => {
    const grant: SessionTurnGrant = {
      grantId: "grant_1",
      sessionId: "ses_parent",
      workspaceId: "ws_1",
      actorId: "actor_grantee",
      intent: "child_completion",
      subjectSessionId: "ses_child",
      turnIdPrefix: "msg_wake_ses_child_",
      issuedAt: 100,
      expiresAt: 200,
    }
    const ask = { actorId: "actor_grantee", sessionId: "ses_parent", workspaceId: "ws_1", turnId: "msg_wake_ses_child_1", now: 150 }
    const code = (value: SessionTurnGrantError | undefined) => value?.code

    expect(code(sessionTurnGrantRefusal(undefined, ask, undefined))).toBe("session_turn_grant_invalid")
    expect(code(sessionTurnGrantRefusal(grant, { ...ask, actorId: "actor_creator" }, undefined))).toBe("session_turn_grant_mismatch")
    expect(code(sessionTurnGrantRefusal(grant, { ...ask, sessionId: "ses_other" }, undefined))).toBe("session_turn_grant_mismatch")
    expect(code(sessionTurnGrantRefusal({ ...grant, revokedAt: 120, expiresAt: 130 }, ask, undefined))).toBe("session_turn_grant_revoked")
    expect(code(sessionTurnGrantRefusal({ ...grant, expiresAt: 150, redeemedAt: 120, redeemedTurnId: "x" }, ask, undefined))).toBe("session_turn_grant_expired")
    expect(code(sessionTurnGrantRefusal(grant, { ...ask, turnId: "msg_other" }, undefined))).toBe("session_turn_grant_mismatch")
    expect(code(sessionTurnGrantRefusal({ ...grant, turnIdPrefix: undefined, turnId: "msg_exact" }, { ...ask, turnId: "msg_exact_2" }, undefined))).toBe("session_turn_grant_mismatch")
    expect(sessionTurnGrantRefusal(grant, ask, undefined)).toBeUndefined()

    const redeemed = { ...grant, redeemedAt: 140, redeemedTurnId: ask.turnId }
    expect(sessionTurnGrantRefusal(redeemed, ask, { turnId: ask.turnId, actorId: ask.actorId })).toBeUndefined()
    expect(code(sessionTurnGrantRefusal(redeemed, ask, undefined))).toBe("session_turn_grant_redeemed")
    expect(code(sessionTurnGrantRefusal(redeemed, ask, { turnId: "msg_wake_ses_child_2", actorId: ask.actorId }))).toBe("session_turn_grant_redeemed")
    expect(code(sessionTurnGrantRefusal(redeemed, { ...ask, turnId: "msg_wake_ses_child_2" }, undefined))).toBe("session_turn_grant_redeemed")
  })

  test("exposes stable conflict and lost-lease classifications", () => {
    expect(new SessionTurnConflictError("ses_1", 123)).toMatchObject({
      name: "SessionTurnConflictError",
      code: "session_turn_in_progress",
      sessionId: "ses_1",
      activeUntil: 123,
    })
    expect(new SessionTurnLeaseLostError("ses_1")).toMatchObject({
      name: "SessionTurnLeaseLostError",
      code: "session_turn_lease_lost",
      sessionId: "ses_1",
    })
  })
})
