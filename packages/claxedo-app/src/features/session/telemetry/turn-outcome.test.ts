import { describe, expect, test } from "bun:test"
import { turnOutcomeEvents } from "./turn-outcome"
import type { FirstTurnMessage } from "../onboarding/first-turn-recovery"

const user = (id: string, created = 1000): FirstTurnMessage => ({ id, role: "user", time: { created } })

const assistant = (
  parentID: string,
  options: { completed?: number; error?: unknown } = {},
): FirstTurnMessage => ({
  id: `${parentID}_a`,
  role: "assistant",
  parentID,
  time: { created: 1000, ...(options.completed === undefined ? {} : { completed: options.completed }) },
  ...(options.error === undefined ? {} : { error: options.error }),
})

describe("settling", () => {
  test("a completed turn reports once", () => {
    const events = turnOutcomeEvents([user("u1"), assistant("u1", { completed: 3500 })], new Set())
    expect(events).toHaveLength(1)
    expect(events[0]!.name).toBe("turn_completed")
    expect(events[0]!.properties.duration_ms).toBe(2500)
  })

  test("an in-flight turn reports nothing", () => {
    // Neither completed nor errored: still streaming. Emitting here would count
    // every live turn as a success.
    expect(turnOutcomeEvents([user("u1"), assistant("u1")], new Set())).toEqual([])
  })

  test("a user message with no assistant reply reports nothing", () => {
    expect(turnOutcomeEvents([user("u1")], new Set())).toEqual([])
  })

  test("an errored turn reports failure even without a completion time", () => {
    const events = turnOutcomeEvents([user("u1"), assistant("u1", { error: { data: { message: "boom" } } })], new Set())
    expect(events).toHaveLength(1)
    expect(events[0]!.name).toBe("turn_failed")
  })
})

describe("failure classification", () => {
  const classOf = (message: string) => {
    const events = turnOutcomeEvents([user("u1"), assistant("u1", { error: { data: { message } } })], new Set())
    return events[0]!.properties.failure_class
  }

  test("derives the class from the wire error", () => {
    expect(classOf("401 unauthorized: invalid api key")).toBe("credential")
    expect(classOf("thread not found")).toBe("session")
    expect(classOf("model deployment unavailable")).toBe("model")
  })

  test("prefers the server-stamped class over the regex fallback", () => {
    const events = turnOutcomeEvents(
      [user("u1"), assistant("u1", { error: { data: { firstTurnErrorClass: "harness", message: "401 unauthorized" } } })],
      new Set(),
    )
    expect(events[0]!.properties.failure_class).toBe("harness")
  })

  test("an unrecognized error still classifies rather than dropping the turn", () => {
    expect(classOf("something entirely unexpected")).toBe("unknown")
  })
})

describe("dedupe", () => {
  test("a turn already reported is not reported again", () => {
    const messages = [user("u1"), assistant("u1", { completed: 2000 })]
    const reported = new Set(["u1"])
    expect(turnOutcomeEvents(messages, reported)).toEqual([])
  })

  test("re-scanning a transcript only yields the newly settled turn", () => {
    // The real caller re-runs this on every message change, so a turn that
    // settled earlier must not re-fire alongside the new one.
    const first = [user("u1", 1000), assistant("u1", { completed: 2000 })]
    const seen = new Set(turnOutcomeEvents(first, new Set()).map((event) => event.userMessageId))
    const second = [...first, user("u2", 3000), assistant("u2", { completed: 4000 })]
    const events = turnOutcomeEvents(second, seen)
    expect(events.map((event) => event.userMessageId)).toEqual(["u2"])
  })

  test("only the first turn is flagged as first", () => {
    const messages = [
      user("u1", 1000), assistant("u1", { completed: 2000 }),
      user("u2", 3000), assistant("u2", { completed: 4000 }),
    ]
    const events = turnOutcomeEvents(messages, new Set())
    expect(events.map((event) => event.properties.is_first_turn)).toEqual([true, false])
  })

  test("the first assistant reply wins when a turn was retried", () => {
    const messages: FirstTurnMessage[] = [
      user("u1"),
      assistant("u1", { error: { data: { message: "429 rate limit" } } }),
      { id: "u1_retry", role: "assistant", parentID: "u1", time: { created: 1000, completed: 5000 } },
    ]
    const events = turnOutcomeEvents(messages, new Set())
    expect(events).toHaveLength(1)
    expect(events[0]!.name).toBe("turn_failed")
  })
})

describe("duration", () => {
  test("is omitted when the assistant never recorded a completion time", () => {
    const events = turnOutcomeEvents([user("u1"), assistant("u1", { error: "x" })], new Set())
    expect(events[0]!.properties).not.toHaveProperty("duration_ms")
  })

  test("is omitted rather than negative when clocks disagree", () => {
    const events = turnOutcomeEvents([user("u1", 9000), assistant("u1", { completed: 1000 })], new Set())
    expect(events[0]!.properties).not.toHaveProperty("duration_ms")
  })
})

/**
 * PII-creep tripwire. A failed turn's error carries provider text, and provider
 * text quotes prompts, paths and repository names. Asserting the EXACT key set
 * means any future property has to be added here deliberately, and the negative
 * assertions name the specific shapes that would leak content.
 */
describe("payload safety", () => {
  test("a failure sends exactly the allowlisted keys", () => {
    const events = turnOutcomeEvents(
      [user("u1"), assistant("u1", { completed: 2000, error: { data: { message: "401 unauthorized" } } })],
      new Set(),
    )
    expect(Object.keys(events[0]!.properties).sort()).toEqual(["duration_ms", "failure_class", "is_first_turn"])
  })

  test("a success sends exactly the allowlisted keys", () => {
    const events = turnOutcomeEvents([user("u1"), assistant("u1", { completed: 2000 })], new Set())
    expect(Object.keys(events[0]!.properties).sort()).toEqual(["duration_ms", "is_first_turn"])
  })

  test("no error text, stack, or prompt content ever rides along", () => {
    const secret = "/Users/someone/private-repo: your prompt said hunter2"
    const events = turnOutcomeEvents(
      [user("u1"), assistant("u1", { error: { data: { message: secret }, stack: "at foo()" } })],
      new Set(),
    )
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain("hunter2")
    expect(serialized).not.toContain("private-repo")
    expect(serialized).not.toContain("at foo()")
    for (const key of ["message", "error", "stack", "text", "prompt"]) {
      expect(events[0]!.properties).not.toHaveProperty(key)
    }
  })
})
