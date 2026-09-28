import { ServerError, type HarnessOptions } from "@/server"
import { applyHarnessOptionsResponse, type HarnessOptionsDecision, type HarnessOptionsStatePatch } from "./options-state"
import { harnessSelectionId, type HarnessType } from "./profile"
import { sameHarnessSelection } from "@/lib/harness-selection"
import type { DraftDefaultApplication, ResolveDraftDefaultInput } from "./draft-default-policy"

export type HarnessOptionsLoaderCache = {
  nextSeq(scope: string): number
  getSeq(scope: string): number | undefined
}

type LoaderInput<ScopeInput> = {
  fetch(type: HarnessType, params?: ScopeInput, model?: string): Promise<HarnessOptions>
  currentHarness(scope: string): HarnessType | undefined
  selectedModel(scope: string): string | undefined
  modelOptional?(scope: string): boolean
  preserveSelectedModel?(scope: string): boolean
  sessionModel?(scope: string): boolean
  selectedThoughtLevel?(scope: string): string | undefined
  seed(scope: string): void
  applyPatch(scope: string, patch: HarnessOptionsStatePatch): void
  draftDefaultApplication?(scope: string, type: HarnessType): DraftDefaultApplication | undefined
  resolveDraftDefault?(application: DraftDefaultApplication, input: Omit<ResolveDraftDefaultInput, "saved">): boolean
  setOptionsLoading(scope: string, value: boolean): void
  readState?(scope: string): { readiness?: string; configError?: string } | undefined
  cache: HarnessOptionsLoaderCache
}

type Request = { readonly scope: string; readonly type: HarnessType; readonly id: number; readonly draftDefault?: DraftDefaultApplication }

export function createHarnessOptionsLoader<ScopeInput>(input: LoaderInput<ScopeInput>) {
  const load = async (scope: string, type: HarnessType, params?: ScopeInput): Promise<HarnessOptions | undefined> => {
    input.seed(scope)
    const request: Request = { scope, type, id: input.cache.nextSeq(scope), draftDefault: input.draftDefaultApplication?.(scope, type) }
    input.setOptionsLoading(scope, true)
    const superseded = () => input.cache.getSeq(scope) !== request.id || !sameHarnessSelection(input.currentHarness(scope), type)
    try {
      const payload = await input.fetch(type, params, input.selectedModel(scope) || undefined)
      if (superseded()) return abandonOptionsRequest(input, request)
      applyOptions(input, request, payload)
      return payload
    } catch (error) {
      if (superseded()) return abandonOptionsRequest(input, request)
      input.applyPatch(scope, {
        dynamicModels: [],
        selectedModel: "",
        optionsSource: "empty",
        optionsStale: true,
        optionsLoading: false,
        configError: error instanceof ServerError && error.status !== undefined ? error.message : "Failed to load model options",
      })
      return undefined
    }
  }
  return { load }
}

function abandonOptionsRequest<ScopeInput>(input: LoaderInput<ScopeInput>, request: Request) {
  if (input.cache.getSeq(request.scope) === request.id) input.setOptionsLoading(request.scope, false)
  return undefined
}

function applyOptions<ScopeInput>(input: LoaderInput<ScopeInput>, request: Request, payload: HarnessOptions) {
  const { scope, type } = request
  const decision = applyHarnessOptionsResponse({
    type,
    selectedModel: input.selectedModel(scope),
    selectedThoughtLevel: input.selectedThoughtLevel?.(scope),
    modelOptional: input.modelOptional?.(scope),
    preserveSelectedModel: input.preserveSelectedModel?.(scope),
    sessionModel: input.sessionModel?.(scope),
    payload,
  })
  const current = input.readState?.(scope)
  if (current?.readiness === "error" && current.configError && decision.patch.configError === undefined) {
    input.setOptionsLoading(scope, false)
    return
  }
  const resolvingDefault = request.draftDefault && input.resolveDraftDefault ? request.draftDefault : undefined
  input.applyPatch(scope, resolvingDefault ? withoutSelection(decision.patch, payload.stale) : decision.patch)
  if (resolvingDefault && !payload.stale) requestDraftDefault(input, resolvingDefault, type, decision)
}

function requestDraftDefault<ScopeInput>(input: LoaderInput<ScopeInput>, application: DraftDefaultApplication, type: HarnessType, decision: HarnessOptionsDecision) {
  const providerId = harnessSelectionId(type)
  input.resolveDraftDefault?.(application, {
    supportedHarnesses: [type],
    eligibleModels: (decision.patch.dynamicModels ?? []).map((model) => ({ providerId, modelId: model.id })),
    ...(decision.patch.selectedModel ? { declaredDefaultModel: { providerId, modelId: decision.patch.selectedModel } } : {}),
  })
}

function withoutSelection(patch: HarnessOptionsStatePatch, keepError: boolean): HarnessOptionsStatePatch {
  const result = { ...patch }
  delete result.selectedModel
  if (!keepError) delete result.configError
  return result
}
