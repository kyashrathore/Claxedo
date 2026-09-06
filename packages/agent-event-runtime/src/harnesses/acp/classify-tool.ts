import type { AgentRuntimeEvent } from "../../contracts/agent-runtime-event"
import type { ToolIntent as AcpIntent } from "../../contracts/agent-runtime-event"
import type { ToolView } from "./state"
import type { AcpDiagnostics } from "./diagnostics"

export type AcpToolClassification =
  | { kind: "tool"; payload: ToolView }
  | { kind: "reasoning"; payload: ToolView }
  | { kind: "switch_mode"; payload: ToolView }
  | { kind: "mcp"; payload: ToolView }
  | { kind: "generic"; payload: ToolView }

export function acpIntent(tool: ToolView): AcpIntent {
  return tool.metadata.acp.intent
}

export function isSessionSurface(classification: AcpToolClassification) {
  return classification.kind === "reasoning"
}

export function classifyToolCall(tool: ToolView, _diagnostics: AcpDiagnostics): AcpToolClassification {
  const intent = acpIntent(tool)
  if (intent === "generic") {
    return { kind: "generic", payload: tool }
  }

  if (
    intent === "reasoning" ||
    intent === "switch_mode" ||
    intent === "mcp"
  ) {
    return { kind: intent, payload: tool }
  }

  return { kind: "tool", payload: tool }
}

export function projectToolStart(toolCallId: string, tool: ToolView, kind?: string): AgentRuntimeEvent {
  return {
    type: "tool-start",
    toolCallId,
    toolName: tool.toolName,
    kind,
    display: tool.display,
    metadata: tool.metadata,
  }
}
