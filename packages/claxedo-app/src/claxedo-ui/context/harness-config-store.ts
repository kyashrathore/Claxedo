import { useQuery } from "@tanstack/solid-query"
import { useShellQueryOptions as useQueryOptions } from "@claxedo/shell/data/query-options"
import { authFetch, getClaxedoServerUrl } from "../../utils/api"
import { createHarnessConfigRuntime } from "./harness-config-runtime"
import { createPreparedRuntimeSessionStore } from "./harness-prepared-runtime-session"
import { createHarnessRuntimeSessionActions } from "./harness-runtime-session-actions"
import { createHarnessOptionsLoader } from "./harness-options-loader"
import { createHarnessHydrator } from "./harness-hydrator"
import { createHarnessSwitcher } from "./harness-switcher"
import { createHarnessModelWriter } from "./harness-model-writer"
import { createHarnessStore } from "./harness-store"
import {
  clearHarnessOptionsTries,
  createHarnessHydratorQueryCache,
  createHarnessOptionsQueryCache,
  createHarnessSwitcherQueryCache,
  createPreparedRuntimeSessionQueryCache,
  createSessionModelSyncQueryCache,
} from "./harness-query-cache"
import { createHarnessStatusActions } from "./harness-status-actions"
import { useDirectorySessionCacheActions } from "../../shell/data/directory-session-cache"
import { useGlobalBootstrapActions } from "../../shell/data/global-bootstrap"
import { fastSessionSwitchNetworkQuiet } from "../../session/store/fast-session-switch"
import {
  harnessWorkspaceRuntimeRef,
  type HarnessScopeInput,
} from "../../session-client/harness/store-policy"
import type {
  HarnessType,
  OptionsResponse,
} from "../../session-client/harness/profile"

type ScopeInput = HarnessScopeInput

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}

async function errorMessage(res: Response, fallback: string) {
  const body = record(await res.json().catch(() => undefined))
  if (typeof body?.error === "string") return body.error
  const error = record(body?.error)
  if (typeof error?.message === "string") return error.message
  return fallback
}

export function createHarnessConfigStore() {
  const globalBootstrapActions = useGlobalBootstrapActions()
  const directorySessionCacheActions = useDirectorySessionCacheActions()
  const queryOptions = useQueryOptions()
  const projectsQuery = useQuery(() => queryOptions.projects())
  const base = getClaxedoServerUrl()
  const request = authFetch
  const harnessRuntime = createHarnessConfigRuntime({
    base,
    request,
    projects: () => projectsQuery.data ?? [],
  })
  const harnessStore = createHarnessStore(localStorage)
  const runtimeSessionActions = createHarnessRuntimeSessionActions({
    base,
    runtime: harnessRuntime,
  })

  const preparedRuntimeSessions = createPreparedRuntimeSessionStore<ScopeInput>({
    canUseRuntimeSession: runtimeSessionActions.canUseRuntimeSession,
    state: harnessStore.touch,
    create: runtimeSessionActions.create,
    remove: runtimeSessionActions.remove,
    setPrepareError: (scope, err) => {
      harnessStore.setConfigError(scope, err instanceof Error ? err.message : "Failed to initialize harness")
      harnessStore.setReadiness(scope, "error")
    },
    cache: createPreparedRuntimeSessionQueryCache(),
  })

  const optionsLoader = createHarnessOptionsLoader<ScopeInput>({
    fetch: harnessRuntime.configOptionsFetch,
    currentHarness: (scope) => harnessStore.state(scope)?.harness,
    selectedModel: (scope) => harnessStore.state(scope)?.selectedModel,
    seed: harnessStore.seed,
    applyPatch: harnessStore.applyPatch,
    saveModel: (scope, model) => harnessStore.save(scope, "model", model),
    setOptionsLoading: harnessStore.setOptionsLoading,
    errorMessage,
    cache: createHarnessOptionsQueryCache(),
  })

  async function fetchConfigOptions(
    scope: string,
    type: HarnessType,
    input?: ScopeInput,
  ): Promise<OptionsResponse | undefined> {
    return optionsLoader.load(scope, type, input)
  }

  const statusActions = createHarnessStatusActions<ScopeInput>({
    dropPrepared: (scope) => {
      void preparedRuntimeSessions.drop(scope)
    },
    clearOptionsTries: clearHarnessOptionsTries,
    applyPatch: harnessStore.applyPatch,
    state: harnessStore.state,
    save: harnessStore.save,
    fetchConfigOptions: (scope, type, input) => {
      void fetchConfigOptions(scope, type, input)
    },
    bootstrap: async (params) => {
      await globalBootstrapActions.bootstrap(params)
    },
    ensureDirectory: async (params) => {
      await directorySessionCacheActions.ensure(params)
    },
    refreshDirectory: async (params) => {
      await directorySessionCacheActions.refresh(params)
    },
  })

  const hydrator = createHarnessHydrator<ScopeInput>({
    base,
    seed: harnessStore.seed,
    state: harnessStore.state,
    resetWorkspaceDraftHarness: statusActions.resetWorkspaceDraftHarness,
    applyStatus: statusActions.applyStatus,
    setReadyHydration: statusActions.setReadyHydration,
    setReadyFallback: statusActions.setReadyFallback,
    fetchConfigOptions: (scope, type, input) => {
      void fetchConfigOptions(scope, type, input)
    },
    refresh: statusActions.refresh,
    fastSessionSwitchQuiet: (input) => fastSessionSwitchNetworkQuiet({ sessionId: input?.sessionId }),
    workspaceRuntime: (input) => !!harnessWorkspaceRuntimeRef(input),
    runtime: harnessRuntime,
    cache: createHarnessHydratorQueryCache(),
  })

  const modelWriter = createHarnessModelWriter<ScopeInput>({
    base,
    seed: harnessStore.seed,
    setSelectedModel: harnessStore.setSelectedModel,
    setSelectedAgent: harnessStore.setSelectedAgent,
    saveModel: (scope, model) => harnessStore.save(scope, "model", model),
    saveAgent: (scope, name) => harnessStore.save(scope, "agent", name),
    dropPrepared: (scope) => {
      void preparedRuntimeSessions.drop(scope)
    },
    runtime: harnessRuntime,
    cache: createSessionModelSyncQueryCache(),
  })

  const setModel = modelWriter.setModel

  const switcher = createHarnessSwitcher<ScopeInput>({
    base,
    seed: harnessStore.seed,
    dropPrepared: (scope) => {
      void preparedRuntimeSessions.drop(scope)
    },
    applyPatch: harnessStore.applyPatch,
    saveHarness: (scope, type) => harnessStore.save(scope, "harness", type),
    saveModel: (scope, model) => harnessStore.save(scope, "model", model),
    refresh: statusActions.refresh,
    fetchConfigOptions: (scope, type, input) => {
      void fetchConfigOptions(scope, type, input)
    },
    errorMessage,
    runtime: harnessRuntime,
    cache: createHarnessSwitcherQueryCache(),
  })

  const setHarness = switcher.setHarness

  const setAgent = modelWriter.setAgent

  const claimSession = preparedRuntimeSessions.claim

  return {
    hydrate: hydrator.hydrate,
    claimSession,
    promote: harnessStore.promote,
    setModel,
    setHarness,
    setAgent,
    harnessMode: harnessStore.harnessMode,
    harnessBinary: harnessStore.harnessBinary,
    selectedModel: harnessStore.selectedModel,
    harness: harnessStore.harness,
    selectedAgent: harnessStore.selectedAgent,
    models: harnessStore.models,
    displayName: harnessStore.displayName,
    isHarnessMode: harnessStore.isHarnessMode,
    readiness: (scope: string) => harnessStore.read(scope).readiness,
    optionsSource: harnessStore.optionsSource,
    optionsStale: harnessStore.optionsStale,
    optionsLoading: harnessStore.optionsLoading,
    configError: harnessStore.configError,
    harnessModelKeyForSubmit: harnessStore.harnessModelKeyForSubmit,
    harnessModelNameForSubmit: harnessStore.harnessModelNameForSubmit,
    harnessReadyForSubmit: harnessStore.harnessReadyForSubmit,
  }
}
