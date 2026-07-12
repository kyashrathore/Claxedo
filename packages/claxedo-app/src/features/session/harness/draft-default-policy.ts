import type { ModelKey } from "@/features/session/composer/model-strategy"
import type { HarnessType } from "./profile"

export type DraftDefaultPair = {
  readonly harness: HarnessType
  readonly model?: ModelKey
}

export type DraftDefaultResult = DraftDefaultPair & {
  readonly state: "ready" | "choose-model" | "saved-model-unavailable" | "unsupported-placement"
  readonly source: "saved" | "harness-default" | "pi-opencode" | "pi-provider-default" | "placement-default"
  readonly blockedModel?: ModelKey
}

export type ResolveDraftDefaultInput = {
  readonly saved: DraftDefaultPair
  readonly supportedHarnesses: readonly HarnessType[]
  readonly eligibleModels: readonly ModelKey[]
  readonly declaredDefaultModel?: ModelKey
  readonly openCodeModel?: ModelKey
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
  if (!input.supportedHarnesses.includes(input.saved.harness)) {
    const placementDefault = input.placementDefault ?? {
      harness: input.supportedHarnesses.includes("opencode")
        ? "opencode"
        : (input.supportedHarnesses[0] ?? "opencode"),
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
  if (
    input.saved.harness === "pi" &&
    eligible(input.eligibleModels, input.openCodeModel)
  ) {
    return {
      harness: "pi",
      model: input.openCodeModel,
      state: "ready",
      source: "pi-opencode",
    }
  }
  if (input.saved.harness === "pi") {
    const defaults = [...new Set(input.connectedProviderIDs ?? [])]
      .map((providerID) => {
        const modelID = input.providerDefaults?.[providerID]
        return modelID ? { providerID, modelID } : undefined
      })
      .filter((model): model is ModelKey => !!model)
      .filter((model) => eligible(input.eligibleModels, model))
    if (defaults.length === 1) {
      return {
        harness: "pi",
        model: defaults[0],
        state: "ready",
        source: "pi-provider-default",
      }
    }
  }
  if (
    input.saved.harness !== "pi" &&
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
