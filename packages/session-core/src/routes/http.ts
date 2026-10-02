import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { bearerToken } from "@claxedo/helpers/string"
import { rec } from "../json-value"
import { errorBody } from "./error-body"

export { bearerToken }
export { errorBody }

export const JSON_BODY_LIMIT_BYTES = 5 * 1024 * 1024

export function noStoreJson(c: Context, data: unknown, status?: ContentfulStatusCode) {
  return c.json(data, status, {
    "Cache-Control": "no-store",
  })
}

export class RequestBodyTooLargeError extends Error {
  limit: number

  constructor(limit = JSON_BODY_LIMIT_BYTES) {
    super("Request body is too large")
    this.name = "RequestBodyTooLargeError"
    this.limit = limit
  }
}

type JsonBodyContext = {
  req: {
    raw: Request
  }
}

/**
 * The size-bounded JSON body read these routes share.
 *
 * `undefined` covers the three cases callers previously collapsed into a
 * `fallback`: no body, an empty body, and one that is not valid JSON. It
 * returns `unknown` rather than a caller-named type parameter, because the
 * parse never checked that type — callers narrow through `json-value`.
 */
export async function boundedJsonBody(
  c: JsonBodyContext,
  options: { limit?: number } = {},
): Promise<unknown> {
  const text = await boundedTextBody(c, options.limit ?? JSON_BODY_LIMIT_BYTES)
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** {@link boundedJsonBody} for the common case of a JSON object body. */
export async function boundedJsonRecord(
  c: JsonBodyContext,
  options: { limit?: number } = {},
): Promise<Record<string, unknown>> {
  return rec(await boundedJsonBody(c, options)) ?? {}
}

export function isRequestBodyTooLarge(cause: unknown): cause is RequestBodyTooLargeError {
  return cause instanceof RequestBodyTooLargeError
}

export function requestBodyTooLargeBody() {
  return errorBody("request_body_too_large", "Request body is too large")
}

export async function boundedTextBody(c: JsonBodyContext, limit = JSON_BODY_LIMIT_BYTES) {
  return readBoundedText(c.req.raw, limit)
}

/** Strict JSON input for routes that require a body and reject malformed UTF-8. */
export async function boundedJson(request: Request, limit: number): Promise<unknown> {
  const text = await readBoundedText(request, limit, true)
  if (!request.body) throw new Error("Request body is required")
  return JSON.parse(text) as unknown
}

async function readBoundedText(request: Request, limit: number, fatal = false) {
  const contentLength = readContentLength(request)
  if (contentLength !== undefined && contentLength > limit) {
    throw new RequestBodyTooLargeError(limit)
  }
  if (!request.body) return ""

  const reader = request.body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal })
  let total = 0
  let text = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > limit) throw new RequestBodyTooLargeError(limit)
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}

function readContentLength(request: Request): number | undefined {
  const value = request.headers.get("content-length")
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}
