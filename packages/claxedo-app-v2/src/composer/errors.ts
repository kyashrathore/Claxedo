import type { AppError, ErrorClass } from "@/server"

const classes: readonly ErrorClass[] = ["auth", "rate_limit", "network", "not_found", "conflict", "invalid", "internal"]

function isAppError(value: unknown): value is AppError {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { class?: unknown; message?: unknown; retryable?: unknown }
  return (
    typeof candidate.class === "string" &&
    (classes as readonly string[]).includes(candidate.class) &&
    typeof candidate.message === "string" &&
    typeof candidate.retryable === "boolean"
  )
}

export function asAppError(value: unknown): AppError {
  if (isAppError(value)) return value
  return {
    class: "internal",
    message: value instanceof Error ? value.message : String(value),
    retryable: false,
    cause: value,
  }
}

export function appError(input: { class: ErrorClass; message: string; code?: string; retryable?: boolean }): AppError {
  return { class: input.class, message: input.message, retryable: input.retryable ?? false, code: input.code }
}
