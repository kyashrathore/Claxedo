import { asRecord } from "@claxedo/helpers/guards"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { runtimeDiagnostic } from "@claxedo/agent-runtime-contract"

export type ClaudeFrameEvent = { source: string; method?: string; payload: unknown }
export type ClaudeSdkSystemMessage = Extract<SDKMessage, { type: "system" }>
export type ClaudeSdkAssistantMessage = Extract<SDKMessage, { type: "assistant" }>
export type ClaudeSdkStreamEvent = Extract<SDKMessage, { type: "stream_event" }>["event"]

export function assertNever(value: never): never {
  throw new Error(`Unhandled Claude SDK event: ${JSON.stringify(value)}`)
}

export function sdkMessage(event: { payload: unknown }) {
  return asRecord(event.payload) ?? {}
}

const sdkMessageTypes = {
  assistant: true,
  auth_status: true,
  conversation_reset: true,
  prompt_suggestion: true,
  rate_limit_event: true,
  result: true,
  stream_event: true,
  system: true,
  tool_progress: true,
  tool_use_summary: true,
  user: true,
} satisfies Record<SDKMessage["type"], true>

export function isSdkMessage(message: Record<string, unknown>): message is SDKMessage {
  return typeof message.type === "string" && message.type in sdkMessageTypes
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

export function unmappedSdkEvent(input: {
  sdkEvent: string
  reason: string
  event: { source: string; method?: string; payload: unknown }
  severity?: "debug" | "info" | "warn" | "error"
}) {
  return [diagnosticForEvent({
    code: "claude_sdk.unmapped_event",
    message: `${input.sdkEvent}: ${input.reason}`,
    severity: input.severity ?? "info",
    event: input.event,
    details: { sdkEvent: input.sdkEvent, reason: input.reason },
  })]
}
