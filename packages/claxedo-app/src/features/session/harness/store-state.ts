import {
  desiredHarness,
  effectiveHarnessModel,
  hardFailedHarness,
  harnessHasConfigOptions,
  type HarnessHealthStatus,
  type HarnessModelOption,
  type HarnessState,
  type HarnessType,
  type OptionsSource,
} from "./profile"
import { harnessMode, type HarnessReadiness } from "./selection"
import { initialHarness } from "./store-policy"
import type { DraftDefault } from "./draft-defaults"
import type { DraftDefaultAuthority, DraftDefaultResult } from "./draft-default-policy"

export type HarnessStoreState = {
  harnessMode: "opencode" | "harness" | "unknown"
  harnessBinary: string
  harness: HarnessType
  selectedModel: string
  selectedModelProvider?: string
  selectedAgent: string
  dynamicModels: HarnessModelOption[] | null
  /** Reasoning/thinking levels the harness offers; `[]` = none, `null` = unknown. */
  thoughtLevels: HarnessModelOption[] | null
  selectedThoughtLevel: string | undefined
  readiness: HarnessReadiness
  optionsSource: OptionsSource
  optionsStale: boolean
  optionsLoading: boolean
  configError?: string
  workspaceId?: string
  draftDefaultAuthority?: DraftDefaultAuthority
  draftDefaultRevision?: number
  draftDefaultServerUrl?: string
  draftDefaultWorkspaceKey?: string
  draftDefault?: DraftDefault
  draftDefaultState?: DraftDefaultResult["state"]
  draftDefaultWritePending?: boolean
}

export type HarnessStorePatch = Partial<HarnessStoreState>

/**
 * The TRANSIENT seed a scope starts from, before any authority answers.
 *
 * It carries no remembered choice: a draft's remembered (harness, model) comes
 * from the per-(server, workspace, harness) draft defaults, and an existing
 * session's comes from its session config. Both overwrite this within the same
 * hydration.
 */
export function initialHarnessStoreState(input: {
  scope: string
}): HarnessStoreState {
  const type = initialHarness()
  return {
    harnessMode: harnessMode(type),
    harnessBinary: "",
    harness: type,
    selectedModel: effectiveHarnessModel(type, ""),
    selectedModelProvider: type === "pi" ? undefined : type,
    selectedAgent: "",
    dynamicModels: null,
    thoughtLevels: null,
    selectedThoughtLevel: undefined,
    readiness: "ready",
    optionsSource: "empty",
    optionsStale: false,
    optionsLoading: false,
    configError: undefined,
    draftDefaultAuthority: scopeAuthority(input.scope),
    draftDefaultRevision: 0,
    draftDefaultWritePending: false,
  }
}

function scopeAuthority(scope: string): DraftDefaultAuthority {
  return scope.startsWith("session:") ? "server" : "unresolved"
}

export function workspaceDraftHarnessResetPatch(): HarnessStorePatch {
  return {
    harness: "opencode",
    harnessMode: "opencode",
    selectedModel: "",
    selectedModelProvider: undefined,
    dynamicModels: null,
    thoughtLevels: null,
    selectedThoughtLevel: undefined,
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
  // A live-but-degraded harness (`/api/wr/health` reports `ok:true`/`ready:true`
  // while `harnessHealth.status` is degraded/unavailable — the harness process was
  // lost and is recovering) maps to the "degraded" readiness. This finally
  // populates the union member declared at selection.ts:9 that has been inert
  // since it was written, and drives the composer health peek + Send gate (T4).
  // Precedence: a hard failure still wins; a still-connecting harness
  // (`ready === false`, i.e. startup) stays "polling" — a genuinely process-lost
  // harness reports `ready:true`, so the two never legitimately coincide, and
  // ordering polling first avoids a startup flicker of "The agent stopped
  // responding". OpenCode — the always-available local default — never degrades.
  const health = input.data.harnessHealth?.status
  const readiness: HarnessStoreState["readiness"] = hardFailedHarness(input.data)
    ? "error"
    : want !== "opencode" && input.data.ready === false
      ? (input.settled ? "error" : "polling")
      : want !== "opencode" && (health === "degraded" || health === "unavailable")
        ? "degraded"
        : "ready"
  return {
    harnessMode: harnessMode(want),
    harnessBinary: input.data.activeBinary ?? input.data.binary ?? "",
    harness: want,
    selectedModel: input.data.model ?? (want === "opencode" ? "" : (input.current?.selectedModel ?? "")),
    selectedModelProvider: input.data.modelProviderID ?? (want === "opencode" ? undefined : input.current?.selectedModelProvider),
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
    harness: input.type,
    harnessMode: harnessMode(input.type),
    selectedModel: "",
    selectedModelProvider: undefined,
    dynamicModels: null,
    thoughtLevels: null,
    selectedThoughtLevel: undefined,
    configError: undefined,
    readiness: "ready",
    optionsSource: "empty",
    optionsStale: false,
    optionsLoading: harnessHasConfigOptions(input.type),
  }
}

/**
 * The readiness transition a standing harness-health probe (T4) should apply, or
 * `undefined` to leave readiness untouched. Deliberately narrow: it only moves
 * between "ready" and "degraded" and never stomps a state owned by another
 * source — a hard "error" or an in-flight "polling" is left alone, and OpenCode
 * (the always-available local default) never degrades. This keeps the modest
 * 20s health poll from fighting hydration / harness-switch over readiness.
 */
export function harnessHealthReadiness(input: {
  harness: HarnessType
  current: HarnessReadiness
  health?: HarnessHealthStatus
}): HarnessReadiness | undefined {
  if (input.harness === "opencode") return undefined
  if (input.health === "degraded" || input.health === "unavailable") {
    return input.current === "error" || input.current === "polling" ? undefined : "degraded"
  }
  if (input.health === "ok" && input.current === "degraded") return "ready"
  return undefined
}

function emptyOptionsPatch() {
  return {
    dynamicModels: null,
    thoughtLevels: null,
    selectedThoughtLevel: undefined,
    optionsSource: "empty" as const,
    optionsStale: false,
    optionsLoading: false,
  }
}
