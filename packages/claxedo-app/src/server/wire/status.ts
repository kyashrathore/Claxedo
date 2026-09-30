import type { AgentRuntimeStatus } from "@claxedo/agent-runtime-contract"
import { turnError } from "../errors"
import type { RetryAction, SessionStatus } from "../types"
import { isRecord } from "@claxedo/helpers/guards"

function retryActionFromWire(value: unknown): RetryAction | undefined {
  if (!isRecord(value)) return undefined
  const { reason, provider, title, message, label, link } = value
  if (typeof reason !== "string" || typeof provider !== "string" || typeof title !== "string" || typeof message !== "string" || typeof label !== "string") return undefined
  return { reason, provider, title, message, label, ...(typeof link === "string" ? { link } : {}) }
}

function runtimeStatusFromWire(value: unknown): AgentRuntimeStatus | undefined {
  if (!isRecord(value)) return undefined
  switch (value.type) {
    case "idle":
    case "busy":
      return { type: value.type }
    case "retry": {
      const { attempt, message, next } = value
      if (typeof message !== "string") return undefined
      const action = retryActionFromWire(value.action)
      return { type: "retry", message, ...(typeof attempt === "number" ? { attempt } : {}), ...(typeof next === "number" ? { next } : {}), ...(action ? { action } : {}) }
    }
    case "recovering":
      return (value.kind === "process_restart" || value.kind === "uncertain_execution") && typeof value.message === "string"
        ? { type: "recovering", kind: value.kind, message: value.message }
        : undefined
    default:
      return undefined
  }
}

function sessionStatusFromRuntime(status: AgentRuntimeStatus): SessionStatus {
  switch (status.type) {
    case "idle":
      return { kind: "idle" }
    case "busy":
      return { kind: "working" }
    case "retry":
      return {
        kind: "retrying",
        message: status.message,
        ...(status.attempt !== undefined ? { attempt: status.attempt } : {}),
        ...(status.next !== undefined ? { nextAt: status.next } : {}),
        ...(status.action ? { action: status.action } : {}),
      }
    case "recovering":
      return { kind: "recovering", reason: status.kind === "process_restart" ? "processRestart" : "uncertainExecution", message: status.message }
  }
}

export function sessionStatusFromWire(value: unknown): SessionStatus | undefined {
  const status = runtimeStatusFromWire(value)
  return status ? sessionStatusFromRuntime(status) : undefined
}

const TURN_CANCELLED_ERROR = "MessageAbortedError"

export function sessionStatusFromTurnError(value: unknown): SessionStatus {
  const name = value && typeof value === "object" ? (value as { name?: unknown }).name : undefined
  return name === TURN_CANCELLED_ERROR ? { kind: "idle" } : { kind: "failed", error: turnError(value) }
}
