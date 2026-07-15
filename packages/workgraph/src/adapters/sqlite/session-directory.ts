export class SqliteWorkGraphSessionDirectoryRequiredError extends Error {
  readonly code = "workgraph_session_directory_required"
  readonly retryable = false

  constructor(purpose: string) {
    super(`${purpose} requires an explicit Session directory`)
    this.name = "SqliteWorkGraphSessionDirectoryRequiredError"
  }
}

export function requireSessionDirectory(value: string | undefined, purpose: string) {
  const directory = value?.trim()
  if (!directory) throw new SqliteWorkGraphSessionDirectoryRequiredError(purpose)
  return directory
}
