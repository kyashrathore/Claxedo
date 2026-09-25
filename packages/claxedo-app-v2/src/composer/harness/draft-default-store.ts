import type { ModelChoice } from "@/server"
import { sameHarnessSelection } from "@/lib/harness-selection"
import { resolveDraftDefault, shouldApplyDraftDefault, type DraftDefaultApplication, type ResolveDraftDefaultInput } from "./draft-default-policy"
import type { createDraftDefaultPreferences, DraftDefaultLabels, DraftDefaultScope } from "./draft-defaults"
import type { HarnessScopes } from "./harness-scopes"
import { harnessHasConfigOptions, isCatalogHarness, type HarnessType } from "./profile"
import type { HarnessStorePatch, HarnessStoreState } from "./store-state"

export type DraftDefaultContext = { readonly scopes: HarnessScopes; readonly memory: ReturnType<typeof createDraftDefaultPreferences> }
type WorkspaceIdentity = Omit<DraftDefaultScope, "fallbackWorkspaceKey">

function owner(scopes: HarnessScopes, scope: string) {
  const state = scopes.read(scope)
  return {
    authority: state.draftDefaultAuthority ?? (scope.startsWith("session:") ? "server" : "unresolved"),
    revision: state.draftDefaultRevision ?? 0,
    scope,
    workspaceKey: state.draftDefaultWorkspaceKey ?? "",
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
  if (current.draftDefaultWorkspaceKey === identity.workspaceKey) {
    return { application: owner(scopes, scope), saved: current.draftDefault }
  }
  const revision = (current.draftDefaultRevision ?? 0) + 1
  const saved = memory.read(identity)
  const type = saved?.harness
  scopes.setStore(scope, {
    draftDefaultAuthority: "unresolved",
    draftDefaultRevision: revision,
    draftDefaultServerUrl: identity.serverUrl,
    draftDefaultWorkspaceKey: identity.workspaceKey,
    draftDefault: saved,
    draftDefaultState: undefined,
    harness: type,
    harnessMode: type ? "harness" : "unknown",
    selectedModel: saved?.model?.modelId ?? "",
    selectedModelProvider: saved?.model?.providerId,
    optionsLoading: !!saved && !!type && harnessHasConfigOptions(type),
    configError: saved ? "Loading model options..." : undefined,
  })
  return { application: { scope, workspaceKey: identity.workspaceKey, revision }, saved }
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
    !current.draftDefaultWorkspaceKey
  ) return undefined
  return { scope, workspaceKey: current.draftDefaultWorkspaceKey, revision: current.draftDefaultRevision ?? 0 }
}

/**
 * Whether a fresh options answer must keep this scope's model instead of
 * replacing it with the harness's own.
 *
 * Only a model the USER chose is held: `draftDefault.model` is the choice
 * this scope descends from, so it covers both a choice made here and one
 * restored from the workspace's memory, including the choice a shrunken
 * catalog no longer offers — that one has to stay selected for
 * "Saved model unavailable" to name it. A model the harness resolved is a
 * default, not a choice: every load may answer it afresh, and a catalog that
 * drops it simply resolves the next default rather than accusing the user of
 * selecting a model that is gone.
 */
export function protectDraftModel(scopes: HarnessScopes, scope: string) {
  const current = scopes.read(scope)
  const authority = current.draftDefaultAuthority
  return (authority === "defaulted" || authority === "explicit") && !!current.draftDefault?.model
}

/**
 * What it means for this draft to be on harness `type`: `type` plus the
 * choice `type` OWNS here, and nothing else.
 *
 * A harness switch is a choice of HARNESS, never of model. The live selection
 * belongs to the harness being left, and the model the incoming harness
 * resolves for itself is a default — so a harness the user has never picked a
 * model for carries no model, its draft state stays unsettled until the
 * options load resolves one, and the resolved default is shown afresh every
 * time rather than filed as something the user chose.
 */
function draftHarnessChoicePatch({ scopes, memory }: DraftDefaultContext, scope: string, identity: WorkspaceIdentity, type: HarnessType) {
  const choice = memory.readHarness(identity, type)
  return {
    choice,
    patch: {
      draftDefaultAuthority: "explicit",
      draftDefaultRevision: (scopes.read(scope).draftDefaultRevision ?? 0) + 1,
      draftDefaultServerUrl: identity.serverUrl,
      draftDefaultWorkspaceKey: identity.workspaceKey,
      draftDefault: { harness: type, ...choice },
      draftDefaultState: choice?.model || !harnessHasConfigOptions(type) ? "ready" : undefined,
      configError: undefined,
    } satisfies HarnessStorePatch,
  }
}

/** The user's switch to `type` landed: this workspace now opens drafts on it. */
export function rememberDraftHarness(context: DraftDefaultContext, scope: string, identity: WorkspaceIdentity, type: HarnessType, save: boolean) {
  context.scopes.seed(scope)
  const { choice, patch } = draftHarnessChoicePatch(context, scope, identity, type)
  const persisted = save && context.memory.save(identity, { harness: type, ...choice })
  // The switch flow already put the selection where it belongs; only the
  // remembered pair is this call's business.
  context.scopes.setStore(scope, patch)
  return persisted
}

/**
 * The user picked `type` for this draft: restore what THAT harness last used
 * here. Each harness owns its own slot, so switching away and back returns to
 * the model it was on instead of "Choose a model".
 */
export function beginDraftHarnessChoice(context: DraftDefaultContext, scope: string, identity: WorkspaceIdentity, type: HarnessType) {
  context.scopes.seed(scope)
  const { choice, patch } = draftHarnessChoicePatch(context, scope, identity, type)
  context.scopes.setStore(scope, { ...patch, selectedModel: choice?.model?.modelId ?? "", selectedModelProvider: choice?.model?.providerId })
}

export function rememberDraftModel(
  { scopes, memory }: DraftDefaultContext,
  scope: string,
  identity: WorkspaceIdentity,
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
    draftDefaultServerUrl: identity.serverUrl,
    draftDefaultWorkspaceKey: identity.workspaceKey,
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
