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
