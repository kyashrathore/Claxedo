import type { SurfaceAgentConfiguration } from "@claxedo/plugin-api/surface"
import { NATIVE_HARNESS_IDS, connectionHarness, nativeHarness, type HarnessSelection } from "@/lib/harness-selection"
import type { DraftHarnessChoice } from "../view/draft-harness-picker"

export type AgentConfiguration = SurfaceAgentConfiguration

export type AgentHarnessReference = NonNullable<AgentConfiguration["harness"]>

export type AgentModelReference = NonNullable<AgentConfiguration["model"]>

export type AgentPlacement = "local" | "cloud"

function sameHarness(left: AgentHarnessReference, right: AgentHarnessReference) {
  return left.id === right.id && left.access === right.access
}

export function rebaseConfiguration(previous: AgentConfiguration, next: AgentConfiguration): AgentConfiguration {
  if (!previous.harness || !next.harness || sameHarness(previous.harness, next.harness)) return next
  const carried =
    !!previous.model &&
    !!next.model &&
    previous.model.providerID === next.model.providerID &&
    previous.model.modelID === next.model.modelID
  return carried ? { harness: next.harness, model: null, effort: null } : next
}

function harnessReferenceOf(selection: HarnessSelection): AgentHarnessReference {
  return selection.kind === "native" ? { id: selection.harnessId, access: "native" } : { id: selection.connectionId, access: "connection" }
}

function harnessSelectionFromReference(reference: AgentHarnessReference): HarnessSelection | undefined {
  if (reference.access === "connection") return connectionHarness(reference.id)
  const native = NATIVE_HARNESS_IDS.find((id) => id === reference.id)
  return native ? nativeHarness(native) : undefined
}

export function harnessChoiceOf(configuration: AgentConfiguration): DraftHarnessChoice {
  return {
    harness: configuration.harness ? harnessSelectionFromReference(configuration.harness) : undefined,
    model: configuration.model ? { providerId: configuration.model.providerID, modelId: configuration.model.modelID } : undefined,
    effort: configuration.effort ?? undefined,
  }
}

export function configurationOf(choice: DraftHarnessChoice): AgentConfiguration {
  return {
    harness: choice.harness ? harnessReferenceOf(choice.harness) : null,
    model: choice.model ? { providerID: choice.model.providerId, modelID: choice.model.modelId } : null,
    effort: choice.effort ?? null,
  }
}
