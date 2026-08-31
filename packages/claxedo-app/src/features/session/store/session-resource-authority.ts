import type { SessionRef } from "@/platform/identity/session-ref"
import { normalizedAgentRuntimeServerUrl, type AgentRuntimeDirectory } from "@/platform/runtime/agent/agent-runtime-urls"

export type SessionResourceAuthorityScope = {
  sessionID: string
  directory: AgentRuntimeDirectory
  serverUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
  sessionRef?: SessionRef
}

/**
 * The single builder for a session-resource authority scope.
 *
 * The workspace identity belongs to the authority only when the signed control
 * plane routes the request; an unsigned/loopback transport addresses the runtime
 * directly and folding a workspace id into its key names an authority nothing
 * reads. Every producer — the pane query keys, the goal read/mutation transport,
 * and the live event stream — builds its scope here so the reader and the writer
 * of a cache entry can never disagree about that gate.
 */
export function sessionResourceAuthorityScope(input: {
  sessionID: string
  directory: AgentRuntimeDirectory
  serverUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
  sessionRef?: SessionRef
}): SessionResourceAuthorityScope {
  const signedControlPlane = input.signedControlPlane === true
  return {
    sessionID: input.sessionID,
    directory: input.directory,
    ...(input.serverUrl === undefined ? {} : { serverUrl: input.serverUrl }),
    signedControlPlane,
    ...(signedControlPlane && input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(signedControlPlane && input.workspaceKind ? { workspaceKind: input.workspaceKind } : {}),
    ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
  }
}

export function sessionHydrationAuthorityKey(ref: SessionRef | undefined) {
  if (!ref) return "unresolved"
  return JSON.stringify(sessionRefAuthority(ref))
}

function sandboxAuthority(ref: SessionRef) {
  const sandbox = ref.toolSandbox
  if (!sandbox) return null
  if (sandbox.kind === "virtual") return ["virtual"] as const
  if (sandbox.kind === "local") return ["local", sandbox.cwd] as const
  return ["workspace", sandbox.workspaceId, sandbox.hosting, sandbox.hostId ?? ""] as const
}

function sessionRefAuthority(ref: SessionRef | undefined) {
  if (!ref) return null
  return [
    ref.sessionId,
    ref.host,
    ref.workspaceId ?? "",
    ref.cwd ?? "",
    sandboxAuthority(ref),
    ref.harness ? [ref.harness.id, ref.harness.binary ?? ""] as const : null,
  ] as const
}

function workspaceAuthority(scope: SessionResourceAuthorityScope) {
  const ref = scope.sessionRef
  if (!ref) return [scope.workspaceId ?? "", scope.workspaceKind ?? ""] as const
  const sandbox = ref.toolSandbox
  if (sandbox?.kind === "workspace") return [sandbox.workspaceId, sandbox.hosting] as const
  return [ref.workspaceId ?? "", ""] as const
}

/**
 * Canonical identity of the authority that answers a session resource read.
 *
 * Keep this tuple data-only and compact: it is embedded in TanStack Query keys,
 * so it must distinguish transport routes without retaining request clients or
 * closures. The complete SessionRef is intentional. A central session and a
 * workspace-backed session may share an opaque id, workspace id, and directory
 * while still naming different authoritative resources.
 */
export function sessionResourceAuthorityKey(scope: SessionResourceAuthorityScope) {
  const workspace = workspaceAuthority(scope)
  return [
    "session-resource-authority-v1",
    scope.sessionID,
    normalizedAgentRuntimeServerUrl(scope.serverUrl),
    scope.directory,
    workspace[0],
    scope.signedControlPlane === true ? "signed" : "local",
    workspace[1],
    sessionRefAuthority(scope.sessionRef),
  ] as const
}
