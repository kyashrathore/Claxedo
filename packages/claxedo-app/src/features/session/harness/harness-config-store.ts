import { useQuery } from "@tanstack/solid-query"
import { useShellQueryOptions as useQueryOptions } from "@/features/session/app-ports"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { createHarnessConfigRuntime } from "./harness-config-runtime"
import { createPreparedRuntimeSessionStore } from "./harness-prepared-runtime-session"
import { createHarnessRuntimeSessionActions } from "./harness-runtime-session-actions"
import { createHarnessOptionsLoader } from "./harness-options-loader"
import { createHarnessHydrator } from "./harness-hydrator"
import { createHarnessSwitcher } from "./harness-switcher"
import { createHarnessModelWriter } from "./harness-model-writer"
import { createHarnessStore } from "./harness-store"
import { createAcpConnectionsCatalog } from "./acp-connections"
import {
  clearHarnessOptionsTries,
  createHarnessHydratorQueryCache,
  createHarnessOptionsQueryCache,
  createHarnessSwitcherQueryCache,
  createPreparedRuntimeSessionQueryCache,
  createSessionModelSyncQueryCache,
} from "./harness-query-cache"
import { createHarnessStatusActions } from "./harness-status-actions"
import { useDirectorySessionCacheActions } from "../data/sync/directory-session-cache"
import { useGlobalBootstrapActions } from "@/features/session/app-ports"
import { fastSessionSwitchNetworkQuiet } from "@/platform/runtime/session-switch"
import {
  harnessWorkspaceRuntimeRef,
  type HarnessScopeInput,
} from "./store-policy"
import { decodeHarnessState } from "./profile"
import { harnessHealthReadiness } from "./store-state"
import { harnessConfigUrl } from "./harness-config-routes"
import type {
  HarnessType,
  OptionsResponse,
} from "./profile"
import type { DraftDefaultLabels } from "./draft-defaults"
import type { ModelKey } from "@/features/session/composer/model-strategy"
import type { ResolveDraftDefaultInput } from "./draft-default-policy"
import { sessionPaneWorkspaceKey } from "@/platform/runtime/session-workspace"
import type { PreparedRuntimeSessionConfig } from "./prepared-session"

type ScopeInput = HarnessScopeInput
type ClaimInput = ScopeInput & { sessionConfig: PreparedRuntimeSessionConfig }

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
  // Operator-configured ACP connections: the sanitized discovery rows the
  // picker's ACP group renders. One catalog per store (per app shell).
  const acpConnections = createAcpConnectionsCatalog({ base, request })
  const runtimeSessionActions = createHarnessRuntimeSessionActions<ClaimInput>({
    base,
    runtime: harnessRuntime,
  })

  const preparedRuntimeSessions = createPreparedRuntimeSessionStore<ClaimInput>({
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
    preserveSelectedModel: harnessStore.protectDraftModel,
    seed: harnessStore.seed,
    applyPatch: harnessStore.applyPatch,
    saveModel: (scope, model) => harnessStore.save(scope, "model", model),
    draftDefaultApplication: harnessStore.draftDefaultApplication,
    resolveDraftDefault: harnessStore.applyDraftDefault,
    completeRememberedHarness: harnessStore.completeRememberedHarness,
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
    beginDraftDefault: (scope, input) => {
      const identity = draftDefaultIdentity(input)
      if (!identity) return undefined
      return harnessStore.beginDraftDefault(scope, identity)
    },
    markServer: harnessStore.markServer,
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
    acceptsDraftModel: harnessStore.acceptsDraftModel,
    setSelectedModel: harnessStore.setSelectedModel,
    setSelectedAgent: harnessStore.setSelectedAgent,
    saveModel: (scope, model) => harnessStore.save(scope, "model", model),
    saveAgent: (scope, name) => harnessStore.save(scope, "agent", name),
    rememberDraftModel: (scope, model, input, labels) => {
      rememberDraftModel(scope, model, input, labels)
    },
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
    beginDraftHarnessChoice: (scope, type, input) => {
      const identity = draftDefaultIdentity(input)
      if (identity) harnessStore.beginDraftHarnessChoice(scope, identity, type)
    },
    rememberDraftHarness: (scope, type, input) => {
      rememberDraftHarness(scope, type, input)
    },
    refresh: statusActions.refresh,
    fetchConfigOptions: (scope, type, input) => {
      void fetchConfigOptions(scope, type, input)
    },
    errorMessage,
    runtime: harnessRuntime,
    cache: createHarnessSwitcherQueryCache(),
  })

  const setHarness: typeof switcher.setHarness = (scope, type, input, binary) => {
    hydrator.cancel(scope)
    return switcher.setHarness(scope, type, input, binary)
  }

  const setAgent = modelWriter.setAgent

  const claimSession = preparedRuntimeSessions.claim

  function draftDefaultIdentity(input?: ScopeInput) {
    if (!input?.directory || (input.sessionId && input.sessionId !== "new")) return undefined
    const workspaceKey = sessionPaneWorkspaceKey({
      directory: input.directory,
      projects: projectsQuery.data ?? [],
    })
    return {
      serverUrl: base,
      workspaceKey,
      ...(workspaceKey !== input.directory ? { fallbackWorkspaceKey: input.directory } : {}),
    }
  }

  const rememberDraftHarness = (scope: string, type: HarnessType, input?: ScopeInput) => {
    const identity = draftDefaultIdentity(input)
    if (!identity) return false
    return harnessStore.rememberDraftHarness(scope, identity, type)
  }

  const rememberDraftModel = (scope: string, model: ModelKey, input?: ScopeInput, labels?: DraftDefaultLabels) => {
    const identity = draftDefaultIdentity(input)
    if (!identity) return false
    return harnessStore.rememberDraftModel(scope, identity, model, labels)
  }

  const resolveCurrentDraftDefault = (
    scope: string,
    input: Omit<ResolveDraftDefaultInput, "saved">,
  ) => {
    const type = harnessStore.state(scope)?.draftDefault?.harness
    if (!type) return false
    const application = harnessStore.draftDefaultApplication(scope, type)
    if (!application) return false
    return harnessStore.applyDraftDefault(application, input)
  }

  // Standing harness-health probe (T4). Hydration/reprobe short-circuit an
  // existing session on its stored session-config (`harnessStateFromSessionConfig`
  // forces ready:true), so they never observe a harness that DIED after settling.
  // This hits the harness route directly — which now forwards `/api/wr/health`'s
  // `harnessHealth` (D1 fix) — and moves readiness ready<->degraded so the
  // composer health peek + Send gate react. Deliberately does NOT re-fetch config
  // options, re-save preferences, or touch harness/model identity: it only
  // transitions readiness, and only when it owns that transition.
  const probeHarnessHealth = async (scope: string, input?: ScopeInput) => {
    if (!input?.directory) return
    const current = harnessStore.read(scope)
    if (current.harness === "opencode") return
    const res = await harnessRuntime
      .localHarnessConfigFetch(input)(
        harnessConfigUrl({ serverUrl: base, directory: input.directory, sessionId: input.sessionId }),
      )
      .catch(() => undefined)
    if (!res?.ok) return
    const data = decodeHarnessState(await res.json().catch(() => undefined))
    if (!data) return
    const next = harnessHealthReadiness({
      harness: current.harness,
      current: harnessStore.read(scope).readiness,
      health: data.harnessHealth?.status,
    })
    if (next) harnessStore.setReadiness(scope, next)
  }

  return {
    hydrate: hydrator.hydrate,
    reprobe: hydrator.reprobe,
    acpConnections: acpConnections.rows,
    enabledAcpConnections: acpConnections.enabled,
    acpConnectionLabel: acpConnections.label,
    refreshAcpConnections: acpConnections.refresh,
    probeHealth: probeHarnessHealth,
    // Give up on a harness that never left "polling": surface the terminal
    // "error" readiness so the selector shows the "Unavailable" affordance and
    // submit stays blocked (harnessReadyForSubmit is false for "error").
    markUnavailable: (scope: string) => harnessStore.setReadiness(scope, "error"),
    claimSession,
    promote: harnessStore.promote,
    rememberDraftModel,
    resolveDraftDefault: resolveCurrentDraftDefault,
    setModel,
    setHarness,
    setAgent,
    harnessMode: harnessStore.harnessMode,
    harnessBinary: harnessStore.harnessBinary,
    selectedModel: harnessStore.selectedModel,
    selectedModelKey: harnessStore.selectedModelKey,
    harness: harnessStore.harness,
    selectedAgent: harnessStore.selectedAgent,
    models: harnessStore.models,
    thoughtLevels: harnessStore.thoughtLevels,
    setThoughtLevel: harnessStore.setThoughtLevel,
    selectedThoughtLevel: harnessStore.selectedThoughtLevel,
    displayName: harnessStore.displayName,
    isHarnessMode: harnessStore.isHarnessMode,
    readiness: (scope: string) => harnessStore.read(scope).readiness,
    optionsSource: harnessStore.optionsSource,
    optionsStale: harnessStore.optionsStale,
    optionsLoading: harnessStore.optionsLoading,
    configError: harnessStore.configError,
    draftDefaultState: harnessStore.draftDefaultState,
    draftDefaultLabels: harnessStore.draftDefaultLabels,
    draftDefaultModel: harnessStore.draftDefaultModel,
    harnessModelKeyForSubmit: harnessStore.harnessModelKeyForSubmit,
    harnessModelNameForSubmit: harnessStore.harnessModelNameForSubmit,
    harnessReadyForSubmit: harnessStore.harnessReadyForSubmit,
  }
}
