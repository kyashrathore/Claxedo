import type { ProviderDirect } from "@claxedo/agent-runtime-contract"
import type { Models } from "@earendil-works/pi-ai"
import type { Conversation, Harness, HarnessOptions, Registry, UserInput } from "@earendil-works/pi-durable"
import type { McpTransport } from "@earendil-works/pi-mcp"
import type { CustomProviderDefinition, PluginProjection, ProjectedMcpServer, ResolvedCredentials } from "../../contract"

export type PiSubmitOptions = { requestId: string; whenBusy: "steer" | "followUp" }

export type PiSessionRuntime = {
  readonly harness: Harness
  readonly conversation: Conversation
  readonly registry: Registry
  submit(input: UserInput, options: PiSubmitOptions): Promise<void>
  close(): Promise<void>
}

export type PiTurnContext = {
  credentials: ResolvedCredentials
  projection: PluginProjection
  providerDefinitions: readonly CustomProviderDefinition[]
}

export interface PiPlacement {
  open(input: { sessionId: string; directory: string; models: Models }): Promise<PiSessionRuntime>
  env(input: { sessionId: string; directory: string }): HarnessOptions["env"]
  mcpTransport(server: ProjectedMcpServer, sessionId: string): Promise<McpTransport>
  prepareTurn?(sessionId: string, signal: AbortSignal): Promise<PiTurnContext>
  refreshCredential?(providerId: string, sessionId: string): Promise<ProviderDirect | undefined>
}
