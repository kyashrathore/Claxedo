import { canonicalToolName, reconstructQuestionAnswers, asText as text } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent, RuntimeToolAttachment, ToolDisplay } from "@claxedo/agent-runtime-contract"
import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import { imageAttachment } from "../../../translate/tool-attachments"
import { optionLabels } from "../../../translate/value"
import type { ClaudeSdkAdapterState, ClaudeTranslation } from "./adapter-state"
import { isClaudeQuestionDecline } from "./question-decline"
import { applyClaudeTaskResult } from "./task-tracking"
import { isTaskTool, toolDisplay, toolKind } from "./tool-blocks"

type ToolResultBlock = ReturnType<typeof toolResultBlocks>[number]

function exitCodeFromResultText(resultText: string) {
  const match = /^Exit code (\d+)(?:\s|$)/.exec(resultText)
  return match ? Number(match[1]) : undefined
}

function toolResultText(block: Record<string, unknown>) {
  const content = block.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.flatMap((item) => text(item) ?? text(asRecord(item)?.text) ?? []).join("\n")
}

function toolResultImages(block: Record<string, unknown>): Array<{ mime: string; data: string }> {
  const content = block.content
  if (!Array.isArray(content)) return []
  return content.flatMap((item) => {
    const row = asRecord(item)
    if (row?.type !== "image") return []
    const source = asRecord(row.source)
    if (source?.type !== "base64") return []
    const mime = text(source.media_type)
    const data = text(source.data)
    if (!mime || !data) return []
    return [{ mime, data }]
  })
}

function resultAttachments(
  images: Array<{ mime: string; data: string }>,
  display: ToolDisplay,
): RuntimeToolAttachment[] {
  if (images.length !== 1) return images.map((image) => imageAttachment(image))
  const sourcePath = display.filePath ?? display.path
  const filename = sourcePath?.split(/[\\/]/).pop()
  return images.map((image) => imageAttachment({ ...image, filename, sourcePath }))
}

export function toolResultBlocks(message: Record<string, unknown>) {
  const row = asRecord(message.message) ?? {}
  const content = Array.isArray(row.content) ? row.content : []
  return content.flatMap((item) => {
    const block = asRecord(item)
    if (!block || block.type !== "tool_result") return []
    const toolCallId = text(block.tool_use_id)
    if (!toolCallId) return []
    return [{
      toolCallId,
      block,
      text: toolResultText(block),
      images: toolResultImages(block),
      isError: block.is_error === true,
      structured: asRecord(message.tool_use_result),
    }]
  })
}

function agentResultMetadata(result: Record<string, unknown> | undefined) {
  if (!result || !text(result.agentId)) return {}
  return {
    agentId: text(result.agentId),
    status: text(result.status),
    totalTokens: asFiniteNumber(result.totalTokens),
    totalToolUseCount: asFiniteNumber(result.totalToolUseCount),
    totalDurationMs: asFiniteNumber(result.totalDurationMs),
    usage: asRecord(result.usage),
    toolStats: asRecord(result.toolStats),
  }
}

function isQuestionTool(toolName: string) {
  return canonicalToolName(toolName) === "question"
}

function questionAnswerMetadata(input: Record<string, unknown>, result: Record<string, unknown> | undefined) {
  const answers = asRecord(result?.answers)
  if (!answers) return {}
  const questions = Array.isArray(input.questions) ? input.questions : []
  return {
    answers: reconstructQuestionAnswers(
      questions.map((item) => {
        const row = asRecord(item) ?? {}
        return {
          question: text(row.question) ?? "",
          optionLabels: optionLabels(row.options),
          multiple: row.multiSelect === true,
        }
      }),
      answers,
    ),
  }
}

function agentResultText(result: Record<string, unknown> | undefined, fallback: string) {
  if (!result) return fallback
  const content = Array.isArray(result.content) ? result.content : []
  return content.flatMap((item) => text(asRecord(item)?.text) ?? []).join("\n") || fallback
}

function toolResultMetadata(toolName: string, result: ToolResultBlock) {
  const exitCode = toolKind(toolName) === "command_execution" ? exitCodeFromResultText(result.text) : undefined
  return {
    ...(exitCode === undefined ? {} : { exitCode }),
    claude: {
      itemType: toolKind(toolName),
      ...(isTaskTool(toolName) ? { subagent: agentResultMetadata(result.structured) } : {}),
    },
  }
}

function toolResultEvent(toolName: string, input: Record<string, unknown>, result: ToolResultBlock): AgentRuntimeEvent {
  const metadata = toolResultMetadata(toolName, result)
  const display = toolDisplay(toolName, input)
  if (result.isError) {
    const declined = isQuestionTool(toolName) && isClaudeQuestionDecline(result.text)
    return {
      type: "tool-error",
      toolCallId: result.toolCallId,
      error: result.text,
      display,
      metadata: { ...metadata, ...(declined ? { question: { declined: true } } : {}) },
    }
  }
  return {
    type: "tool-output",
    toolCallId: result.toolCallId,
    output: isTaskTool(toolName) ? agentResultText(result.structured, result.text) : result.text,
    ...(result.images.length ? { attachments: resultAttachments(result.images, display) } : {}),
    display,
    metadata: {
      ...metadata,
      ...(isQuestionTool(toolName) ? questionAnswerMetadata(input, result.structured) : {}),
    },
  }
}

function toolsByCallId(state: ClaudeSdkAdapterState) {
  return Object.fromEntries(
    [...Object.values(state.blocksByIndex), ...Object.values(state.toolsById)].flatMap((block) =>
      block.type === "tool" && block.toolCallId ? [[block.toolCallId, block]] : [],
    ),
  )
}

export function translateToolResults(state: ClaudeSdkAdapterState, message: Record<string, unknown>): ClaudeTranslation {
  const byToolId = toolsByCallId(state)
  let tasks = state.tasks ?? {}
  let changedTasks = false
  const events = toolResultBlocks(message).flatMap((result): AgentRuntimeEvent[] => {
    const tool = byToolId[result.toolCallId]
    if (!tool?.toolName) return []
    if (!result.isError) {
      const nextTasks = applyClaudeTaskResult(tasks, tool.toolName, tool.input ?? {}, result.structured)
      if (nextTasks) {
        tasks = nextTasks
        changedTasks = true
      }
    }
    return [toolResultEvent(tool.toolName, tool.input ?? {}, result)]
  })
  if (!changedTasks) return events
  return { state: { ...state, tasks }, events: [...events, { type: "todo-update", todos: Object.values(tasks) } satisfies AgentRuntimeEvent] }
}
