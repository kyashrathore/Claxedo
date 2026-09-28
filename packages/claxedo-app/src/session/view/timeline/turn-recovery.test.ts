import { describe, expect, test } from "bun:test"
import { sessionScreenEnglish } from "../i18n/en"
import type { TimelineTextKey } from "./model"
import { turnRecoveryKeys, sessionRecoveryClass, sessionRecoveryDescription, sessionRecoveryTitle, type SessionErrorClass } from "./turn-recovery"

const RATE_LIMITED =
  "Claude assistant message failed: rate_limit\nAPI Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later."
const USAGE_LIMITED = "You've reached your Codex usage limit. It will reset in about 5 hours."

const english = (key: TimelineTextKey) => sessionScreenEnglish[`sessionScreen.timeline.${key}`]

function copy(kind: SessionErrorClass) {
  const text = turnRecoveryKeys(kind)
  return { title: english(text.title), description: english(text.description), action: text.action && english(text.action) }
}

const failed = (message: string, firstTurnErrorClass?: string) => ({
  name: "UnknownError",
  data: { message, ...(firstTurnErrorClass ? { firstTurnErrorClass } : {}) },
})

describe("turn recovery", () => {
  test("a rate limit asks to try again shortly and offers Resend", () => {
    expect(copy("rate_limit")).toEqual({ title: "Rate limited", description: "Try again shortly.", action: "Resend" })
  })

  test("a usage limit asks for another model or account and offers no resend", () => {
    expect(copy("usage_limit")).toEqual({ title: "Usage limit reached", description: "Choose another model or account.", action: undefined })
  })

  test("the runtime's class wins over the wording", () => {
    expect(sessionRecoveryClass(failed(RATE_LIMITED, "usage_limit"))).toBe("usage_limit")
    expect(sessionRecoveryClass(failed(USAGE_LIMITED, "rate_limit"))).toBe("rate_limit")
  })

  test("without a class, a 429 that says try again later is a rate limit and an exhausted window is a usage limit", () => {
    expect(sessionRecoveryClass(failed(RATE_LIMITED))).toBe("rate_limit")
    expect(sessionRecoveryClass(failed(USAGE_LIMITED))).toBe("usage_limit")
    expect(sessionRecoveryClass(failed("429 You exceeded your current quota, please check your plan and billing details."))).toBe("usage_limit")
  })

  test("a class outside the vocabulary is read from the wording instead", () => {
    expect(sessionRecoveryClass(failed(RATE_LIMITED, "throttled"))).toBe("rate_limit")
  })

  test("a usage limit the provider named keeps the provider's limit and asks for another model or account", () => {
    const error = failed("Claude Code returned an error result: You've reached your Fable 5 limit. It will reset at 3pm.", "usage_limit")
    const context = { providerID: "anthropic", modelID: "claude-fable-5" }
    expect(sessionRecoveryTitle("usage_limit", error, context)).toBe("Anthropic usage limit reached")
    expect(sessionRecoveryDescription("usage_limit", error, context))
      .toBe("You've reached your Fable 5 limit. It will reset at 3pm. Choose another model or account.")
  })

  test("a rate limit with no provider status falls back to its class copy", () => {
    expect(sessionRecoveryTitle("rate_limit", failed(RATE_LIMITED, "rate_limit"))).toBeUndefined()
    expect(sessionRecoveryDescription("rate_limit", failed(RATE_LIMITED, "rate_limit"))).toBeUndefined()
  })
})
