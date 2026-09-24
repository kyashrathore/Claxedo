import type { AgentRuntimeStatus } from "@claxedo/agent-runtime-contract"
import { turnError } from "../errors"
import type { RetryAction, SessionStatus } from "../types"

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function retryAction(value: unknown): RetryAction | undefined {
  if (!isRecord(value)) return undefined
  const { reason, provider, title, message, label, link } = value
  if (typeof reason !== "string" || typeof provider !== "string" || typeof title !== "string" || typeof message !== "string" || typeof label !== "string") return undefined
  return { reason, provider, title, message, label, ...(typeof link === "string" ? { link } : {}) }
}

export function runtimeStatusFromWire(value: unknown): AgentRuntimeStatus | undefined {
  if (!isRecord(value)) return undefined
  switch (value.type) {
    case "idle":
    case "busy":
      return { type: value.type }
    case "retry": {
      const { attempt, message, next } = value
      if (typeof attempt !== "number" || typeof message !== "string" || typeof next !== "number") return undefined
      const action = retryAction(value.action)
      return { type: "retry", attempt, message, next, ...(action ? { action } : {}) }
    }
    case "recovering":
      return (value.kind === "process_restart" || value.kind === "uncertain_execution") && typeof value.message === "string"
        ? { type: "recovering", kind: value.kind, message: value.message }
        : undefined
    default:
      return undefined
  }
}

export function sessionStatusFromRuntime(status: AgentRuntimeStatus): SessionStatus {
  switch (status.type) {
    case "idle":
      return { kind: "idle" }
    case "busy":
      return { kind: "working" }
    case "retry":
      return { kind: "retrying", attempt: status.attempt, message: status.message, nextAt: status.next, ...(status.action ? { action: status.action } : {}) }
    case "recovering":
      return { kind: "recovering", reason: status.kind === "process_restart" ? "processRestart" : "uncertainExecution", message: status.message }
  }
}

export function sessionStatusFromWire(value: unknown): SessionStatus | undefined {
  const status = runtimeStatusFromWire(value)
  return status ? sessionStatusFromRuntime(status) : undefined
}

export function sessionStatusFailed(value: unknown): SessionStatus {
  return { kind: "failed", error: turnError(value) }
}
