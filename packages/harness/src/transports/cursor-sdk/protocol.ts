import type { McpServerConfig, SDKMessage, SDKUserMessage, SettingSource } from "@cursor/sdk"

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
  | { id: number; kind: "close"; sessionId: string }

export type HostRequest = HostCommand extends infer Command
  ? Command extends HostCommand ? Omit<Command, "id"> : never
  : never

export type HostResult = { agentId?: string; runId?: string; status?: string; result?: string; models?: HostModel[] }

export type HostReply =
  | { id: number; kind: "result"; value?: HostResult }
  | { id: number; kind: "event"; message: SDKMessage }
  | { id: number; kind: "error"; message: string }

const commandKinds: readonly string[] = ["open", "run", "title", "models", "cancel", "close"]
const replyKinds: readonly string[] = ["result", "event", "error"]

function frameOf(value: unknown, kinds: readonly string[]): boolean {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "number" &&
    "kind" in value && typeof value.kind === "string" && kinds.includes(value.kind)
}

export function isHostCommand(value: unknown): value is HostCommand { return frameOf(value, commandKinds) }

export function isHostReply(value: unknown): value is HostReply { return frameOf(value, replyKinds) }
