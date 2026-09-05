import type {
  ActivationWinner,
  ArtifactDigest,
  EffectiveActivation,
  EffectiveActivationInput,
} from "./types"

type Selected =
  | { enabled: false; winner: ActivationWinner }
  | {
      enabled: true
      winner: Exclude<ActivationWinner, "none">
      digest?: ArtifactDigest
    }

function signedSelection(input: Extract<EffectiveActivationInput, { mode: "signed" }>): Selected {
  if (input.projectOverride !== undefined) {
    return { enabled: input.projectOverride, winner: "project", digest: input.pins.user }
  }
  if (input.userDefault !== undefined) {
    return { enabled: input.userDefault, winner: "user-default", digest: input.pins.user }
  }
  if (input.organizationDefault) {
    return { enabled: true, winner: "organization", digest: input.pins.organization }
  }
  if (input.claxedoDefault) {
    return { enabled: true, winner: "claxedo", digest: input.pins.claxedo }
  }
  return { enabled: false, winner: "none" }
}

function unsignedSelection(input: Extract<EffectiveActivationInput, { mode: "unsigned" }>): Selected {
  if (input.machineOverride !== undefined) {
    return { enabled: input.machineOverride, winner: "machine", digest: input.pins.localMachine }
  }
  if (input.claxedoDefault) {
    return { enabled: true, winner: "claxedo", digest: input.pins.claxedo }
  }
  return { enabled: false, winner: "none" }
}

/**
 * The sole activation precedence rule.
 *
 * This function intentionally performs no I/O and does not accept actor,
 * project, store, or clock services. Callers authorize and load one coherent
 * snapshot before invoking it. A selected authority without a retained
 * artifact remains visibly desired and unavailable; it is never collapsed to
 * disabled.
 */
export function resolveEffectiveActivation(input: EffectiveActivationInput): EffectiveActivation {
  const selected = input.mode === "signed" ? signedSelection(input) : unsignedSelection(input)
  if (!selected.enabled) {
    return { status: "ready", effective: false, winner: selected.winner }
  }
  if (!selected.digest) {
    return {
      status: "artifact-unavailable",
      effective: true,
      winner: selected.winner,
    }
  }
  return {
    status: "ready",
    effective: true,
    winner: selected.winner,
    artifactDigest: selected.digest,
  }
}
