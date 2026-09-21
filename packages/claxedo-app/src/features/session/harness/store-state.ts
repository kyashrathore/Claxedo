import type { HarnessConnectionRef } from "@claxedo/agent-runtime-contract"
import {
  desiredHarness,
  hardFailedHarness,
  harnessHasConfigOptions,
  type HarnessHealthStatus,
  type HarnessConnectionState,
  type HarnessModelOption,
  type HarnessState,
  type HarnessType,
  type OptionsSource,
} from "./profile"
import { harnessMode, type HarnessReadiness } from "./selection"
import type { DraftDefault } from "./draft-defaults"
import type { DraftDefaultAuthority, DraftDefaultResult } from "./draft-default-policy"
import { isCatalogHarnessId } from "@/platform/identity/harness-selection"

export type HarnessStoreState = {
  harnessMode: "harness" | "unknown"
  harness?: HarnessType
  selectedModel: string
  selectedModelProvider?: string
  dynamicModels: HarnessModelOption[] | null
  /** Reasoning/thinking levels the harness offers; `[]` = none, `null` = unknown. */
  thoughtLevels: HarnessModelOption[] | null
  selectedThoughtLevel: string | undefined
  readiness: HarnessReadiness
  connectionDeclaration?: HarnessConnectionRef
  connectionState?: HarnessConnectionState
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
  return {
    harnessMode: "unknown",
    harness: undefined,
    selectedModel: "",
    selectedModelProvider: undefined,
    dynamicModels: null,
    thoughtLevels: null,
    selectedThoughtLevel: undefined,
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
  // A COMPLETED switch response (harness-switcher applyPostedStatus), as opposed
  // to a startup/in-flight hydration probe. A completed response is definitive:
  // ready:false means the switch finished and the harness is unavailable, so it
  // is an "error", not "polling". Default (probe) keeps the connecting semantics.
  settled?: boolean
}): HarnessStorePatch {
  const want = desiredHarness(input.data) ?? input.current?.harness
  if (!want) return {
    harnessMode: "unknown",
    readiness: input.data.ready === false || hardFailedHarness(input.data) ? "error" : "unresolved",
    configError: input.data.error ?? undefined,
  }
  // A harness that reports ready:false without a hard failure
  // (status "error" or an error message) is still CONNECTING during a startup or
  // in-flight probe — surface that as "polling" so the selector renders a
  // "Connecting" pill instead of a red "Unavailable". A hard failure — or a
  // ready:false carried by a *settled* completed switch response — is "error".
  // A live-but-degraded harness (`ready:true` while `harnessHealth.status` is
  // degraded/unavailable — the process was lost and is recovering) maps to
  // "degraded", which drives the composer health peek and the Send gate.
  // Precedence: a hard failure still wins; a still-connecting harness
  // (`ready === false`, i.e. startup) stays "polling" — a genuinely process-lost
  // harness reports `ready:true`, so the two never legitimately coincide, and
  // ordering polling first avoids a startup flicker of "The agent stopped
  // responding".
  const health = input.data.harnessHealth?.status
  const readiness: HarnessStoreState["readiness"] = hardFailedHarness(input.data)
    ? "error"
    : input.data.ready === false
      ? (input.settled ? "error" : "polling")
      : health === "degraded" || health === "unavailable"
        ? "degraded"
        : "ready"
  return {
    harnessMode: harnessMode(want),
    harness: want,
    selectedModel: input.data.model ?? input.current?.selectedModel ?? "",
    selectedModelProvider: input.data.modelProviderID ?? input.current?.selectedModelProvider,
    readiness,
    connectionState: want.kind === "connection" && input.data.connectionState?.connectionId === want.connectionId
      ? input.data.connectionState
      : want.kind === "connection" && input.current?.connectionState?.connectionId === want.connectionId ? input.current.connectionState : undefined,
    configError: input.data.error ?? undefined,
    workspaceId: input.data.workspaceId ?? input.current?.workspaceId,
  }
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
    configError: undefined,
    readiness: "ready",
    optionsSource: "empty",
    optionsStale: false,
    optionsLoading: harnessHasConfigOptions(input.type),
  }
}

/**
 * The readiness transition a standing harness-health probe should apply, or
 * `undefined` to leave readiness untouched. It only moves between "ready" and
 * "degraded"; a hard "error" or an in-flight "polling" belongs to hydration /
 * harness-switch and is left alone, so the health poll never fights them.
 */
export function harnessHealthReadiness(input: {
  harness?: HarnessType
  current: HarnessReadiness
  health?: HarnessHealthStatus
}): HarnessReadiness | undefined {
  if (!input.harness) return undefined
  if (input.health === "degraded" || input.health === "unavailable") {
    return input.current === "error" || input.current === "polling" ? undefined : "degraded"
  }
  if (input.health === "ok" && input.current === "degraded") return "ready"
  return undefined
}

function emptyOptionsPatch(type: HarnessType) {
  // A catalog harness's model list is provider-backed, not harness-config-
  // backed. A saved draft model may be resolved before this hydration patch
  // lands, so it must not erase that canonical provider/model pair merely
  // because it has no harness config-options endpoint.
  const model = type.kind === "native" && isCatalogHarnessId(type.harnessId)
    ? {}
    : {
        selectedModel: type.kind === "connection" ? "default" : "",
        selectedModelProvider: undefined,
      }
  return {
    ...model,
    dynamicModels: type.kind === "connection" ? [] : null,
    thoughtLevels: null,
    selectedThoughtLevel: undefined,
    optionsSource: "empty" as const,
    optionsStale: false,
    optionsLoading: false,
  }
}
