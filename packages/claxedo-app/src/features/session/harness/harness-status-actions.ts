import {
  desiredHarness,
  failedHarness,
  hardFailedHarness,
  harnessHasConfigOptions,
  type HarnessState,
  type HarnessType,
} from "./profile"
import {
  harnessStatusPatch,
  pollingHarnessHydrationPatch,
  readyHarnessHydrationPatch,
  workspaceDraftHarnessResetPatch,
  type HarnessStorePatch,
  type HarnessStoreState,
} from "./store-state"
import {
  shouldFetchConfigOptionsForScope,
  shouldRefreshDirectoryAfterHarnessStatus,
  type HarnessScopeInput,
} from "./store-policy"

type HarnessDirectory = NonNullable<HarnessScopeInput["directory"]>

export function createHarnessStatusActions<ScopeInput extends HarnessScopeInput>(input: {
  dropPrepared(scope: string): void
  clearOptionsTries(scope: string): void
  applyPatch(scope: string, patch: HarnessStorePatch): void
  state(scope: string): HarnessStoreState | undefined
  fetchConfigOptions(scope: string, type: HarnessType, params?: ScopeInput): void
  bootstrap(params: { harnessType?: string }): Promise<void>
  ensureDirectory(params: { directory: HarnessDirectory; harnessType?: string; quiet: boolean }): Promise<void>
  refreshDirectory(params: { directory: HarnessDirectory; harnessType?: string }): Promise<void>
}) {
  const resetWorkspaceDraftHarness = (scope: string) => {
    input.dropPrepared(scope)
    input.applyPatch(scope, workspaceDraftHarnessResetPatch())
    input.clearOptionsTries(scope)
  }

  const refresh = async (directory?: HarnessScopeInput["directory"], harnessType?: string, opts?: { draft?: boolean }) => {
    if (!directory) {
      await input.bootstrap({ harnessType })
      return
    }
    if (opts?.draft) {
      await input.ensureDirectory({
        directory,
        harnessType,
        quiet: true,
      })
      return
    }
    await input.refreshDirectory({
      directory,
      harnessType,
    })
  }

  const applyStatus = async (scope: string, data: HarnessState, params?: ScopeInput) => {
    const current = input.state(scope)
    const want = desiredHarness(data) ?? input.state(scope)?.harness ?? "opencode"
    // Skip a failed status only when the user has confirmed a *different* real
    // harness. The store seeds `harness: "opencode"` before any confirmation,
    // so the seed must NOT be treated as a deliberate selection — otherwise a
    // failed status for the harness this scope is actually configured with is
    // silently swallowed, leaving submit unblocked with no error dot
    // (core-harness-ownership-local). applyStatus only runs during hydration
    // (no external callers), so a confirmed non-opencode selection is the only
    // thing worth protecting here.
    if (failedHarness(data) && current?.harness && current.harness !== "opencode" && want !== current.harness) return
    input.applyPatch(scope, harnessStatusPatch({ data, current }))
    if (shouldFetchConfigOptionsForScope(want, hardFailedHarness(data), params)) {
      input.fetchConfigOptions(scope, want, params)
    } else if (harnessHasConfigOptions(want) && hardFailedHarness(data)) {
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
    }
    if (params?.directory && shouldRefreshDirectoryAfterHarnessStatus(params)) {
      await refresh(params.directory, want, { draft: true })
    }
  }

  return {
    applyStatus,
    refresh,
    resetWorkspaceDraftHarness,
    setPollingHydration: (scope: string, type?: HarnessType) => input.applyPatch(scope, pollingHarnessHydrationPatch(type)),
    setReadyHydration: (scope: string, type: HarnessType) => input.applyPatch(scope, readyHarnessHydrationPatch(type)),
  }
}
