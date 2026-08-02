import { runtimeEnvText } from "../env"

export function bearerToken(header: string | null | undefined) {
  if (!header) return
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || undefined
}

export function errorBody(code: string, message: string, details?: Record<string, unknown>) {
  return {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  }
}

export const JSON_BODY_LIMIT_BYTES = jsonBodyLimit()

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
    header(name: string): string | undefined
    raw: Request
  }
}

export async function boundedJsonBody<T>(
  c: JsonBodyContext,
  fallback: T,
  options: { limit?: number } = {},
): Promise<T> {
  const text = await boundedTextBody(c, options.limit ?? JSON_BODY_LIMIT_BYTES)
  if (!text.trim()) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export function isRequestBodyTooLarge(cause: unknown): cause is RequestBodyTooLargeError {
  return cause instanceof RequestBodyTooLargeError
}

export function requestBodyTooLargeBody() {
  return errorBody("request_body_too_large", "Request body is too large")
}

function jsonBodyLimit() {
  const configured = Number(runtimeEnvText(process.env, "WORKSPACE_RUNTIME_JSON_BODY_LIMIT_BYTES"))
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : 5 * 1024 * 1024
}

async function boundedTextBody(c: JsonBodyContext, limit: number) {
  const contentLength = readContentLength(c)
  if (contentLength !== undefined && contentLength > limit) {
    throw new RequestBodyTooLargeError(limit)
  }
  if (!c.req.raw.body) return ""

  const reader = c.req.raw.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ""
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    total += chunk.value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      throw new RequestBodyTooLargeError(limit)
    }
    text += decoder.decode(chunk.value, { stream: true })
  }
  return text + decoder.decode()
}

function readContentLength(c: JsonBodyContext) {
  const value = c.req.header("content-length")
  if (!value) return
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}
