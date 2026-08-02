import { applyHarnessOptionsResponse, type HarnessOptionsStatePatch } from "./options-state"
import { optionsResponse, type HarnessType, type OptionsResponse } from "./profile"
import type { ModelKey } from "@/features/session/composer/model-strategy"
import type { DraftDefaultApplication, ResolveDraftDefaultInput } from "./draft-default-policy"
import type { DraftDefaultLabels } from "./draft-defaults"

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
  preserveSelectedModel?(scope: string): boolean
  seed(scope: string): void
  applyPatch(scope: string, patch: HarnessOptionsStatePatch): void
  saveModel(scope: string, model: string): void
  draftDefaultApplication?(scope: string, type: HarnessType): DraftDefaultApplication | undefined
  resolveDraftDefault?(
    application: DraftDefaultApplication,
    input: Omit<ResolveDraftDefaultInput, "saved">,
  ): boolean
  completeRememberedHarness?(scope: string, type: HarnessType, model?: ModelKey, labels?: DraftDefaultLabels): boolean
  setOptionsLoading(scope: string, value: boolean): void
  errorMessage(res: Response, fallback: string): Promise<string>
  scheduleRetry?(run: () => void): HarnessOptionsTimer
  clearRetry?(timer: HarnessOptionsTimer): void
  cache: HarnessOptionsLoaderCache
}) {
  const optionTimers = new Map<string, HarnessOptionsTimer>()

  const clearTimer = (scope: string) => {
    const timer = optionTimers.get(scope)
    if (timer !== undefined) (input.clearRetry ?? clearTimeout)(timer)
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
     * A load whose result is no longer wanted — the scope moved to another
     * harness, or a newer load superseded this one — must still release the
     * loading flag it raised. It previously just returned, and since the model
     * control renders "Loading models" straight off `optionsLoading` with no
     * other exit, a switch that outran its own in-flight request left the
     * control stuck there for the life of the scope (caught by Tier R's
     * `real-harness-local`). Releasing the flag is safe even when someone else
     * now owns the scope: the winning load raised it again on its own entry,
     * and whatever it resolves to writes the authoritative value after this.
     */
    const abandon = () => {
      input.setOptionsLoading(scope, false)
      return undefined
    }
    const superseded = () => input.cache.getSeq(scope) !== id || input.currentHarness(scope) !== type
    try {
      const res = await input.fetch(type, params)
      if (!res.ok) {
        if (superseded()) return abandon()
        const configError = await input.errorMessage(res, "Failed to load model options")
        if (superseded()) return abandon()
        input.cache.clearTries(scope)
        input.applyPatch(scope, {
          dynamicModels: [],
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
        preserveSelectedModel: input.preserveSelectedModel?.(scope),
        payload,
        tries,
      })
      if (decision.clearTries) input.cache.clearTries(scope)
      const resolvingDefault = !!draftDefault && !!input.resolveDraftDefault
      input.applyPatch(scope, resolvingDefault ? withoutSelection(decision.patch, payload.stale) : decision.patch)
      if (!resolvingDefault && decision.saveModel) input.saveModel(scope, decision.saveModel)
      if (resolvingDefault && !payload.stale) {
        const eligibleModels = (decision.patch.dynamicModels ?? []).map((model) => ({
          providerID: type,
          modelID: model.id,
        }))
        input.resolveDraftDefault!(draftDefault, {
          supportedHarnesses: ["opencode", type],
          eligibleModels,
          ...(decision.patch.selectedModel
            ? { declaredDefaultModel: { providerID: type, modelID: decision.patch.selectedModel } }
            : {}),
        })
      }
      if (!payload.stale) {
        const resolvedModel = decision.patch.selectedModel &&
          decision.patch.dynamicModels?.some((model) => model.id === decision.patch.selectedModel)
          ? { providerID: type, modelID: decision.patch.selectedModel }
          : undefined
        input.completeRememberedHarness?.(
          scope,
          type,
          resolvedModel,
          resolvedModel
            ? { provider: type, model: decision.patch.dynamicModels?.find((item) => item.id === resolvedModel.modelID)?.name ?? resolvedModel.modelID }
            : undefined,
        )
      }
      if (decision.retry) {
        input.cache.setTries(scope, tries + 1)
        optionTimers.set(
          scope,
          (input.scheduleRetry ?? ((run) => setTimeout(run, 1000)))(() => {
            if (input.cache.getSeq(scope) !== id || input.currentHarness(scope) !== type) return
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
