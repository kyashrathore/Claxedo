import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import type { AgentRuntimeEvent, RuntimeToolAttachment } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { imageAttachment, imageFileAttachment } from "../../../translate/tool-attachments"
import type { CursorSdkAdapterState, CursorTranslation } from "./state"
import { taskMetadata, taskOutput } from "./tasks"
import { ensureTool, isTaskTool, isTodoTool, mcpContentTexts, successfulOutput } from "./tools"

type Completion = { state: CursorSdkAdapterState; toolCallId: string; toolName: string; rawInput: Record<string, unknown>; result: unknown; isError: boolean }

function errorMessage(value: unknown) {
  const row = asRecord(value)
  const nested = asRecord(row?.error)
  const texts = mcpContentTexts(value)
  return text(row?.message) ?? text(nested?.message) ?? text(row?.error) ?? (texts.length ? texts.join("\n") : undefined) ?? text(value) ?? JSON.stringify(value)
}

function isErrorResult(value: unknown) {
  const row = asRecord(value)
  if (row?.status === "error") return true
  const success = asRecord(row?.value)
  if (success?.isError === true) return true
  const exitCode = asFiniteNumber(success?.exitCode)
  return exitCode !== undefined && exitCode !== 0
}

function outputAttachments(toolName: string, result: Record<string, unknown> | undefined): RuntimeToolAttachment[] {
  const images = (Array.isArray(result?.content) ? result.content : []).flatMap((item) => {
    const image = asRecord(asRecord(item)?.image)
    const data = text(image?.data)
    const mime = text(image?.mimeType) ?? "image/*"
    return data && mime.startsWith("image/") ? [imageAttachment({ mime, data })] : []
  })
  const generated = toolName === "generateImage" ? text(result?.filePath) : undefined
  return generated ? [...images, imageFileAttachment(generated, "image/*")] : images
}

function cursorMetadata(result: unknown, tool: { toolName: string; kind: string }, subagent: unknown) {
  const exitCode = asFiniteNumber(asRecord(asRecord(result)?.value)?.exitCode)
  return { ...(exitCode === undefined ? {} : { exitCode }), cursor: { itemType: tool.kind, ...(isTaskTool(tool.toolName) ? { subagent } : {}) } }
}

export function toolCompletedEvents(input: Completion): CursorTranslation {
  const ensured = ensureTool(input)
  if (isTodoTool(ensured.toolName)) return { state: ensured.state, events: ensured.events }
  if (input.isError || isErrorResult(input.result)) {
    return { state: ensured.state, events: [...ensured.events, { type: "tool-error", toolCallId: input.toolCallId, error: errorMessage(input.result),
      display: ensured.display, metadata: cursorMetadata(input.result, ensured, { transcript: "unavailable" }) }] }
  }
  const attachments = outputAttachments(ensured.toolName, asRecord(successfulOutput(input.result)))
  const event: AgentRuntimeEvent = { type: "tool-output", toolCallId: input.toolCallId,
    output: isTaskTool(ensured.toolName) ? taskOutput(input.result) : successfulOutput(input.result),
    ...(attachments.length ? { attachments } : {}), display: ensured.display, metadata: cursorMetadata(input.result, ensured, taskMetadata(input.result)) }
  return { state: ensured.state, events: [...ensured.events, event] }
}
