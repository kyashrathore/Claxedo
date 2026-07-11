import {
  decodeHarnessState,
  decodeSessionConfig,
  failedHarness,
  harnessHasConfigOptions,
  type HarnessState,
  type HarnessType,
} from "../../session/harness/profile"
import type { HarnessStoreState } from "../../session/harness/store-state"
import {
  harnessStateFromSessionConfig,
  refreshHarnessTypeForScope,
  shouldFetchConfigOptionsForScope,
  shouldHydrateDraftFromHarnessStatus,
  shouldRefreshDirectoryAfterHarnessStatus,
  shouldResetWorkspaceDraftHarness,
  type HarnessScopeInput,
} from "../../session/harness/store-policy"
import {
  harnessConfigUrl,
  sessionResourceUrl,
} from "./harness-config-routes"

export type HarnessHydratorCache<ScopeInput extends HarnessScopeInput> = {
  getSeen(scope: string): string | undefined
  setSeen(scope: string, key: string): void
  clearSeen(scope: string): void
  getPending(scope: string): Promise<void> | undefined
  setPending(scope: string, value: Promise<void>): void
  removePending(scope: string, value: Promise<void>): void
  fetchSessionConfig(
    params: HydratedSessionInput<ScopeInput>,
    run: () => Promise<unknown>,
  ): Promise<unknown>
}

type HydratedSessionInput<ScopeInput extends HarnessScopeInput> =
  ScopeInput & Required<Pick<HarnessScopeInput, "directory" | "sessionId">>

export function createHarnessHydrator<ScopeInput extends HarnessScopeInput>(input: {
  base: string
  seed(scope: string): void
  state(scope: string): HarnessStoreState | undefined
  resetWorkspaceDraftHarness(scope: string): void
  applyStatus(scope: string, data: HarnessState, params?: ScopeInput): Promise<void>
  setReadyHydration(scope: string, type: HarnessType): void
  setReadyFallback(scope: string, type: HarnessType): void
  fetchConfigOptions(scope: string, type: HarnessType, params?: ScopeInput): void
  refresh(directory?: string, harnessType?: string, opts?: { draft?: boolean }): Promise<void>
  fastSessionSwitchQuiet(params?: ScopeInput): boolean
  workspaceRuntime(params?: ScopeInput): boolean
  runtime: {
    useLocalHarnessConfig(params?: ScopeInput): boolean
    harnessSessionFetch(params?: ScopeInput): typeof fetch
    localHarnessConfigFetch(params?: ScopeInput): typeof fetch
  }
  cache: HarnessHydratorCache<ScopeInput>
}) {
  const status = async (params?: ScopeInput): Promise<HarnessState | undefined> => {
    if (!input.runtime.useLocalHarnessConfig(params) && !input.workspaceRuntime(params)) return undefined
    if (!params?.directory) return undefined
    if (input.fastSessionSwitchQuiet(params)) return undefined
    if (params.sessionId && params.sessionId !== "new") {
      const config = await input.cache.fetchSessionConfig(params as HydratedSessionInput<ScopeInput>, async () => {
        const res = await input.runtime.harnessSessionFetch(params)(
          sessionResourceUrl({
            serverUrl: input.base,
            sessionID: params.sessionId!,
            directory: params.directory!,
            resource: "config",
          }),
        )
        if (!res.ok) return null
        return await res.json().catch(() => null)
      })
      const hit = harnessStateFromSessionConfig(decodeSessionConfig(config))
      if (hit) return hit
    }
    const res = await input.runtime.localHarnessConfigFetch(params)(
      harnessConfigUrl({
        serverUrl: input.base,
        directory: params.directory,
        sessionId: params.sessionId,
      }),
    )
    if (!res.ok) return undefined
    return decodeHarnessState(await res.json())
  }

  const hydrate = async (scope: string, params?: ScopeInput) => {
    input.seed(scope)
    const key = stamp(params)
    const currentHarness = input.state(scope)?.harness ?? "opencode"
    if (shouldResetWorkspaceDraftHarness({
      scope,
      directory: params?.directory,
      sessionId: params?.sessionId,
      harness: currentHarness,
    })) {
      input.resetWorkspaceDraftHarness(scope)
    }
    if (input.cache.getSeen(scope) === key) return
    const pending = input.cache.getPending(scope)
    if (pending) return pending

    const run = (async () => {
      if (!params?.directory) return
      if (!params.sessionId || params.sessionId === "new") {
        const useLocalHarnessConfig = input.runtime.useLocalHarnessConfig(params)
        if (shouldHydrateDraftFromHarnessStatus({
          useLocalHarnessConfig,
          workspaceRuntime: input.workspaceRuntime(params),
        })) {
          const data = await status(params).catch(() => undefined)
          if (data) {
            await applyAndMarkSeen(scope, data, params, key)
            return
          }
        }
        const type = input.state(scope)?.harness ?? "opencode"
        input.setReadyHydration(scope, type)
        if (harnessHasConfigOptions(type)) input.fetchConfigOptions(scope, type, params)
        await input.refresh(params.directory, refreshHarnessTypeForScope({ directory: params.directory, harness: type }), { draft: true })
        input.cache.setSeen(scope, key)
        return
      }
      if (input.fastSessionSwitchQuiet(params)) {
        markReadyFallback(scope, key)
        return
      }
      const data = await status(params).catch(() => undefined)
      if (!data) {
        const fallback = input.state(scope)?.harness ?? "opencode"
        input.setReadyFallback(scope, fallback)
        if (shouldRefreshDirectoryAfterHarnessStatus(params)) {
          await input.refresh(params.directory, refreshHarnessTypeForScope({ directory: params.directory, harness: fallback }), { draft: true })
        }
        input.cache.setSeen(scope, key)
        return
      }
      await applyAndMarkSeen(scope, data, params, key)
    })()

    input.cache.setPending(scope, run)
    return run.finally(() => input.cache.removePending(scope, run))
  }

  const applyAndMarkSeen = async (
    scope: string,
    data: HarnessState,
    params: ScopeInput,
    key: string,
  ) => {
    await input.applyStatus(scope, data, params)
    input.cache.setSeen(scope, key)
  }

  const markReadyFallback = (scope: string, key: string) => {
    input.setReadyFallback(scope, input.state(scope)?.harness ?? "opencode")
    input.cache.setSeen(scope, key)
  }

  // Re-run a single hydration probe for a scope that is still "polling". Hydrate
  // is one-shot (guarded by the per-scope "seen" stamp), so a bounded re-probe
  // must first CLEAR that stamp; otherwise hydrate early-returns and the harness
  // stays Connecting forever. Any probe already in flight is deduped by the
  // pending guard inside `hydrate`, so re-probing never stacks requests.
  const reprobe = async (scope: string, params?: ScopeInput) => {
    input.cache.clearSeen(scope)
    return hydrate(scope, params)
  }

  return {
    hydrate,
    reprobe,
    status,
  }
}

function stamp(input?: HarnessScopeInput) {
  if (input?.sessionId && input.sessionId !== "new") return `session:${input.sessionId}`
  return `${input?.directory ?? ""}\nnew`
}
