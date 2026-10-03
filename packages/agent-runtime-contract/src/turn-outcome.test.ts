import { expect, test } from "bun:test"
import { parseAgentTurnOutcome } from "./turn-outcome"
import type { AgentTurnOutcome } from "./sessions"

test("turn snapshots preserve canonical reply identity and structured failure details", () => {
  const outcome: AgentTurnOutcome = { status: "failed", assistantMessageId: "reply-final", completedAt: 20, error: "Quota exhausted", errorClass: "usage_limit", account: { kind: "machine", harnessId: "codex" }, detail: { retryAfter: "tomorrow" } }
  expect(parseAgentTurnOutcome(outcome)).toEqual(outcome)
  expect(parseAgentTurnOutcome({ status: "completed", completedAt: 20, reason: "done" })).toEqual({ status: "completed", completedAt: 20, reason: "done" })
  expect(parseAgentTurnOutcome(undefined)).toBeUndefined()
})

test("invalid terminal identities and failure details are refused", () => {
  for (const row of [
    { status: "completed", completedAt: 2.5 },
    { status: "completed", completedAt: 2, assistantMessageId: " " },
    { status: "failed", completedAt: 2 },
    { status: "failed", completedAt: 2, error: "failed", detail: { code: 5 } },
    { status: "failed", completedAt: 2, error: "failed", errorClass: "fabricated" },
    { status: "failed", completedAt: 2, error: "failed", account: { kind: "machine", harnessId: "unknown" } },
  ]) expect(() => parseAgentTurnOutcome(row)).toThrow()
})
