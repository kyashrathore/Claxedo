import {
  decodeHarnessState,
  effectiveHarnessModel,
  failedHarness,
  harnessHasConfigOptions,
  type HarnessState,
  type HarnessType,
} from "./profile"
import {
  harnessStatusPatch,
  harnessSwitchStartPatch,
  type HarnessStorePatch,
} from "./store-state"
import {
  harnessChangeKey,
  type HarnessScopeInput,
} from "./store-policy"
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
  beginDraftHarnessChoice?(scope: string, type: HarnessType, params?: ScopeInput): void
  rememberDraftHarness(scope: string, type: HarnessType, params?: ScopeInput): void
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
  const revisions = new Map<string, number>()
  let nextRevision = 0

  const setHarness = (scope: string, type: HarnessType, params?: ScopeInput, binary?: string) => {
    const key = harnessChangeKey(scope, type, binary)
    const pending = input.cache.getPending(key)
    if (pending) return pending

    const revision = ++nextRevision
    revisions.set(scope, revision)
    const run = setHarnessOnce(scope, type, params, binary, () => revisions.get(scope) === revision)
    input.cache.setPending(key, run)
    return run.finally(() => {
      input.cache.removePending(key, run)
      if (revisions.get(scope) === revision) revisions.delete(scope)
    })
  }

  const setHarnessOnce = async (
    scope: string,
    type: HarnessType,
    params: ScopeInput | undefined,
    binary: string | undefined,
    active: () => boolean,
  ) => {
    const useLocalHarnessConfig = input.runtime.useLocalHarnessConfig(params)
    input.seed(scope)
    input.dropPrepared(scope)
    if (!params?.sessionId || params.sessionId === "new") input.beginDraftHarnessChoice?.(scope, type, params)
    input.applyPatch(scope, harnessSwitchStartPatch({ type }))
    input.cache.clearOptionsTries(scope)
    input.saveHarness(scope, type)
    input.saveModel(scope, effectiveHarnessModel(type))

    if (!params?.sessionId || params.sessionId === "new") {
      const accepted = await switchDraftHarness(scope, type, params, binary, useLocalHarnessConfig, active)
      if (accepted && active()) input.rememberDraftHarness(scope, type, params)
      return
    }

    if (!useLocalHarnessConfig) {
      await input.refresh(params.directory, type)
      return
    }

    await switchExistingLocalHarness(scope, type, params, binary, active)
  }

  const switchDraftHarness = async (
    scope: string,
    type: HarnessType,
    params: ScopeInput | undefined,
    binary: string | undefined,
    useLocalHarnessConfig: boolean,
    active: () => boolean,
  ) => {
    const workspace = await input.runtime.workspace(params).catch(() => undefined)
    if (!active()) return false
    const status = useLocalHarnessConfig && workspace?.kind !== "cloud" && workspace?.kind !== "user-hosted"
      ? await postHarnessConfig(scope, type, params, binary, undefined, active)
      : true
    if (!status || !active()) return false
    if (!harnessHasConfigOptions(type)) {
      input.applyPatch(scope, { harnessBinary: "" })
      await input.refresh(params?.directory, type, { draft: true })
      if (!active()) return false
      applyPostedStatus(scope, status)
      return true
    }
    input.fetchConfigOptions(scope, type, params)
    await input.refresh(params?.directory, type, { draft: true })
    if (!active()) return false
    applyPostedStatus(scope, status)
    return true
  }

  const switchExistingLocalHarness = async (
    scope: string,
    type: HarnessType,
    params: ScopeInput,
    binary?: string,
    active: () => boolean = () => true,
  ) => {
    const status = await postHarnessConfig(scope, type, params, binary, {
      sessionId: params.sessionId,
      directory: params.directory,
    }, active)
    if (!status || !active()) return
    if (binary) input.applyPatch(scope, { harnessBinary: binary })
    await input.refresh(params.directory, type)
    if (!active()) return
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
    active: () => boolean = () => true,
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
      if (!active()) return false
      if (res.ok) {
        const data = decodeHarnessState(await res.json().catch(() => undefined)) ?? await fetchHarnessStatus(params, session) ?? true
        return active() ? data : false
      }
      throw new Error(await input.errorMessage(res, `Failed to switch to ${type}`))
    } catch (err) {
      if (!active()) return false
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
