import { operation, facts } from "./fixtures.test"
import { finalizeRecoveryOperation } from "./operations"
import { describe, test, expect } from "bun:test"

describe("finalizing an attempt", () => {
  test("unknown execution cannot finish a cancellation", () => {
    const finalized = finalizeRecoveryOperation(
      { ...operation, initiatingError: undefined, cleanupErrors: [] },
      facts("unknown", "verified_clear", "committed"),
    )
    expect(finalized.state).toBe("needs_action")
  })

  test("a known failure alongside an unmet postcondition is failed, not pending", () => {
    expect(finalizeRecoveryOperation(operation, facts("terminal", "unknown", "committed")).state).toBe("failed")
  })

  test("a met postcondition succeeds and carries the newest observation time", () => {
    const finalized = finalizeRecoveryOperation(operation, facts("terminal", "verified_clear", "committed"))
    expect(finalized.state).toBe("succeeded")
    expect(finalized.updatedAt).toBe(1_700_000_000_300)
  })

  test("later evidence updates the facts of a terminal attempt without rewriting it", () => {
    const failed = { ...operation, state: "failed" as const }
    const finalized = finalizeRecoveryOperation(failed, facts("terminal", "verified_clear", "committed"))
    expect(finalized.state).toBe("failed")
    expect(finalized.facts.cleanup.value).toBe("verified_clear")
  })
})
