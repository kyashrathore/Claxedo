import { asRecord } from "../lib/record"
import type { AppError, ErrorClass } from "./types"

declare module "@tanstack/solid-query" {
  interface Register {
    defaultError: AppError
  }
}

const RETRYABLE: Readonly<Record<ErrorClass, boolean>> = {
  auth: false,
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

  constructor(input: {
    readonly class: ErrorClass
    readonly message: string
    readonly status?: number
    readonly code?: string
    readonly cause?: unknown
    readonly retryable?: boolean
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = "ServerError"
    this.class = input.class
    this.retryable = input.retryable ?? RETRYABLE[input.class]
    if (input.status !== undefined) this.status = input.status
    if (input.code !== undefined) this.code = input.code
  }
}

function errorClassForStatus(status: number): ErrorClass {
  if (status === 401 || status === 403) return "auth"
  if (status === 404) return "not_found"
  if (status === 409) return "conflict"
  if (status === 429) return "rate_limit"
  if (status === 502 || status === 503 || status === 504) return "network"
  if (status >= 400 && status < 500) return "invalid"
  return "internal"
}

type ErrorBody = { readonly code?: string; readonly message?: string }

function readErrorBody(text: string): ErrorBody {
  if (!text.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { message: text }
  }
  if (!parsed || typeof parsed !== "object") return { message: text }
  const body = parsed as { error?: unknown; code?: unknown; message?: unknown }
  const envelope = body.error && typeof body.error === "object" ? (body.error as { code?: unknown; message?: unknown }) : undefined
  const code = envelope?.code ?? body.code
  const message = envelope?.message ?? (typeof body.error === "string" ? body.error : body.message)
  return {
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof message === "string" ? { message } : {}),
  }
}

export async function responseError(response: Response, label = "Request"): Promise<ServerError> {
  const text = await response.text()
  const body = readErrorBody(text)
  return new ServerError({
    class: errorClassForStatus(response.status),
    message: body.message ?? `${label} failed with status ${response.status}`,
    status: response.status,
    ...(body.code !== undefined ? { code: body.code } : {}),
  })
}

export async function responseErrorCode(response: Response): Promise<string | undefined> {
  return readErrorBody(await response.clone().text()).code
}

const TURN_ERROR_CLASSES: Readonly<Record<string, ErrorClass>> = { credential: "auth", usage_limit: "rate_limit", session: "not_found" }

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

export function isRetryable(error: unknown): boolean {
  return error instanceof ServerError ? error.retryable : false
}

const ERROR_CLASSES: ReadonlySet<string> = new Set<ErrorClass>(["auth", "rate_limit", "network", "not_found", "conflict", "invalid", "internal"])

export function isAppError(value: unknown): value is AppError {
  if (value instanceof ServerError) return true
  if (!value || typeof value !== "object") return false
  const row = value as { class?: unknown; message?: unknown; retryable?: unknown }
  return typeof row.class === "string" && ERROR_CLASSES.has(row.class) && typeof row.message === "string" && typeof row.retryable === "boolean"
}

export function isGeminiQuotaRetry(message: string): boolean {
  return message.includes("exceeded your current quota") && message.includes("gemini")
}

export function isTurnAdmissionConflict(error: unknown): boolean {
  const data = asRecord(asRecord(error)?.data)
  return data?.code === "turn_already_active" ||
    data?.code === "session_turn_in_progress" ||
    data?.message === "Session is already processing a message"
}

export function isCodexTurnAborted(data: unknown): boolean {
  return asRecord(data)?.message === "Codex turn aborted"
}
