import { applyHarnessOptionsResponse, type HarnessOptionsStatePatch } from "./options-state"
import { harnessSelectionId, optionsResponse, type HarnessType, type OptionsResponse } from "./profile"
import { sameHarnessSelection } from "@/platform/identity/harness-selection"
import type { DraftDefaultApplication, ResolveDraftDefaultInput } from "./draft-default-policy"

export type HarnessOptionsLoaderCache = {
  nextSeq(scope: string): number
  getSeq(scope: string): number | undefined
  getTries(scope: string): number | undefined
  setTries(scope: string, value: number): void
  clearTries(scope: string): void
}

type HarnessOptionsTimer = ReturnType<typeof setTimeout> | undefined

export function createHarnessOptionsLoader<ScopeInput>(input: {
  fetch(type: HarnessType, params?: ScopeInput): Promise<Response>
  currentHarness(scope: string): HarnessType | undefined
  selectedModel(scope: string): string | undefined
  modelOptional?(scope: string): boolean
  preserveSelectedModel?(scope: string): boolean
  seed(scope: string): void
  applyPatch(scope: string, patch: HarnessOptionsStatePatch): void
  draftDefaultApplication?(scope: string, type: HarnessType): DraftDefaultApplication | undefined
  resolveDraftDefault?(
    application: DraftDefaultApplication,
    input: Omit<ResolveDraftDefaultInput, "saved">,
  ): boolean
  setOptionsLoading(scope: string, value: boolean): void
  readState?(scope: string): { readiness?: string; configError?: string } | undefined
  errorMessage(res: Response, fallback: string): Promise<string>
  // Arrow properties, not methods: both are passed around as bare references
  // below (`input.clearRetry ?? clearTimeout`), which is only sound for a
  // function that carries no `this`.
  scheduleRetry?: (run: () => void) => HarnessOptionsTimer
  clearRetry?: (timer: HarnessOptionsTimer) => void
  cache: HarnessOptionsLoaderCache
}) {
  const optionTimers = new Map<string, HarnessOptionsTimer>()

  const clearTimer = (scope: string) => {
    const timer = optionTimers.get(scope)
    if (timer !== undefined) (input.clearRetry ?? ((handle) => clearTimeout(handle)))(timer)
    optionTimers.delete(scope)
  }

  const load = async (
    scope: string,
    type: HarnessType,
    params?: ScopeInput,
  ): Promise<OptionsResponse | undefined> => {
    input.seed(scope)
    clearTimer(scope)
    const id = input.cache.nextSeq(scope)
    const draftDefault = input.draftDefaultApplication?.(scope, type)
    input.setOptionsLoading(scope, true)
    /**
     * A load whose result is no longer wanted still has to release the loading
     * flag it raised: the model control renders "Loading models" straight off
     * `optionsLoading` with no other exit, so a harness switch that outran its
     * own in-flight request would leave the control stuck there for the life of
     * the scope.
     *
     * The seq check is what makes that safe. When a NEWER load has taken the
     * scope it raised the flag for itself and owns it until its own request
     * settles; clearing here would drop the control out of its loading state
     * while that request is still running.
     */
    const abandon = () => {
      if (input.cache.getSeq(scope) === id) input.setOptionsLoading(scope, false)
      return undefined
    }
    const superseded = () => input.cache.getSeq(scope) !== id || !sameHarnessSelection(input.currentHarness(scope), type)
    try {
      const res = await input.fetch(type, params)
      if (!res.ok) {
        if (superseded()) return abandon()
        const configError = await input.errorMessage(res, "Failed to load model options")
        if (superseded()) return abandon()
        input.cache.clearTries(scope)
        input.applyPatch(scope, {
          dynamicModels: [],
          selectedModel: "",
          optionsSource: "empty",
          optionsStale: true,
          optionsLoading: false,
          configError,
        })
        return undefined
      }

      const payload = optionsResponse(await res.json())
      if (superseded()) return abandon()

      const tries = input.cache.getTries(scope) ?? 0
      const decision = applyHarnessOptionsResponse({
        type,
        selectedModel: input.selectedModel(scope),
        modelOptional: input.modelOptional?.(scope),
        preserveSelectedModel: input.preserveSelectedModel?.(scope),
        payload,
        tries,
      })
      if (decision.clearTries) input.cache.clearTries(scope)
      const resolvingDefault = !!draftDefault && !!input.resolveDraftDefault
      const current = input.readState?.(scope)
      if (current?.readiness === "error" && current.configError && decision.patch.configError === undefined) {
        input.setOptionsLoading(scope, false)
        return payload
      }
      input.applyPatch(scope, resolvingDefault
        ? withoutSelection(decision.patch, payload.stale)
        : decision.patch)
      if (resolvingDefault && !payload.stale) {
        const eligibleModels = (decision.patch.dynamicModels ?? []).map((model) => ({
          providerID: harnessSelectionId(type),
          modelID: model.id,
        }))
        input.resolveDraftDefault!(draftDefault, {
          supportedHarnesses: [type],
          eligibleModels,
          ...(decision.patch.selectedModel
            ? { declaredDefaultModel: { providerID: harnessSelectionId(type), modelID: decision.patch.selectedModel } }
            : {}),
        })
      }
      if (decision.retry) {
        input.cache.setTries(scope, tries + 1)
        optionTimers.set(
          scope,
          (input.scheduleRetry ?? ((run) => setTimeout(run, 1000)))(() => {
            if (input.cache.getSeq(scope) !== id || !sameHarnessSelection(input.currentHarness(scope), type)) return
            void load(scope, type, params)
          }),
        )
      }
      return payload
    } catch {
      if (superseded()) return abandon()
      input.cache.clearTries(scope)
      input.applyPatch(scope, {
        dynamicModels: [],
        selectedModel: "",
        optionsSource: "empty",
        optionsStale: true,
        optionsLoading: false,
        configError: "Failed to load model options",
      })
      return undefined
    }
  }

  return {
    load,
  }
}

function withoutSelection(patch: HarnessOptionsStatePatch, keepError: boolean): HarnessOptionsStatePatch {
  const result = { ...patch }
  delete result.selectedModel
  if (!keepError) delete result.configError
  return result
}
