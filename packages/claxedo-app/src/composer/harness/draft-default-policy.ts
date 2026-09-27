import { sameModelKey, type ModelChoice } from "@/server"
import type { HarnessType } from "./profile"
import { sameHarnessSelection } from "@/lib/harness-selection"
import { isCatalogHarnessId } from "@/lib/harness-selection"

export type DraftDefaultPair = {
  readonly harness: HarnessType
  readonly model?: ModelChoice
}

export type DraftDefaultResult = DraftDefaultPair & {
  readonly state: "ready" | "choose-model" | "saved-model-unavailable" | "unsupported-placement"
  readonly source: "saved" | "harness-default" | "catalog-provider-default" | "placement-default"
  readonly blockedModel?: ModelChoice
}

export type ResolveDraftDefaultInput = {
  readonly saved: DraftDefaultPair
  readonly supportedHarnesses: readonly HarnessType[]
  readonly eligibleModels: readonly ModelChoice[]
  readonly declaredDefaultModel?: ModelChoice
  readonly connectedProviderIds?: readonly string[]
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
    return { ...(input.placementDefault ?? { harness: input.saved.harness }), state: "unsupported-placement", source: "placement-default" }
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
  const catalog = input.saved.harness.kind === "native" && isCatalogHarnessId(input.saved.harness.harnessId)
  const providerDefault = catalog ? onlyProviderDefault(input) : undefined
  if (providerDefault) return { harness: input.saved.harness, model: providerDefault, state: "ready", source: "catalog-provider-default" }
  if (!catalog && eligible(input.eligibleModels, input.declaredDefaultModel)) {
    return {
      harness: input.saved.harness,
      model: input.declaredDefaultModel,
      state: "ready",
      source: "harness-default",
    }
  }
  return { harness: input.saved.harness, state: "choose-model", source: "harness-default" }
}

function onlyProviderDefault(input: ResolveDraftDefaultInput): ModelChoice | undefined {
  const defaults = [...new Set(input.connectedProviderIds ?? [])]
    .map((providerId) => {
      const modelId = input.providerDefaults?.[providerId]
      return modelId ? { providerId, modelId } : undefined
    })
    .filter((model): model is ModelChoice => !!model)
    .filter((model) => eligible(input.eligibleModels, model))
  return defaults.length === 1 ? defaults[0] : undefined
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

function eligible(models: readonly ModelChoice[], candidate?: ModelChoice): candidate is ModelChoice {
  return !!candidate && models.some((model) => sameModelKey(model, candidate))
}
