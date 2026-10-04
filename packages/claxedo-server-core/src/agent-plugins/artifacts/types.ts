import type { ArtifactDigest } from "../activation/types"
import type { AgentPluginDiagnostic, ValidatedAgentPlugin } from "../catalog/types"
import type { AgentPluginTree } from "./tree"

export type InspectedAgentPluginArtifact = {
  digest: ArtifactDigest
  tree: AgentPluginTree
  plugin: ValidatedAgentPlugin
  diagnostics: AgentPluginDiagnostic[]
}

export type RetainedAgentPluginArtifact = {
  digest: ArtifactDigest
  /** Present only for a filesystem-backed runtime store. */
  root?: string
  tree: AgentPluginTree
  plugin: ValidatedAgentPlugin
}

/**
 * Function properties rather than methods: no implementation uses `this`, and
 * passing `store.put` around (a test spy, a wrapper) is then an ordinary value
 * rather than an unbound method.
 */
export type AgentPluginArtifactStore = {
  put: (artifact: InspectedAgentPluginArtifact) => Promise<RetainedAgentPluginArtifact>
  get: (digest: ArtifactDigest) => Promise<RetainedAgentPluginArtifact | undefined>
}

export class AgentPluginArtifactError extends Error {
  constructor(
    readonly code: "plugin-invalid" | "artifact-corrupt" | "artifact-path-escape" | "artifact-unsupported-entry",
    message: string,
  ) {
    super(message)
    this.name = "AgentPluginArtifactError"
  }
}
