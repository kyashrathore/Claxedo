import type { HarnessState } from "@/server"
import {
  failedHarness,
  hardFailedHarness,
  harnessHasConfigOptions,
  type HarnessType,
} from "./profile"
import {
  harnessStatusPatch,
  pollingHarnessHydrationPatch,
  readyHarnessHydrationPatch,
  type HarnessStorePatch,
  type HarnessStoreState,
} from "./store-state"
import {
  shouldFetchConfigOptionsForScope,
  type HarnessScopeInput,
} from "./store-policy"
import { sameHarnessSelection } from "@/lib/harness-selection"

type StatusInput<ScopeInput extends HarnessScopeInput> = {
  applyPatch(scope: string, patch: HarnessStorePatch): void
  state(scope: string): HarnessStoreState | undefined
  fetchConfigOptions(scope: string, type: HarnessType, params?: ScopeInput): Promise<unknown> | void
  hasConfigOptions?(type: HarnessType): Promise<boolean>
}

export function createHarnessStatusActions<ScopeInput extends HarnessScopeInput>(input: StatusInput<ScopeInput>) {
  return {
    applyStatus: (scope: string, data: HarnessState, params?: ScopeInput) => applyStatus(input, scope, data, params),
    setPollingHydration: (scope: string, type?: HarnessType) => input.applyPatch(scope, pollingHarnessHydrationPatch(type)),
    setReadyHydration: (scope: string, type: HarnessType, hasConfigOptions?: boolean) =>
      input.applyPatch(scope, readyHarnessHydrationPatch(type, hasConfigOptions)),
  }
}

async function applyStatus<ScopeInput extends HarnessScopeInput>(input: StatusInput<ScopeInput>, scope: string, data: HarnessState, params?: ScopeInput) {
  const current = input.state(scope)
  const want = data.type ?? current?.harness
  // A failed status for another confirmed selection must not overwrite the
  // current harness. With no confirmed selection, the runtime response is the
  // authority for this hydration.
  if (want && failedHarness(data) && current?.harness && !sameHarnessSelection(want, current.harness)) return
  input.applyPatch(scope, harnessStatusPatch({ data, current }))
  if (!want) return
  let hasConfigOptions: boolean
  try {
    hasConfigOptions = input.hasConfigOptions ? await input.hasConfigOptions(want) : harnessHasConfigOptions(want)
  } catch (error) {
    input.applyPatch(scope, { configError: error instanceof Error ? error.message : "Failed to load connection capabilities", readiness: "error", optionsLoading: false })
    return
  }
  await settleStatusOptions(input, { scope, want, data, params, hasConfigOptions })
}

async function settleStatusOptions<ScopeInput extends HarnessScopeInput>(
  input: StatusInput<ScopeInput>,
  status: { readonly scope: string; readonly want: HarnessType; readonly data: HarnessState; readonly params?: ScopeInput; readonly hasConfigOptions: boolean },
) {
  const { scope, want, data, params, hasConfigOptions } = status
  if (hasConfigOptions && shouldFetchConfigOptionsForScope(want, hardFailedHarness(data), params)) {
    await input.fetchConfigOptions(scope, want, params)
  } else if (hasConfigOptions && hardFailedHarness(data)) {
    // A HARD-FAILED harness that has config options is the one case where the
    // flag can strand: `shouldFetchConfigOptionsForScope` declines the fetch,
    // and `harnessStatusPatch` does not touch `optionsLoading`, so a flag
    // raised earlier (by a switch, or by the store's seed for a scope with a
    // saved harness) is never lowered and the model control renders "Loading
    // models" behind the error state forever.
    //
    // Deliberately NOT an unconditional `else`: that also fires for
    // `opencode` (no config options), which reaches this line on ordinary
    // hydrations while a legitimate load may be in flight — clearing the
    // flag there races the real fetch and flickers the harness through a
    // false "no models" state.
    input.applyPatch(scope, { optionsLoading: false })
  } else if (!hasConfigOptions && !hardFailedHarness(data)) {
    input.applyPatch(scope, readyHarnessHydrationPatch(want, false))
  }
}
