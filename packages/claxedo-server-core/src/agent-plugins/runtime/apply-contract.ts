import type { AgentPluginHarnessId } from "./harness-registry"
import type { ArtifactDigest } from "../activation/types"

export const AGENT_PLUGINS_RUNTIME_APPLY_PATH = "/api/wr/agent-plugins/apply" as const

export type AgentPluginRuntimeApplyRequest = {
  version: 1
  identity: {
    mode: "signed"
    userId: string
    projectId: string
  }
  revision: number
  selections: Array<{
    pluginInstanceId: string
    artifactDigest: ArtifactDigest
    harnessIds: AgentPluginHarnessId[]
  }>
  artifacts: Array<{
    digest: ArtifactDigest
    /** Base64 of the bounded CLXPLG1 tree encoding, never a source archive. */
    tree: string
  }>
  mcpServers: Array<{
    pluginInstanceId: string
    artifactDigest: ArtifactDigest
    harnessId: AgentPluginHarnessId
    serverName: string
    state: "gateway" | "unavailable"
    /** Gateway target before the sandbox-native broker transport is selected in the VM. */
    url?: string
    brokeredSecretName?: string
    reason?: string
  }>
}

export type AgentPluginRuntimeApplyResponse = {
  ok: true
  generationId: string
  revision: number
  harnessLaunch: Record<string, Record<string, unknown>>
}
