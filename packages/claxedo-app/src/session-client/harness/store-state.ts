// target-layer: session-client
import {
  desiredHarness,
  effectiveHarnessModel,
  failedHarness,
  harnessHasConfigOptions,
  type HarnessState,
  type HarnessType,
  type OptionsSource,
} from "./profile"
import { harnessMode, type HarnessReadiness } from "./selection"
import { initialHarness, initialValue } from "./store-policy"

export type HarnessStoreState = {
  harnessMode: "opencode" | "harness" | "unknown"
  harnessBinary: string
  harness: HarnessType
  selectedModel: string
  selectedAgent: string
  dynamicModels: { id: string; name: string }[] | null
  readiness: HarnessReadiness
  optionsSource: OptionsSource
  optionsStale: boolean
  optionsLoading: boolean
  configError?: string
  workspaceId?: string
}

export type HarnessStorePatch = Partial<HarnessStoreState>

export function initialHarnessStoreState(input: {
  scope: string
  savedHarness?: string
  savedModel?: string
  savedAgent?: string
  legacyHarness?: string | null
  legacyModel?: string | null
  legacyAgent?: string | null
}): HarnessStoreState {
  const type = initialHarness(input.scope, input.savedHarness, input.legacyHarness)
  return {
    harnessMode: harnessMode(type),
    harnessBinary: "",
    harness: type,
    selectedModel: effectiveHarnessModel(type, initialValue(input.scope, input.savedModel, input.legacyModel)),
    selectedAgent: initialValue(input.scope, input.savedAgent, input.legacyAgent),
    dynamicModels: null,
    readiness: "ready",
    optionsSource: "empty",
    optionsStale: false,
    optionsLoading: false,
    configError: undefined,
  }
}

export function workspaceDraftHarnessResetPatch(): HarnessStorePatch {
  return {
    harness: "opencode",
    harnessMode: "opencode",
    selectedModel: "",
    dynamicModels: null,
    readiness: "ready",
    optionsSource: "empty",
    optionsStale: false,
    optionsLoading: false,
    configError: undefined,
  }
}

export function harnessStatusPatch(input: {
  data: HarnessState
  current?: HarnessStoreState
}): HarnessStorePatch {
  const want = desiredHarness(input.data) ?? input.current?.harness ?? "opencode"
  return {
    harnessMode: harnessMode(want),
    harnessBinary: input.data.activeBinary ?? input.data.binary ?? "",
    harness: want,
    selectedModel: input.data.model ?? (want === "opencode" ? "" : (input.current?.selectedModel ?? "")),
    ...(want === "opencode" ? emptyOptionsPatch() : {}),
    readiness: failedHarness(input.data) ? "error" : "ready",
    configError: input.data.error ?? undefined,
    workspaceId: input.data.workspaceId ?? input.current?.workspaceId,
  }
}

export function readyHarnessHydrationPatch(type: HarnessType): HarnessStorePatch {
  return {
    harnessMode: harnessMode(type),
    readiness: "ready",
    ...(!harnessHasConfigOptions(type) ? emptyOptionsPatch() : {}),
  }
}

export function readyHarnessFallbackPatch(type: HarnessType): HarnessStorePatch {
  return {
    harnessMode: harnessMode(type),
    readiness: "ready",
    ...emptyOptionsPatch(),
  }
}

export function harnessSwitchStartPatch(input: {
  type: HarnessType
  useLocalHarnessConfig: boolean
}): HarnessStorePatch {
  return {
    harness: input.type,
    harnessMode: harnessMode(input.type),
    selectedModel: effectiveHarnessModel(input.type),
    dynamicModels: null,
    configError: undefined,
    readiness: "ready",
    optionsSource: "empty",
    optionsStale: false,
    optionsLoading: input.useLocalHarnessConfig && harnessHasConfigOptions(input.type),
  }
}

function emptyOptionsPatch() {
  return {
    dynamicModels: null,
    optionsSource: "empty" as const,
    optionsStale: false,
    optionsLoading: false,
  }
}
