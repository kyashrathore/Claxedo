export type RetryAfterMs = (error: unknown) => number | undefined

export function channelRetryDelayMs(input: {
  error: unknown
  attempt: number
  retryDelayMs: number
  retryAfterMs?: RetryAfterMs
}) {
  return input.retryAfterMs?.(input.error)
    ?? retryAfterMs(input.error)
    ?? input.retryDelayMs * 2 ** input.attempt
}

function retryAfterMs(error: unknown) {
  if (!error || typeof error !== "object") return
  const row = error as {
    retryAfterMs?: unknown
    headers?: unknown
    response?: {
      headers?: unknown
    }
  }
  return normalizedDelay(row.retryAfterMs)
    ?? retryAfterHeaderMs(row.headers)
    ?? retryAfterHeaderMs(row.response?.headers)
}

function retryAfterHeaderMs(headers: unknown) {
  if (!headers || typeof headers !== "object") return
  const row = headers as {
    get?: (name: string) => unknown
  }
  return retryAfterValueMs(typeof row.get === "function" ? row.get("retry-after") : undefined)
}

function retryAfterValueMs(value: unknown) {
  if (typeof value !== "string") return normalizedDelay(value)
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return normalizedDelay(seconds * 1000)
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return
  return Math.max(0, at - Date.now())
}

function normalizedDelay(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}
