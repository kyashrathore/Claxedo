/// <reference types="bun" />
import { expect, test } from "bun:test"
import { userMessageHead } from "./user-message-head"

test("a user message with no agent is headed by the harness the session runs, never by an agent name the app made up", () => {
  expect(userMessageHead({ harnessLabel: "Claude Code", model: "claude-opus-5-5" })).toBe("Claude Code · claude-opus-5-5")
  expect(userMessageHead({ harnessLabel: "Pi", model: "" })).toBe("Pi")
  expect(userMessageHead({ model: "gpt-5" })).toBe("gpt-5")
})

test("a user message that names an engine agent is headed by that agent, capitalized", () => {
  expect(userMessageHead({ agent: "plan", harnessLabel: "OpenCode", model: "gpt-5" })).toBe("Plan · gpt-5")
})
