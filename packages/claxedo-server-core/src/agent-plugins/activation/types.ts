import type { AgentPluginHarnessId } from "../runtime/harness-registry"

export type ArtifactDigest = `sha256:${string}`

/**
 * The only shape a retained artifact is ever named by. Every boundary that
 * reads a digest off the wire, out of a row or out of a token claim narrows
 * through this, so none of them can disagree about what counts as one.
 */
export function isArtifactDigest(value: unknown): value is ArtifactDigest {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value)
}

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
