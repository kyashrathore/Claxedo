import type { AgentQuestionAnswer } from "./content"

export type QuestionAnswerSource = {
  question: string
  optionLabels: string[]
  multiple: boolean
}

const MULTI_SELECT_JOIN = ", "

/**
 * A harness reports one answer per question as a single string, joining a multi-select
 * with `", "`, which loses the selection boundaries. Splitting unconditionally would cut
 * a free-text answer at its first comma, so the declared option labels decide: a value
 * that is itself a label, or that does not split cleanly into labels, is one answer.
 */
export function reconstructQuestionAnswers(
  questions: QuestionAnswerSource[],
  answers: Record<string, unknown>,
): AgentQuestionAnswer[] {
  return questions.map((question) => {
    const value = answers[question.question]
    if (typeof value !== "string" || !value) return []
    const labels = new Set(question.optionLabels)
    if (labels.has(value) || !question.multiple) return [value]
    const selected = value.split(MULTI_SELECT_JOIN)
    return selected.length > 1 && selected.every((label) => labels.has(label)) ? selected : [value]
  })
}
