import { createHttpSessionBackend, DEFAULT_OPENCODE_TRANSPORT_CAPABILITIES } from "@/platform/runtime/http-backend"
import type { SessionTransportCapabilities } from "../data/backend/types"
import type { AgentRuntimeDirectory } from "@/platform/runtime/agent/agent-runtime-client"
import { usesScopedSessionTransport } from "@/platform/identity/legacy-resolver"
import { suppressedByFastSessionSwitch } from "@/platform/runtime/session-switch"
import type { SessionRef } from "@/platform/identity/session-ref"
import type { SessionMessagePageRequest } from "@/platform/runtime/session"
import type { AgentRuntimeGoalMutationResult } from "@/platform/runtime/agent/agent-runtime-client"
import type { AgentRuntimeGoalState } from "@/platform/runtime/agent/agent-runtime-goal-client"

export type SessionClient = Parameters<typeof createHttpSessionBackend>[0]["client"]

export type { SessionTransportCapabilities }
export { DEFAULT_OPENCODE_TRANSPORT_CAPABILITIES }

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
// harnesses acp/opencode/pi and the shared sdk-runtime-adapter), and the
// composer's stop control renders from `working() && canAbort()` — a
// pessimistic abort:false here suppressed the stop icon for the ENTIRE first
// turn of a freshly created native session, because `syncSessionCapabilities`
// only runs at delayed first-fold hydration, which lands after a short first
// turn has already gone idle.
export const PENDING_SCOPED_TRANSPORT_CAPABILITIES: SessionTransportCapabilities = {
  ...DEFAULT_OPENCODE_TRANSPORT_CAPABILITIES,
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
  client: SessionClient
  directory: string
  sessionID: string
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
  sessionRef?: SessionRef
}) {
  return await createHttpSessionBackend({
    client: input.client,
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    workspaceKind: input.workspaceKind,
    sessionRef: input.sessionRef,
  }).getSession(input)
}

export async function fetchSessionMessagesByTransport(input: {
  client: SessionClient
  directory: string
  sessionID: string
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
  /**
   * Whether the workspace runtime can currently answer. A dead CLOUD workspace
   * reads its transcript from the control plane instead of the relay — the
   * history synced there outlives the sandbox.
   */
  workspaceReachable?: boolean
  sessionRef?: SessionRef
  signal?: AbortSignal
  /** Explicit user intent owns this read even while background switch work is suppressed. */
  bypassQuiet?: boolean
} & SessionMessagePageRequest) {
  if (!input.bypassQuiet && suppressedByFastSessionSwitch(input.sessionID)) {
    return { data: [], response: new Response(null) }
  }
  return await createHttpSessionBackend({
    client: input.client,
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    workspaceKind: input.workspaceKind,
    workspaceReachable: input.workspaceReachable,
    sessionRef: input.sessionRef,
  }).listMessages(input)
}

export async function fetchSessionTodoByTransport(input: {
  client: SessionClient
  directory: string
  sessionID: string
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
  sessionRef?: SessionRef
}) {
  return await createHttpSessionBackend({
    client: input.client,
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    workspaceKind: input.workspaceKind,
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
  client: SessionClient
  directory: AgentRuntimeDirectory
  sessionID: string
  /** The harness being asked about — see the port doc; required on a draft. */
  harness?: string
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
  sessionRef?: SessionRef
}) {
  return await createHttpSessionBackend({
    client: input.client,
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    workspaceKind: input.workspaceKind,
    sessionRef: input.sessionRef,
  }).getPermissionModes(input)
}

export async function setSessionPermissionModeByTransport(input: {
  client: SessionClient
  directory: AgentRuntimeDirectory
  sessionID: string
  modeId: string
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
  sessionRef?: SessionRef
}) {
  return await createHttpSessionBackend({
    client: input.client,
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    workspaceKind: input.workspaceKind,
    sessionRef: input.sessionRef,
  }).setPermissionMode(input)
}

export async function fetchSessionCapabilitiesByTransport(input: {
  client: SessionClient
  directory: string
  sessionID?: string
  harness?: string
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
  sessionRef?: SessionRef
  signal?: AbortSignal
}) {
  return await createHttpSessionBackend({
    client: input.client,
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    workspaceKind: input.workspaceKind,
    sessionRef: input.sessionRef,
  }).getCapabilities(input)
}

export type SessionGoalTransportScope = {
  client: SessionClient
  directory: AgentRuntimeDirectory
  sessionID: string
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
  sessionRef?: SessionRef
  signal?: AbortSignal
}

function sessionGoalBackend(input: SessionGoalTransportScope) {
  return createHttpSessionBackend({
    client: input.client,
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    workspaceKind: input.workspaceKind,
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
