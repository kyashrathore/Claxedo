import {
  initialPaneHarness,
  initialPaneValue,
  isDraftPaneScope,
  panePreferenceScope,
} from "@/features/session/preferences/pane"
import { isFilesystemDirectory } from "@/platform/identity/legacy-resolver"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { centralTransportForServer } from "@/platform/runtime/transport"
import type { SessionRef } from "@/platform/identity/session-ref"
import { harnessHasConfigOptions, pickHarness, type HarnessState, type HarnessType } from "./profile"

export const MODEL_OPTIONS_RETRY_LIMIT = 5

export type HarnessScopeInput = {
  directory?: undefined | string
  sessionId?: string
  sessionRef?: SessionRef
}

export type HarnessWorkspaceKind = "local" | "cloud" | "user-hosted"

export const harnessScope = panePreferenceScope
export const isDraftScope = isDraftPaneScope
export const initialValue = initialPaneValue

export function initialHarness(scope: string, saved?: string, legacy?: string | null): HarnessType {
  // Draft scopes ignore the legacy harness default and fall through to OpenCode.
  // Session scopes still honor the legacy default when they have one.
  return pickHarness(initialPaneHarness(scope, saved, legacy), null) ?? "opencode"
}

export function shouldShowModelOptionsStaleWarning(input: {
  stale: boolean
  models: { id: string; name: string }[] | null | undefined
}) {
  return input.stale && (input.models?.length ?? 0) === 0
}

export function shouldRetryModelOptions(input: { stale: boolean; tries: number; limit?: number }) {
  return input.stale && input.tries < (input.limit ?? MODEL_OPTIONS_RETRY_LIMIT)
}

export function modelOptionsUnavailableMessage(input: { stale: boolean }) {
  return input.stale ? "Model options unavailable" : "No model options available"
}

export function shouldFetchConfigOptionsForScope(type: HarnessType, failed: boolean, input?: HarnessScopeInput) {
  const existingSession = !!input?.sessionId && input.sessionId !== "new"
  return harnessHasConfigOptions(type) && !failed && !existingSession
}

export function shouldRefreshDirectoryAfterHarnessStatus(input?: HarnessScopeInput) {
  return !input?.sessionId || input.sessionId === "new"
}

export function shouldHydrateDraftFromHarnessStatus(input: {
  useLocalHarnessConfig: boolean
  workspaceRuntime?: boolean
  workspaceKind?: HarnessWorkspaceKind | null
}) {
  if (!input.useLocalHarnessConfig) return false
  if (!input.workspaceRuntime) return true
  return input.workspaceKind === "local"
}

export function harnessWorkspaceRuntimeRef(input?: HarnessScopeInput) {
  return input?.directory ? sessionWorkspaceRuntimeRef({ directory: input.directory }) : undefined
}

export function refreshHarnessTypeForScope(input: {
  directory?: string
  harness: HarnessType
}): HarnessType | undefined {
  if (input.harness !== "opencode") return input.harness
  return harnessWorkspaceRuntimeRef(input) ? "opencode" : undefined
}

export function harnessChangeKey(scope: string, type: HarnessType, binary?: string) {
  return `${scope}\n${type}\n${binary ?? ""}`
}

export function harnessChangeRequestKey(key: string) {
  return ["shell", "harness-config", "harness-change", key] as const
}

export function harnessHydrateRequestKey(scope: string) {
  return ["shell", "harness-config", "hydrate", scope] as const
}

export function harnessHydrateSeenKey(scope: string) {
  return ["shell", "harness-config", "hydrate", scope, "seen"] as const
}

export function harnessPreparedSessionKey(scope: string) {
  return ["shell", "harness-config", "prepared-session", scope] as const
}

export function harnessOptionsSeqKey(scope: string) {
  return ["shell", "harness-config", "options", scope, "seq"] as const
}

export function harnessOptionsTriesKey(scope: string) {
  return ["shell", "harness-config", "options", scope, "tries"] as const
}

export function harnessPreparedSessionSeqKey(scope: string) {
  return ["shell", "harness-config", "prepared-session", scope, "seq"] as const
}

export function harnessPreparingSessionKey(scope: string) {
  return ["shell", "harness-config", "prepared-session", scope, "prepare"] as const
}

export function harnessStateFromSessionConfig(input: {
  harness?: HarnessState
  model?: { providerID?: string | null; modelID?: string | null } | null
}): HarnessState | undefined {
  const harness = input.harness
  const type = pickHarness(harness?.type, harness?.binary)
  if (!harness || !type) return undefined
  return {
    ...harness,
    type,
    model: harness.model ?? input.model?.modelID ?? undefined,
    modelProviderID: harness.modelProviderID ?? input.model?.providerID ?? undefined,
    status: "ready",
    ready: true,
    activeType: type,
    activeBinary: harness.binary ?? null,
  }
}

export function sessionModelSyncKey(base: string, input?: HarnessScopeInput) {
  if (!input?.directory || !input.sessionId || input.sessionId === "new") return undefined
  return `${base}\n${input.sessionId}`
}

export function sessionModelSyncStateKey(key: string) {
  return ["shell", "harness-config", "session-model", key] as const
}

export function sessionModelSyncRequestKey(key: string, model: string) {
  return ["shell", "harness-config", "session-model", key, "sync", model] as const
}

export function shouldUseLocalHarnessConfigApi(input: {
  baseUrl?: string
  directory?: string
  workspaceKind?: HarnessWorkspaceKind | null
}) {
  if (isRemoteHarnessWorkspaceKind(input.workspaceKind)) return false
  return centralTransportForServer(input.baseUrl) === "loopback" && isFilesystemDirectory(input.directory)
}

function isRemoteHarnessWorkspaceKind(input?: HarnessWorkspaceKind | null) {
  return input === "cloud" || input === "user-hosted"
}
