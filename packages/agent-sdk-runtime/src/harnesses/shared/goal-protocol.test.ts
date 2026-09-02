import { describe, expect, test } from "bun:test"
import {
  GOAL_PROMPT_TEXT,
  goalContinuationPrompt,
  goalEvaluationProgress,
  goalEvaluatorRequest,
  goalInitialPrompt,
  parseGoalEvaluation,
} from "./goal-protocol"

describe("goal protocol", () => {
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
  })

  test("a continuation without a recorded verdict still states what is missing", () => {
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

  test("a verdict is read out of surrounding prose", () => {
    expect(parseGoalEvaluation('Verdict: {"met":true,"reason":"Suite is green"} — done', "Pi")).toEqual({
      met: true,
      reason: "Suite is green",
    })
  })

  test("an unusable verdict names the evaluator that produced it", () => {
    expect(() => parseGoalEvaluation("no json here", "Pi"))
      .toThrow("Pi Goal evaluator returned no JSON result")
    expect(() => parseGoalEvaluation('{"met":"yes","reason":"x"}', "OpenCode"))
      .toThrow("OpenCode Goal evaluator returned an invalid result")
    expect(() => parseGoalEvaluation('{"met":true}', "OpenCode"))
      .toThrow("OpenCode Goal evaluator returned an invalid result")
  })

  test("a met objective completes the Goal and an unmet one keeps it running", () => {
    expect(goalEvaluationProgress({
      evaluation: { met: true, reason: "Suite is green" },
      iteration: 3,
      now: 1_000,
    })).toEqual({ status: "complete", updatedAt: 1_000, iteration: 3, lastReason: "Suite is green" })
    expect(goalEvaluationProgress({
      evaluation: { met: false, reason: "No test run" },
      iteration: 1,
      now: 1_000,
    })).toEqual({ status: "active", updatedAt: 1_000, iteration: 1, lastReason: "No test run" })
  })
})
