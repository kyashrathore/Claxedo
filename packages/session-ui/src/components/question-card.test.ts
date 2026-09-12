import { describe, expect, test } from "bun:test"
import type { AgentQuestionInfo } from "@claxedo/agent-runtime-contract"
import { questionAnswerRows } from "./question-card"

function question(input: Partial<AgentQuestionInfo> & { question: string }): AgentQuestionInfo {
  return { header: "", options: [], ...input }
}

describe("questionAnswerRows", () => {
  test("pairs each question with the answer at its own index", () => {
    const rows = questionAnswerRows(
      [
        question({ question: "Which environment?", options: [{ label: "Staging", description: "" }] }),
        question({ question: "Which checks?", options: [{ label: "Unit", description: "" }] }),
      ],
      [["Staging"], ["Unit"]],
    )

    expect(rows).toEqual([
      { question: "Which environment?", answers: [{ text: "Staging", custom: false }] },
      { question: "Which checks?", answers: [{ text: "Unit", custom: false }] },
    ])
  })

  test("keeps a multi-select answer as one mark per selection", () => {
    const rows = questionAnswerRows(
      [question({
        question: "Which checks?",
        multiple: true,
        options: [{ label: "Unit", description: "" }, { label: "Browser", description: "" }],
      })],
      [["Unit", "Browser"]],
    )

    expect(rows[0]?.answers).toEqual([{ text: "Unit", custom: false }, { text: "Browser", custom: false }])
  })

  test("marks an answer the reader typed, verbatim, as custom", () => {
    const rows = questionAnswerRows(
      [question({ question: "Which environment?", custom: true, options: [{ label: "Staging", description: "" }] })],
      [["the preview box, with --force"]],
    )

    expect(rows[0]?.answers).toEqual([{ text: "the preview box, with --force", custom: true }])
  })

  test("leaves an unanswered question with no marks rather than dropping the row", () => {
    const rows = questionAnswerRows(
      [question({ question: "Which environment?" }), question({ question: "Which checks?" })],
      [["Staging"]],
    )

    expect(rows.map((row) => row.answers.length)).toEqual([1, 0])
    expect(rows[1]?.question).toBe("Which checks?")
  })

  test("drops an empty string rather than drawing a blank mark", () => {
    const rows = questionAnswerRows([question({ question: "Which environment?" })], [["", "Staging"]])

    expect(rows[0]?.answers).toEqual([{ text: "Staging", custom: true }])
  })
})
