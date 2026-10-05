import { asRecord } from "@claxedo/helpers/guards"
import type { AppError, ErrorClass } from "./types"

declare module "@tanstack/solid-query" {
  interface Register {
    defaultError: AppError
  }
}

const RETRYABLE: Readonly<Record<ErrorClass, boolean>> = {
  auth: false,
  forbidden: false,
  rate_limit: true,
  network: true,
  not_found: false,
  conflict: false,
  invalid: false,
  internal: false,
}

export class ServerError extends Error implements AppError {
  readonly class: ErrorClass
  readonly retryable: boolean
  readonly status?: number
  readonly code?: string
  readonly details?: Readonly<Record<string, unknown>>

  constructor(input: {
    readonly class: ErrorClass
    readonly message: string
    readonly status?: number
    readonly code?: string
    readonly details?: Readonly<Record<string, unknown>>
    readonly cause?: unknown
    readonly retryable?: boolean
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = "ServerError"
    this.class = input.class
    this.retryable = input.retryable ?? RETRYABLE[input.class]
    if (input.status !== undefined) this.status = input.status
    if (input.code !== undefined) this.code = input.code
    if (input.details !== undefined) this.details = input.details
  }
}

const SIGN_IN_REFUSAL = /(^|_)(token|proof|credential)(_|$)/

function errorClassForStatus(status: number, code?: string): ErrorClass {
  if (status === 401) return "auth"
  if (status === 403) return code !== undefined && SIGN_IN_REFUSAL.test(code) ? "auth" : "forbidden"
  if (status === 404) return "not_found"
  if (status === 409) return "conflict"
  if (status === 429) return "rate_limit"
  if (status === 502 || status === 503 || status === 504) return "network"
  if (status >= 400 && status < 500) return "invalid"
  return "internal"
}

type ErrorBody = { readonly code?: string; readonly message?: string; readonly retryable?: boolean; readonly details?: Readonly<Record<string, unknown>> }

const SETTLED_CODES: ReadonlySet<string> = new Set(["harness_config_options_unavailable"])

function readErrorBody(text: string): ErrorBody {
  if (!text.trim()) return {}
  let parsed: unknown
  if (!/^\s*[[{]/.test(text)) return { message: text }
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    console.warn("An error body that looks like JSON could not be parsed; its text is the message", { error })
    return { message: text }
  }
  if (!parsed || typeof parsed !== "object") return { message: text }
  const body = parsed as { error?: unknown; code?: unknown; message?: unknown; retryable?: unknown }
  const envelope = body.error && typeof body.error === "object" ? (body.error as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown }) : undefined
  const code = envelope?.code ?? body.code
  const message = envelope?.message ?? (typeof body.error === "string" ? body.error : body.message)
  const retryable = envelope?.retryable ?? body.retryable
  const details = asRecord(envelope?.details)
  return {
    ...(details ? { details } : {}),
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof message === "string" ? { message } : {}),
    ...(typeof retryable === "boolean" ? { retryable } : {}),
  }
}

export function statusError(status: number, text: string, label = "Request"): ServerError {
  return errorFromBody(status, readErrorBody(text), label)
}

export function errorFromBody(status: number, body: ErrorBody, label = "Request"): ServerError {
  return new ServerError({
    class: errorClassForStatus(status, body.code),
    message: body.message ?? `${label} failed with status ${status}`,
    status,
    ...(body.code !== undefined ? { code: body.code } : {}),
    ...(body.details !== undefined ? { details: body.details } : {}),
    ...(body.retryable !== undefined ? { retryable: body.retryable } : body.code !== undefined && SETTLED_CODES.has(body.code) ? { retryable: false } : {}),
  })
}

export async function responseError(response: Response, label = "Request"): Promise<ServerError> {
  return statusError(response.status, await response.text(), label)
}

export async function responseErrorCode(response: Response): Promise<string | undefined> {
  return readErrorBody(await response.clone().text()).code
}

const TURN_ERROR_CLASSES: Readonly<Record<string, ErrorClass>> = { credential: "auth", rate_limit: "rate_limit", usage_limit: "rate_limit", session: "not_found" }

function turnErrorClass(data: { firstTurnErrorClass?: unknown }, status: number | undefined): ErrorClass {
  const reported = typeof data.firstTurnErrorClass === "string" ? TURN_ERROR_CLASSES[data.firstTurnErrorClass] : undefined
  return reported ?? (status === undefined ? "internal" : errorClassForStatus(status))
}

export function turnError(value: unknown): ServerError {
  const error = value && typeof value === "object" ? (value as { name?: unknown; data?: unknown }) : {}
  const data = error.data && typeof error.data === "object" ? (error.data as { message?: unknown; status?: unknown; statusCode?: unknown; firstTurnErrorClass?: unknown }) : {}
  const name = typeof error.name === "string" ? error.name : undefined
  const reportedStatus = typeof data.status === "number" ? data.status : data.statusCode
  const status = typeof reportedStatus === "number" ? reportedStatus : undefined
  return new ServerError({
    class: turnErrorClass(data, status),
    message: typeof data.message === "string" ? data.message : name ?? "The turn failed",
    ...(status !== undefined ? { status } : {}),
    ...(name !== undefined ? { code: name } : {}),
  })
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
}

export function toAppError(error: unknown): ServerError {
  if (error instanceof ServerError) return error
  if (isAbort(error)) return new ServerError({ class: "network", message: "The request was aborted", code: "aborted", retryable: false, cause: error })
  if (error instanceof TypeError) return new ServerError({ class: "network", message: "The server could not be reached", cause: error })
  const message = error instanceof Error ? error.message : String(error)
  return new ServerError({ class: "internal", message, cause: error })
}

const HOSTED_HTTP_FAILURE = /HOSTED_HTTP (\d{3}) (\{[\s\S]*\})\s*$/
const HOSTED_UNSIGNED = /\bnot signed in\b/

function hostedHttpError(operation: string, status: number, envelope: string): ServerError {
  let parsed: unknown
  try {
    parsed = JSON.parse(envelope)
  } catch (error) {
    return new ServerError({ class: "internal", message: `${operation} failed with status ${status}`, status, cause: error })
  }
  const body = asRecord(parsed)?.body
  const detail = asRecord(parsed)?.detail
  const failure = statusError(status, body === undefined || body === null ? "" : JSON.stringify(body), operation)
  return typeof detail === "string" && failure.message === `${operation} failed with status ${status}`
    ? new ServerError({ class: failure.class, message: detail, status, ...(failure.code ? { code: failure.code } : {}) })
    : failure
}

export function hostedOperationError(operation: string, error: unknown): ServerError {
  const message = error instanceof Error ? error.message : String(error)
  const http = HOSTED_HTTP_FAILURE.exec(message)
  if (http?.[1] && http[2]) return hostedHttpError(operation, Number(http[1]), http[2])
  if (HOSTED_UNSIGNED.test(message)) return new ServerError({ class: "auth", message: `${operation} needs a signed account`, cause: error })
  return new ServerError({ class: "network", message: `${operation} could not reach the account's control plane: ${message}`, cause: error })
}

export function contractMismatch(what: string): ServerError {
  return new ServerError({ class: "internal", message: `The ${what} answer does not match its contract` })
}

export function isRetryableServerError(error: unknown): boolean {
  return error instanceof ServerError ? error.retryable : false
}

const ERROR_CLASSES: ReadonlySet<string> = new Set<ErrorClass>(["auth", "forbidden", "rate_limit", "network", "not_found", "conflict", "invalid", "internal"])

export function isAppError(value: unknown): value is AppError {
  if (value instanceof ServerError) return true
  if (!value || typeof value !== "object") return false
  const row = value as { class?: unknown; message?: unknown; retryable?: unknown }
  return typeof row.class === "string" && ERROR_CLASSES.has(row.class) && typeof row.message === "string" && typeof row.retryable === "boolean"
}

export function isTurnAdmissionConflict(error: unknown): boolean {
  const data = asRecord(asRecord(error)?.data)
  return data?.code === "turn_already_active" ||
    data?.code === "session_turn_in_progress" ||
    data?.message === "Session is already processing a message"
}
