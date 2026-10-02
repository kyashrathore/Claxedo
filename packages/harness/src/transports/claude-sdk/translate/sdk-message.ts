import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { runtimeDiagnostic, type AgentRuntimeEvent, type RuntimeNoticeSeverity } from "@claxedo/agent-runtime-contract"
import type { ClaudeTranslatorMemory } from "./translator-memory"

export type ClaudeFrameEvent = { source: string; method?: string; payload: unknown }
export type ClaudeSdkAssistantMessage = Extract<SDKMessage, { type: "assistant" }>
export type ClaudeSdkStreamEvent = Extract<SDKMessage, { type: "stream_event" }>["event"]

type DiagnosticInput = Omit<Parameters<typeof runtimeDiagnostic>[0], "source" | "method" | "raw"> & { event: ClaudeFrameEvent }

export function diagnosticForEvent({ event, ...input }: DiagnosticInput) {
  return {
    type: "diagnostic",
    diagnostic: runtimeDiagnostic({
      ...input,
      source: event.source,
      method: event.method,
      raw: event.payload,
    }),
  } satisfies AgentRuntimeEvent
}

export function ignoredFrame(memory: ClaudeTranslatorMemory, kind: string): AgentRuntimeEvent[] {
  if (memory.noted.has(kind)) return []
  memory.noted.add(kind)
  return [{ type: "diagnostic", diagnostic: runtimeDiagnostic({ code: "claude_sdk.ignored_frame", severity: "debug", source: "claude.sdk",
    message: `Claude frame ${kind} is not known to this transport and is ignored`, details: { kind } }) }]
}

export function claudeNotice(code: string, message: string, severity: RuntimeNoticeSeverity): AgentRuntimeEvent {
  return { type: "harness-notice", code: `claude_sdk.${code}`, message, severity }
}
