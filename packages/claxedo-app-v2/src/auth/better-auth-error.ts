import { readField, readString } from "@/lib/record"

export async function authResponseBody(response: Response): Promise<unknown> {
  return response.headers.get("content-type")?.includes("application/json") ? await response.json() : undefined
}

export function betterAuthApiError(body: unknown, status: number, fallback: string) {
  return new Error(
    readString(body, "error_description")
      ?? readString(readField(body, "error"), "message")
      ?? `${fallback} (${status})`,
  )
}
