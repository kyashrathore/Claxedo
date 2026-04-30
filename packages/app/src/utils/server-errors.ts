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
    providerID?: string
    message?: string
  }
}

type Translator = (key: string, vars?: Record<string, string | number>) => string

function tr(translator: Translator | undefined, key: string, text: string, vars?: Record<string, string | number>) {
  if (!translator) return text
  const out = translator(key, vars)
  if (!out || out === key) return text
  return out
}

export function formatServerError(error: unknown, translate?: Translator, fallback?: string) {
  if (error instanceof Error && error.message === "Unknown error" && error.cause) {
    return formatServerError(error.cause, translate, fallback)
  }
  if (isConfigInvalidErrorLike(error)) return parseReadableConfigInvalidError(error, translate)
  if (isProviderAuthErrorLike(error)) return parseReadableProviderAuthError(error, translate)
  if (isProviderModelNotFoundErrorLike(error)) return parseReadableProviderModelNotFoundError(error, translate)
  if (isDataMessageErrorLike(error)) return error.data.message
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  if (fallback) return fallback
  return tr(translate, "error.chain.unknown", "Unknown error")
}

function isConfigInvalidErrorLike(error: unknown): error is ConfigInvalidError {
  if (typeof error !== "object" || error === null) return false
  const o = error as Record<string, unknown>
  return o.name === "ConfigInvalidError" && typeof o.data === "object" && o.data !== null
}

function isProviderModelNotFoundErrorLike(error: unknown): error is ProviderModelNotFoundError {
  if (typeof error !== "object" || error === null) return false
  const o = error as Record<string, unknown>
  return o.name === "ProviderModelNotFoundError" && typeof o.data === "object" && o.data !== null
}

function isProviderAuthErrorLike(error: unknown): error is ProviderAuthError {
  if (typeof error !== "object" || error === null) return false
  const o = error as Record<string, unknown>
  return o.name === "ProviderAuthError" && typeof o.data === "object" && o.data !== null
}

function isDataMessageErrorLike(error: unknown): error is { data: { message: string } } {
  if (typeof error !== "object" || error === null) return false
  const data = (error as Record<string, unknown>).data
  if (typeof data !== "object" || data === null) return false
  return typeof (data as Record<string, unknown>).message === "string"
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

function parseReadableProviderAuthError(errorInput: ProviderAuthError, translator?: Translator) {
  const provider = errorInput.data.providerID?.trim() || "unknown"
  const message = errorInput.data.message?.trim()
  if (!message) return tr(translator, "error.chain.providerInitFailed", `Provider failed to initialize: ${provider}`, { provider })
  return tr(translator, "error.chain.providerAuthFailed", `${provider}: ${message}`, { provider, message })
}

function parseReadableProviderModelNotFoundError(errorInput: ProviderModelNotFoundError, translator?: Translator) {
  const p = errorInput.data.providerID.trim()
  const m = errorInput.data.modelID.trim()
  const list = (errorInput.data.suggestions ?? []).map((v) => v.trim()).filter(Boolean)
  const body = tr(translator, "error.chain.modelNotFound", `Model not found: ${p}/${m}`, { provider: p, model: m })
  const tail = tr(translator, "error.chain.checkConfig", "Check your config (opencode.json) provider/model names")
  if (list.length) {
    const suggestions = list.slice(0, 5).join(", ")
    return [body, tr(translator, "error.chain.didYouMean", `Did you mean: ${suggestions}`, { suggestions }), tail].join(
      "\n",
    )
  }
  return [body, tail].join("\n")
}
