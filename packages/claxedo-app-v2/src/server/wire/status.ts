import type { AgentRuntimeStatus } from "@claxedo/agent-runtime-contract"
import { ServerError } from "../errors"
import type { ErrorClass, SessionStatus } from "../types"

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
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
      return { type: "retry", attempt, message, next }
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
      return { kind: "retrying", attempt: status.attempt, message: status.message, nextAt: status.next }
    case "recovering":
      return { kind: "recovering", message: status.message }
  }
}

export function sessionStatusFromWire(value: unknown): SessionStatus | undefined {
  const status = runtimeStatusFromWire(value)
  return status ? sessionStatusFromRuntime(status) : undefined
}

function errorClassForName(name: string | undefined, status: number | undefined): ErrorClass {
  if (status === 401 || status === 403 || /auth/i.test(name ?? "")) return "auth"
  if (status === 429 || /rate.?limit|quota/i.test(name ?? "")) return "rate_limit"
  if (/network|fetch|econn|timeout/i.test(name ?? "")) return "network"
  return "internal"
}

export function sessionStatusFailed(value: unknown): SessionStatus {
  const error = isRecord(value) ? value : undefined
  const data = isRecord(error?.data) ? error.data : undefined
  const name = typeof error?.name === "string" ? error.name : undefined
  const status = typeof data?.status === "number" ? data.status : undefined
  const message = typeof data?.message === "string" ? data.message : name ?? "The turn failed"
  return {
    kind: "failed",
    error: new ServerError({
      class: errorClassForName(name, status),
      message,
      ...(status !== undefined ? { status } : {}),
      ...(name !== undefined ? { code: name } : {}),
    }),
  }
}
