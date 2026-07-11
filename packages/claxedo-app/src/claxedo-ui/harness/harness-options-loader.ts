import { applyHarnessOptionsResponse, type HarnessOptionsStatePatch } from "../../session-client/harness/options-state"
import { optionsResponse, type HarnessType, type OptionsResponse } from "../../session-client/harness/profile"

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
  seed(scope: string): void
  applyPatch(scope: string, patch: HarnessOptionsStatePatch): void
  saveModel(scope: string, model: string): void
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
    input.setOptionsLoading(scope, true)
    try {
      const res = await input.fetch(type, params)
      if (!res.ok) {
        if (input.cache.getSeq(scope) !== id) return undefined
        input.cache.clearTries(scope)
        input.applyPatch(scope, {
          dynamicModels: [],
          optionsSource: "empty",
          optionsStale: true,
          optionsLoading: false,
          configError: await input.errorMessage(res, "Failed to load model options"),
        })
        return undefined
      }

      const payload = optionsResponse(await res.json())
      if (input.cache.getSeq(scope) !== id || input.currentHarness(scope) !== type) return undefined

      const tries = input.cache.getTries(scope) ?? 0
      const decision = applyHarnessOptionsResponse({
        type,
        selectedModel: input.selectedModel(scope),
        payload,
        tries,
      })
      if (decision.clearTries) input.cache.clearTries(scope)
      input.applyPatch(scope, decision.patch)
      if (decision.saveModel) input.saveModel(scope, decision.saveModel)
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
      if (input.cache.getSeq(scope) !== id) return undefined
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
