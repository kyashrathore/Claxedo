import type { AgentRuntimeEventOf } from "@claxedo/agent-runtime-contract"

export function todos(chunk: AgentRuntimeEventOf<"todo-update">) {
  return chunk.todos.map((todo) => ({
    id: todo.id,
    content: todo.description,
    status: todo.status,
    priority: todo.priority ?? "medium",
  }))
}

export function questions(chunk: AgentRuntimeEventOf<"question">) {
  return chunk.questions.map((question, i) => ({
    question: question.text,
    header: question.header ?? (question.text.slice(0, 30) || `Question ${i + 1}`),
    options: (question.options ?? []).map((label) => ({
      label,
      description: question.optionDescriptions?.[label] ?? label,
    })),
    ...(question.multiple !== undefined ? { multiple: question.multiple } : {}),
    custom: question.custom ?? !question.options?.length,
  }))
}

export function questionAnswers(chunk: AgentRuntimeEventOf<"question-answered">) {
  return Object.keys(chunk.answers).sort().map((key) => {
    const answer = chunk.answers[key]
    if (Array.isArray(answer)) return answer.filter((value): value is string => typeof value === "string")
    return typeof answer === "string" ? [answer] : []
  })
}
