import { asRecord } from "@claxedo/helpers/guards"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AgentRuntimeEvent, AgentRuntimeEventOf, RuntimeNoticeSeverity } from "@claxedo/agent-runtime-contract"
import { runtimeDiagnostic } from "@claxedo/agent-runtime-contract"
import type { ClaudeTranslatorMemory } from "./translator-memory"

export type ClaudeFrameEvent = { source: string; method?: string; payload: unknown }
export type ClaudeSdkSystemMessage = Extract<SDKMessage, { type: "system" }>
export type ClaudeSdkAssistantMessage = Extract<SDKMessage, { type: "assistant" }>
export type ClaudeSdkStreamEvent = Extract<SDKMessage, { type: "stream_event" }>["event"]

export function sdkMessage(event: { payload: unknown }) {
  return asRecord(event.payload) ?? {}
}

export function diagnosticForEvent(input: {
  code: string
  message: string
  event: { source: string; method?: string; payload: unknown }
  severity?: "debug" | "info" | "warn" | "error"
  details?: Record<string, unknown>
}) {
  return {
    type: "diagnostic",
    diagnostic: runtimeDiagnostic({
      code: input.code,
      message: input.message,
      severity: input.severity,
      source: input.event.source,
      method: input.event.method,
      raw: input.event.payload,
      details: input.details,
    }),
  } satisfies AgentRuntimeEvent
}

export function ignoredFrame(memory: ClaudeTranslatorMemory, kind: string): AgentRuntimeEvent[] {
  if (memory.noted.has(kind)) return []
  memory.noted.add(kind)
  return [{ type: "diagnostic", diagnostic: runtimeDiagnostic({ code: "claude_sdk.ignored_frame", severity: "debug", source: "claude.sdk",
    message: `Claude frame ${kind} is not known to this transport and is ignored`, details: { kind } }) }]
}

export function claudeNotice(code: string, message: string, severity: RuntimeNoticeSeverity = "info", details?: Record<string, unknown>): AgentRuntimeEventOf<"harness-notice"> {
  return { type: "harness-notice", code: `claude_sdk.${code}`, message, severity, ...(details ? { details } : {}) }
}
