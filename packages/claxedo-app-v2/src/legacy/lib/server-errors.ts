export type ConfigInvalidError = {
  name: "ConfigInvalidError"
  data: {
    path?: string
    message?: string
    issues?: Array<{ message: string; path: string[] }>
  }
}

export type ProviderModelNotFoundError = {
  name: "ProviderModelNotFoundError"
  data: {
    providerID: string
    modelID: string
    suggestions?: string[]
  }
}

export type ProviderAuthError = {
  name: "ProviderAuthError"
  data: {
    providerID: string
    message?: string
  }
}

import { isRecord, readField, readString } from "./record"

type Translator = (key: string, vars?: Record<string, string | number>) => string

function tr(translator: Translator | undefined, key: string, text: string, vars?: Record<string, string | number>) {
  if (!translator) return text
  const out = translator(key, vars)
  if (!out || out === key) return text
  return out
}

/**
 * The message text of an unknown thrown value.
 *
 * `error instanceof Error ? error.message : String(error)` appears at ninety-two
 * places in this package, plus five private `errorMessage` helpers that each
 * disagree slightly. It is also wrong in the same way every time: `String()` on
 * a thrown object renders `"[object Object]"`, and that placeholder is what the
 * user is then shown. This reads the message where one actually exists —
 * including the `{ message }` envelope the control plane throws — and answers
 * `fallback` rather than a placeholder when none does.
 *
 * For a SERVER error envelope (`ConfigInvalidError` and friends) use
 * `formatServerError`, which understands their payloads; this is the plain
 * "what went wrong" string for everything else.
 */
export function errorMessage(error: unknown, fallback = "Unknown error"): string {
  if (typeof error === "string") return error.trim() || fallback
  if (error instanceof Error) return error.message.trim() || fallback
  const message = readString(error, "message")?.trim()
  if (message) return message
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") return String(error)
  return fallback
}

export function formatServerError(error: unknown, translate?: Translator, fallback?: string) {
  const unwrapped = unwrapNamedError(error)
  if (isConfigInvalidErrorLike(unwrapped)) return parseReadableConfigInvalidError(unwrapped, translate)
  if (isProviderModelNotFoundErrorLike(unwrapped)) return parseReadableProviderModelNotFoundError(unwrapped, translate)
  if (isProviderAuthErrorLike(unwrapped)) return parseReadableProviderAuthError(unwrapped, translate)
  const dataMessage = readableDataMessage(unwrapped)
  if (dataMessage) return dataMessage
  return errorMessage(error, fallback || tr(translate, "error.chain.unknown", "Unknown error"))
}

function unwrapNamedError(error: unknown): unknown {
  if (!(error instanceof Error) || !isRecord(error.cause)) return error
  return "body" in error.cause ? error.cause.body : error.cause
}

/**
 * The shared shape of every server error envelope this module understands:
 * a `name` discriminator plus a `data` payload object. The three named guards
 * below differ only in which `name` they accept.
 */
function isNamedServerError(error: unknown, name: string): boolean {
  return isRecord(error) && error.name === name && isRecord(error.data)
}

function isConfigInvalidErrorLike(error: unknown): error is ConfigInvalidError {
  return isNamedServerError(error, "ConfigInvalidError")
}

function isProviderModelNotFoundErrorLike(error: unknown): error is ProviderModelNotFoundError {
  return isNamedServerError(error, "ProviderModelNotFoundError")
}

function isProviderAuthErrorLike(error: unknown): error is ProviderAuthError {
  return isNamedServerError(error, "ProviderAuthError")
}

function readableDataMessage(error: unknown): string | undefined {
  return readString(readField(error, "data"), "message")?.trim() || undefined
}

export function parseReadableConfigInvalidError(errorInput: ConfigInvalidError, translator?: Translator) {
  const file = errorInput.data.path && errorInput.data.path !== "config" ? errorInput.data.path : "config"
  const detail = errorInput.data.message?.trim() ?? ""
  const issues = (errorInput.data.issues ?? [])
    .map((issue) => {
      const msg = issue.message.trim()
      if (!issue.path.length) return msg
      return `${issue.path.join(".")}: ${msg}`
    })
    .filter(Boolean)
  const msg = issues.length ? issues.join("\n") : detail
  if (!msg) return tr(translator, "error.chain.configInvalid", `Config file at ${file} is invalid`, { path: file })
  return tr(translator, "error.chain.configInvalidWithMessage", `Config file at ${file} is invalid: ${msg}`, {
    path: file,
    message: msg,
  })
}

function parseReadableProviderModelNotFoundError(errorInput: ProviderModelNotFoundError, translator?: Translator) {
  const p = errorInput.data.providerID.trim()
  const m = errorInput.data.modelID.trim()
  const list = (errorInput.data.suggestions ?? []).map((v) => v.trim()).filter(Boolean)
  const body = tr(translator, "error.chain.modelNotFound", `Model not found: ${p}/${m}`, { provider: p, model: m })
  const tail = tr(translator, "error.chain.checkConfig", "Check the selected runtime's provider and model configuration")
  if (list.length) {
    const suggestions = list.slice(0, 5).join(", ")
    return [body, tr(translator, "error.chain.didYouMean", `Did you mean: ${suggestions}`, { suggestions }), tail].join(
      "\n",
    )
  }
  return [body, tail].join("\n")
}

function parseReadableProviderAuthError(errorInput: ProviderAuthError, translator?: Translator) {
  const provider = errorInput.data.providerID.trim()
  const message = errorInput.data.message?.trim() || "Authentication failed"
  return tr(translator, "error.chain.providerAuthFailed", `${provider} auth failed: ${message}`, {
    provider,
    message,
  })
}
