import {
  harnessHasConfigOptions,
  type HarnessType,
} from "./profile"
import {
  harnessSwitchStartPatch,
  type HarnessStorePatch,
} from "./store-state"
import {
  harnessChangeKey,
  type HarnessScopeInput,
} from "./store-policy"
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
  holdHarness(scope: string, patch: HarnessStorePatch): void
  restoreHeldHarness(scope: string, type: HarnessType): boolean
  beginDraftHarnessChoice?(scope: string, type: HarnessType, params?: ScopeInput): void
  rememberDraftHarness(scope: string, type: HarnessType, params?: ScopeInput): void
  refresh(directory?: string, harnessType?: string, opts?: { draft?: boolean }): Promise<void>
  fetchConfigOptions(scope: string, type: HarnessType, params?: ScopeInput): void
  hasConfigOptions?(type: HarnessType): Promise<boolean>
  runtime: {
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

  /**
   * A pick is local to the composer on both paths. A draft remembers it as the
   * workspace's next default; an existing session holds it until the next send
   * switches the session, so picking around never touches the session itself.
   */
  const setHarnessOnce = async (
    scope: string,
    type: HarnessType,
    params: ScopeInput | undefined,
    active: () => boolean,
  ) => {
    input.seed(scope)
    input.dropPrepared(scope)
    const draft = !params?.sessionId || params.sessionId === "new"
    if (!draft && input.restoreHeldHarness(scope, type)) return
    if (draft) {
      input.beginDraftHarnessChoice?.(scope, type, params)
      input.applyPatch(scope, harnessSwitchStartPatch({ type }))
    } else {
      input.holdHarness(scope, harnessSwitchStartPatch({ type }))
    }
    input.cache.clearOptionsTries(scope)
    const accepted = await loadPickedHarness(scope, type, params, active)
    if (draft && accepted && active()) input.rememberDraftHarness(scope, type, params)
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

  const loadPickedHarness = async (
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

  return {
    setHarness,
  }
}
