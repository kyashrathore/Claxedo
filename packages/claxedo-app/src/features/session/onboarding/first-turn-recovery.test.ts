import { describe, expect, test } from "bun:test"
import {
  sessionRecovery,
  sessionRecoveryClass,
  firstTurnOutcome,
  firstTurnFunnelEvents,
  shouldShowStarterPrompts,
} from "./first-turn-recovery"

describe("first-turn recovery", () => {
  test("starter prompts are visible only until the first prompt is sent", () => {
    expect(shouldShowStarterPrompts({ completedTurns: 0, sentTurns: 0 })).toBe(true)
    expect(shouldShowStarterPrompts({ completedTurns: 0, sentTurns: 1 })).toBe(false)
    expect(shouldShowStarterPrompts({ completedTurns: 1, sentTurns: 1 })).toBe(false)
  })

  test.each([
    ["credential", "Reconnect provider"],
    ["harness", "Try again"],
    ["model", "Switch model and retry"],
    ["workspace", "Retry"],
    ["session", "Start a new session"],
    ["unknown", "Try again"],
  ] as const)("maps %s to one recovery action", (kind, label) => {
    expect(sessionRecovery(kind)).toEqual(expect.objectContaining({ kind, label }))
  })

  test("reads the server classification and has a legacy-message fallback", () => {
    expect(sessionRecoveryClass({
      name: "UnknownError",
      data: { message: "bad token", firstTurnErrorClass: "credential" },
    })).toBe("credential")
    expect(sessionRecoveryClass({ name: "UnknownError", data: { message: "model not found" } })).toBe("model")
    expect(sessionRecoveryClass({ name: "UnknownError", data: { message: "harness_switch_not_supported" } })).toBe("harness")
    expect(sessionRecoveryClass({ name: "UnknownError", data: { message: "thread not found: abc" } })).toBe("session")
    expect(sessionRecoveryClass({ name: "UnknownError", data: { message: "Stream error" } })).toBe("unknown")
  })

  test("emits a typed outcome only when the first turn settles", () => {
    const user = { id: "u1", role: "user" as const, time: { created: 1 } }
    expect(firstTurnOutcome([user])).toBeUndefined()
    expect(firstTurnOutcome([user, {
      id: "a1", role: "assistant", parentID: "u1", time: { created: 2, completed: 3 },
    }])).toEqual({ name: "first_turn_ok" })
    expect(firstTurnOutcome([user, {
      id: "a1", role: "assistant", parentID: "u1", time: { created: 2, completed: 3 },
      error: { data: { message: "model not found", firstTurnErrorClass: "model" } },
    }])).toEqual({ name: "first_turn_failed", class: "model" })
  })

  test("adds the cloud milestone once to a successful first cloud turn", () => {
    const messages = [
      { id: "u1", role: "user" as const, time: { created: 1 } },
      { id: "a1", role: "assistant" as const, parentID: "u1", time: { created: 2, completed: 3 } },
    ]
    expect(firstTurnFunnelEvents(messages, false)).toEqual([{ name: "first_turn_ok" }])
    expect(firstTurnFunnelEvents(messages, true)).toEqual([{ name: "first_turn_ok" }, { name: "first_cloud_turn_ok" }])
  })
})
