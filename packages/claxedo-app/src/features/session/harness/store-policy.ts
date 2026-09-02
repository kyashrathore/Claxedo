import {
  isDraftPaneScope,
  panePreferenceScope,
} from "@/features/session/preferences/pane"
import { isFilesystemDirectory } from "@/platform/identity/legacy-resolver"
import { sessionWorkspaceRuntimeRef, type SessionWorkspaceRuntimeInput } from "@/platform/runtime/session-workspace"
import { centralTransportForServer } from "@/platform/runtime/transport"
import { isRelayBackedWorkspaceKind, type WorkspaceKind } from "@/platform/runtime/agent/workspace-kind"
import { normalizedAgentRuntimeServerUrl } from "@/platform/runtime/agent/agent-runtime-urls"
import {
  sessionResourceAuthorityKey,
  sessionResourceAuthorityScope,
} from "../store/session-resource-authority"
import type { SessionRef } from "@/platform/identity/session-ref"
import {
  harnessHasConfigOptions,
  pickHarness,
  type HarnessState,
  type HarnessType,
} from "./profile"

export const MODEL_OPTIONS_RETRY_LIMIT = 5

export type HarnessScopeInput = {
  directory?: undefined | string
  sessionId?: string
  sessionRef?: SessionRef
}

export const harnessScope = panePreferenceScope
export const isDraftScope = isDraftPaneScope

/**
 * The harness a scope's transient state starts on: OpenCode, the product's
 * default, stated once here. Every real answer — the workspace's draft default
 * or the session's own config — replaces it during hydration.
 */
export function initialHarness(): HarnessType {
  return "opencode"
}

export function shouldShowModelOptionsStaleWarning(input: {
  stale: boolean
  models: { id: string; name: string }[] | null | undefined
}) {
  return input.stale && (input.models?.length ?? 0) === 0
}

export function shouldRetryModelOptions(input: {
  stale: boolean
  tries: number
  limit?: number
}) {
  return input.stale && input.tries < (input.limit ?? MODEL_OPTIONS_RETRY_LIMIT)
}

export function modelOptionsUnavailableMessage(input: {
  stale: boolean
}) {
  return input.stale ? "Model options unavailable" : "No model options available"
}

export function shouldFetchConfigOptionsForScope(type: HarnessType, failed: boolean, _input?: HarnessScopeInput) {
  // Existing sessions load selectable models too: an active session's picker
  // must not render empty just because the scope has already hydrated.
  return harnessHasConfigOptions(type) && !failed
}

export function shouldRefreshDirectoryAfterHarnessStatus(input?: HarnessScopeInput) {
  return !input?.sessionId || input.sessionId === "new"
}

/**
 * Whether a new-session draft takes its harness from the workspace's status
 * probe. A workspace served by a machine — this one (`local`) or one reached
 * through the relay (`user-hosted`) — carries that machine's harness
 * configuration, and a draft starts from it exactly as the desktop does. Cloud
 * sandboxes keep the draft-default policy.
 */
export function shouldHydrateDraftFromHarnessStatus(input: {
  useLocalHarnessConfig: boolean
  workspaceRuntime?: boolean
  workspaceKind?: WorkspaceKind | null
}) {
  if (input.workspaceKind === "user-hosted") return true
  if (!input.useLocalHarnessConfig) return false
  if (!input.workspaceRuntime) return true
  return input.workspaceKind === "local"
}

/**
 * `projects` is the signed workspace inventory (the same shape
 * `signedWorkspaceFromProjects` matches against). It is optional and defaults
 * to none so existing callers that only know the directory keep their prior
 * behavior; a caller that has the inventory in hand (the harness config
 * runtime, which threads its own `input.projects()`) passes it so a
 * user-hosted workspace addressed by its filesystem-path directory still
 * resolves to its `workspaceId` instead of falling through unresolved.
 */
export function harnessWorkspaceRuntimeRef(
  input?: HarnessScopeInput,
  projects?: SessionWorkspaceRuntimeInput["projects"],
) {
  return input?.directory ? sessionWorkspaceRuntimeRef({ directory: input.directory, projects }) : undefined
}

export function refreshHarnessTypeForScope(input: {
  directory?: string
  harness: HarnessType
}): HarnessType | undefined {
  if (input.harness !== "opencode") return input.harness
  return harnessWorkspaceRuntimeRef(input) ? "opencode" : undefined
}

/**
 * WHICH MACHINE answers a harness-config request, and for what.
 *
 * A pane scope is a directory string and a surface id; two servers exposing the
 * same worktree produce the same scope, so on its own it named one cache entry
 * for two runtimes. This carries the machine and the workspace it serves as
 * well, and it is the SAME tuple `session-capabilities-query.ts` keys on —
 * built by the same `sessionResourceAuthorityKey`, not a second builder that
 * can drift from it.
 */
export type HarnessConfigAuthority = HarnessScopeInput & {
  serverUrl?: string
  workspaceId?: string
  workspaceKind?: WorkspaceKind | null
}

export function harnessConfigAuthorityKey(authority: HarnessConfigAuthority) {
  const kind = authority.workspaceKind
  const relayBacked = isRelayBackedWorkspaceKind(kind)
  return sessionResourceAuthorityKey(sessionResourceAuthorityScope({
    sessionID: authority.sessionId ?? "",
    directory: authority.directory ?? "",
    serverUrl: authority.serverUrl,
    signedControlPlane: relayBacked,
    ...(authority.workspaceId ? { workspaceId: authority.workspaceId } : {}),
    ...(relayBacked ? { workspaceKind: kind } : {}),
    ...(authority.sessionRef ? { sessionRef: authority.sessionRef } : {}),
  }))
}

export function harnessChangeKey(authority: HarnessConfigAuthority, type: HarnessType, binary?: string) {
  return JSON.stringify([harnessConfigAuthorityKey(authority), type, binary ?? ""])
}

export function harnessChangeRequestKey(key: string) {
  return ["shell", "harness-config", "harness-change", key] as const
}

/** The machine component every scope-keyed harness-config entry carries. */
function server(serverUrl: string) {
  return normalizedAgentRuntimeServerUrl(serverUrl)
}

export function harnessHydrateRequestKey(serverUrl: string, scope: string) {
  return ["shell", "harness-config", "hydrate", server(serverUrl), scope] as const
}

export function harnessHydrateSeenKey(serverUrl: string, scope: string) {
  return ["shell", "harness-config", "hydrate", server(serverUrl), scope, "seen"] as const
}

export function harnessPreparedSessionKey(serverUrl: string, scope: string) {
  return ["shell", "harness-config", "prepared-session", server(serverUrl), scope] as const
}

export function harnessOptionsSeqKey(serverUrl: string, scope: string) {
  return ["shell", "harness-config", "options", server(serverUrl), scope, "seq"] as const
}

export function harnessOptionsTriesKey(serverUrl: string, scope: string) {
  return ["shell", "harness-config", "options", server(serverUrl), scope, "tries"] as const
}

export function harnessPreparedSessionSeqKey(serverUrl: string, scope: string) {
  return ["shell", "harness-config", "prepared-session", server(serverUrl), scope, "seq"] as const
}

export function harnessPreparingSessionKey(serverUrl: string, scope: string) {
  return ["shell", "harness-config", "prepared-session", server(serverUrl), scope, "prepare"] as const
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

export function sessionModelSyncKey(authority: HarnessConfigAuthority) {
  if (!authority.directory || !authority.sessionId || authority.sessionId === "new") return undefined
  return JSON.stringify(harnessConfigAuthorityKey(authority))
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
  workspaceKind?: WorkspaceKind | null
}) {
  if (isRelayBackedWorkspaceKind(input.workspaceKind)) return false
  return centralTransportForServer(input.baseUrl) === "loopback" && isFilesystemDirectory(input.directory)
}
