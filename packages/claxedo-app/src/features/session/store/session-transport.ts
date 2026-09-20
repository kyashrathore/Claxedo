import { createHttpSessionBackend, DEFAULT_SESSION_TRANSPORT_CAPABILITIES } from "@/platform/runtime/http-backend"
import type { SessionTransportCapabilities } from "../data/backend/types"
import type { AgentRuntimeDirectory } from "@/platform/runtime/agent/agent-runtime-client"
import { usesScopedSessionTransport } from "@/platform/identity/legacy-resolver"
import type { SessionRef } from "@/platform/identity/session-ref"
import type { SessionBackend, SessionMessagePageRequest } from "@/platform/runtime/session"
import type { AgentRuntimeGoalMutationResult } from "@/platform/runtime/agent/agent-runtime-client"
import type { AgentRuntimeGoalState } from "@/platform/runtime/agent/agent-runtime-goal-client"
import type { RelayHostKind } from "@/platform/runtime/placement-wire"

export type { SessionTransportCapabilities }
export { DEFAULT_SESSION_TRANSPORT_CAPABILITIES }

export async function fetchTransportSession<TSession, TMessages>(input: {
  shouldFetchSession: boolean
  fetchSession: () => Promise<TSession>
  fetchMessages: () => Promise<TMessages>
}) {
  const [session, messages] = await Promise.all([
    input.shouldFetchSession ? input.fetchSession() : Promise.resolve(undefined),
    input.fetchMessages(),
  ])
  return { session, messages }
}

export function shouldFetchSessionAlongsideHistory(input: {
  before?: string
  view?: "latest-turn" | "latest-surface"
  hasSession: boolean
  force?: boolean
  title?: string
}) {
  // Semantic transcript views are message projections. Session metadata has
  // its own authoritative, deferred directory-cache path and must never join
  // the click's message waterfall.
  if (input.before || input.view === "latest-turn" || input.view === "latest-surface") return false
  return !input.hasSession || input.force === true || !input.title || input.title === "New Session"
}

// Capabilities reported while a scoped-transport session's capabilities fetch
// is still in flight. Optional affordances (permission answering, fork,
// revert, ...) stay hidden until the transport confirms them — offering one it
// lacks would break on click. Abort is the exception and keeps DEFAULT's
// `true`: every shipped harness reports abort:true (agent-sdk-runtime
// harnesses exposed by connection providers and native SDK adapters), and the
// composer's stop control renders from `working() && canAbort()` — a
// pessimistic abort:false here suppressed the stop icon for the ENTIRE first
// turn of a freshly created native session, because `syncSessionCapabilities`
// only runs at delayed first-fold hydration, which lands after a short first
// turn has already gone idle.
export const PENDING_SCOPED_TRANSPORT_CAPABILITIES: SessionTransportCapabilities = {
  ...DEFAULT_SESSION_TRANSPORT_CAPABILITIES,
  permissions: false,
  questions: false,
  commands: false,
  fork: false,
  revert: false,
  unrevert: false,
  configOptions: false,
}

export function usesClaxedoSessionTransport(sessionID: string | undefined, directory?: string) {
  return usesScopedSessionTransport(sessionID, directory)
}

export async function fetchSessionByTransport(input: {
  directory: string
  sessionID: string
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  hostKind?: RelayHostKind
  sessionRef?: SessionRef
}) {
  return await createHttpSessionBackend({
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    hostKind: input.hostKind,
    sessionRef: input.sessionRef,
  }).getSession(input)
}

/**
 * Builds the deferred session-info reader used by the pane cache owner.
 *
 * Session metadata must follow the same SessionRef-selected route as history:
 * a central child is not an upstream workspace session even when its pane has
 * a filesystem directory for tool execution.
 */
export function createSessionInfoHydrationGetter(input: {
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  hostKind?: RelayHostKind
  sessionRef?: SessionRef
}) {
  return async (session: Parameters<SessionBackend["getSession"]>[0]) =>
    (await fetchSessionByTransport({ ...input, ...session })).data
}

export async function fetchSessionMessagesByTransport(input: {
  directory: string
  sessionID: string
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  hostKind?: RelayHostKind
  /**
   * Whether the workspace runtime can currently answer. A dead CLOUD workspace
   * reads its transcript from the control plane instead of the relay — the
   * history synced there outlives the sandbox.
   */
  workspaceReachable?: boolean
  sessionRef?: SessionRef
  signal?: AbortSignal
} & SessionMessagePageRequest) {
  return await createHttpSessionBackend({
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    hostKind: input.hostKind,
    workspaceReachable: input.workspaceReachable,
    sessionRef: input.sessionRef,
  }).listMessages(input)
}

export async function fetchSessionTodoByTransport(input: {
  directory: string
  sessionID: string
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  hostKind?: RelayHostKind
  sessionRef?: SessionRef
}) {
  return await createHttpSessionBackend({
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    hostKind: input.hostKind,
    sessionRef: input.sessionRef,
  }).listTodos(input)
}

/**
 * The harness's own permission modes for a session.
 *
 * Same transport split as the todo fetch beside it, for the same reason: which
 * backend answers depends on the session's scope, and only the runtime transport
 * has this route at all.
 */
export async function fetchSessionPermissionModesByTransport(input: {
  directory: AgentRuntimeDirectory
  sessionID: string
  /** The harness being asked about — see the port doc; required on a draft. */
  harness?: import("@/platform/identity/harness-selection").HarnessSelection
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  hostKind?: RelayHostKind
  sessionRef?: SessionRef
}) {
  return await createHttpSessionBackend({
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    hostKind: input.hostKind,
    sessionRef: input.sessionRef,
  }).getPermissionModes(input)
}

export async function setSessionPermissionModeByTransport(input: {
  directory: AgentRuntimeDirectory
  sessionID: string
  modeId: string
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  hostKind?: RelayHostKind
  sessionRef?: SessionRef
}) {
  return await createHttpSessionBackend({
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    hostKind: input.hostKind,
    sessionRef: input.sessionRef,
  }).setPermissionMode(input)
}

export async function fetchSessionCapabilitiesByTransport(input: {
  directory: string
  sessionID?: string
  harness?: import("@/platform/identity/harness-selection").HarnessSelection
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  hostKind?: RelayHostKind
  sessionRef?: SessionRef
  signal?: AbortSignal
}) {
  return await createHttpSessionBackend({
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    hostKind: input.hostKind,
    sessionRef: input.sessionRef,
  }).getCapabilities(input)
}

export type SessionGoalTransportScope = {
  request?: typeof fetch
  directory: AgentRuntimeDirectory
  sessionID: string
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  hostKind?: RelayHostKind
  sessionRef?: SessionRef
  signal?: AbortSignal
}

function sessionGoalBackend(input: SessionGoalTransportScope) {
  return createHttpSessionBackend({
    request: input.request,
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    hostKind: input.hostKind,
    sessionRef: input.sessionRef,
  })
}

export async function fetchSessionGoalStateByTransport(
  input: SessionGoalTransportScope,
): Promise<AgentRuntimeGoalState> {
  return await sessionGoalBackend(input).getGoalState(input)
}

export async function pauseSessionGoalByTransport(
  input: SessionGoalTransportScope,
): Promise<AgentRuntimeGoalMutationResult> {
  return await sessionGoalBackend(input).pauseGoal(input)
}

export async function resumeSessionGoalByTransport(
  input: SessionGoalTransportScope,
): Promise<AgentRuntimeGoalMutationResult> {
  return await sessionGoalBackend(input).resumeGoal(input)
}

export async function stopSessionGoalByTransport(
  input: SessionGoalTransportScope,
): Promise<AgentRuntimeGoalMutationResult> {
  return await sessionGoalBackend(input).stopGoal(input)
}

export async function deleteSessionGoalByTransport(
  input: SessionGoalTransportScope,
): Promise<AgentRuntimeGoalMutationResult> {
  return await sessionGoalBackend(input).deleteGoal(input)
}
