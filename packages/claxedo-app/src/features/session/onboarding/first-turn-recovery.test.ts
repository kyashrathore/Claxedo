import { describe, expect, test } from "bun:test"
import {
  sessionRecovery,
  sessionRecoveryClass,
  sessionRecoveryDescription,
  firstTurnOutcome,
  firstTurnFunnelEvents,
} from "./first-turn-recovery"

describe("first-turn recovery", () => {
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

  // BANNED STRING. No failed turn may render a generic shrug: every mapped
  // state must name what failed and what to do about it.
  test("never renders the banned no-detail copy in any mapped state", () => {
    const banned = /no more detail was reported|something went wrong/i
    const errors: unknown[] = [
      undefined,
      {},
      { name: "UnknownError", data: {} },
      { name: "UnknownError", data: { message: "fetch failed" } },
      { name: "APIError", data: { message: "Unauthorized", statusCode: 401 } },
      { name: "APIError", data: { message: "boom", statusCode: 502, responseBody: "{}" } },
    ]
    const classes = ["credential", "harness", "model", "workspace", "session", "unknown"] as const

    for (const kind of classes) {
      // The static table must not carry the banned copy either.
      expect(sessionRecovery(kind).description).not.toMatch(banned)
      for (const error of errors) {
        const text = sessionRecoveryDescription(kind, error, { providerID: "anthropic" })
        expect(text).not.toMatch(banned)
        expect(text.trim().length).toBeGreaterThan(0)
      }
    }
  })

  test("names the provider, the status and the repair for a detailed failure", () => {
    expect(
      sessionRecoveryDescription(
        "unknown",
        { name: "APIError", data: { message: "Unauthorized", statusCode: 401 } },
        { providerID: "anthropic" },
      ),
    ).toBe("Anthropic rejected the credential (401). Check your API key in Settings, then try again.")
  })

  test("a bodyless transport failure names the provider and the failure mode", () => {
    // The minimal case still gets specific copy, never a shrug.
    expect(sessionRecoveryDescription("unknown", { name: "UnknownError", data: {} }, { providerID: "anthropic" }))
      .toBe("Couldn't reach Anthropic — the request never got a response. Check your connection and try again.")
  })

  // A 401 classifies as `credential`, whose class copy is strictly vaguer than
  // the provider's own line. Whenever we have a real status, the specific
  // sentence wins for EVERY class, not just `unknown`.
  test("a real provider status outranks the class sentence for every class", () => {
    const error = { name: "APIError", data: { message: "Unauthorized", statusCode: 401 } }
    for (const kind of ["credential", "harness", "model", "workspace", "session", "unknown"] as const) {
      expect(sessionRecoveryDescription(kind, error, { providerID: "anthropic" })).toBe(
        "Anthropic rejected the credential (401). Check your API key in Settings, then try again.",
      )
    }
  })

  test("keeps the class description when the class already explains the failure", () => {
    // A classified failure has its own repair sentence; the provider summary
    // must not overwrite it with a vaguer one.
    expect(sessionRecoveryDescription("credential", { name: "UnknownError", data: {} })).toBe(
      "The provider rejected the credential for this workspace.",
    )
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
