export type TransportErrorKind = "acp" | "claude" | "cursor" | "pi" | "codex" | "opencode" | "provider"

export class TransportError extends Error {
  readonly retryable: boolean
  readonly detail: Readonly<Record<string, string>> | undefined

  constructor(readonly transport: TransportErrorKind, readonly code: string, message: string,
    options?: { cause?: unknown; retryable?: boolean; detail?: Readonly<Record<string, string>> }) {
    super(message, { cause: options?.cause })
    this.detail = options?.detail
    this.name = transport === "provider" ? "HarnessProviderError" : `${transport === "acp" ? "Acp" :
      transport === "pi" ? "Pi" : transport === "codex" ? "Codex" :
      transport === "opencode" ? "OpenCode" : transport === "claude" ? "Claude" : "Cursor"}TransportError`
    this.retryable = options?.retryable ?? (
      (transport === "acp" && (code === "connection" || code === "timeout")) ||
      (transport === "cursor" && (code === "worker" || code === "sdk")) ||
      (transport === "pi" && (code === "timeout" || code === "process")) ||
      (transport === "codex" && code === "process") ||
      (transport === "opencode" && code === "engine"))
  }
}

export class AgentHarnessEngineError extends Error {
  readonly code = "harness_engine_error"
  readonly harness: string
  readonly operation: string
  readonly directory: string
  readonly status: number | undefined

  constructor(input: {
    harness: string
    operation: string
    directory: string
    status?: number
    reason?: string
    cause?: unknown
  }) {
    const answer = input.status === undefined ? (input.reason ?? "an unreadable error") : `status ${input.status}`
    super(`${input.harness} answered ${input.operation} for ${input.directory} with ${answer}`, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = "AgentHarnessEngineError"
    this.harness = input.harness
    this.operation = input.operation
    this.directory = input.directory
    this.status = input.status
  }
}

export function isAgentHarnessEngineError(error: unknown): error is AgentHarnessEngineError {
  return error instanceof AgentHarnessEngineError
}
