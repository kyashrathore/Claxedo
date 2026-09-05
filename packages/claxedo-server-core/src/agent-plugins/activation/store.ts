import type { AgentPluginHarnessId } from "../runtime/harness-registry"
import type { ArtifactDigest } from "./types"
import type { SignedControlPlaneAuth } from "../../platform/auth/auth"

export type UnsignedActivationSnapshot = {
  revision: number
  pluginInstanceId: string
  harnessId: AgentPluginHarnessId
  machineOverride?: boolean
  claxedoDefault?: true
  pins: {
    localMachine?: ArtifactDigest
    claxedo?: ArtifactDigest
  }
}

export type MutateMachineActivation = {
  pluginInstanceId: string
  harnessIds: readonly string[]
  choice: boolean | undefined
  /** Supplied after artifact retention; committed atomically with `choice`. */
  artifact?: {
    digest: ArtifactDigest
    sourceId: string
    relativePath: string
    sourceRevision: string
  }
  expectedRevision: number
}

export type UnsignedKnownPlugin = {
  pluginInstanceId: string
  pin?: {
    digest: ArtifactDigest
    sourceId: string
    relativePath: string
    sourceRevision: string
  }
}

export type UnsignedAgentPluginActivationStore = {
  revision(): number
  listKnown(): UnsignedKnownPlugin[]
  read(pluginInstanceId: string, harnessId: string): UnsignedActivationSnapshot
  mutate(input: MutateMachineActivation): number
}

export type AgentPluginArtifactPin = {
  digest: ArtifactDigest
  sourceId: string
  relativePath: string
  sourceRevision: string
}

export type SignedActivationSnapshot = {
  revision: number
  pluginInstanceId: string
  harnessId: AgentPluginHarnessId
  projectId?: string
  projectOverride?: boolean
  userDefault?: boolean
  organizationDefault?: true
  claxedoDefault?: true
  pins: {
    user?: ArtifactDigest
    organization?: ArtifactDigest
    claxedo?: ArtifactDigest
  }
}

export type SignedKnownPlugin = {
  pluginInstanceId: string
  pins: {
    user?: AgentPluginArtifactPin
    organization?: AgentPluginArtifactPin
    claxedo?: AgentPluginArtifactPin
  }
}

export type MutateSignedUserActivation = {
  pluginInstanceId: string
  harnessIds: readonly AgentPluginHarnessId[]
  choice: boolean | undefined
  target:
    | { scope: "all-projects" }
    | { scope: "projects"; projectIds: readonly string[] }
  artifact?: AgentPluginArtifactPin
  expectedRevision: number
}

export type MutateSignedOrganizationDefault = {
  pluginInstanceId: string
  harnessIds: readonly AgentPluginHarnessId[]
  choice: true | undefined
  artifact?: AgentPluginArtifactPin
  expectedRevision: number
}

export type UpdateSignedArtifactPin = {
  pluginInstanceId: string
  artifact: AgentPluginArtifactPin
  expectedRevision: number
}

/**
 * Authenticated durable metadata authority. Implementations resolve internal
 * user/org IDs and authorize every project; routes never accept owner IDs.
 */
export type SignedAgentPluginActivationStore = {
  /** Authorizes a project even when the catalog and retained set are empty. */
  authorizeProject(auth: SignedControlPlaneAuth, projectId: string): Promise<void>
  revision(auth: SignedControlPlaneAuth): Promise<number>
  listKnown(auth: SignedControlPlaneAuth): Promise<SignedKnownPlugin[]>
  read(
    auth: SignedControlPlaneAuth,
    input: { pluginInstanceId: string; harnessId: AgentPluginHarnessId; projectId?: string },
  ): Promise<SignedActivationSnapshot>
  mutateUser(auth: SignedControlPlaneAuth, input: MutateSignedUserActivation): Promise<number>
  mutateOrganizationDefault(
    auth: SignedControlPlaneAuth,
    input: MutateSignedOrganizationDefault,
  ): Promise<number>
  updateUserArtifact(auth: SignedControlPlaneAuth, input: UpdateSignedArtifactPin): Promise<number>
  updateOrganizationArtifact(auth: SignedControlPlaneAuth, input: UpdateSignedArtifactPin): Promise<number>
}

export class AgentPluginActivationStoreError extends Error {
  constructor(
    readonly code: "unsupported-harness" | "revision-conflict" | "artifact-unavailable",
    message: string,
  ) {
    super(message)
    this.name = "AgentPluginActivationStoreError"
  }
}
