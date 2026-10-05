import type { HarnessConnectionState, HarnessHealth, HarnessOptionChoice, HarnessOptionsSource, HarnessState, HarnessUnavailableHere, PlacementId } from "@/server"
import type { HarnessConnectionRef } from "@claxedo/agent-runtime-contract"
import {
  hardFailedHarness,
  harnessHasConfigOptions,
  type HarnessType,
} from "./profile"
import { harnessMode, type HarnessReadiness } from "./selection"
import type { DraftDefault } from "./draft-defaults"
import type { DraftDefaultAuthority, DraftDefaultResult } from "./draft-default-policy"
import { isCatalogHarnessId, sameHarnessSelection } from "@/lib/harness-selection"

export type HarnessStoreState = {
  harnessMode: "harness" | "unknown"
  harness?: HarnessType
  selectedModel: string
  selectedModelProvider?: string
  dynamicModels: readonly HarnessOptionChoice[] | null
  thoughtLevels: readonly HarnessOptionChoice[] | null
  selectedThoughtLevel: string | undefined
  serviceTiers: readonly HarnessOptionChoice[] | null
  selectedServiceTier: string | undefined
  readiness: HarnessReadiness
  connectionDeclaration?: HarnessConnectionRef
  connectionState?: HarnessConnectionState
  optionsSource: HarnessOptionsSource
  optionsStale: boolean
  optionsLoading: boolean
  configError?: string
  unavailableHere?: HarnessUnavailableHere
  workspaceId?: string
  draftDefaultAuthority?: DraftDefaultAuthority
  draftDefaultRevision?: number
  draftDefaultPlacementId?: PlacementId
  draftDefault?: DraftDefault
  draftDefaultState?: DraftDefaultResult["state"]
  heldFrom?: Omit<HarnessStoreState, "heldFrom">
}

export type HarnessStorePatch = Partial<HarnessStoreState>

export function initialHarnessStoreState(input: {
  scope: string
}): HarnessStoreState {
  return {
    harnessMode: "unknown",
    harness: undefined,
    selectedModel: "",
    selectedModelProvider: undefined,
    dynamicModels: null,
    thoughtLevels: null,
    selectedThoughtLevel: undefined,
    serviceTiers: null,
    selectedServiceTier: undefined,
    readiness: "unresolved",
    optionsSource: "empty",
    optionsStale: false,
    optionsLoading: false,
    configError: undefined,
    draftDefaultAuthority: scopeAuthority(input.scope),
    draftDefaultRevision: 0,
  }
}

function scopeAuthority(scope: string): DraftDefaultAuthority {
  return scope.startsWith("session:") ? "server" : "unresolved"
}

export function harnessStatusPatch(input: {
  data: HarnessState
  current?: HarnessStoreState
}): HarnessStorePatch {
  const want = input.data.type ?? input.current?.harness
  const kept = sameHarnessSelection(input.current?.harness, want) ? input.current : undefined
  if (!want) return {
    harnessMode: "unknown",
    readiness: input.data.ready === false || hardFailedHarness(input.data) ? "error" : "unresolved",
    configError: input.data.error ?? undefined,
  }
  return {
    harnessMode: harnessMode(want),
    harness: want,
    selectedModel: input.data.model ?? kept?.selectedModel ?? "",
    selectedModelProvider: input.data.modelProviderId ?? kept?.selectedModelProvider,
    readiness: statusReadiness(input.data),
    connectionState: statusConnection(want, input.data, input.current),
    configError: input.data.error ?? undefined,
    workspaceId: input.data.workspaceId ?? input.current?.workspaceId,
    selectedThoughtLevel: Object.hasOwn(input.data, "thoughtLevel") ? input.data.thoughtLevel : kept?.selectedThoughtLevel,
  }
}

function statusReadiness(data: HarnessState): HarnessStoreState["readiness"] {
  const health = data.harnessHealth?.status
  if (hardFailedHarness(data)) return "error"
  if (data.ready === false) return "polling"
  return health === "degraded" || health === "unavailable" ? "degraded" : "ready"
}

function statusConnection(want: HarnessType, data: HarnessState, current: HarnessStoreState | undefined) {
  if (want.kind !== "connection") return undefined
  if (data.connectionState?.connectionId === want.connectionId) return data.connectionState
  return current?.connectionState?.connectionId === want.connectionId ? current.connectionState : undefined
}

export function readyHarnessHydrationPatch(type: HarnessType, hasConfigOptions = harnessHasConfigOptions(type)): HarnessStorePatch {
  return {
    harness: type,
    harnessMode: harnessMode(type),
    readiness: "ready",
    ...(!hasConfigOptions ? emptyOptionsPatch(type) : {}),
  }
}

export function pollingHarnessHydrationPatch(type?: HarnessType): HarnessStorePatch {
  return {
    ...(type
      ? {
          harness: type,
          harnessMode: harnessMode(type),
          selectedModel: "",
          selectedModelProvider: undefined,
          dynamicModels: null,
          thoughtLevels: null,
          selectedThoughtLevel: undefined,
          serviceTiers: null,
          selectedServiceTier: undefined,
          optionsSource: "empty" as const,
          optionsStale: false,
          optionsLoading: false,
        }
      : {}),
    readiness: "polling",
    configError: undefined,
  }
}

export function harnessSwitchStartPatch(input: {
  type: HarnessType
}): HarnessStorePatch {
  return {
    connectionState: undefined,
    harness: input.type,
    harnessMode: harnessMode(input.type),
    selectedModel: "",
    selectedModelProvider: undefined,
    dynamicModels: null,
    thoughtLevels: null,
    selectedThoughtLevel: undefined,
    serviceTiers: null,
    selectedServiceTier: undefined,
    configError: undefined,
    unavailableHere: undefined,
    readiness: "ready",
    optionsSource: "empty",
    optionsStale: false,
    optionsLoading: harnessHasConfigOptions(input.type),
  }
}

export function harnessHealthReadiness(input: {
  harness?: HarnessType
  current: HarnessReadiness
  health?: HarnessHealth["status"]
}): HarnessReadiness | undefined {
  if (!input.harness) return undefined
  if (input.health === "degraded" || input.health === "unavailable") {
    return input.current === "error" || input.current === "polling" ? undefined : "degraded"
  }
  if (input.health === "ok" && input.current === "degraded") return "ready"
  return undefined
}

function emptyOptionsPatch(type: HarnessType) {
  const model = type.kind === "native" && isCatalogHarnessId(type.harnessId)
    ? {}
    : {
        selectedModel: type.kind === "connection" ? "default" : "",
        selectedModelProvider: undefined,
        selectedThoughtLevel: undefined,
      }
  return {
    ...model,
    dynamicModels: type.kind === "connection" ? [] : null,
    thoughtLevels: null,
    serviceTiers: null,
    selectedServiceTier: undefined,
    optionsSource: "empty" as const,
    optionsStale: false,
    optionsLoading: false,
  }
}
