import { describe, expect, test } from "bun:test"
import { isQuestionDeclined, reconstructQuestionAnswers } from "./question-result"

/**
 * Verbatim from `~/.claude/projects/**\/*.jsonl`: the only two error payloads any
 * `AskUserQuestion` tool_result carries, across 30 occurrences.
 */
const DISMISSED = "User dismissed the question"
const REJECTED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.\n\nNote: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions."

const ENVIRONMENT = {
  question: "Which test environment?",
  optionLabels: ["Staging", "Production"],
  multiple: false,
}
const CHECKS = {
  question: "Which checks should run?",
  optionLabels: ["Unit", "Browser"],
  multiple: true,
}

describe("isQuestionDeclined", () => {
  test("accepts the dismissal the claude driver writes", () => {
    expect(isQuestionDeclined(DISMISSED)).toBe(true)
  })

  test("accepts the rejection the CLI writes", () => {
    expect(isQuestionDeclined(REJECTED)).toBe(true)
  })

  test("accepts the dismissal through the harness's Error prefix", () => {
    expect(isQuestionDeclined(`Error: ${DISMISSED}`)).toBe(true)
  })

  test("rejects a real failure", () => {
    expect(isQuestionDeclined("Claude AskUserQuestion requires a non-empty questions array")).toBe(false)
  })

  test("rejects a failure that merely quotes a decline", () => {
    expect(isQuestionDeclined(`Tool crashed while reporting: ${DISMISSED}`)).toBe(false)
  })
})

describe("reconstructQuestionAnswers", () => {
  test("pairs a single-select answer with its question", () => {
    expect(reconstructQuestionAnswers([ENVIRONMENT], { "Which test environment?": "Staging" })).toEqual([["Staging"]])
  })

  test("splits a multi-select into its selected labels", () => {
    expect(
      reconstructQuestionAnswers([ENVIRONMENT, CHECKS], {
        "Which test environment?": "Staging",
        "Which checks should run?": "Unit, Browser",
      }),
    ).toEqual([["Staging"], ["Unit", "Browser"]])
  })

  test("keeps a non-ASCII custom answer whole", () => {
    expect(reconstructQuestionAnswers([ENVIRONMENT], { "Which test environment?": "Preview café 日本語" })).toEqual([
      ["Preview café 日本語"],
    ])
  })

  test("keeps a free-text answer containing a comma whole", () => {
    const destination = {
      question: "Where should the shareable version go?",
      optionLabels: ["Proof link (Recommended)", "Self-contained HTML file"],
      multiple: false,
    }
    expect(
      reconstructQuestionAnswers([destination], {
        "Where should the shareable version go?":
          "claude can create hosted artificates, i am just testing if it works",
      }),
    ).toEqual([["claude can create hosted artificates, i am just testing if it works"]])
  })

  test("keeps a multi-select option label containing a comma whole", () => {
    const scope = {
      question: "Which e2e scope should run?",
      optionLabels: ["Everything, including tier-real and live", "Unit only"],
      multiple: true,
    }
    expect(
      reconstructQuestionAnswers([scope], { "Which e2e scope should run?": "Everything, including tier-real and live" }),
    ).toEqual([["Everything, including tier-real and live"]])
  })

  test("keeps a multi-select free-text answer whole when it is not a set of labels", () => {
    expect(reconstructQuestionAnswers([CHECKS], { "Which checks should run?": "whatever is fastest, then the rest" })).toEqual([
      ["whatever is fastest, then the rest"],
    ])
  })

  test("reports an unanswered question as empty", () => {
    expect(reconstructQuestionAnswers([ENVIRONMENT, CHECKS], { "Which test environment?": "Staging" })).toEqual([
      ["Staging"],
      [],
    ])
  })
})
