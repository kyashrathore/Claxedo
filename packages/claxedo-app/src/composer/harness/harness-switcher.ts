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

export type HarnessSwitcherCache = {
  getPending(key: string): Promise<void> | undefined
  setPending(key: string, value: Promise<void>): void
  removePending(key: string, value: Promise<void>): void
}

type SwitcherInput<ScopeInput extends HarnessScopeInput> = {
  seed(scope: string): void
  applyPatch(scope: string, patch: HarnessStorePatch): void
  holdHarness(scope: string, patch: HarnessStorePatch): void
  restoreHeldHarness(scope: string, type: HarnessType): boolean
  beginDraftHarnessChoice?(scope: string, type: HarnessType, params?: ScopeInput): void
  rememberDraftHarness(scope: string, type: HarnessType, params?: ScopeInput): void
  fetchConfigOptions(scope: string, type: HarnessType, params?: ScopeInput): void
  hasConfigOptions?(type: HarnessType): Promise<boolean>
  cache: HarnessSwitcherCache
}

export function createHarnessSwitcher<ScopeInput extends HarnessScopeInput>(input: SwitcherInput<ScopeInput>) {
  const revisions = new Map<string, number>()
  let nextRevision = 0
  const setHarness = (scope: string, type: HarnessType, params?: ScopeInput) => {
    const key = harnessChangeKey(params ?? {}, type)
    const pending = input.cache.getPending(key)
    if (pending) return pending
    const revision = ++nextRevision
    revisions.set(scope, revision)
    const run = setHarnessOnce(input, scope, type, params, () => revisions.get(scope) === revision)
    input.cache.setPending(key, run)
    return run.finally(() => {
      input.cache.removePending(key, run)
      if (revisions.get(scope) === revision) revisions.delete(scope)
    })
  }
  return { setHarness }
}

async function setHarnessOnce<ScopeInput extends HarnessScopeInput>(
  input: SwitcherInput<ScopeInput>,
  scope: string,
  type: HarnessType,
  params: ScopeInput | undefined,
  active: () => boolean,
) {
  input.seed(scope)
  const draft = !params?.sessionId || params.sessionId === "new"
  if (!draft && input.restoreHeldHarness(scope, type)) return
  if (draft) {
    input.beginDraftHarnessChoice?.(scope, type, params)
    input.applyPatch(scope, harnessSwitchStartPatch({ type }))
  } else {
    input.holdHarness(scope, harnessSwitchStartPatch({ type }))
  }
  const accepted = await loadPickedHarness(input, scope, type, params, active)
  if (draft && accepted && active()) input.rememberDraftHarness(scope, type, params)
}

async function hasConfigOptions<ScopeInput extends HarnessScopeInput>(input: SwitcherInput<ScopeInput>, scope: string, type: HarnessType) {
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

async function loadPickedHarness<ScopeInput extends HarnessScopeInput>(
  input: SwitcherInput<ScopeInput>,
  scope: string,
  type: HarnessType,
  params: ScopeInput | undefined,
  active: () => boolean,
) {
  const configOptions = await hasConfigOptions(input, scope, type)
  if (configOptions === undefined || !active()) return false
  if (!configOptions) {
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
  return active()
}
