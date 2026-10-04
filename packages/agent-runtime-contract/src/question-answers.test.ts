import { describe, expect, test } from "bun:test"
import { reconstructQuestionAnswers } from "./question-answers"

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
    expect(
      reconstructQuestionAnswers([CHECKS], { "Which checks should run?": "whatever is fastest, then the rest" }),
    ).toEqual([["whatever is fastest, then the rest"]])
  })

  test("reports an unanswered question as empty", () => {
    expect(reconstructQuestionAnswers([ENVIRONMENT, CHECKS], { "Which test environment?": "Staging" })).toEqual([
      ["Staging"],
      [],
    ])
  })
})
