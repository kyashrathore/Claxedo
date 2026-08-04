import type { LspStatus, McpStatus, Session, Todo, VcsInfo } from "@opencode-ai/sdk/v2/client"
import { authFetch, getDefaultBaseUrl, normalizeUrl } from "@/platform/api/api"
import type { SessionRef } from "@/platform/identity/session-ref"
import {
  createAgentRuntimeClient,
  DEFAULT_AGENT_RUNTIME_CAPABILITIES,
} from "@/platform/runtime/agent/agent-runtime-client"
import { workspaceResolveUrl } from "@/platform/runtime/agent/workspace-control-routes"
import { openWorkspaceConnection } from "@/platform/runtime/agent/workspace-relay-connection"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { createTransport, centralTransportForServer } from "@/platform/runtime/transport"
import type { SessionBackend, SessionMessageRow } from "@/platform/runtime/session"
import type { WorkspaceRuntimeSnapshot } from "@/platform/runtime/workspace-runtime"

export type WorkspaceRuntimeBackend = {
  resolveWorkspace: (input: {
    directory?: string
    workspaceId?: string
    create?: boolean
  }) => Promise<WorkspaceRuntimeSnapshot | null>
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
    limit: number
    before?: string
  }) => Promise<{ data?: SessionMessageRow[]; response: Response }>
  todo: (input: { sessionID: string }) => Promise<{ data?: Todo[] }>
}

export const DEFAULT_OPENCODE_TRANSPORT_CAPABILITIES = DEFAULT_AGENT_RUNTIME_CAPABILITIES

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.text()) || `Request failed: ${res.status}`)
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error("Workspace runtime is unavailable.")
  }
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

  async function resolveWorkspaceRuntime(directory: string) {
    const res = await request(workspaceResolveUrl({ baseUrl, scope: directory }), {
      headers: { Accept: "application/json" },
    })
    if (!res.ok) return null
    return await readJson<WorkspaceRuntimeSnapshot>(res)
  }

  async function runtimeJson<T>(
    directory: string | undefined,
    resource: WorkspaceRuntimeStatusResource,
    failure: string,
  ): Promise<T | undefined> {
    if (!directory) return undefined
    const workspaceId = input.workspaceId ?? sessionWorkspaceRuntimeRef({ directory })?.workspaceId
    const workspace = input.workspace ?? (workspaceId
      ? { kind: "cloud" as const, workspaceId }
      : await resolveWorkspaceRuntime(directory))
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
    resolveWorkspace: async (params) => {
      if (!params.directory && !params.workspaceId) {
        throw new Error("workspace resolve requires directory or workspaceId")
      }
      const res = await request(workspaceResolveUrl({
        baseUrl,
        scope: params.directory,
        workspaceId: params.workspaceId,
        create: params.create,
      }), {
        headers: { Accept: "application/json" },
      })
      if (res.status === 404) return null
      return await readJson<WorkspaceRuntimeSnapshot>(res)
    },
    ensureWorkspace: async (params) => {
      const resolveUrl = workspaceResolveUrl({
        baseUrl,
        scope: params.directory,
        workspaceId: params.workspaceId,
      })
      const workspace = await readJson<WorkspaceRuntimeSnapshot>(await request(resolveUrl, {
        headers: { Accept: "application/json" },
      }))
      if (workspace.kind !== "cloud" && workspace.kind !== "user-hosted") return workspace
      await openWorkspaceConnection(workspace.workspaceId, { serverUrl: baseUrl, request })
      return await readJson<WorkspaceRuntimeSnapshot>(await request(resolveUrl, {
        headers: { Accept: "application/json" },
      }))
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
    getSession: (params) => runtimeFor(params.sessionRef).getSession(params),
    listMessages: (params) => runtimeFor(params.sessionRef).getMessages(params),
    listTodos: (params) => runtimeFor(params.sessionRef).getTodos(params),
    getPermissionModes: (params) => runtimeFor(params.sessionRef).getPermissionModes(params),
    setPermissionMode: (params) => runtimeFor(params.sessionRef).setPermissionMode(params),
  }
}
