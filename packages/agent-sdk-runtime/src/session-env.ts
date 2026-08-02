export type SessionEnvExecOptions = {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export type SessionEnvExecResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type SessionEnvFileStat = {
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
  size: number
  mtimeMs: number
}

export type SessionEnvKind = "virtual" | "workspace-runtime"

export type SessionEnv = {
  readonly kind: SessionEnvKind
  cwd(): string
  resolvePath(input?: string): string
  exec(command: string, options?: SessionEnvExecOptions): Promise<SessionEnvExecResult>
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, content: string | Uint8Array): Promise<void>
  stat(path: string): Promise<SessionEnvFileStat>
  readdir(path?: string): Promise<string[]>
  exists(path: string): Promise<boolean>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  dispose?(): Promise<void> | void
}

export type SessionStartMode = "local" | "cloud" | "hybrid"

export type SessionHost = "central" | "workspace"

export type SandboxRef =
  | { kind: "virtual"; id?: string }
  // Tools-only placement: the session stays central; exec/file side effects run
  // inside the selected workspace runtime via /api/wr/session-env/*.
  | {
      kind: "workspace-runtime"
      workspaceId: string
      directory?: string
      worktree?: string
      baseCommit?: string
      leaseEpoch?: number
    }

export type SessionEnvFactoryInput = {
  sessionId: string
  mode: SessionStartMode
  host: SessionHost
  directory?: string
  workspaceId?: string
  toolSandbox?: SandboxRef
}

export type ResolvedSessionPlacement = SessionEnvFactoryInput

export type SessionEnvFactory = (input: SessionEnvFactoryInput) => SessionEnv | Promise<SessionEnv>

export type RunStoreEvent<TPayload = unknown> = {
  runId: string
  eventIndex: number
  payload: TPayload
  createdAt: number
}

export type RunStoreAppendInput<TPayload = unknown> = {
  runId: string
  payload: TPayload
  createdAt?: number
}

export type RunStore<TPayload = unknown> = {
  appendEvent(input: RunStoreAppendInput<TPayload>): RunStoreEvent<TPayload>
  getEvents(runId: string, fromIndex?: number): RunStoreEvent<TPayload>[]
}

export function createMemoryRunStore<TPayload = unknown>(): RunStore<TPayload> {
  const events = new Map<string, RunStoreEvent<TPayload>[]>()
  return {
    appendEvent(input) {
      const list = events.get(input.runId) ?? []
      const event = {
        runId: input.runId,
        eventIndex: list.length,
        payload: input.payload,
        createdAt: input.createdAt ?? Date.now(),
      }
      events.set(input.runId, [...list, event])
      return event
    },
    getEvents(runId, fromIndex = 0) {
      return (events.get(runId) ?? []).filter((event) => event.eventIndex >= fromIndex)
    },
  }
}
