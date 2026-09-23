import { readField, readString } from "@/lib/record"

/**
 * The Error behind a failed `/api/auth/*` response.
 *
 * Better Auth answers its OAuth endpoints with RFC 6749's
 * `{ error, error_description }` and its own endpoints with
 * `{ error: { message } }`. A caller that reads one shape shows the user a
 * status code where the server sent a reason — "expired user code" arrives
 * as `error_description`, "not found" as the nested message.
 */
export function betterAuthApiError(body: unknown, status: number, fallback: string) {
  return new Error(
    readString(body, "error_description")
      ?? readString(readField(body, "error"), "message")
      ?? `${fallback} (${status})`,
  )
}
