import { record } from "../json"

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

function retryAfterMs(error: unknown): number | undefined {
  const row = record(error)
  if (!row) return undefined
  return normalizedDelay(row.retryAfterMs)
    ?? retryAfterHeaderMs(row.headers)
    ?? retryAfterHeaderMs(record(row.response)?.headers)
}

function retryAfterHeaderMs(headers: unknown): number | undefined {
  const row = record(headers)
  const get = row?.get
  if (typeof get !== "function") return undefined
  return retryAfterValueMs(get.call(headers, "retry-after"))
}

function retryAfterValueMs(value: unknown): number | undefined {
  if (typeof value !== "string") return normalizedDelay(value)
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return normalizedDelay(seconds * 1000)
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return undefined
  return Math.max(0, at - Date.now())
}

function normalizedDelay(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}
