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
    input.applyPatch(scope, { optionsLoading: false })
  } else if (!hasConfigOptions && !hardFailedHarness(data)) {
    input.applyPatch(scope, readyHarnessHydrationPatch(want, false))
  }
}
