/**
 * The engine behind a harness adapter refused a read with a failure the adapter
 * cannot interpret — a bare 5xx, an unnamed transport fault. Carried as its own
 * type so an HTTP boundary can answer 502 with the operation and the harness
 * named, without importing the harness's client to recognise its error.
 */
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
