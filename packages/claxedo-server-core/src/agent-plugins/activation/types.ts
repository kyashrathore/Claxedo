import type { AgentPluginHarnessId } from "../runtime/harness-registry"

export type PluginInstanceId = string & { readonly __pluginInstanceId: unique symbol }
export type ArtifactDigest = `sha256:${string}`

export type ActivationIdentity = {
  pluginInstanceId: string
  harnessId: AgentPluginHarnessId
}

export type AuthorityPins = {
  claxedo?: ArtifactDigest
  organization?: ArtifactDigest
  user?: ArtifactDigest
  localMachine?: ArtifactDigest
}

export type SignedActivationInput = ActivationIdentity & {
  mode: "signed"
  projectOverride?: boolean
  userDefault?: boolean
  organizationDefault?: boolean
  claxedoDefault?: boolean
  pins: AuthorityPins
}

export type UnsignedActivationInput = ActivationIdentity & {
  mode: "unsigned"
  machineOverride?: boolean
  claxedoDefault?: boolean
  pins: AuthorityPins
}

export type EffectiveActivationInput = SignedActivationInput | UnsignedActivationInput

export type ActivationWinner = "project" | "user-default" | "organization" | "claxedo" | "machine" | "none"

export type EffectiveActivation =
  | {
      status: "ready"
      effective: false
      winner: ActivationWinner
    }
  | {
      status: "ready"
      effective: true
      winner: Exclude<ActivationWinner, "none">
      artifactDigest: ArtifactDigest
    }
  | {
      status: "artifact-unavailable"
      effective: true
      winner: Exclude<ActivationWinner, "none">
    }
