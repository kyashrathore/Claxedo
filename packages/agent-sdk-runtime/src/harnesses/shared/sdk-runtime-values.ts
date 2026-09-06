import { asRecord, asText } from "@claxedo/agent-runtime-contract"

/**
 * Harness payload readers. The structural guards are the contract package's, so
 * every harness in this package narrows unknown payloads the same way.
 */
export const record = asRecord
export const text = asText

/** The string-valued entries of a config record, or undefined when it is not one. */
export function stringRecord(value: unknown): Record<string, string> | undefined {
  const row = record(value)
  if (!row) return undefined
  return Object.fromEntries(
    Object.entries(row).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
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
