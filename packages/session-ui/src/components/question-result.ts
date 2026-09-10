import type { AgentQuestionAnswer } from "@claxedo/agent-runtime-contract"

/**
 * The two payloads a declined `AskUserQuestion` can carry. The first is written by
 * `agent-sdk-runtime`'s claude driver when the prompt closes unanswered; the second by
 * the CLI when the call is rejected. Both arrive as `AgentToolState.error`, and nothing
 * else distinguishes them from a real failure: the harness log's `toolDenialKind` is
 * dropped before a part is built, so the message is the only signal that reaches a
 * renderer. Matched as prefixes because the rejection text continues into CLI guidance
 * that is free to change.
 */
const DECLINE_PREFIXES = [
  "User dismissed the question",
  "The user doesn't want to proceed with this tool use.",
]

const ERROR_PREFIX = "Error: "

/** Whether a `question` tool's error is the user declining rather than a failure. */
export function isQuestionDeclined(error: string): boolean {
  const text = error.trim()
  const message = text.startsWith(ERROR_PREFIX) ? text.slice(ERROR_PREFIX.length).trim() : text
  return DECLINE_PREFIXES.some((prefix) => message.startsWith(prefix))
}

export type QuestionAnswerSource = {
  question: string
  optionLabels: string[]
  multiple: boolean
}

const MULTI_SELECT_JOIN = ", "

/**
 * The harness records one answer per question as a single string, joining a multi-select
 * with `", "` — the same join the claude driver applies when it replies, which loses the
 * selection boundaries. Splitting unconditionally would cut a free-text answer at its
 * first comma, so the declared option labels decide: a value that is itself a label, or
 * that does not split cleanly into labels, is one answer.
 */
export function reconstructQuestionAnswers(
  questions: QuestionAnswerSource[],
  answers: Record<string, string>,
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
