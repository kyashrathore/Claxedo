import type { LspStatus, McpStatus, Session, Todo, VcsInfo } from "@opencode-ai/sdk/v2/client"
import { authFetch, getDefaultBaseUrl, normalizeUrl } from "@/platform/api/api"
import type { SessionRef } from "@/platform/identity/session-ref"
import {
  createAgentRuntimeClient,
  DEFAULT_AGENT_RUNTIME_CAPABILITIES,
} from "@/platform/runtime/agent/agent-runtime-client"
import { openWorkspaceConnection } from "@/platform/runtime/agent/workspace-relay-connection"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { createTransport, centralTransportForServer } from "@/platform/runtime/transport"
import type { SessionBackend, SessionMessagePageRequest, SessionMessageRow } from "@/platform/runtime/session"
import type { WorkspaceRuntimeSnapshot } from "@/platform/runtime/workspace-runtime"
import { fetchWorkspaceRecord, workspaceRuntimeRoutingRecord } from "@/platform/runtime/workspace-runtime-record"

export type WorkspaceRuntimeBackend = {
  ensureWorkspace: (input: {
    directory?: string
    workspaceId?: string
  }) => Promise<WorkspaceRuntimeSnapshot>
  getVcs: (input?: { directory?: string }) => Promise<VcsInfo | undefined>
  getMcpStatus: (input?: { directory?: string }) => Promise<Record<string, McpStatus>>
  getLspStatus: (input?: { directory?: string }) => Promise<LspStatus[]>
}

type VcsClient = {
  vcs: { get: () => Promise<{ data?: VcsInfo }> }
}

type McpClient = {
  mcp: { status: () => Promise<{ data?: Record<string, McpStatus> }> }
}

type LspClient = {
  lsp: { status: () => Promise<{ data?: LspStatus[] }> }
}

type WorkspaceRuntimeStatusResource = "vcs" | "mcp" | "lsp"

type SessionClient = {
  get: (input: { sessionID: string }) => Promise<{ data?: Session }>
  messages: (input: {
    sessionID: string
    directory?: string
  } & SessionMessagePageRequest, options?: { signal?: AbortSignal }) => Promise<{ data?: SessionMessageRow[]; response: Response }>
  todo: (input: { sessionID: string }) => Promise<{ data?: Todo[] }>
}

export const DEFAULT_OPENCODE_TRANSPORT_CAPABILITIES = DEFAULT_AGENT_RUNTIME_CAPABILITIES

async function readWorkspaceRecord(input: { baseUrl: string; request: typeof fetch; directory?: string; workspaceId?: string }) {
  const workspace = await fetchWorkspaceRecord(input)
  if (!workspace) throw new Error("Workspace runtime is unavailable.")
  return workspace
}

export function createHttpWorkspaceRuntimeBackend(input: {
  baseUrl?: string
  request?: typeof fetch
  client?: Partial<VcsClient & McpClient & LspClient>
  workspaceId?: string
  workspace?: WorkspaceRuntimeSnapshot | null
  signedControlPlane?: boolean
}): WorkspaceRuntimeBackend {
  const baseUrl = normalizeUrl(input.baseUrl) ?? getDefaultBaseUrl()
  const request = input.request ?? authFetch
  const strictSignedRuntime = input.signedControlPlane === true

  async function runtimeJson<T>(
    directory: string | undefined,
    resource: WorkspaceRuntimeStatusResource,
    failure: string,
  ): Promise<T | undefined> {
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
      ? { kind: "cloud" as const, workspaceId }
      : await workspaceRuntimeRoutingRecord({ baseUrl, request, directory }).catch(() => null))
    if (workspace?.kind !== "cloud" && workspace?.kind !== "user-hosted") {
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
    }).json<T>(`${runtimePath.pathname}${runtimePath.search}`)
  }

  return {
    ensureWorkspace: async (params) => {
      // Deliberately uncached: this reads the record to decide whether to open
      // the relay connection, then reads it back to observe the runtime state
      // that opening it produced. Both reads have to be the live record.
      const scope = { baseUrl, request, directory: params.directory, workspaceId: params.workspaceId }
      const workspace = await readWorkspaceRecord(scope)
      if (workspace.kind !== "cloud" && workspace.kind !== "user-hosted") return workspace
      await openWorkspaceConnection(workspace.workspaceId, { serverUrl: baseUrl, request })
      return await readWorkspaceRecord(scope)
    },
    getVcs: async (params) => {
      const runtime = await runtimeJson<VcsInfo>(params?.directory, "vcs", "signed workspace VCS relay connection unavailable")
      if (runtime) return runtime
      const client = input.client?.vcs
      if (!client) throw new Error("workspace runtime backend requires client for vcs")
      return (await client.get()).data ?? {}
    },
    getMcpStatus: async (params) => {
      const runtime = await runtimeJson<Record<string, McpStatus>>(params?.directory, "mcp", "signed workspace MCP relay connection unavailable")
      if (runtime) return runtime
      const client = input.client?.mcp
      if (!client) throw new Error("workspace runtime backend requires client for mcp")
      return (await client.status()).data ?? {}
    },
    getLspStatus: async (params) => {
      const runtime = await runtimeJson<LspStatus[]>(params?.directory, "lsp", "signed workspace LSP relay connection unavailable")
      if (runtime) return runtime
      const client = input.client?.lsp
      if (!client) throw new Error("workspace runtime backend requires client for lsp")
      return (await client.status()).data ?? []
    },
  }
}

export function createHttpSessionBackend(input: {
  client: SessionClient
  request?: typeof fetch
  claxedoServerUrl?: string
  sessionRef?: SessionRef
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
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
    workspaceKind: input.workspaceKind,
    workspaceReachable: input.workspaceReachable,
    opencodeClient: { session: input.client },
  })
  const runtime = runtimeFor()

  return {
    usesScopedTransport: runtime.usesScopedTransport,
    getCapabilities: (params) => runtimeFor(params.sessionRef).getCapabilities(params),
    getGoalCapabilities: (params) => runtimeFor(params.sessionRef).getGoalCapabilities(params),
    getGoal: (params) => runtimeFor(params.sessionRef).getGoal(params),
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
