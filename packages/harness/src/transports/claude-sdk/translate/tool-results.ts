import { canonicalToolName, reconstructQuestionAnswers, asText as text } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent, RuntimeToolAttachment, ToolDisplay } from "@claxedo/agent-runtime-contract"
import { asArray, asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import { imageAttachment } from "../../../translate/tool-attachments"
import { optionLabels, own } from "../../../translate/value"
import type { ClaudeSdkAdapterState, ClaudeTranslation } from "./adapter-state"
import { messageBlocks } from "./message-content"
import { isClaudeQuestionDecline } from "./question-decline"
import { applyClaudeTaskResult } from "./task-tracking"
import { isTaskTool, toolDisplay, toolKind, toolPresentation } from "./tool-blocks"

const serverToolResults: readonly string[] = ["web_search_tool_result", "web_fetch_tool_result", "advisor_tool_result", "code_execution_tool_result",
  "bash_code_execution_tool_result", "text_editor_code_execution_tool_result", "tool_search_tool_result", "mcp_tool_result"]

type ToolResultBlock = ReturnType<typeof toolResultBlocks>[number]

function exitCodeFromResultText(resultText: string) {
  const match = /^Exit code (\d+)(?:\s|$)/.exec(resultText)
  return match ? Number(match[1]) : undefined
}

export function toolResultText(block: Record<string, unknown>) {
  const content = block.content
  if (typeof content === "string") return content
  return asArray(content).flatMap((item) => text(item) ?? text(asRecord(item)?.text) ?? []).join("\n")
}

function toolResultFiles(block: Record<string, unknown>): Array<{ mime: string; data: string }> {
  return asArray(block.content).flatMap((item) => {
    const row = asRecord(item)
    if (row?.type !== "image" && row?.type !== "document") return []
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
  const sourcePath = images.length === 1 ? display.filePath ?? display.path : undefined
  const filename = sourcePath?.split(/[\\/]/).pop()
  return images.map((image) => imageAttachment({ ...image, filename, sourcePath }))
}

export function toolResultBlocks(message: Record<string, unknown>) {
  return messageBlocks(message).flatMap((block) => {
    if (block.type !== "tool_result") return []
    const toolCallId = text(block.tool_use_id)
    if (!toolCallId) return []
    return [{
      toolCallId,
      block,
      text: toolResultText(block),
      images: toolResultFiles(block),
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

function toolResultEvent(toolName: string, input: Record<string, unknown>, result: ToolResultBlock): AgentRuntimeEvent {
  const { display, metadata: presentation } = toolPresentation(toolName, input)
  const question = canonicalToolName(toolName) === "question"
  const exitCode = toolKind(toolName) === "command_execution" ? exitCodeFromResultText(result.text) : undefined
  const metadata = {
    ...(exitCode === undefined ? {} : { exitCode }),
    claude: {
      ...presentation.claude,
      ...(isTaskTool(toolName) ? { subagent: agentResultMetadata(result.structured) } : {}),
    },
  }
  const settled = { toolCallId: result.toolCallId, display }
  if (result.isError) {
    const declined = question && isClaudeQuestionDecline(result.text)
    return {
      type: "tool-error",
      ...settled,
      error: result.text,
      metadata: { ...metadata, ...(declined ? { question: { declined: true } } : {}) },
    }
  }
  return {
    type: "tool-output",
    ...settled,
    output: isTaskTool(toolName) ? agentResultText(result.structured, result.text) : result.text,
    ...(result.images.length ? { attachments: resultAttachments(result.images, display) } : {}),
    metadata: {
      ...metadata,
      ...(question ? questionAnswerMetadata(input, result.structured) : {}),
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
  const initialTasks = tasks
  const events = toolResultBlocks(message).flatMap((result): AgentRuntimeEvent[] => {
    const tool = byToolId[result.toolCallId]
    if (!tool?.toolName) return []
    if (!result.isError) {
      tasks = applyClaudeTaskResult(tasks, tool.toolName, tool.input ?? {}, result.structured) ?? tasks
    }
    return [toolResultEvent(tool.toolName, tool.input ?? {}, result)]
  })
  if (tasks === initialTasks) return events
  return { state: { ...state, tasks }, events: [...events, { type: "todo-update", todos: Object.values(tasks) } satisfies AgentRuntimeEvent] }
}

export function isServerToolResult(type: unknown) {
  return typeof type === "string" && serverToolResults.includes(type)
}

export function serverToolResult(state: ClaudeSdkAdapterState, block: Record<string, unknown>): ClaudeTranslation {
  const toolCallId = text(block.tool_use_id)
  const tool = toolCallId ? own(state.toolsById, toolCallId) : undefined
  if (!toolCallId || tool?.settled) return []
  const content = asRecord(block.content)
  const display = tool?.toolName ? { display: toolDisplay(tool.toolName, tool.input ?? {}) } : {}
  const event: AgentRuntimeEvent = block.is_error === true || text(content?.type)?.endsWith("_error")
    ? { type: "tool-error", toolCallId, error: text(content?.error_code) ?? toolResultText(block), ...display }
    : { type: "tool-output", toolCallId, output: toolResultText(block) || block.content, ...display }
  return { state: { ...state, toolsById: { ...state.toolsById, [toolCallId]: { ...(tool ?? { type: "tool", toolCallId }), settled: true } } }, events: [event] }
}
