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
