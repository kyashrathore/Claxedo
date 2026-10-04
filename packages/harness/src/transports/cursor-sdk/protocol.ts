import type { McpServerConfig, SDKMessage, SDKUserMessage, SettingSource, ShellOutputDeltaUpdate, ToolCallDeltaUpdate } from "@cursor/sdk"

export type HostLocalOptions = {
  settingSources?: SettingSource[]
  sandboxOptions?: { enabled: boolean }
  autoReview?: boolean
}

export type HostSession = {
  sessionId: string
  agentId?: string
  directory: string
  apiKey: string
  model?: string
  mcpServers: Record<string, McpServerConfig>
  local: HostLocalOptions
}

export type HostModel = { id: string; name: string; description?: string }

export type HostCommand =
  | { id: number; kind: "open"; session: HostSession }
  | { id: number; kind: "run"; session: HostSession; prompt: string | SDKUserMessage; mode?: "plan" }
  | { id: number; kind: "title"; session: HostSession; prompt: string }
  | { id: number; kind: "models"; apiKey: string }
  | { id: number; kind: "cancel"; sessionId: string }
  | { id: number; kind: "steer"; sessionId: string; text: string }
  | { id: number; kind: "close"; sessionId: string }

export type HostRequest = HostCommand extends infer Command
  ? Command extends HostCommand ? Omit<Command, "id"> : never
  : never

export type HostRunError = { message: string; code?: string }

export type HostSteerOutcome = "complete_delivered" | "revert_to_followup" | "no_run" | "unsupported"

export type HostResult = { agentId?: string; runId?: string; status?: string; result?: string; error?: HostRunError; models?: HostModel[]; steer?: HostSteerOutcome }

export type HostFailure = { message: string; name?: string; code?: string; retryable?: boolean }

export type HostDelta = ShellOutputDeltaUpdate | ToolCallDeltaUpdate

export type HostReply =
  | { id: number; kind: "result"; value?: HostResult }
  | { id: number; kind: "event"; message: SDKMessage }
  | { id: number; kind: "delta"; update: HostDelta }
  | ({ id: number; kind: "error" } & HostFailure)

export type HostResultReply = Extract<HostReply, { kind: "result" }>

const commandKinds: readonly string[] = ["open", "run", "title", "models", "cancel", "steer", "close"]
const replyKinds: readonly string[] = ["result", "event", "delta", "error"]

function frameOf(value: unknown, kinds: readonly string[]): boolean {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "number" &&
    "kind" in value && typeof value.kind === "string" && kinds.includes(value.kind)
}

export function isHostCommand(value: unknown): value is HostCommand { return frameOf(value, commandKinds) }

export function isHostReply(value: unknown): value is HostReply { return frameOf(value, replyKinds) }

export function hostFailure(error: unknown, message: string): HostFailure {
  const sdk = error instanceof Error ? error as Error & { code?: unknown; isRetryable?: unknown } : undefined
  return {
    message,
    ...(sdk && sdk.name !== "Error" ? { name: sdk.name } : {}),
    ...(typeof sdk?.code === "string" ? { code: sdk.code } : {}),
    ...(typeof sdk?.isRetryable === "boolean" ? { retryable: sdk.isRetryable } : {}),
  }
}

export function hostRunError(error: HostRunError | undefined): { error?: HostRunError } {
  return error ? { error: { message: error.message, ...(error.code ? { code: error.code } : {}) } } : {}
}
