import type { WorkspaceMcpStatus as McpStatus, WorkspaceVcsInfo as VcsInfo } from "@claxedo/workspace-runtime/client"
import { authFetch, getDefaultBaseUrl, normalizeUrl } from "@/platform/api/api"
import type { SessionRef } from "@/platform/identity/session-ref"
import {
  createAgentRuntimeClient,
} from "@/platform/runtime/agent/agent-runtime-client"
import { openWorkspaceConnection } from "@/platform/runtime/agent/workspace-relay-connection"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { createTransport, centralTransportForServer } from "@/platform/runtime/transport"
import type { SessionBackend } from "@/platform/runtime/session"
import type { SessionTransportCapabilities } from "@/platform/runtime/capabilities"
import type { WorkspaceRuntimeSnapshot } from "@/platform/runtime/workspace-runtime"
import { fetchWorkspaceRecord, workspaceRuntimeRoutingRecord } from "@/platform/runtime/workspace-runtime-record"
import { isRelayHostKind, type RelayHostKind } from "@/platform/runtime/placement-wire"
import { readString, recordOrEmpty } from "@/lib/record"

export type WorkspaceRuntimeBackend = {
  ensureWorkspace: (input: {
    directory?: string
    workspaceId?: string
  }) => Promise<WorkspaceRuntimeSnapshot>
  getVcs: (input?: { directory?: string }) => Promise<VcsInfo | undefined>
  getMcpStatus: (input?: { directory?: string }) => Promise<Record<string, McpStatus>>
}

type VcsClient = {
  vcs: { get: () => Promise<{ data?: VcsInfo }> }
}

type McpClient = {
  mcp: { status: () => Promise<{ data?: Record<string, McpStatus> }> }
}

type WorkspaceRuntimeStatusResource = "vcs" | "mcp"

export const DEFAULT_SESSION_TRANSPORT_CAPABILITIES: SessionTransportCapabilities = {
  transport: "runtime",
  abort: true,
  reconnect: false,
  replay: true,
  permissions: true,
  questions: true,
  todos: true,
  commands: true,
  fork: true,
  revert: true,
  unrevert: true,
  configOptions: false,
}

/**
 * The two status resources this backend reads off a workspace runtime. The
 * relay path and the SDK-client path answer the same two shapes, and both go
 * through these decoders: a member that is not what `claxedo-api-types`
 * declares is dropped, so a runtime on an older build degrades to "nothing to
 * show" instead of a status pill bound to `undefined`.
 */
function vcsInfoFromWire(raw: unknown): VcsInfo {
  return {
    branch: readString(raw, "branch"),
    default_branch: readString(raw, "default_branch"),
  }
}

function mcpStatusFromWire(raw: unknown): McpStatus | undefined {
  const error = readString(raw, "error")
  switch (readString(raw, "status")) {
    case "connected":
      return { status: "connected" }
    case "disabled":
      return { status: "disabled" }
    case "needs_auth":
      return { status: "needs_auth" }
    // Both failure states carry the reason the UI renders; without it there is
    // nothing to tell the user, so the row is dropped rather than shown blank.
    case "failed":
      return error === undefined ? undefined : { status: "failed", error }
    case "needs_client_registration":
      return error === undefined ? undefined : { status: "needs_client_registration", error }
    default:
      return undefined
  }
}

function mcpStatusMapFromWire(raw: unknown): Record<string, McpStatus> {
  return Object.fromEntries(
    Object.entries(recordOrEmpty(raw)).flatMap(([server, value]) => {
      const status = mcpStatusFromWire(value)
      return status ? [[server, status] as const] : []
    }),
  )
}

async function readWorkspaceRecord(input: { baseUrl: string; request: typeof fetch; directory?: string; workspaceId?: string }) {
  const workspace = await fetchWorkspaceRecord(input)
  if (!workspace) throw new Error("Workspace runtime is unavailable.")
  return workspace
}

export function createHttpWorkspaceRuntimeBackend(input: {
  baseUrl?: string
  request?: typeof fetch
  client?: Partial<VcsClient & McpClient>
  workspaceId?: string
  workspace?: WorkspaceRuntimeSnapshot | null
  signedControlPlane?: boolean
}): WorkspaceRuntimeBackend {
  const baseUrl = normalizeUrl(input.baseUrl) ?? getDefaultBaseUrl()
  const request = input.request ?? authFetch
  const strictSignedRuntime = input.signedControlPlane === true

  async function runtimeJson(
    directory: string | undefined,
    resource: WorkspaceRuntimeStatusResource,
    failure: string,
  ): Promise<unknown> {
    if (!directory) return undefined
    const workspaceId = input.workspaceId ?? sessionWorkspaceRuntimeRef({ directory })?.workspaceId
    // The record read is owned by `workspace-runtime-record.ts` — one cache
    // key, one ref normalization, one set of policies. A private copy here
    // shared the key but none of the policies. This is a ROUTING read: the
    // record decides whether the status call goes over the relay or centrally,
    // and nothing else. This caller's own policy is the degradation: a failed
    // resolve means "no workspace record", which falls through to the direct
    // SDK client below.
    const workspace = input.workspace ?? (workspaceId
      ? { kind: "provisioner" as const, workspaceId }
      : await workspaceRuntimeRoutingRecord({ baseUrl, request, directory }).catch(() => null))
    if (!workspace || !isRelayHostKind(workspace.kind)) {
      if (strictSignedRuntime) throw new Error(failure)
      return undefined
    }
    if (!workspace.workspaceId) {
      if (strictSignedRuntime) throw new Error(failure)
      return undefined
    }
    const runtimePath = new URL(`/${resource}`, "http://claxedo.local")
    runtimePath.searchParams.set("directory", directory)
    return await createTransport({
      placement: {
        workspaceId: workspace.workspaceId,
        hosting: "workspace",
        transport: centralTransportForServer(baseUrl) === "loopback" ? "loopback" : "workspace-relay",
      },
      serverUrl: baseUrl,
      directory,
      request,
    }).json(`${runtimePath.pathname}${runtimePath.search}`)
  }

  return {
    ensureWorkspace: async (params) => {
      // Deliberately uncached: this reads the record to decide whether to open
      // the relay connection, then reads it back to observe the runtime state
      // that opening it produced. Both reads have to be the live record.
      const scope = { baseUrl, request, directory: params.directory, workspaceId: params.workspaceId }
      const workspace = await readWorkspaceRecord(scope)
      if (!isRelayHostKind(workspace.kind)) return workspace
      await openWorkspaceConnection(workspace.workspaceId, { serverUrl: baseUrl, request })
      return await readWorkspaceRecord(scope)
    },
    getVcs: async (params) => {
      const runtime = await runtimeJson(params?.directory, "vcs", "signed workspace VCS relay connection unavailable")
      if (runtime) return vcsInfoFromWire(runtime)
      const client = input.client?.vcs
      if (!client) throw new Error("workspace runtime backend requires client for vcs")
      return (await client.get()).data ?? {}
    },
    getMcpStatus: async (params) => {
      const runtime = await runtimeJson(params?.directory, "mcp", "signed workspace MCP relay connection unavailable")
      if (runtime) return mcpStatusMapFromWire(runtime)
      const client = input.client?.mcp
      if (!client) throw new Error("workspace runtime backend requires client for mcp")
      return (await client.status()).data ?? {}
    },
  }
}

export function createHttpSessionBackend(input: {
  request?: typeof fetch
  claxedoServerUrl?: string
  sessionRef?: SessionRef
  signedControlPlane?: boolean
  workspaceId?: string
  hostKind?: RelayHostKind
  /** See `createAgentRuntimeClient`'s `workspaceReachable`. */
  workspaceReachable?: boolean
}): SessionBackend {
  const request = input.request ?? authFetch
  const runtimeFor = (sessionRef?: SessionRef) => createAgentRuntimeClient({
    request,
    serverUrl: normalizeUrl(input.claxedoServerUrl),
    signedControlPlane: input.signedControlPlane === true,
    sessionRef: sessionRef ?? input.sessionRef,
    workspaceId: input.workspaceId,
    hostKind: input.hostKind,
    workspaceReachable: input.workspaceReachable,
  })
  const runtime = runtimeFor()

  return {
    usesScopedTransport: runtime.usesScopedTransport,
    getCapabilities: (params) => runtimeFor(params.sessionRef).getCapabilities(params),
    getGoalState: (params) => runtimeFor(params.sessionRef).getGoalState(params),
    startGoal: (params) => runtimeFor(params.sessionRef).startGoal(params),
    pauseGoal: (params) => runtimeFor(params.sessionRef).pauseGoal(params),
    resumeGoal: (params) => runtimeFor(params.sessionRef).resumeGoal(params),
    stopGoal: (params) => runtimeFor(params.sessionRef).stopGoal(params),
    deleteGoal: (params) => runtimeFor(params.sessionRef).deleteGoal(params),
    getSession: (params) => runtimeFor(params.sessionRef).getSession(params),
    listMessages: (params) => runtimeFor(params.sessionRef).getMessages(params),
    listTodos: (params) => runtimeFor(params.sessionRef).getTodos(params),
    getPermissionModes: (params) => runtimeFor(params.sessionRef).getPermissionModes(params),
    setPermissionMode: (params) => runtimeFor(params.sessionRef).setPermissionMode(params),
  }
}
