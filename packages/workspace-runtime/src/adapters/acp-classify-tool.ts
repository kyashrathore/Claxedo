import type { AgentEvent } from "./index"
import type { AcpIntent } from "./acp-registry"
import type { ToolView } from "./acp-state"
import { diagnoseTranslation, shape } from "./acp-translation-diagnostics"

export type AcpToolClassification =
  | { kind: "tool"; payload: ToolView }
  | { kind: "question"; payload: ToolView }
  | { kind: "todos"; payload: ToolView }
  | { kind: "reasoning"; payload: ToolView }
  | { kind: "task"; payload: ToolView }
  | { kind: "image"; payload: ToolView }
  | { kind: "computer"; payload: ToolView }
  | { kind: "mcp"; payload: ToolView }
  | { kind: "generic"; payload: ToolView }

const SESSION_SURFACE_INTENTS: Set<AcpIntent> = new Set(["todos", "question", "reasoning"])

function object(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

export function acpIntent(metadata: Record<string, unknown>): AcpIntent | undefined {
  const acp = object(metadata.acp)
  return acp?.intent as AcpIntent | undefined
}

export function acpMode(metadata: Record<string, unknown>): string | undefined {
  const acp = object(metadata.acp)
  return typeof acp?.mode === "string" ? acp.mode : undefined
}

export function isSessionSurface(classification: AcpToolClassification) {
  return SESSION_SURFACE_INTENTS.has(classification.kind as AcpIntent)
}

export function classifyToolCall(tool: ToolView): AcpToolClassification {
  const acp = object(tool.metadata.acp)
  const intent = acpIntent(tool.metadata) ?? "generic"
  const base = {
    agent: typeof acp?.client === "string" ? acp.client : undefined,
    toolCallId: typeof acp?.toolCallId === "string" ? acp.toolCallId : undefined,
    title: typeof acp?.title === "string" ? acp.title : undefined,
    name: typeof acp?.rawToolName === "string" ? acp.rawToolName : undefined,
    kind: typeof acp?.kind === "string" ? acp.kind : undefined,
    intent,
    extractor: typeof acp?.extractor === "string" ? acp.extractor : undefined,
  }

  if (!acp?.extractor) {
    diagnoseTranslation("acp.registry_miss", {
      ...base,
      reason: "no_registry_rule",
      shape: shape(acp?.rawInput),
    })
  }

  if (intent === "generic") {
    diagnoseTranslation("acp.generic_fallback", {
      ...base,
      reason: acp?.extractor ? "registry_generic" : "heuristic_generic",
      shape: shape(acp?.rawInput),
    })
    return { kind: "generic", payload: tool }
  }

  if (
    intent === "question" ||
    intent === "todos" ||
    intent === "reasoning" ||
    intent === "task" ||
    intent === "image" ||
    intent === "computer" ||
    intent === "mcp"
  ) {
    return { kind: intent, payload: tool }
  }

  return { kind: "tool", payload: tool }
}

export function projectToolStart(toolCallId: string, tool: ToolView, kind?: string): AgentEvent {
  return {
    type: "tool-start",
    toolCallId,
    toolName: tool.toolName,
    kind,
    metadata: tool.metadata,
  }
}
