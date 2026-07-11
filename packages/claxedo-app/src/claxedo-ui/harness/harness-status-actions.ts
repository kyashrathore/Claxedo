import {
  desiredHarness,
  failedHarness,
  hardFailedHarness,
  type HarnessState,
  type HarnessType,
} from "../../session/harness/profile"
import {
  harnessStatusPatch,
  readyHarnessFallbackPatch,
  readyHarnessHydrationPatch,
  workspaceDraftHarnessResetPatch,
  type HarnessStorePatch,
  type HarnessStoreState,
} from "../../session/harness/store-state"
import {
  shouldFetchConfigOptionsForScope,
  shouldRefreshDirectoryAfterHarnessStatus,
  type HarnessScopeInput,
} from "../../session/harness/store-policy"

type PreferenceKey = "harness" | "model" | "agent"
type HarnessDirectory = NonNullable<HarnessScopeInput["directory"]>

export function createHarnessStatusActions<ScopeInput extends HarnessScopeInput>(input: {
  dropPrepared(scope: string): void
  clearOptionsTries(scope: string): void
  applyPatch(scope: string, patch: HarnessStorePatch): void
  state(scope: string): HarnessStoreState | undefined
  save(scope: string, key: PreferenceKey, value: string): void
  fetchConfigOptions(scope: string, type: HarnessType, params?: ScopeInput): void
  bootstrap(params: { harnessType?: string }): Promise<void>
  ensureDirectory(params: { directory: HarnessDirectory; harnessType?: string; quiet: boolean }): Promise<void>
  refreshDirectory(params: { directory: HarnessDirectory; harnessType?: string }): Promise<void>
}) {
  const resetWorkspaceDraftHarness = (scope: string) => {
    input.dropPrepared(scope)
    input.applyPatch(scope, workspaceDraftHarnessResetPatch())
    input.clearOptionsTries(scope)
    input.save(scope, "harness", "opencode")
    input.save(scope, "model", "")
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
    input.save(scope, "harness", want)
    if (data.model) input.save(scope, "model", data.model)
    if (shouldFetchConfigOptionsForScope(want, hardFailedHarness(data), params)) {
      input.fetchConfigOptions(scope, want, params)
    }
    if (params?.directory && shouldRefreshDirectoryAfterHarnessStatus(params)) {
      await refresh(params.directory, want, { draft: true })
    }
  }

  return {
    applyStatus,
    refresh,
    resetWorkspaceDraftHarness,
    setReadyFallback: (scope: string, type: HarnessType) => input.applyPatch(scope, readyHarnessFallbackPatch(type)),
    setReadyHydration: (scope: string, type: HarnessType) => input.applyPatch(scope, readyHarnessHydrationPatch(type)),
  }
}
