import type { NotApplied, ProjectedMcpServer } from "@claxedo/harness/contract"
import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import type { ValidatedAgentPlugin } from "@claxedo/server-core/agent-plugins/catalog/types"
import type { ArtifactDigest } from "@claxedo/server-core/agent-plugins/activation/types"
import type { RuntimeMcpServerProjection } from "@claxedo/server-core/agent-plugins/runtime/mcp-projection"

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
    skillNames: readonly string[]
  }>
  mcpServers: ProjectedMcpServer[]
  notApplied: NotApplied[]
}

export type AgentPluginHarnessProjectionAdapter = {
  harnessId: AgentPluginHarnessId
  project(input: {
    generationRoot: string
    plugins: readonly GenerationPluginRoot[]
    mcpServers?: readonly RuntimeMcpServerProjection[]
  }): Promise<HarnessPluginProjection>
}
