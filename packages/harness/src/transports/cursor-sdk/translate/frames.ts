import { asRecord } from "@claxedo/helpers/guards"
import type { LocalRunStreamEvent, SDKMessage } from "@cursor/sdk"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { runtimeDiagnostic } from "@claxedo/agent-runtime-contract"

export function assertNever(value: never): never {
  throw new Error(`Unhandled Cursor SDK event: ${JSON.stringify(value)}`)
}

export function payload(event: { payload: unknown }) {
  return asRecord(event.payload) ?? {}
}

const sdkMessageTypes = {
  assistant: true,
  request: true,
  status: true,
  system: true,
  task: true,
  thinking: true,
  tool_call: true,
  usage: true,
  user: true,
} satisfies Record<SDKMessage["type"], true>

const localRunStreamEventTypes = {
  done: true,
  result: true,
  sdk_message: true,
} satisfies Record<LocalRunStreamEvent["type"], true>

export function isSdkMessage(value: unknown): value is SDKMessage {
  const message = asRecord(value)
  return typeof message?.type === "string" && message.type in sdkMessageTypes
}

export function isLocalRunStreamEvent(value: unknown): value is LocalRunStreamEvent {
  const message = asRecord(value)
  return typeof message?.type === "string" && message.type in localRunStreamEventTypes
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
    code: "cursor_sdk.unmapped_event",
    message: `${input.sdkEvent}: ${input.reason}`,
    severity: input.severity ?? "info",
    event: input.event,
    details: { sdkEvent: input.sdkEvent, reason: input.reason },
  })]
}
