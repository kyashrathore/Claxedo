// target-layer: session
import {
  desiredHarness,
  effectiveHarnessModel,
  hardFailedHarness,
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
  // A COMPLETED switch response (harness-switcher applyPostedStatus), as opposed
  // to a startup/in-flight hydration probe. A completed response is definitive:
  // ready:false means the switch finished and the harness is unavailable, so it
  // is an "error", not "polling". Default (probe) keeps the connecting semantics.
  settled?: boolean
}): HarnessStorePatch {
  const want = desiredHarness(input.data) ?? input.current?.harness ?? "opencode"
  // A non-opencode harness that reports ready:false without a hard failure
  // (status "error" or an error message) is still CONNECTING during a startup or
  // in-flight probe — surface that as "polling" so the selector renders a
  // "Connecting" pill instead of a red "Unavailable". OpenCode is the
  // always-available local default and never polls. A hard failure — or a
  // ready:false carried by a *settled* completed switch response — is "error".
  const readiness: HarnessStoreState["readiness"] = hardFailedHarness(input.data)
    ? "error"
    : want !== "opencode" && input.data.ready === false
      ? (input.settled ? "error" : "polling")
      : "ready"
  return {
    harnessMode: harnessMode(want),
    harnessBinary: input.data.activeBinary ?? input.data.binary ?? "",
    harness: want,
    selectedModel: input.data.model ?? (want === "opencode" ? "" : (input.current?.selectedModel ?? "")),
    ...(want === "opencode" ? emptyOptionsPatch() : {}),
    readiness,
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
    optionsLoading: harnessHasConfigOptions(input.type),
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
