import { MCP_APP_MIME, toolMcpFacts, type AgentToolPart, type ToolMcpFacts } from "@claxedo/agent-runtime-contract"
import { decodeDocumentDataUrl } from "./document"
import type { AppDocument } from "./model"

export type AppNotification = { readonly method: string; readonly params: Readonly<Record<string, unknown>> }

function partMetadata(part: AgentToolPart): Record<string, unknown> | undefined {
  return part.state.status === "pending" ? undefined : part.state.metadata
}

export function appFactsOf(part: AgentToolPart): ToolMcpFacts | undefined {
  const facts = toolMcpFacts(partMetadata(part))
  return facts?.app ? facts : undefined
}

export function isMcpAppPart(part: AgentToolPart): boolean {
  return part.state.status === "completed" && appFactsOf(part) !== undefined
}

export function appDocumentOf(part: AgentToolPart): AppDocument {
  if (part.headerOnly) return { kind: "pending" }
  if (part.state.status !== "completed") return { kind: "invalid" }
  const attachment = part.state.attachments?.find((file) => file.mime === MCP_APP_MIME)
  const html = attachment ? decodeDocumentDataUrl(attachment.url) : undefined
  return html === undefined ? { kind: "invalid" } : { kind: "ready", html }
}

function toolResult(output: string, facts: ToolMcpFacts | undefined): Readonly<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: output }],
    ...(facts?.structuredContent === undefined ? {} : { structuredContent: facts.structuredContent }),
    ...(facts?.resultMeta ? { _meta: facts.resultMeta } : {}),
  }
}

export function toolReplay(part: AgentToolPart): readonly AppNotification[] {
  const input = { method: "ui/notifications/tool-input", params: { arguments: part.state.input } }
  const state = part.state
  if (state.status === "completed") return [input, { method: "ui/notifications/tool-result", params: toolResult(state.output, toolMcpFacts(state.metadata)) }]
  if (state.status === "error") return [input, { method: "ui/notifications/tool-cancelled", params: { reason: state.error } }]
  return [input]
}
