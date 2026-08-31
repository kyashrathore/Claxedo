import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import type { ValidatedAgentPlugin } from "@claxedo/server-core/agent-plugins/catalog/types"
import type { ArtifactDigest } from "@claxedo/server-core/agent-plugins/activation/types"

type RuntimeMcpServerProjectionIdentity = {
  pluginInstanceId: string
  artifactDigest: ArtifactDigest
  harnessId: AgentPluginHarnessId
  serverName: string
}

export type RuntimeMcpServerProjection = RuntimeMcpServerProjectionIdentity & (
  | { state: "gateway"; url: string; headers?: Record<string, string> }
  | { state: "unavailable"; reason: string }
)

export type GenerationPluginRoot = {
  pluginInstanceId: string
  artifactDigest: ArtifactDigest
  plugin: ValidatedAgentPlugin
  root: string
  dataRoot: string
}

export type HarnessPluginProjection = {
  harnessId: AgentPluginHarnessId
  /** Optional generated harness configuration consumed by its runtime driver. */
  configFile?: string
  pluginRoots: Array<{
    pluginInstanceId: string
    root: string
    dataRoot: string
  }>
  diagnostics: Array<{
    pluginInstanceId: string
    code: string
    message: string
  }>
}

export type AgentPluginHarnessProjectionAdapter = {
  harnessId: AgentPluginHarnessId
  /** Run even with no selected plugins when the adapter owns external state that must be cleared. */
  projectEmpty?: boolean
  project(input: {
    generationRoot: string
    plugins: readonly GenerationPluginRoot[]
    mcpServers?: readonly RuntimeMcpServerProjection[]
  }): Promise<HarnessPluginProjection>
}
