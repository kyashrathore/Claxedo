import type { ModelChoice } from "@/server"
import { sameHarnessSelection } from "@/lib/harness-selection"
import { resolveDraftDefault, shouldApplyDraftDefault, type DraftDefaultApplication, type ResolveDraftDefaultInput } from "./draft-default-policy"
import type { createDraftDefaultPreferences, DraftDefaultLabels, DraftDefaultScope } from "./draft-defaults"
import type { HarnessScopes } from "./harness-scopes"
import { harnessHasConfigOptions, isCatalogHarness, type HarnessType } from "./profile"
import type { HarnessStorePatch, HarnessStoreState } from "./store-state"

export type DraftDefaultContext = { readonly scopes: HarnessScopes; readonly memory: ReturnType<typeof createDraftDefaultPreferences> }

function owner(scopes: HarnessScopes, scope: string) {
  const state = scopes.read(scope)
  return {
    authority: state.draftDefaultAuthority ?? (scope.startsWith("session:") ? "server" : "unresolved"),
    revision: state.draftDefaultRevision ?? 0,
    scope,
    placementId: state.draftDefaultPlacementId,
  }
}

export function promote(scopes: HarnessScopes, from: string, to: string) {
  scopes.seed(from)
  scopes.setStore(to, {
    ...scopes.read(from),
    draftDefaultAuthority: "server",
    draftDefaultRevision: (scopes.read(from).draftDefaultRevision ?? 0) + 1,
  })
}

export function beginDraftDefault({ scopes, memory }: DraftDefaultContext, scope: string, identity: DraftDefaultScope) {
  scopes.seed(scope)
  const current = scopes.read(scope)
  if (current.draftDefaultAuthority === "server") return undefined
  if (current.draftDefaultPlacementId === identity.placementId) {
    return { application: { scope, placementId: identity.placementId, revision: current.draftDefaultRevision ?? 0 }, saved: current.draftDefault }
  }
  const revision = (current.draftDefaultRevision ?? 0) + 1
  const saved = memory.read(identity)
  const type = saved?.harness
  scopes.setStore(scope, {
    draftDefaultAuthority: "unresolved",
    draftDefaultRevision: revision,
    draftDefaultPlacementId: identity.placementId,
    draftDefault: saved,
    draftDefaultState: undefined,
    harness: type,
    harnessMode: type ? "harness" : "unknown",
    selectedModel: saved?.model?.modelId ?? "",
    selectedModelProvider: saved?.model?.providerId,
    optionsLoading: !!saved && !!type && harnessHasConfigOptions(type),
    configError: saved ? "Loading model options..." : undefined,
  })
  return { application: { scope, placementId: identity.placementId, revision }, saved }
}

export function applyDraftDefault(scopes: HarnessScopes, application: DraftDefaultApplication, input: Omit<ResolveDraftDefaultInput, "saved">) {
  const saved = scopes.read(application.scope).draftDefault
  if (!shouldApplyDraftDefault(application, owner(scopes, application.scope)) || !saved) return false
  const result = resolveDraftDefault({ ...input, saved })
  const model = result.model ?? result.blockedModel
  scopes.setStore(application.scope, {
    harness: result.harness,
    harnessMode: "harness",
    selectedModel: model?.modelId ?? "",
    selectedModelProvider: model?.providerId,
    optionsLoading: false,
    configError: result.state === "saved-model-unavailable"
      ? "Saved model unavailable"
      : result.state === "choose-model"
        ? "Choose a model"
        : undefined,
    draftDefaultAuthority: "defaulted",
    draftDefaultState: result.state,
  })
  return true
}

export function markServer(scopes: HarnessScopes, scope: string) {
  scopes.seed(scope)
  scopes.setStore(scope, {
    draftDefaultAuthority: "server",
    draftDefaultRevision: (scopes.read(scope).draftDefaultRevision ?? 0) + 1,
    draftDefault: undefined,
    draftDefaultState: undefined,
    configError: undefined,
  })
}

export function draftDefaultApplication(scopes: HarnessScopes, scope: string, type: HarnessType) {
  const current = scopes.read(scope)
  if (
    (current.draftDefaultAuthority ?? "unresolved") !== "unresolved" ||
    !sameHarnessSelection(current.draftDefault?.harness, type) ||
    !current.draftDefaultPlacementId
  ) return undefined
  return { scope, placementId: current.draftDefaultPlacementId, revision: current.draftDefaultRevision ?? 0 }
}

export function protectDraftModel(scopes: HarnessScopes, scope: string) {
  const current = scopes.read(scope)
  const authority = current.draftDefaultAuthority
  return (authority === "defaulted" || authority === "explicit") && !!current.draftDefault?.model
}

function draftHarnessChoicePatch({ scopes, memory }: DraftDefaultContext, scope: string, identity: DraftDefaultScope, type: HarnessType) {
  const choice = memory.readHarness(identity, type)
  return {
    choice,
    patch: {
      draftDefaultAuthority: "explicit",
      draftDefaultRevision: (scopes.read(scope).draftDefaultRevision ?? 0) + 1,
      draftDefaultPlacementId: identity.placementId,
      draftDefault: { harness: type, ...choice },
      draftDefaultState: choice?.model || !harnessHasConfigOptions(type) ? "ready" : undefined,
      configError: undefined,
    } satisfies HarnessStorePatch,
  }
}

export function rememberDraftHarness(context: DraftDefaultContext, scope: string, identity: DraftDefaultScope, type: HarnessType, save: boolean) {
  context.scopes.seed(scope)
  const { choice, patch } = draftHarnessChoicePatch(context, scope, identity, type)
  const persisted = save && context.memory.save(identity, { harness: type, ...choice })
  context.scopes.setStore(scope, patch)
  return persisted
}

export function beginDraftHarnessChoice(context: DraftDefaultContext, scope: string, identity: DraftDefaultScope, type: HarnessType) {
  context.scopes.seed(scope)
  const { choice, patch } = draftHarnessChoicePatch(context, scope, identity, type)
  context.scopes.setStore(scope, { ...patch, selectedModel: choice?.model?.modelId ?? "", selectedModelProvider: choice?.model?.providerId })
}

export function rememberDraftModel(
  { scopes, memory }: DraftDefaultContext,
  scope: string,
  identity: DraftDefaultScope,
  model: ModelChoice,
  labels: DraftDefaultLabels | undefined,
  save: boolean,
) {
  scopes.seed(scope)
  const current = scopes.read(scope)
  if (!current.harness || !canSelectDraftModel(current, model)) return false
  const draftDefault = { harness: current.harness, model, ...(labels ? { labels } : {}) }
  const persisted = save && memory.save(identity, draftDefault)
  scopes.setStore(scope, {
    draftDefaultAuthority: "explicit",
    draftDefaultRevision: (current.draftDefaultRevision ?? 0) + 1,
    draftDefaultPlacementId: identity.placementId,
    draftDefault,
    draftDefaultState: "ready",
    configError: undefined,
  })
  return persisted
}

export function canSelectDraftModel(state: HarnessStoreState, model: ModelChoice) {
  if (!state.harness) return false
  if (isCatalogHarness(state.harness) || state.harness.kind === "connection") return true
  return model.providerId === state.harness.harnessId && !!state.dynamicModels?.some((item) => item.id === model.modelId)
}
