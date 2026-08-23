import {
  decodeHarnessState,
  decodeSessionConfig,
  failedHarness,
  harnessHasConfigOptions,
  type HarnessState,
  type HarnessType,
} from "./profile"
import type { HarnessStoreState } from "./store-state"
import type { DraftDefault } from "./draft-defaults"
import type { DraftDefaultApplication } from "./draft-default-policy"
import {
  harnessStateFromSessionConfig,
  refreshHarnessTypeForScope,
  shouldFetchConfigOptionsForScope,
  shouldHydrateDraftFromHarnessStatus,
  shouldRefreshDirectoryAfterHarnessStatus,
  type HarnessScopeInput,
} from "./store-policy"
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
  beginDraftDefault?(scope: string, params?: ScopeInput): {
    application: DraftDefaultApplication
    saved?: DraftDefault
  } | undefined
  markServer?(scope: string): void
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
    workspaceKind?(params?: ScopeInput): "local" | "cloud" | "user-hosted" | null | undefined
    harnessSessionFetch(params?: ScopeInput): typeof fetch
    localHarnessConfigFetch(params?: ScopeInput): typeof fetch
  }
  cache: HarnessHydratorCache<ScopeInput>
}) {
  const generations = new Map<string, number>()
  const pendingByScope = new Map<string, { key: string; run: Promise<void> }>()
  let nextGeneration = 0

  const status = async (params?: ScopeInput): Promise<HarnessState | undefined> => {
    // A central SessionRef is itself a runtime route. It deliberately has no
    // local/workspace runtime classification, but harnessSessionFetch maps its
    // session resource request through the central runtime API.
    if (
      params?.sessionRef?.host !== "central" &&
      !input.runtime.useLocalHarnessConfig(params) &&
      !input.workspaceRuntime(params)
    ) return undefined
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
    const existingSession = !!params?.sessionId && params.sessionId !== "new"
    if (existingSession) input.markServer?.(scope)
    const draftDefault = existingSession ? undefined : input.beginDraftDefault?.(scope, params)
    // The draft harness selection persists across directory switches — the
    // embedded local runtime backs every harness, so a user's choice is never
    // force-reset to OpenCode when navigating between workspaces.
    if (input.cache.getSeen(scope) === key) return
    const pending = pendingByScope.get(scope)
    if (pending?.key === key) return pending.run
    const generation = ++nextGeneration
    generations.set(scope, generation)
    const active = () => generations.get(scope) === generation

    const run = (async () => {
      if (!params?.directory) return
      if (!params.sessionId || params.sessionId === "new") {
        if (draftDefault?.saved) {
          if (!active()) return
          const type = input.state(scope)?.harness ?? draftDefault.saved?.harness ?? "opencode"
          input.setReadyHydration(scope, type)
          if (harnessHasConfigOptions(type)) input.fetchConfigOptions(scope, type, params)
          await input.refresh(params.directory, refreshHarnessTypeForScope({ directory: params.directory, harness: type }), { draft: true })
          if (active()) input.cache.setSeen(scope, key)
          return
        }
        const useLocalHarnessConfig = input.runtime.useLocalHarnessConfig(params)
        if (shouldHydrateDraftFromHarnessStatus({
          useLocalHarnessConfig,
          workspaceRuntime: input.workspaceRuntime(params),
          workspaceKind: input.runtime.workspaceKind?.(params),
        })) {
          const data = await status(params).catch(() => undefined)
          if (!active()) return
          if (data) {
            await applyAndMarkSeen(scope, data, params, key, active)
            return
          }
        }
        const type = input.state(scope)?.harness ?? "opencode"
        input.setReadyHydration(scope, type)
        if (harnessHasConfigOptions(type)) input.fetchConfigOptions(scope, type, params)
        await input.refresh(params.directory, refreshHarnessTypeForScope({ directory: params.directory, harness: type }), { draft: true })
        if (active()) input.cache.setSeen(scope, key)
        return
      }
      if (input.fastSessionSwitchQuiet(params)) {
        markReadyFallback(scope, key, params)
        return
      }
      const data = await status(params).catch(() => undefined)
      if (!active()) return
      if (!data) {
        const fallback = params.sessionRef?.harness?.id ?? input.state(scope)?.harness ?? "opencode"
        input.setReadyFallback(scope, fallback)
        if (shouldRefreshDirectoryAfterHarnessStatus(params)) {
          await input.refresh(params.directory, refreshHarnessTypeForScope({ directory: params.directory, harness: fallback }), { draft: true })
        }
        if (active()) input.cache.setSeen(scope, key)
        return
      }
      await applyAndMarkSeen(scope, data, params, key, active)
    })()

    pendingByScope.set(scope, { key, run })
    input.cache.setPending(scope, run)
    return run.finally(() => {
      if (pendingByScope.get(scope)?.run === run) pendingByScope.delete(scope)
      if (generations.get(scope) === generation) generations.delete(scope)
      input.cache.removePending(scope, run)
    })
  }

  const applyAndMarkSeen = async (
    scope: string,
    data: HarnessState,
    params: ScopeInput,
    key: string,
    active: () => boolean,
  ) => {
    if (!active()) return
    await input.applyStatus(scope, data, params)
    if (active()) input.cache.setSeen(scope, key)
  }

  const markReadyFallback = (scope: string, key: string, params?: ScopeInput) => {
    input.setReadyFallback(scope, params?.sessionRef?.harness?.id ?? input.state(scope)?.harness ?? "opencode")
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

  // An explicit user selection owns the scope immediately. Any hydration
  // already waiting on status/refresh must not apply its older server snapshot
  // after that click and silently restore the previous harness.
  const cancel = (scope: string) => {
    generations.delete(scope)
  }

  return {
    cancel,
    hydrate,
    reprobe,
    status,
  }
}

function stamp(input?: HarnessScopeInput) {
  if (input?.sessionId && input.sessionId !== "new") {
    const ref = input.sessionRef
    if (!ref) return `session:${input.sessionId}`
    const sandbox = ref.toolSandbox
    const backing = sandbox?.kind === "workspace"
      ? `${sandbox.workspaceId}:${sandbox.hosting}:${sandbox.hostId ?? ""}`
      : sandbox?.kind === "local" ? sandbox.cwd : ""
    return [
      `session:${input.sessionId}`,
      ref.host,
      ref.workspaceId ?? "",
      ref.cwd ?? "",
      sandbox?.kind ?? "",
      backing,
      ref.harness?.id ?? "",
      ref.harness?.binary ?? "",
    ].join("\n")
  }
  return `${input?.directory ?? ""}\nnew`
}
