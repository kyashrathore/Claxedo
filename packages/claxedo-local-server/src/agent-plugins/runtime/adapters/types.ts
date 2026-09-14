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
    /**
     * The harness owns this root's location outside the generation (Cursor
     * reads one plugin per child of `~/.cursor/plugins/local`), so a restart
     * re-read accepts the recorded absolute path instead of requiring it to
     * sit inside the generation directory.
     */
    external?: true
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
    /**
     * This projection is one root's explicit capability set, so the inventory
     * the harness ends up with must be exactly these plugins. An adapter that
     * writes into harness-owned state the harness also loads from on its own —
     * Codex's config, Cursor's local plugin directory — refuses when it finds
     * anything there it did not put there, because leaving it alone (what
     * default activation correctly does) would add capabilities nobody
     * selected.
     */
    selected?: boolean
  }): Promise<HarnessPluginProjection>
}
