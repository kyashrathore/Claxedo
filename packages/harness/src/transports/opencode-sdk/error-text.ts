import { rec, str } from "./value"

export function errorMessage(input: unknown): string {
  if (input instanceof Error) return input.message
  const row = rec(input)
  if (!row) return String(input)
  const message = str(row.message) ?? str(rec(row.data)?.message)
  if (message) return message
  try {
    return JSON.stringify(row) ?? String(input)
  } catch {

    return `{${Object.keys(row).join(", ")}}`
  }
}
