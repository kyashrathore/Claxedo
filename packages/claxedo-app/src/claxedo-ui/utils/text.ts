/** Collapse whitespace to single spaces and trim. */
export const collapse = (value: unknown) => {
  if (typeof value !== "string") return ""
  return value.replace(/\s+/g, " ").trim()
}

/** Clip text to max length, appending "..." if truncated. */
export const clip = (value: string, max: number) => {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 3)).trimEnd()}...`
}

/** Format RSS kilobytes as MB (0 decimals above 1 GB, 1 decimal below). */
export const formatMB = (rssKb: number) => `${(rssKb / 1024).toFixed(rssKb >= 1024 * 1024 ? 0 : 1)} MB`

/** Format a CPU percentage (0 decimals at 10%+, 1 decimal below). */
export const formatCPU = (value: number) => `${value.toFixed(value >= 10 ? 0 : 1)}%`

/** Extract a human-readable error message from an unknown error value. */
export const errorText = (error: unknown) => {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (!error || typeof error !== "object") return String(error)
  const message =
    (error as { error?: { message?: unknown } }).error?.message || (error as { message?: unknown }).message
  if (typeof message === "string" && message.trim()) return message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
