import type { McpServerConfig, SDKMessage, SDKUserMessage } from "@cursor/sdk"

export type WorkerSession = {
  sessionId: string
  agentId?: string
  directory: string
  apiKey: string
  model?: string
  mcpServers: Record<string, McpServerConfig>
  plugins: boolean
}

export type WorkerCommand =
  | { id: number; kind: "open"; session: WorkerSession }
  | { id: number; kind: "run"; session: WorkerSession; prompt: string | SDKUserMessage; mode?: "plan" }
  | { id: number; kind: "cancel"; sessionId: string }
  | { id: number; kind: "close"; sessionId: string }

export type WorkerRequest = WorkerCommand extends infer Command
  ? Command extends WorkerCommand ? Omit<Command, "id"> : never
  : never

export type WorkerReply =
  | { id: number; kind: "result"; value?: { agentId?: string; runId?: string; status?: string; result?: string } }
  | { id: number; kind: "event"; message: SDKMessage }
  | { id: number; kind: "error"; message: string }
