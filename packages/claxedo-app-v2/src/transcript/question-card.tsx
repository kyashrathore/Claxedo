import { createMemo, For, Show } from "solid-js"
import type { AgentQuestionAnswer, AgentQuestionInfo } from "@claxedo/agent-runtime-contract"
import { Icon } from "@opencode-ai/ui/icon"
import { useI18n } from "@opencode-ai/ui/context/i18n"

export type QuestionAnswerMark = {
  text: string
  /** The reader typed this rather than picking a declared option. */
  custom: boolean
}

export type QuestionAnswerRow = {
  question: string
  answers: QuestionAnswerMark[]
}

export function questionAnswerRows(
  questions: readonly AgentQuestionInfo[],
  answers: readonly AgentQuestionAnswer[],
): QuestionAnswerRow[] {
  return questions.map((question, index) => {
    const labels = new Set(question.options?.map((option) => option.label))
    return {
      question: question.question,
      answers: (answers[index] ?? [])
        .filter((text) => text !== "")
        .map((text) => ({ text, custom: !labels.has(text) })),
    }
  })
}

export function QuestionCard(props: { questions: AgentQuestionInfo[]; answers: AgentQuestionAnswer[] }) {
  const i18n = useI18n()
  const rows = createMemo(() => questionAnswerRows(props.questions, props.answers))
  const answered = createMemo(() => rows().filter((row) => row.answers.length > 0).length)

  return (
    <div data-component="question-card" class="ui-question-card">
      <div data-slot="question-card-header">
        <Icon name="bubble-5" size="small" />
        <span data-slot="question-card-title">{i18n.t("ui.tool.questions")}</span>
        <Show when={answered() > 0}>
          <span data-slot="question-card-count">
            {i18n.t("ui.question.subtitle.answered", { count: answered() })}
          </span>
        </Show>
      </div>
      <div data-component="question-answers" class="ui-question-answers">
        <For each={rows()}>
          {(row) => (
            <div data-slot="question-answer-item">
              <div data-slot="question-text" class="ui-question-text">{row.question}</div>
              <Show
                when={row.answers.length > 0}
                fallback={
                  <span data-slot="answer-text" class="ui-answer-text" data-kind="none">
                    {i18n.t("ui.question.answer.none")}
                  </span>
                }
              >
                <div data-slot="question-answer-marks">
                  <For each={row.answers}>
                    {(mark) => (
                      <span
                        data-slot="answer-text" class="ui-answer-text"
                        data-kind={mark.custom ? "custom" : "option"}
                      >
                        {mark.text}
                      </span>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
