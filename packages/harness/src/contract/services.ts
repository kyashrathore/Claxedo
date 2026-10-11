import type { Readable, Writable } from "node:stream"
import type { ElicitationPatternEvaluator, ProviderDirect } from "@claxedo/agent-runtime-contract"
import type { McpServerSpec } from "./projection"
import type { Deadline, Locality } from "./session"

export type SpawnCommand = {
  file: string
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
}

export type SpawnOptions = {
  role: "harness" | "probe"
  label: string
  sessionId?: string
  home?: string
  signal: AbortSignal
}

export type ExitStatus = {
  code: number | null
  signal: string | null
}

export type RetireOutcome =
  | { stopped: true }
  | { stopped: false; error: { code: string; message: string } }

export interface OwnedProcess {
  readonly pid: number
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly exited: Promise<ExitStatus>
  retire(deadline: Deadline): Promise<RetireOutcome>
}

export type LogFields = Readonly<Record<string, unknown>>

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}

export interface Clock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type CredentialRefreshRequest = { sessionId: string; credentialProviderId: string; rejectedExpiresAt?: number }

export interface HarnessServices {
  recordHomeUse(home: string): Promise<void>
  refreshCredential?(request: CredentialRefreshRequest): Promise<ProviderDirect | undefined>
  spawn(command: SpawnCommand, options: SpawnOptions): Promise<OwnedProcess>
  firstPartyMcp(sessionId: string, locality: Locality): McpServerSpec | undefined
  healthChanged(): void
  patternEvaluator: ElicitationPatternEvaluator
  log: Logger
  clock: Clock
}
