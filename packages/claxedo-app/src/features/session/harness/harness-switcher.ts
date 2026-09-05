import {
  decodeHarnessState,
  failedHarness,
  harnessHasConfigOptions,
  harnessSelectionId,
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
import { sessionResourceUrl } from "./harness-config-routes"
import type { WorkspaceBoot } from "./harness-config-runtime"
import { harnessSelectionQuery } from "@/platform/identity/harness-selection"

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
  beginDraftHarnessChoice?(scope: string, type: HarnessType, params?: ScopeInput): void
  rememberDraftHarness(scope: string, type: HarnessType, params?: ScopeInput): void
  refresh(directory?: string, harnessType?: string, opts?: { draft?: boolean }): Promise<void>
  fetchConfigOptions(scope: string, type: HarnessType, params?: ScopeInput): void
  publishSessionConfig(params: ScopeInput, config: unknown): void
  hasConfigOptions?(type: HarnessType): Promise<boolean>
  errorMessage(res: Response, fallback: string): Promise<string>
  runtime: {
    harnessSessionFetch(params?: ScopeInput): typeof fetch
    workspace(params?: ScopeInput): Promise<WorkspaceBoot | undefined>
  }
  cache: HarnessSwitcherCache
}) {
  const revisions = new Map<string, number>()
  let nextRevision = 0

  const setHarness = (scope: string, type: HarnessType, params?: ScopeInput, binary?: string) => {
    const key = harnessChangeKey({ serverUrl: input.base, ...params }, type, binary)
    const pending = input.cache.getPending(key)
    if (pending) return pending

    const revision = ++nextRevision
    revisions.set(scope, revision)
    const run = setHarnessOnce(scope, type, params, () => revisions.get(scope) === revision)
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
    active: () => boolean,
  ) => {
    input.seed(scope)
    input.dropPrepared(scope)
    if (!params?.sessionId || params.sessionId === "new") input.beginDraftHarnessChoice?.(scope, type, params)
    input.applyPatch(scope, harnessSwitchStartPatch({ type }))
    input.cache.clearOptionsTries(scope)

    if (!params?.sessionId || params.sessionId === "new") {
      const accepted = await switchDraftHarness(scope, type, params, active)
      if (accepted && active()) {
        input.rememberDraftHarness(scope, type, params)
        return
      }
      // `harnessSwitchStartPatch` above raised `optionsLoading` before the
      // first await. A switch that is abandoned mid-flight (a newer switch took
      // the scope while this one was parked on the workspace boot, the config
      // POST, or the refresh) never reaches an options fetch, so nothing else
      // would ever lower that flag — and the model control renders "Loading
      // models" straight off it with no other exit, stranding the composer for
      // the life of the scope. Whoever owns the scope now has raised its own
      // flag and will write the authoritative value; this only releases the one
      // this abandoned switch is responsible for.
      if (!active()) input.applyPatch(scope, { optionsLoading: false })
      return
    }

    await switchExistingHarness(scope, type, params, active)
  }

  const hasConfigOptions = async (scope: string, type: HarnessType) => {
    try {
      return input.hasConfigOptions ? await input.hasConfigOptions(type) : harnessHasConfigOptions(type)
    } catch (error) {
      input.applyPatch(scope, {
        configError: error instanceof Error ? error.message : "Failed to load connection capabilities",
        readiness: "error",
        optionsLoading: false,
      })
      return undefined
    }
  }

  const switchDraftHarness = async (
    scope: string,
    type: HarnessType,
    params: ScopeInput | undefined,
    active: () => boolean,
  ) => {
    await input.runtime.workspace(params).catch(() => undefined)
    if (!active()) return false
    const configOptions = await hasConfigOptions(scope, type)
    if (configOptions === undefined || !active()) return false
    if (!configOptions) {
      await input.refresh(params?.directory, undefined, { draft: true })
      if (!active()) return false
      input.applyPatch(scope, {
        ...(type.kind === "connection" ? { selectedModel: "default", dynamicModels: [] } : {}),
        optionsSource: "empty",
        optionsStale: false,
        optionsLoading: false,
        configError: undefined,
      })
      return true
    }
    input.fetchConfigOptions(scope, type, params)
    await input.refresh(params?.directory, undefined, { draft: true })
    if (!active()) return false
    return true
  }

  const switchExistingHarness = async (
    scope: string,
    type: HarnessType,
    params: ScopeInput,
    active: () => boolean = () => true,
  ) => {
    const status = await patchSessionHarness(scope, type, params, active)
    if (!status || !active()) return
    await input.refresh(params.directory, undefined)
    if (!active()) return
    applyPostedStatus(scope, status)
    const configOptions = await hasConfigOptions(scope, type)
    if (configOptions === undefined) return
    if (!configOptions) {
      input.applyPatch(scope, {
        selectedModel: "default",
        dynamicModels: [],
        optionsSource: "empty",
        optionsStale: false,
        optionsLoading: false,
      })
      return
    }
    input.fetchConfigOptions(scope, type, params)
  }

  const patchSessionHarness = async (
    scope: string,
    type: HarnessType,
    params: ScopeInput,
    active: () => boolean,
  ) => {
    if (!params.sessionId || !params.directory) return false
    try {
      const res = await input.runtime.harnessSessionFetch(params)(
        appendHarnessSelection(sessionResourceUrl({
          serverUrl: input.base,
          resource: "config",
          sessionID: params.sessionId,
          directory: params.directory,
        }), type),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      )
      if (!active()) return false
      if (!res.ok) throw new Error(await input.errorMessage(res, `Failed to switch to ${harnessSelectionId(type)}`))
      const config = await res.json().catch(() => undefined)
      if (!active()) return false
      input.publishSessionConfig(params, config)
      return decodeHarnessState(config) ?? true
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

  return {
    setHarness,
  }
}

function appendHarnessSelection(url: string, selection: HarnessType) {
  const next = new URL(url)
  const query = harnessSelectionQuery(selection)
  if ("nativeHarness" in query) next.searchParams.set("nativeHarness", query.nativeHarness)
  else next.searchParams.set("connectionId", query.connectionId)
  return next.toString()
}
