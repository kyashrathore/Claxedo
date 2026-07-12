// Pure error-chain formatting for the crash page. Extracted from `error.tsx`
// so the 9 InitError variants, cycle-safe JSON, and cause-chain dedup can be
// tested without mounting a component.

export type InitError = {
  name: string
  data: Record<string, unknown>
}

/**
 * The translator shape used by the formatters. Matches
 * `ReturnType<typeof useLanguage>["t"]` structurally, so the real translator
 * is assignable without importing the language context here.
 */
export type Translator = (key: string, vars?: Record<string, string | number | boolean>) => string

export const CHAIN_SEPARATOR = "\n" + "─".repeat(40) + "\n"

function isIssue(value: unknown): value is { message: string; path: string[] } {
  if (!value || typeof value !== "object") return false
  if (!("message" in value) || !("path" in value)) return false
  const message = (value as { message: unknown }).message
  const path = (value as { path: unknown }).path
  if (typeof message !== "string") return false
  if (!Array.isArray(path)) return false
  return path.every((part) => typeof part === "string")
}

export function isInitError(error: unknown): error is InitError {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    "data" in error &&
    typeof (error as InitError).data === "object"
  )
}

export function safeJson(value: unknown): string {
  const seen = new WeakSet<object>()
  const json = JSON.stringify(
    value,
    (_key, val) => {
      if (typeof val === "bigint") return val.toString()
      if (typeof val === "object" && val) {
        if (seen.has(val)) return "[Circular]"
        seen.add(val)
      }
      return val
    },
    2,
  )
  return json ?? String(value)
}

export function formatInitError(error: InitError, t: Translator): string {
  const data = error.data
  switch (error.name) {
    case "MCPFailed": {
      const name = typeof data.name === "string" ? data.name : ""
      return t("error.chain.mcpFailed", { name })
    }
    case "ProviderAuthError": {
      const providerID = typeof data.providerID === "string" ? data.providerID : "unknown"
      const message = typeof data.message === "string" ? data.message : safeJson(data.message)
      return t("error.chain.providerAuthFailed", { provider: providerID, message })
    }
    case "APIError": {
      const message = typeof data.message === "string" ? data.message : t("error.chain.apiError")
      const lines: string[] = [message]

      if (typeof data.statusCode === "number") {
        lines.push(t("error.chain.status", { status: data.statusCode }))
      }

      if (typeof data.isRetryable === "boolean") {
        lines.push(t("error.chain.retryable", { retryable: data.isRetryable }))
      }

      if (typeof data.responseBody === "string" && data.responseBody) {
        lines.push(t("error.chain.responseBody", { body: data.responseBody }))
      }

      return lines.join("\n")
    }
    case "ProviderModelNotFoundError": {
      const { providerID, modelID, suggestions } = data as {
        providerID: string
        modelID: string
        suggestions?: string[]
      }

      const suggestionsLine =
        Array.isArray(suggestions) && suggestions.length
          ? [t("error.chain.didYouMean", { suggestions: suggestions.join(", ") })]
          : []

      return [
        t("error.chain.modelNotFound", { provider: providerID, model: modelID }),
        ...suggestionsLine,
        t("error.chain.checkConfig"),
      ].join("\n")
    }
    case "ProviderInitError": {
      const providerID = typeof data.providerID === "string" ? data.providerID : "unknown"
      return t("error.chain.providerInitFailed", { provider: providerID })
    }
    case "ConfigJsonError": {
      const path = typeof data.path === "string" ? data.path : safeJson(data.path)
      const message = typeof data.message === "string" ? data.message : ""
      if (message) return t("error.chain.configJsonInvalidWithMessage", { path, message })
      return t("error.chain.configJsonInvalid", { path })
    }
    case "ConfigDirectoryTypoError": {
      const path = typeof data.path === "string" ? data.path : safeJson(data.path)
      const dir = typeof data.dir === "string" ? data.dir : safeJson(data.dir)
      const suggestion = typeof data.suggestion === "string" ? data.suggestion : safeJson(data.suggestion)
      return t("error.chain.configDirectoryTypo", { dir, path, suggestion })
    }
    case "ConfigFrontmatterError": {
      const path = typeof data.path === "string" ? data.path : safeJson(data.path)
      const message = typeof data.message === "string" ? data.message : safeJson(data.message)
      return t("error.chain.configFrontmatterError", { path, message })
    }
    case "ConfigInvalidError": {
      const issues = Array.isArray(data.issues)
        ? data.issues.filter(isIssue).map((issue) => "↳ " + issue.message + " " + issue.path.join("."))
        : []
      const message = typeof data.message === "string" ? data.message : ""
      const path = typeof data.path === "string" ? data.path : safeJson(data.path)

      const line = message
        ? t("error.chain.configInvalidWithMessage", { path, message })
        : t("error.chain.configInvalid", { path })

      return [line, ...issues].join("\n")
    }
    case "UnknownError":
      return typeof data.message === "string" ? data.message : safeJson(data)
    default:
      if (typeof data.message === "string") return data.message
      return safeJson(data)
  }
}

export function formatErrorChain(error: unknown, t: Translator, depth = 0, parentMessage?: string): string {
  if (!error) return t("error.chain.unknown")

  if (isInitError(error)) {
    const message = formatInitError(error, t)
    if (depth > 0 && parentMessage === message) return ""
    const indent = depth > 0 ? `\n${CHAIN_SEPARATOR}${t("error.chain.causedBy")}\n` : ""
    return indent + `${error.name}\n${message}`
  }

  if (error instanceof Error) {
    if (error.message === "Unknown error" && error.cause) {
      return formatErrorChain(error.cause, t, depth, parentMessage)
    }

    const isDuplicate = depth > 0 && parentMessage === error.message
    const parts: string[] = []
    const indent = depth > 0 ? `\n${CHAIN_SEPARATOR}${t("error.chain.causedBy")}\n` : ""

    const header = `${error.name}${error.message ? `: ${error.message}` : ""}`
    const stack = error.stack?.trim()

    if (stack) {
      const startsWithHeader = stack.startsWith(header)

      if (isDuplicate && startsWithHeader) {
        const trace = stack.split("\n").slice(1).join("\n").trim()
        if (trace) {
          parts.push(indent + trace)
        }
      }

      if (isDuplicate && !startsWithHeader) {
        parts.push(indent + stack)
      }

      if (!isDuplicate && startsWithHeader) {
        parts.push(indent + stack)
      }

      if (!isDuplicate && !startsWithHeader) {
        parts.push(indent + `${header}\n${stack}`)
      }
    }

    if (!stack && !isDuplicate) {
      parts.push(indent + header)
    }

    if (error.cause) {
      const causeResult = formatErrorChain(error.cause, t, depth + 1, error.message)
      if (causeResult) {
        parts.push(causeResult)
      }
    }

    return parts.join("\n\n")
  }

  if (typeof error === "string") {
    if (depth > 0 && parentMessage === error) return ""
    const indent = depth > 0 ? `\n${CHAIN_SEPARATOR}${t("error.chain.causedBy")}\n` : ""
    return indent + error
  }

  const indent = depth > 0 ? `\n${CHAIN_SEPARATOR}${t("error.chain.causedBy")}\n` : ""
  return indent + safeJson(error)
}

export function formatError(error: unknown, t: Translator): string {
  return formatErrorChain(error, t, 0)
}
