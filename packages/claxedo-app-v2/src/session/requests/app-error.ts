import type { AppError } from "@/server"

function isAppError(value: unknown): value is AppError {
  if (typeof value !== "object" || value === null) return false
  return "class" in value && "message" in value && "retryable" in value
}

export function toAppError(cause: unknown): AppError {
  if (isAppError(cause)) return cause
  const message = cause instanceof Error ? cause.message : String(cause)
  return { class: "internal", message, retryable: false, cause }
}
