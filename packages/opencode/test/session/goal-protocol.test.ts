import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import {
  GOAL_PROMPT_TEXT,
  goalContinuationPrompt,
  goalEvaluationProgress,
  goalEvaluatorRequest,
  goalInitialPrompt,
  parseGoalEvaluation,
} from "@/session/goal-protocol"

/**
 * The Pi Goal controller in `@claxedo/agent-sdk-runtime` runs the same executor
 * loop against the same prompt wording and the same evaluator JSON contract.
 * Neither package depends on the other, so the text is mirrored rather than
 * imported, and this test is what keeps the two copies one protocol: it reads
 * the sibling module's source and fails the moment either side is edited alone.
 */
const MIRROR = path.resolve(
  import.meta.dirname,
  "../../../agent-sdk-runtime/src/harnesses/shared/goal-protocol.ts",
)

describe("Goal protocol", () => {
  test("the opening prompt names the objective and defers completion to the evaluator", () => {
    expect(goalInitialPrompt("Ship the release")).toBe([
      "Work autonomously toward this Goal: Ship the release",
      "Use tools as needed and report concrete evidence. An independent evaluator decides completion.",
    ].join("\n\n"))
  })

  test("a continuation carries the evaluator's refusal as the evidence to address", () => {
    expect(goalContinuationPrompt({ objective: "Ship the release", reason: "No test run" })).toBe([
      "Continue working toward the Goal: Ship the release",
      "Independent evaluator: No test run",
      "Address the missing evidence and continue autonomously.",
    ].join("\n\n"))
    expect(goalContinuationPrompt({ objective: "Ship" })).toContain(
      `Independent evaluator: ${GOAL_PROMPT_TEXT.missingEvaluatorReason}`,
    )
  })

  test("the evaluator sees only the objective and the latest work", () => {
    expect(goalEvaluatorRequest({ objective: "Ship", work: "Ran the suite" })).toBe(
      "OBJECTIVE:\nShip\n\nLATEST WORK RESULT:\nRan the suite",
    )
    expect(goalEvaluatorRequest({ objective: "Ship", work: "" })).toContain("(no visible result)")
  })

  test("a verdict is read out of surrounding prose and named when unusable", () => {
    expect(parseGoalEvaluation('Verdict: {"met":true,"reason":"Suite is green"}', "OpenCode")).toEqual({
      met: true,
      reason: "Suite is green",
    })
    expect(() => parseGoalEvaluation("no json here", "OpenCode"))
      .toThrow("OpenCode Goal evaluator returned no JSON result")
    expect(() => parseGoalEvaluation('{"met":"yes","reason":"x"}', "OpenCode"))
      .toThrow("OpenCode Goal evaluator returned an invalid result")
  })

  test("a met objective completes the Goal and an unmet one keeps it running", () => {
    expect(goalEvaluationProgress({ evaluation: { met: true, reason: "Green" }, iteration: 3, now: 1_000 }))
      .toEqual({ status: "complete", updatedAt: 1_000, iteration: 3, lastReason: "Green" })
    expect(goalEvaluationProgress({ evaluation: { met: false, reason: "No run" }, iteration: 1, now: 1_000 }))
      .toEqual({ status: "active", updatedAt: 1_000, iteration: 1, lastReason: "No run" })
  })

  test("every literal of the protocol matches the agent-sdk-runtime mirror", () => {
    expect(fs.existsSync(MIRROR)).toBe(true)
    const mirror = fs.readFileSync(MIRROR, "utf8")
    for (const [field, value] of Object.entries(GOAL_PROMPT_TEXT)) {
      expect(mirror).toContain(`${field}:`)
      for (const literal of Array.isArray(value) ? value : [value]) {
        expect(mirror).toContain(literal)
      }
    }
  })
})
