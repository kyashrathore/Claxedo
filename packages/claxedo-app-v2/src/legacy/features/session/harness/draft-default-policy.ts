import type { ModelKey } from "@/features/session/composer/model-strategy"
import type { HarnessType } from "./profile"
import { sameHarnessSelection } from "@/platform/identity/harness-selection"
import { isCatalogHarnessId } from "@/platform/identity/harness-selection"

export type DraftDefaultPair = {
  readonly harness: HarnessType
  readonly model?: ModelKey
}

export type DraftDefaultResult = DraftDefaultPair & {
  readonly state: "ready" | "choose-model" | "saved-model-unavailable" | "unsupported-placement"
  readonly source: "saved" | "harness-default" | "catalog-provider-default" | "placement-default"
  readonly blockedModel?: ModelKey
}

export type ResolveDraftDefaultInput = {
  readonly saved: DraftDefaultPair
  readonly supportedHarnesses: readonly HarnessType[]
  readonly eligibleModels: readonly ModelKey[]
  readonly declaredDefaultModel?: ModelKey
  readonly connectedProviderIDs?: readonly string[]
  readonly providerDefaults?: Readonly<Record<string, string | undefined>>
  readonly placementDefault?: DraftDefaultPair
}

export type DraftDefaultAuthority = "unresolved" | "defaulted" | "explicit" | "server"

export type DraftDefaultApplication = {
  readonly workspaceKey: string
  readonly scope: string
  readonly revision: number
}

export type DraftDefaultOwner = DraftDefaultApplication & {
  readonly authority: DraftDefaultAuthority
}

export function resolveDraftDefault(input: ResolveDraftDefaultInput): DraftDefaultResult {
  if (!input.supportedHarnesses.some((item) => sameHarnessSelection(item, input.saved.harness))) {
    const placementDefault = input.placementDefault
    if (!placementDefault) return {
      harness: input.saved.harness,
      state: "unsupported-placement",
      source: "placement-default",
    }
    return {
      ...placementDefault,
      state: "unsupported-placement",
      source: "placement-default",
    }
  }
  if (eligible(input.eligibleModels, input.saved.model)) {
    return { ...input.saved, state: "ready", source: "saved" }
  }
  if (input.saved.model) {
    return {
      harness: input.saved.harness,
      blockedModel: input.saved.model,
      state: "saved-model-unavailable",
      source: "saved",
    }
  }
  if (input.saved.harness.kind === "native" && isCatalogHarnessId(input.saved.harness.harnessId)) {
    const defaults = [...new Set(input.connectedProviderIDs ?? [])]
      .map((providerID) => {
        const modelID = input.providerDefaults?.[providerID]
        return modelID ? { providerID, modelID } : undefined
      })
      .filter((model): model is ModelKey => !!model)
      .filter((model) => eligible(input.eligibleModels, model))
    if (defaults.length === 1) {
      return {
        harness: input.saved.harness,
        model: defaults[0],
        state: "ready",
        source: "catalog-provider-default",
      }
    }
  }
  if (
    !(input.saved.harness.kind === "native" && isCatalogHarnessId(input.saved.harness.harnessId)) &&
    eligible(input.eligibleModels, input.declaredDefaultModel)
  ) {
    return {
      harness: input.saved.harness,
      model: input.declaredDefaultModel,
      state: "ready",
      source: "harness-default",
    }
  }
  return { harness: input.saved.harness, state: "choose-model", source: "harness-default" }
}

export function shouldApplyDraftDefault(
  captured: DraftDefaultApplication,
  current: DraftDefaultOwner,
) {
  return current.authority === "unresolved" &&
    current.workspaceKey === captured.workspaceKey &&
    current.scope === captured.scope &&
    current.revision === captured.revision
}

function sameModel(left: ModelKey, right: ModelKey) {
  return left.providerID === right.providerID &&
    left.modelID === right.modelID &&
    left.variant === right.variant
}

function eligible(models: readonly ModelKey[], candidate?: ModelKey): candidate is ModelKey {
  return !!candidate && models.some((model) => sameModel(model, candidate))
}
