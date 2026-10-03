import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { runtimeDiagnostic, type AgentRuntimeEvent, type AgentRuntimeEventOf, type RuntimeNoticeSeverity } from "@claxedo/agent-runtime-contract"
import { asRecord, isRecord } from "@claxedo/helpers/guards"
import { own } from "../../../translate/value"
import type { ClaudeTranslatorMemory } from "./translator-memory"

export type ClaudeFrameEvent = { source: string; method?: string; payload: unknown }
export type ClaudeSdkAssistantMessage = Extract<SDKMessage, { type: "assistant" }>
export type ClaudeSdkStreamEvent = Extract<SDKMessage, { type: "stream_event" }>["event"]

const STREAM_EVENT_RECORDS: Readonly<Record<ClaudeSdkStreamEvent["type"], readonly string[]>> = {
  message_start: ["message"],
  message_delta: ["delta"],
  message_stop: [],
  content_block_start: ["content_block"],
  content_block_delta: ["delta"],
  content_block_stop: [],
}

export function isClaudeStreamEventKind(kind: string | undefined): boolean {
  return kind !== undefined && Object.hasOwn(STREAM_EVENT_RECORDS, kind)
}

export function isClaudeStreamEvent(value: unknown): value is ClaudeSdkStreamEvent {
  const row = asRecord(value)
  const records = typeof row?.type === "string" ? own(STREAM_EVENT_RECORDS, row.type) : undefined
  return !!records && records.every((field) => isRecord(row?.[field]))
}

export function isClaudeAssistantMessage(value: Record<string, unknown>): value is Record<string, unknown> & ClaudeSdkAssistantMessage {
  return value.type === "assistant" && isRecord(value.message)
}

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

export function malformedFrame(event: ClaudeFrameEvent, kind: string): AgentRuntimeEvent[] {
  return [diagnosticForEvent({ code: "claude_sdk.malformed_frame", severity: "warn", event,
    message: `Claude frame ${kind} is missing the fields this transport reads and is ignored` })]
}

export function ignoredFrame(memory: ClaudeTranslatorMemory, kind: string): AgentRuntimeEvent[] {
  if (memory.noted.has(kind)) return []
  memory.noted.add(kind)
  return [{ type: "diagnostic", diagnostic: runtimeDiagnostic({ code: "claude_sdk.ignored_frame", severity: "debug", source: "claude.sdk",
    message: `Claude frame ${kind} is not known to this transport and is ignored`, details: { kind } }) }]
}

export function claudeNotice(code: string, message: string, severity: RuntimeNoticeSeverity): AgentRuntimeEventOf<"harness-notice"> {
  return { type: "harness-notice", code: `claude_sdk.${code}`, message, severity }
}
