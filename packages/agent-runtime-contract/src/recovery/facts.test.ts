import { describe, expect, test } from "bun:test"
import { codeOf, operation } from "./fixtures.test"
import { parseRecoveryOutcome } from "./outcomes"

describe("outcome wire form", () => {

  test.each([
    ["non-finite observation time", { execution: { value: "terminal", source: "harness", observedAt: Number.POSITIVE_INFINITY, generation: "gen-3" } }, "invalid_observed_at"],
    ["unknown fact value", { execution: { value: "finished", source: "harness", observedAt: 1, generation: "gen-3" } }, "invalid_fact"],
    ["fact without a generation", { execution: { value: "terminal", source: "harness", observedAt: 1 } }, "missing_generation"],
  ])("rejects an operation with a %s", (_label, override, code) => {
    const broken = { kind: "operation", operation: { ...operation, facts: { ...operation.facts, ...override } } }
    expect(codeOf(() => parseRecoveryOutcome(broken))).toBe(code)
  })
})
