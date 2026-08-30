import type { JsonRecord } from "./sdk-runtime-driver"

export function record(input: unknown): JsonRecord | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  return input as JsonRecord
}

export function text(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  const row = record(error)
  const data = record(row?.data)
  return text(data?.message) ?? text(row?.message) ?? String(error)
}

export function extractTextFromParts(parts: unknown[]) {
  return parts.flatMap((part) => {
    if (typeof part === "string") return [part]
    const row = record(part)
    if (!row) return []
    return text(row.text) ?? text(row.content) ?? []
  }).join("\n").trim()
}
