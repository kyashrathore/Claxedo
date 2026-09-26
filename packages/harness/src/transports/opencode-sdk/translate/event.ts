import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import { asRecord, asRecordOrEmpty } from "@claxedo/helpers/guards"
import { errorMessage } from "@claxedo/helpers"
import type { ProjectedEvent } from "../event-pump.js"

export function eventSessionID(event: ProjectedEvent): string | undefined {
  const data = asRecordOrEmpty(event.data)
  return typeof data.sessionID === "string" ? data.sessionID : undefined
}

export function eventAssistantMessageID(event: ProjectedEvent): string | undefined {
  const data = asRecordOrEmpty(event.data)
  const id = data.assistantMessageID ?? data.messageID
  return typeof id === "string" ? id : undefined
}

export type SessionOutcome = "succeeded" | "failed" | "interrupted"

export function sessionOutcome(outcome: SessionOutcome, sessionID: string, error?: unknown): AgentRuntimeEvent {
  if (outcome !== "failed") return { type: "finish", sessionId: sessionID, harness: "opencode" }
  const reason = error === undefined ? "" : errorMessage(error)
  return { type: "error", error: reason || "OpenCode execution failed", harness: "opencode" }
}

export function terminal(event: ProjectedEvent, sessionID: string): AgentRuntimeEvent | undefined {
  const data = asRecordOrEmpty(event.data)
  if (event.type === "session.execution.succeeded") return sessionOutcome("succeeded", sessionID)
  if (event.type === "session.execution.interrupted") return sessionOutcome("interrupted", sessionID)
  if (event.type === "session.execution.failed") return sessionOutcome("failed", sessionID, data.error)
  return undefined
}

export function projectTurnEvent(event: ProjectedEvent): AgentRuntimeEvent | undefined {
  const data = asRecordOrEmpty(event.data)
  if (event.type === "session.execution.started") return { type: "session-status", status: "busy", harness: "opencode" }
  if (event.type === "session.text.delta" && typeof data.delta === "string") {
    return { type: "text-delta", delta: data.delta, harness: "opencode" }
  }
  if (event.type === "session.reasoning.delta" && typeof data.delta === "string") {
    return { type: "thinking-delta", delta: data.delta, harness: "opencode" }
  }
  if (event.type === "session.tool.input.started" && typeof data.id === "string" && typeof data.name === "string") {
    return { type: "tool-start", toolCallId: data.id, toolName: data.name, harness: "opencode" }
  }
  if (event.type === "session.tool.called" && typeof data.id === "string") {
    return { type: "tool-input", toolCallId: data.id, input: data.input, harness: "opencode" }
  }
  if (event.type === "session.tool.success" && typeof data.id === "string") {
    const metadata = asRecord(data.metadata)
    return {
      type: "tool-output",
      toolCallId: data.id,
      output: data.content,
      ...(metadata ? { metadata } : {}),
      harness: "opencode",
    }
  }
  if (event.type === "session.tool.failed" && typeof data.id === "string") {
    return { type: "tool-error", toolCallId: data.id, error: JSON.stringify(data.error), harness: "opencode" }
  }
  return undefined
}
