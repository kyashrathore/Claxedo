import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import type { RuntimeToolAttachment } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { contentBlockImages, imageFileAttachment } from "../../../translate/tool-attachments"
import { own } from "../../../translate/value"
import { generatedImageAttachments, generatedImageFailure } from "./generated-image"
import type { CodexAppServerAdapterState } from "./state"

type Row = Record<string, unknown>
type Outcome = { error: string } | { output: unknown; attachments: RuntimeToolAttachment[] }

function contentText(items: unknown) {
  return (Array.isArray(items) ? items : []).flatMap((item) => {
    const block = asRecord(item)
    return block?.type === "inputText" || block?.type === "text" ? text(block.text) ?? [] : []
  }).join("\n")
}

function mcpFailure(completed: Row) {
  const explicit = text(asRecord(completed.error)?.message)
  if (explicit || completed.status !== "failed") return explicit
  return contentText(asRecord(completed.result)?.content) || "MCP tool call failed"
}

function commandFailure(completed: Row, output: unknown) {
  if (completed.status === "declined") return "User declined the command"
  if (completed.status === "failed") return text(output) ?? `Process exited with code ${asFiniteNumber(completed.exitCode)}`
  return undefined
}

function fileChangeFailure(completed: Row) {
  if (completed.status === "declined") return "User declined the file change"
  return completed.status === "failed" ? "The file change failed to apply" : undefined
}

function toolCallFailure(completed: Row) {
  return completed.status === "failed" ? `${text(completed.tool) ?? "Tool call"} failed` : undefined
}

function itemFailure(itemType: string, completed: Row, output: unknown) {
  if (itemType === "mcp_tool_call") return mcpFailure(completed)
  if (itemType === "command_execution") return commandFailure(completed, output)
  if (itemType === "file_change") return fileChangeFailure(completed)
  if (itemType === "dynamic_tool_call") return toolCallFailure(completed)
  if (itemType === "image_generation") return generatedImageFailure(completed)
  return undefined
}

function itemOutput(itemType: string, completed: Row, streamed: string | undefined): unknown {
  if (itemType === "image_generation") return text(completed.revisedPrompt) ?? ""
  if (itemType === "web_search" && completed.results !== null && completed.results !== undefined) return completed.results
  return completed.output ?? completed.result ?? completed.aggregatedOutput ?? completed.text ?? streamed ?? ""
}

function itemAttachments(itemType: string, completed: Row): RuntimeToolAttachment[] {
  if (itemType === "image_generation") return generatedImageAttachments(completed)
  return [
    ...(itemType === "image_view" && text(completed.path) ? [imageFileAttachment(String(completed.path), "image/*")] : []),
    ...contentBlockImages(asRecord(completed.result)?.content),
  ]
}

export function itemOutcome(state: CodexAppServerAdapterState, id: string, itemType: string, completed: Row): Outcome {
  const output = itemOutput(itemType, completed, own(state.toolOutputByCallId, id))
  const error = itemFailure(itemType, completed, output)
  return error === undefined ? { output, attachments: itemAttachments(itemType, completed) } : { error }
}
