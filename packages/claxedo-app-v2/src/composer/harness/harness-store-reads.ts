import type { ModelChoice } from "@/server"
import type { HarnessScopes } from "./harness-scopes"
import {
  connectionAllowsNoModel,
  draftConnectionAllowsNoModel,
  harnessDisplayName,
  harnessModelKeyForSubmit,
  harnessModelNameForSubmit,
  harnessModels,
  harnessReadyForSubmit,
  harnessServiceTierForSubmit,
} from "./selection"
import type { HarnessStoreState } from "./store-state"

type Read = (scope: string) => HarnessStoreState

export function harnessSelectionReads(read: Read) {
  return {
    displayName: (scope: string) => harnessDisplayName(read(scope)),
    harness: (scope: string) => read(scope).harness,
    harnessMode: (scope: string) => read(scope).harnessMode,
    isHarnessMode: (scope: string) => !!read(scope).harness,
    heldHarness: (scope: string) => read(scope).heldFrom ? read(scope).harness : undefined,
    models: (scope: string) => harnessModels(read(scope)),
    selectedModel: (scope: string) => read(scope).selectedModel ?? "",
    selectedModelKey: (scope: string) => harnessModelKeyForSubmit(read(scope)),
    thoughtLevels: (scope: string) => read(scope).thoughtLevels ?? [],
    selectedThoughtLevel: (scope: string) => read(scope).selectedThoughtLevel,
    serviceTiers: (scope: string) => read(scope).serviceTiers ?? [],
    selectedServiceTier: (scope: string) => read(scope).selectedServiceTier,
    harnessModelKeyForSubmit: (scope: string) => harnessModelKeyForSubmit(read(scope)),
    harnessServiceTierForSubmit: (scope: string) => harnessServiceTierForSubmit(read(scope)),
    harnessModelNameForSubmit: (scope: string) => harnessModelNameForSubmit(read(scope)),
    harnessReadyForSubmit: (scope: string) => draftConnectionAllowsNoModel(scope, read(scope)) || harnessReadyForSubmit(read(scope)),
    canOmitModel: (scope: string) => connectionAllowsNoModel(read(scope)),
    canCreateWithoutModel: (scope: string) => draftConnectionAllowsNoModel(scope, read(scope)),
  }
}

export function harnessOptionsReads(read: Read) {
  return {
    optionsSource: (scope: string) => read(scope).optionsSource,
    optionsStale: (scope: string) => read(scope).optionsStale,
    optionsLoading: (scope: string) => read(scope).optionsLoading,
    configError: (scope: string) => read(scope).configError,
    draftDefaultState: (scope: string) => read(scope).draftDefaultState,
    draftDefaultLabels: (scope: string) => read(scope).draftDefault?.labels,
    draftDefaultModel: (scope: string) => read(scope).draftDefault?.model,
    draftDefaultAuthority: (scope: string) => read(scope).draftDefaultAuthority,
  }
}

export function harnessStoreWrites({ seed, setStore, applyPatch }: HarnessScopes) {
  return {
    releaseHeldHarness: (scope: string) => setStore(scope, "heldFrom", undefined),
    setOptionsLoading: (scope: string, value: boolean) => setStore(scope, "optionsLoading", value),
    setReadiness: (scope: string, readiness: HarnessStoreState["readiness"]) => setStore(scope, "readiness", readiness),
    setSelectedModel: (scope: string, model: ModelChoice) => {
      setStore(scope, "selectedModel", model.modelId)
      setStore(scope, "selectedModelProvider", model.providerId)
    },
    setConnectionDeclaration: (scope: string, declaration: HarnessStoreState["connectionDeclaration"]) => {
      seed(scope)
      setStore(scope, "connectionDeclaration", declaration)
    },
    // State only. The level reaches the harness on the NEXT PROMPT via
    // `harnessModelKeyForSubmit`'s `variant`, so there is nothing to push
    // here — the same reason opencode's variant setter is a local write.
    setThoughtLevel: (scope: string, value: string | undefined) => applyPatch(scope, { selectedThoughtLevel: value }),
    setServiceTier: (scope: string, value: string | undefined) => applyPatch(scope, { selectedServiceTier: value }),
  }
}
