import type { AgentPluginHarnessId } from "./harness-registry"
import type { AgentPluginSelectedContribution } from "./execution-selection"
import type { ArtifactDigest } from "../activation/types"

export const AGENT_PLUGINS_RUNTIME_APPLY_PATH = "/api/wr/agent-plugins/apply" as const

/**
 * `version` is the apply revision a runtime must implement to honour the
 * request, not a running count of contract edits.
 *
 * Ordinary workspace-default activation stays at `1`, so an already-baked VM
 * image keeps applying it. An explicit execution selection is `2`, which a
 * version-1 runtime rejects outright — which is the point of the number: a
 * selected-only request has to fail before a session runs rather than fall
 * through to the project's defaults on a runtime that cannot read it.
 */
export const AGENT_PLUGINS_APPLY_VERSION_DEFAULT = 1
export const AGENT_PLUGINS_APPLY_VERSION_SELECTED = 2

type AgentPluginRuntimeApplyCommon = {
  identity: {
    mode: "signed"
    userId: string
    projectId: string
  }
  revision: number
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

type AgentPluginRuntimeSelectionIdentity = {
  pluginInstanceId: string
  artifactDigest: ArtifactDigest
  harnessIds: AgentPluginHarnessId[]
}

export type AgentPluginRuntimeSelectedSelection =
  AgentPluginRuntimeSelectionIdentity & { contribution: AgentPluginSelectedContribution }

export type AgentPluginRuntimeApplyRequest =
  | (AgentPluginRuntimeApplyCommon & {
      version: typeof AGENT_PLUGINS_APPLY_VERSION_DEFAULT
      execution: { mode: "default" }
      selections: AgentPluginRuntimeSelectionIdentity[]
    })
  | (AgentPluginRuntimeApplyCommon & {
      version: typeof AGENT_PLUGINS_APPLY_VERSION_SELECTED
      execution: { mode: "selected"; selectionHash: string }
      selections: AgentPluginRuntimeSelectedSelection[]
    })

export type AgentPluginRuntimeApplyResponse = {
  ok: true
  generationId: string
  revision: number
  /**
   * The selection the runtime materialized, echoed only for a selected
   * request. A caller that asked for one and does not get it back has no proof
   * the projection is the one it resolved, and refuses rather than starting a
   * session in it.
   */
  selectionHash?: string
  harnessLaunch: Record<string, Record<string, unknown>>
}
