import { asText as text } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import type { HarnessEventAdapterContext } from "../../../translate/adapter"
import { optionLabels, pathFields } from "../../../translate/value"

function questionFromToolUse(row: Record<string, unknown>, context: HarnessEventAdapterContext) {
  const toolName = text(row.toolName) ?? text(row.name)
  if (toolName !== "AskUserQuestion") return []
  const input = asRecord(row.input)
  if (!Array.isArray(input?.questions)) return []
  const questions = input.questions.flatMap((value) => {
    const question = asRecord(value)
    const prompt = text(question?.question)
    if (!prompt) return []
    const options = optionLabels(question?.options)
    const optionDescriptions = Object.fromEntries((Array.isArray(question?.options) ? question.options : [])
      .flatMap((value) => {
        const option = asRecord(value)
        const label = text(option?.label)
        const description = text(option?.description)
        return label && description ? [[label, description]] : []
      }))
    return [{
      text: prompt,
      options,
      optionDescriptions,
      header: text(question?.header),
      multiple: question?.multiSelect === true,
      custom: true,
    }]
  })
  if (!questions.length) return []
  return [{
    type: "question",
    requestId: text(row.requestId) ?? context.createId("question"),
    questions,
  }] satisfies AgentRuntimeEvent[]
}

function permissionFromToolUse(row: Record<string, unknown>, context: HarnessEventAdapterContext) {
  const toolName = text(row.toolName) ?? text(row.name)
  if (!toolName) return []
  const input = asRecord(row.input) ?? {}
  return [{
    type: "permission-request",
    requestId: text(row.requestId) ?? context.createId("permission"),
    tool: toolName,
    paths: pathFields(input, ["path", "file_path", "filePath", "cwd"]),
    details: { command: text(input.command), reason: text(input.description) },
  }] satisfies AgentRuntimeEvent[]
}

export function translateCanUseTool(message: Record<string, unknown>, context: HarnessEventAdapterContext): AgentRuntimeEvent[] {
  const questions = questionFromToolUse(message, context)
  return questions.length ? questions : permissionFromToolUse(message, context)
}
