import type { SessionStatus as WireStatus } from "@opencode-ai/sdk/v2"

type RetryRow = {
  status?: unknown
  attempt?: unknown
  message?: unknown
  recovery_error?: unknown
  next?: unknown
}

export type StatusRecover = {
  type: "recovering"
  kind: "process_restart"
  message: string
}

export type StatusCompat = WireStatus | StatusRecover

export type StatusChunk = "busy" | "idle" | "error" | "recovering"

export function recovering(message = "Recovering ACP client..."): StatusRecover {
  return {
    type: "recovering",
    kind: "process_restart",
    message,
  }
}

export function chunk(status: StatusCompat): StatusChunk {
  if (status.type === "busy" || status.type === "idle" || status.type === "recovering") return status.type
  return "error"
}

export function live(input: RetryRow, defaultMessage: string, now = Date.now()): StatusCompat | undefined {
  if (input.status === "busy") return { type: "busy" }
  if (input.status === "recovering") {
    return recovering(typeof input.message === "string" ? input.message : typeof input.recovery_error === "string" ? input.recovery_error : defaultMessage)
  }
  if (input.status !== "retry") return
  return {
    type: "retry",
    attempt: typeof input.attempt === "number" ? input.attempt : 1,
    message: typeof input.message === "string" ? input.message : defaultMessage,
    next: typeof input.next === "number" ? input.next : now,
  }
}
