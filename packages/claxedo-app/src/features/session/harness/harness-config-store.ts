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
import {
  createHarnessHydratorQueryCache,
  createHarnessOptionsQueryCache,
  createHarnessSwitcherQueryCache,
  createPreparedRuntimeSessionQueryCache,
  createSessionModelSyncQueryCache,
} from "./harness-query-cache"
import { createHarnessStatusActions } from "./harness-status-actions"
import { useDirectorySessionCacheActions } from "../data/sync/directory-session-cache"
import { useGlobalBootstrapActions } from "@/features/session/app-ports"
import {
  harnessWorkspaceRuntimeRef,
  type HarnessScopeInput,
} from "./store-policy"
import { decodeHarnessState } from "./profile"
import { harnessHealthReadiness } from "./store-state"
import type {
  HarnessType,
  OptionsResponse,
} from "./profile"
import type { DraftDefaultLabels } from "./draft-defaults"
import type { ModelKey } from "@/features/session/composer/model-strategy"
import type { ResolveDraftDefaultInput } from "./draft-default-policy"
import { sessionPaneWorkspaceKey } from "@/platform/runtime/session-workspace"
import type { PreparedRuntimeSessionConfig } from "./prepared-session"
import { setSessionConfigRawQueryData } from "../store/session-config-query-cache"
import { createHarnessConnectionsCatalog } from "@/platform/query/connection-catalog"
import { harnessHasConfigOptions } from "./profile"

type ScopeInput = HarnessScopeInput
type ClaimInput = ScopeInput & { harness: HarnessType; sessionConfig: PreparedRuntimeSessionConfig; headers?: Record<string, string> }

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
  const connectionCatalog = createHarnessConnectionsCatalog({ base, request })
  let connectionRefresh: Promise<void> | undefined
  const hasConfigOptions = async (type: HarnessType) => {
    if (type.kind === "native") return harnessHasConfigOptions(type)
    if (!connectionCatalog.data()) {
      connectionRefresh ??= connectionCatalog.refresh().finally(() => { connectionRefresh = undefined })
      await connectionRefresh
    }
    const catalog = connectionCatalog.data()
    if (catalog?.status === "unsupported") throw new Error(catalog.reason)
    const row = catalog?.connections.find((item) => item.connectionId === type.connectionId)
    if (!row) {
      throw new Error(connectionCatalog.error() ?? `Connection ${type.connectionId} is unavailable`)
    }
    return row.capabilities.configOptions
  }
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

  const preparedRuntimeSessions = createPreparedRuntimeSessionStore<ClaimInput>({
    canUseRuntimeSession: runtimeSessionActions.canUseRuntimeSession,
    state: harnessStore.touch,
    create: runtimeSessionActions.create,
    remove: runtimeSessionActions.remove,
    setPrepareError: (scope, err) => {
      harnessStore.setConfigError(scope, err instanceof Error ? err.message : "Failed to initialize harness")
      harnessStore.setReadiness(scope, "error")
    },
    cache: createPreparedRuntimeSessionQueryCache(base),
  })

  const optionsLoader = createHarnessOptionsLoader<ScopeInput>({
    fetch: harnessRuntime.configOptionsFetch,
    currentHarness: (scope) => harnessStore.state(scope)?.harness,
    selectedModel: (scope) => harnessStore.state(scope)?.selectedModel,
    modelOptional: harnessStore.canOmitModel,
    preserveSelectedModel: harnessStore.protectDraftModel,
    seed: harnessStore.seed,
    applyPatch: harnessStore.applyPatch,
    draftDefaultApplication: harnessStore.draftDefaultApplication,
    resolveDraftDefault: harnessStore.applyDraftDefault,
    setOptionsLoading: harnessStore.setOptionsLoading,
    readState: (scope) => {
      const state = harnessStore.state(scope)
      return state ? { readiness: state.readiness, configError: state.configError } : undefined
    },
    errorMessage,
    cache: createHarnessOptionsQueryCache(base),
  })

  async function fetchConfigOptions(
    scope: string,
    type: HarnessType,
    input?: ScopeInput,
  ): Promise<OptionsResponse | undefined> {
    return optionsLoader.load(scope, type, input)
  }

  const statusActions = createHarnessStatusActions<ScopeInput>({
    applyPatch: harnessStore.applyPatch,
    state: harnessStore.state,
    fetchConfigOptions,
    hasConfigOptions,
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
    applyStatus: statusActions.applyStatus,
    setPollingHydration: statusActions.setPollingHydration,
    setReadyHydration: statusActions.setReadyHydration,
    setCapabilityError: (scope, message) => {
      harnessStore.applyPatch(scope, { configError: message, readiness: "error", optionsLoading: false })
    },
    fetchConfigOptions,
    hasConfigOptions,
    refresh: statusActions.refresh,
    workspaceRuntime: (input) => !!harnessWorkspaceRuntimeRef(input, projectsQuery.data ?? []),
    runtime: harnessRuntime,
    cache: createHarnessHydratorQueryCache(base),
  })

  const publishSessionConfig = (input: ScopeInput, config: unknown) => {
    if (!input.sessionId || !input.directory || config === undefined) return
    setSessionConfigRawQueryData({
      sessionID: input.sessionId,
      directory: input.directory,
      serverUrl: base,
      sessionRef: input.sessionRef,
      workspaceId: input.sessionRef?.workspaceId,
    }, config)
  }

  const modelWriter = createHarnessModelWriter<ScopeInput>({
    base,
    seed: harnessStore.seed,
    acceptsDraftModel: harnessStore.acceptsDraftModel,
    setSelectedModel: harnessStore.setSelectedModel,
    rememberDraftModel: (scope, model, input, labels) => {
      rememberDraftModel(scope, model, input, labels)
    },
    publishSessionConfig,
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
    publishSessionConfig,
    hasConfigOptions,
    errorMessage,
    runtime: harnessRuntime,
    cache: createHarnessSwitcherQueryCache(base),
  })

  const setHarness: typeof switcher.setHarness = (scope, type, input) => {
    hydrator.cancel(scope)
    return switcher.setHarness(scope, type, input)
  }

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

  // Probe the bound runtime without changing persisted harness/model identity.
  // Hydration alone cannot detect a runtime that exits after the session loads.
  const probeHarnessHealth = async (scope: string, input?: ScopeInput) => {
    if (!input?.directory) return
    const current = harnessStore.read(scope)
    if (!current.harness) return
    const res = await harnessRuntime.harnessHealthFetch(input).catch(() => undefined)
    if (!res?.ok) return
    const data = decodeHarnessState(await res.json().catch(() => undefined))
    if (!data) return
    const held = harnessStore.read(scope)
    if (held.harness?.kind !== current.harness.kind || (held.harness.kind === "connection" && (current.harness.kind !== "connection" || held.harness.connectionId !== current.harness.connectionId))) return
    if (held.harness.kind === "connection" && data.connectionState?.connectionId === held.harness.connectionId) {
      harnessStore.applyPatch(scope, { connectionState: data.connectionState })
    }
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
    canOmitModel: harnessStore.canOmitModel,
    canCreateWithoutModel: harnessStore.canCreateWithoutModel,
    setConnectionDeclaration: harnessStore.setConnectionDeclaration,
    harnessMode: harnessStore.harnessMode,
    selectedModel: harnessStore.selectedModel,
    selectedModelKey: harnessStore.selectedModelKey,
    harness: harnessStore.harness,
    models: harnessStore.models,
    thoughtLevels: harnessStore.thoughtLevels,
    setThoughtLevel: harnessStore.setThoughtLevel,
    selectedThoughtLevel: harnessStore.selectedThoughtLevel,
    displayName: harnessStore.displayName,
    isHarnessMode: harnessStore.isHarnessMode,
    readiness: (scope: string) => harnessStore.read(scope).readiness,
    connectionState: (scope: string) => harnessStore.read(scope).connectionState,
    optionsSource: harnessStore.optionsSource,
    optionsStale: harnessStore.optionsStale,
    optionsLoading: harnessStore.optionsLoading,
    configError: harnessStore.configError,
    draftDefaultState: harnessStore.draftDefaultState,
    draftDefaultLabels: harnessStore.draftDefaultLabels,
    draftDefaultModel: harnessStore.draftDefaultModel,
    draftDefaultAuthority: harnessStore.draftDefaultAuthority,
    harnessModelKeyForSubmit: harnessStore.harnessModelKeyForSubmit,
    harnessModelNameForSubmit: harnessStore.harnessModelNameForSubmit,
    harnessReadyForSubmit: harnessStore.harnessReadyForSubmit,
  }
}
