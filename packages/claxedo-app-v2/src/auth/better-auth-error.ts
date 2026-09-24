import { readField, readString } from "@/lib/record"

export function betterAuthApiError(body: unknown, status: number, fallback: string) {
  return new Error(
    readString(body, "error_description")
      ?? readString(readField(body, "error"), "message")
      ?? `${fallback} (${status})`,
  )
}
