import { describe, expect, test } from "vitest"
import {
  SESSION_TURN_AUTHORITY_METHODS,
  SessionTurnConflictError,
  SessionTurnLeaseLostError,
  type SessionTurnAuthority,
} from "./session-turn-authority"

describe("provider-neutral session-turn authority contract", () => {
  test("keeps the runtime principal explicit and inventories the whole lease lifecycle", () => {
    expect(SESSION_TURN_AUTHORITY_METHODS).toEqual([
      "acquireSessionTurn",
      "renewSessionTurn",
      "releaseSessionTurn",
    ] satisfies Array<keyof SessionTurnAuthority>)
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
