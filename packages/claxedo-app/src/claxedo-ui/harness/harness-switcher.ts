import {
  decodeHarnessState,
  effectiveHarnessModel,
  failedHarness,
  harnessHasConfigOptions,
  type HarnessState,
  type HarnessType,
} from "../../session-client/harness/profile"
import {
  harnessStatusPatch,
  harnessSwitchStartPatch,
  type HarnessStorePatch,
} from "../../session-client/harness/store-state"
import {
  harnessChangeKey,
  type HarnessScopeInput,
} from "../../session-client/harness/store-policy"
import { harnessConfigUrl } from "./harness-config-routes"
import type { WorkspaceBoot } from "./harness-config-runtime"

export type HarnessSwitcherCache = {
  getPending(key: string): Promise<void> | undefined
  setPending(key: string, value: Promise<void>): void
  removePending(key: string, value: Promise<void>): void
  clearOptionsTries(scope: string): void
}

export function createHarnessSwitcher<ScopeInput extends HarnessScopeInput>(input: {
  base: string
  seed(scope: string): void
  dropPrepared(scope: string): void
  applyPatch(scope: string, patch: HarnessStorePatch): void
  saveHarness(scope: string, type: HarnessType): void
  saveModel(scope: string, model: string): void
  refresh(directory?: string, harnessType?: string, opts?: { draft?: boolean }): Promise<void>
  fetchConfigOptions(scope: string, type: HarnessType, params?: ScopeInput): void
  errorMessage(res: Response, fallback: string): Promise<string>
  runtime: {
    useLocalHarnessConfig(params?: ScopeInput): boolean
    localHarnessConfigFetch(params?: ScopeInput): typeof fetch
    workspace(params?: ScopeInput): Promise<WorkspaceBoot | undefined>
  }
  cache: HarnessSwitcherCache
}) {
  const setHarness = (scope: string, type: HarnessType, params?: ScopeInput, binary?: string) => {
    const key = harnessChangeKey(scope, type, binary)
    const pending = input.cache.getPending(key)
    if (pending) return pending

    const run = setHarnessOnce(scope, type, params, binary)
    input.cache.setPending(key, run)
    return run.finally(() => input.cache.removePending(key, run))
  }

  const setHarnessOnce = async (scope: string, type: HarnessType, params?: ScopeInput, binary?: string) => {
    const useLocalHarnessConfig = input.runtime.useLocalHarnessConfig(params)
    input.seed(scope)
    input.dropPrepared(scope)
    input.applyPatch(scope, harnessSwitchStartPatch({ type }))
    input.cache.clearOptionsTries(scope)
    input.saveHarness(scope, type)
    input.saveModel(scope, effectiveHarnessModel(type))

    if (!params?.sessionId || params.sessionId === "new") {
      await switchDraftHarness(scope, type, params, binary, useLocalHarnessConfig)
      return
    }

    if (!useLocalHarnessConfig) {
      await input.refresh(params.directory, type)
      return
    }

    await switchExistingLocalHarness(scope, type, params, binary)
  }

  const switchDraftHarness = async (
    scope: string,
    type: HarnessType,
    params: ScopeInput | undefined,
    binary: string | undefined,
    useLocalHarnessConfig: boolean,
  ) => {
    const workspace = await input.runtime.workspace(params).catch(() => undefined)
    const status = useLocalHarnessConfig && workspace?.kind !== "cloud" && workspace?.kind !== "user-hosted"
      ? await postHarnessConfig(scope, type, params, binary)
      : true
    if (!status) return
    if (!harnessHasConfigOptions(type)) {
      input.applyPatch(scope, { harnessBinary: "" })
      await input.refresh(params?.directory, type, { draft: true })
      applyPostedStatus(scope, status)
      return
    }
    input.fetchConfigOptions(scope, type, params)
    await input.refresh(params?.directory, type, { draft: true })
    applyPostedStatus(scope, status)
  }

  const switchExistingLocalHarness = async (
    scope: string,
    type: HarnessType,
    params: ScopeInput,
    binary?: string,
  ) => {
    const status = await postHarnessConfig(scope, type, params, binary, {
      sessionId: params.sessionId,
      directory: params.directory,
    })
    if (!status) return
    if (binary) input.applyPatch(scope, { harnessBinary: binary })
    await input.refresh(params.directory, type)
    applyPostedStatus(scope, status)
    if (!harnessHasConfigOptions(type)) {
      input.applyPatch(scope, {
        harnessBinary: "",
        optionsSource: "empty",
        optionsStale: false,
        optionsLoading: false,
      })
      return
    }
    input.fetchConfigOptions(scope, type, params)
  }

  const postHarnessConfig = async (
    scope: string,
    type: HarnessType,
    params: ScopeInput | undefined,
    binary: string | undefined,
    session?: { sessionId?: string; directory?: string },
  ) => {
    try {
      const res = await input.runtime.localHarnessConfigFetch(params)(
        harnessConfigUrl({ serverUrl: input.base }),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type,
            ...(session ? { binary } : binary ? { binary } : {}),
            ...(session?.sessionId ? { sessionId: session.sessionId } : {}),
            ...(session?.directory ? { directory: session.directory } : params?.directory ? { directory: params.directory } : {}),
          }),
        },
      )
      if (res.ok) return decodeHarnessState(await res.json().catch(() => undefined)) ?? await fetchHarnessStatus(params, session) ?? true
      throw new Error(await input.errorMessage(res, `Failed to switch to ${type}`))
    } catch (err) {
      input.applyPatch(scope, {
        configError: err instanceof Error ? err.message : "Failed to switch harness",
        readiness: "error",
        optionsLoading: false,
      })
      return false
    }
  }

  const applyPostedStatus = (scope: string, status: true | HarnessState) => {
    // A posted switch response is settled/definitive: a ready:false here means
    // the switch completed and the harness came back unavailable → "error", not
    // the "polling" a startup hydration probe would report.
    if (status !== true && failedHarness(status)) input.applyPatch(scope, harnessStatusPatch({ data: status, settled: true }))
  }

  const fetchHarnessStatus = async (
    params: ScopeInput | undefined,
    session?: { sessionId?: string; directory?: string },
  ) => {
    if (!params?.directory && !session?.directory) return undefined
    const res = await input.runtime.localHarnessConfigFetch(params)(
      harnessConfigUrl({
        serverUrl: input.base,
        directory: session?.directory ?? params?.directory,
        sessionId: session?.sessionId ?? params?.sessionId,
      }),
    )
    if (!res.ok) return undefined
    return decodeHarnessState(await res.json().catch(() => undefined))
  }

  return {
    setHarness,
  }
}
