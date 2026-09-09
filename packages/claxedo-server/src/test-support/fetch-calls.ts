/**
 * Reading a `fetch` stub's arguments.
 *
 * A stub written as `(input, init) => ...` receives `input: string | URL |
 * Request` and `init.body: BodyInit`, and both were being read with
 * `String(...)`. For the shapes the production code actually sends — a
 * `Request`, or a `ReadableStream`/`Blob`/`FormData` body — `String()` returns
 * `"[object Object]"`, so the assertion compares one constant against another
 * and passes no matter what the caller sent. These read the value instead.
 */

import { asRecord, parseJson } from "@claxedo/server-core/platform/json/index"

/** The URL a fetch call targets, whether it was passed as a string, a `URL`, or a `Request`. */
export function fetchUrl(input: unknown): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  throw new TypeError(`Unsupported fetch input: ${Object.prototype.toString.call(input)}`)
}

/**
 * The text of a request body. Streaming and multipart bodies are rejected
 * rather than stringified: a test asserting on them needs to await the real
 * bytes, which is a different helper than this one.
 */
export function fetchBodyText(body: unknown): string {
  if (body === undefined || body === null) return ""
  if (typeof body === "string") return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body))
  throw new TypeError(`Unsupported fetch body: ${Object.prototype.toString.call(body)}`)
}

/** The parsed JSON body of a fetch call, as a record. */
export function fetchJsonBody(body: unknown): Record<string, unknown> {
  const parsed = asRecord(parseJson(fetchBodyText(body)))
  if (!parsed) throw new TypeError("Expected a JSON object request body")
  return parsed
}
